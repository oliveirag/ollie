/**
 * Phase 0 exit check: a signal can be written to the database and read back.
 *
 * The signal is fabricated — no market data, no broker, no LLM — so this
 * exercises exactly one thing: the schema, the triggers, and the repository
 * layer agree on what a signal is.
 *
 *   npm run signal:write-test
 *   npm run signal:write-test -- --decide approved --reason "looked fine"
 *
 * Writes to whatever DATABASE_URL points at, so point it at a scratch database
 * unless you want a fabricated row in your permanent record — and it is
 * permanent, that is the point of the triggers.
 */
import { randomUUID } from 'node:crypto';
import { disconnectPrisma } from '../src/db/client.js';
import {
  getSignal,
  insertSignal,
  listSignalEvents,
  transitionSignal,
  type DecidedStatus,
} from '../src/db/signals.js';
import { getAppSettings } from '../src/db/settings.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const DECIDABLE: readonly DecidedStatus[] = ['approved', 'rejected', 'expired'];

async function main(): Promise<void> {
  const settings = await getAppSettings();
  console.log(
    `app_settings: execution_mode=${settings.executionMode} kill_switch=${settings.killSwitch}`,
  );

  const barTime = new Date().toISOString();
  const created = await insertSignal({
    symbol: 'AAPL',
    side: 'buy',
    signalType: 'technical',
    quantity: '2',
    thesis:
      'Fabricated test signal. AAPL RSI(14) at 27.3 crossed below the oversold threshold of 30.',
    thesisSource: 'fallback_template',
    indicators: {
      rsi14: 27.3,
      rsi14Prev: 31.2,
      macdLine: -1.84,
      macdSignal: -1.42,
      macdHist: -0.42,
    },
    reviewSnapshot: {
      note: 'fabricated — not a real review_equity_order response',
      estimated_price: '182.50',
      alerts: [],
    },
    executionMode: settings.executionMode,
    dedupeKey: `write-test:AAPL:buy:${barTime}:${randomUUID().slice(0, 8)}`,
  });

  console.log(`\ninserted signal ${created.id}`);

  const decision = flag('decide');
  if (decision) {
    if (!DECIDABLE.includes(decision as DecidedStatus)) {
      throw new Error(`--decide must be one of ${DECIDABLE.join(', ')}`);
    }
    await transitionSignal(
      created.id,
      decision as DecidedStatus,
      flag('reason') ?? 'write-test script',
    );
  }

  const readBack = await getSignal(created.id);
  if (!readBack) throw new Error(`signal ${created.id} vanished between write and read`);

  console.log('\nread back from the database:');
  console.table([
    {
      id: readBack.id,
      symbol: readBack.symbol,
      side: readBack.side,
      quantity: readBack.quantity.toString(),
      status: readBack.status,
      mode: readBack.executionMode,
      thesis_source: readBack.thesisSource,
      created_at: readBack.createdAt.toISOString(),
      decided_at: readBack.decidedAt?.toISOString() ?? null,
    },
  ]);
  console.log('indicators:      ', JSON.stringify(readBack.indicators));
  console.log('review_snapshot: ', JSON.stringify(readBack.reviewSnapshot));
  console.log('ref_id:          ', readBack.refId, '(broker idempotency key, unused until live)');

  const events = await listSignalEvents(created.id);
  if (events.length > 0) {
    console.log('\naudit trail:');
    console.table(
      events.map((e) => ({
        from: e.fromStatus,
        to: e.toStatus,
        reason: e.reason,
        at: e.createdAt.toISOString(),
      })),
    );
  }
}

main()
  .then(() => console.log('\nPhase 0 exit check passed: signal written and read back.'))
  .catch((error: unknown) => {
    console.error('\nwrite-test-signal failed:', error);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
