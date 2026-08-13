import type { Logger } from 'pino';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildConfig, type Config } from '../src/config/index.js';
import { listExecutions } from '../src/db/executions.js';
import { insertSignal, transitionSignal } from '../src/db/signals.js';
import { appendTrackRecord, listOpenLots, listTrackRecord } from '../src/db/trackRecord.js';
import { NoOpenPositionError, PaperExecutor } from '../src/orchestrator/executor.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';

const db = testPrisma();
const logger: Logger = pino({ level: 'silent' });

function config(): Config {
  return buildConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    SYMBOL_ALLOWLIST: 'AAPL',
    SLIPPAGE_BPS: '10',
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv);
}

/** A review snapshot the executor will actually accept. */
function snapshot(side: 'buy' | 'sell', quantity: string, estimatedPrice: string) {
  return {
    schema_version: 1 as const,
    estimated_price: estimatedPrice,
    requested: { symbol: 'AAPL', side, quantity, type: 'market' as const },
    captured_at: '2026-07-31T13:35:00.000Z',
    raw: { symbol: 'AAPL', _test: true },
  };
}

async function seedOpenLot(quantity: string, entryPrice: string, recordedAt: Date) {
  const signal = await insertSignal(
    {
      symbol: 'AAPL',
      side: 'buy',
      signalType: 'technical',
      quantity,
      thesis: null,
      thesisSource: 'llm',
      indicators: {},
      reviewSnapshot: snapshot('buy', quantity, entryPrice),
      executionMode: 'paper',
      dedupeKey: uniqueDedupeKey('entry'),
    },
    db,
  );
  await appendTrackRecord({ signalId: signal.id, entryPrice, status: 'open', recordedAt }, db);
  return signal;
}

/** An approved sell, ready for the executor. */
async function seedApprovedExit(quantity: string, estimatedPrice = '300.000000') {
  const signal = await insertSignal(
    {
      symbol: 'AAPL',
      side: 'sell',
      signalType: 'technical',
      quantity,
      thesis: null,
      thesisSource: 'llm',
      indicators: {},
      reviewSnapshot: snapshot('sell', quantity, estimatedPrice),
      executionMode: 'paper',
      dedupeKey: uniqueDedupeKey('exit'),
    },
    db,
  );
  return transitionSignal(signal.id, 'approved', 'owner approved', { prisma: db });
}

const executor = () => new PaperExecutor({ config: config(), logger, prisma: db });

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestPrisma();
});

describe('an approved exit closes the lot', () => {
  it('writes a closed row instead of opening another position', async () => {
    const entry = await seedOpenLot('2', '100.000000', new Date(1_000));
    const exit = await seedApprovedExit('2', '110.000000');

    await executor().execute(exit);

    // The bug this replaces: the executor appended an `open` row for every
    // signal, so approving a sell opened a second position rather than closing
    // the first — and the record would show two longs where one was closed.
    const rows = await listTrackRecord(entry.id, db);
    expect(rows.map((r) => r.status)).toEqual(['open', 'closed']);
    expect(await listOpenLots(db)).toHaveLength(0);
  });

  it('computes realized pnl from the slippage-adjusted fill', async () => {
    const entry = await seedOpenLot('2', '100.000000', new Date(1_000));
    const exit = await seedApprovedExit('2', '110.000000');

    await executor().execute(exit);

    // A sell fills *below* the estimate: 110 x (1 - 0.001) = 109.89. Realized
    // is (109.89 - 100) x 2 = 19.78, not the 20 the estimate would suggest.
    // Slippage works against the trader on both legs so paper never flatters.
    const closed = (await listTrackRecord(entry.id, db)).at(-1)!;
    expect(closed.exitPrice?.toString()).toBe('109.89');
    expect(closed.realizedPnl?.toString()).toBe('19.78');
  });

  it('attributes the close to the sell signal that caused it', async () => {
    const entry = await seedOpenLot('2', '100.000000', new Date(1_000));
    const exit = await seedApprovedExit('2', '110.000000');

    await executor().execute(exit);

    const closed = (await listTrackRecord(entry.id, db)).at(-1)!;
    expect(closed.closedBySignalId).toBe(exit.id);
  });

  it('records the execution against the exit signal', async () => {
    await seedOpenLot('2', '100.000000', new Date(1_000));
    const exit = await seedApprovedExit('2', '110.000000');

    await executor().execute(exit);

    const executions = await listExecutions(exit.id, db);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.fillPrice.toString()).toBe('109.89');
    expect(executions[0]?.brokerOrderId).toBeNull();
  });
});

describe('lots are consumed oldest first', () => {
  it('leaves a newer lot open when the exit only covers the older one', async () => {
    const older = await seedOpenLot('2', '100.000000', new Date(1_000));
    const newer = await seedOpenLot('3', '120.000000', new Date(2_000));
    // Sized to the older lot alone — the shape a buy approved *after* the exit
    // was proposed produces. The exit's quantity was fixed at proposal time.
    const exit = await seedApprovedExit('2', '110.000000');

    await executor().execute(exit);

    const open = await listOpenLots(db);
    expect(open.map((lot) => lot.signalId)).toEqual([newer.id]);
    expect((await listTrackRecord(older.id, db)).at(-1)!.status).toBe('closed');
  });
});

describe('an exit with nothing to close', () => {
  it('refuses rather than recording a fill against no position', async () => {
    const exit = await seedApprovedExit('2', '110.000000');

    await expect(executor().execute(exit)).rejects.toThrow(NoOpenPositionError);

    // Nothing partial: no execution, no rows. The signal keeps its own status
    // and the record stays silent about a trade that never happened.
    expect(await listExecutions(exit.id, db)).toHaveLength(0);
    expect(await listOpenLots(db)).toHaveLength(0);
  });
});
