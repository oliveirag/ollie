/**
 * Approve or reject a pending signal. This is the owner's decision surface for
 * Phase 1 — the iOS app replaces it in Phase 2, calling the same repository
 * functions through the API.
 *
 *   npm run signal:decide -- --list
 *   npm run signal:decide -- <signal-id> approve
 *   npm run signal:decide -- <signal-id> reject --reason "changed my mind"
 *
 * Approving runs the executor for the signal's own execution mode. In paper
 * mode that writes a simulated fill and opens a track-record position without
 * contacting the broker. In live mode it throws, because live execution does
 * not exist until Phase 5.
 */
import { disconnectPrisma } from '../src/db/client.js';
import { getConfig } from '../src/config/index.js';
import { logger } from '../src/logger.js';
import {
  getSignal,
  listPendingSignals,
  transitionSignal,
  type DecidedStatus,
} from '../src/db/signals.js';
import { executorFor } from '../src/orchestrator/executor.js';
import { parseReviewSnapshot } from '../src/orchestrator/reviewSnapshot.js';
import { McpBrokerAdapter } from '../src/orchestrator/robinhood/mcpClient.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function listPending(): Promise<void> {
  const pending = await listPendingSignals();
  if (pending.length === 0) {
    console.log('no pending signals');
    return;
  }

  console.table(
    pending.map((s) => ({
      id: s.id,
      created_at: s.createdAt.toISOString(),
      symbol: s.symbol,
      side: s.side,
      quantity: s.quantity.toString(),
      mode: s.executionMode,
      estimated_price: safeEstimatedPrice(s.reviewSnapshot),
    })),
  );
  for (const signal of pending) {
    console.log(`\n${signal.id}  ${signal.symbol} ${signal.side}\n  ${signal.thesis ?? '(no thesis)'}`);
  }
}

function safeEstimatedPrice(snapshot: unknown): string {
  try {
    return parseReviewSnapshot(snapshot).estimated_price;
  } catch {
    return '(unreadable)';
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--list')) {
    await listPending();
    return;
  }

  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const [signalId, action] = positional;

  if (!signalId || !action) {
    console.error(
      'usage:\n' +
        '  npm run signal:decide -- --list\n' +
        '  npm run signal:decide -- <signal-id> approve|reject [--reason "..."]',
    );
    process.exitCode = 1;
    return;
  }
  if (action !== 'approve' && action !== 'reject') {
    throw new Error(`action must be "approve" or "reject", got "${action}"`);
  }

  const signal = await getSignal(signalId);
  if (!signal) throw new Error(`no signal with id ${signalId}`);
  if (signal.status !== 'pending') {
    throw new Error(`signal ${signalId} is already ${signal.status}; decisions happen once`);
  }

  const status: DecidedStatus = action === 'approve' ? 'approved' : 'rejected';
  const reason = flag('reason') ?? `${action}d via decide-signal CLI`;

  const decided = await transitionSignal(signalId, status, reason);
  console.log(`\nsignal ${signalId} -> ${decided.status} (${reason})`);

  if (status === 'rejected') {
    console.log('rejected signals stay on the record with their reason; nothing was executed.');
    return;
  }

  // Only reached on approval. The broker is constructed but unused in paper
  // mode — PaperExecutor holds no reference to it.
  const config = getConfig();
  const broker = new McpBrokerAdapter({ logger });
  try {
    const executor = executorFor(decided, { config, logger }, broker);
    const { execution, trackRecord } = await executor.execute(decided);

    console.log(`\n${execution.mode} fill recorded:`);
    console.table([
      {
        execution_id: execution.id,
        fill_price: execution.fillPrice.toString(),
        quantity: execution.quantity.toString(),
        filled_at: execution.filledAt.toISOString(),
        broker_order_id: execution.brokerOrderId ?? '(none — paper)',
      },
    ]);
    console.log(
      `track record opened: entry ${trackRecord.entryPrice.toString()}, status ${trackRecord.status}`,
    );
  } finally {
    await broker.close();
  }
}

main()
  .catch((error: unknown) => {
    console.error('\ndecide-signal failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
