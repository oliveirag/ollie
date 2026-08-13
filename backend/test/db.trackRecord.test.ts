import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { insertSignal } from '../src/db/signals.js';
import {
  appendTrackRecord,
  closeLots,
  hasMarkForDay,
  listOpenLots,
  openLotsForSymbol,
} from '../src/db/trackRecord.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';

const db = testPrisma();

async function seedSignal(overrides: Partial<Parameters<typeof insertSignal>[0]> = {}) {
  return insertSignal(
    {
      symbol: 'AAPL',
      side: 'buy',
      signalType: 'technical',
      quantity: '2',
      thesis: 'RSI(14) crossed below 30.',
      thesisSource: 'llm',
      indicators: {},
      reviewSnapshot: { estimated_price: '182.50', alerts: [] },
      executionMode: 'paper',
      dedupeKey: uniqueDedupeKey(),
      ...overrides,
    },
    db,
  );
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestPrisma();
});

describe('mark rows', () => {
  it('records the quote a mark was computed from', async () => {
    const signal = await seedSignal();

    const row = await appendTrackRecord(
      {
        signalId: signal.id,
        entryPrice: '100.00',
        unrealizedPnl: '12.00',
        markPrice: '106.00',
        status: 'open',
      },
      db,
    );

    // Without the price the row is an unauditable number: a reader cannot tell
    // a mark against a stale quote from one against a good quote, and the rows
    // can never be corrected in place.
    expect(row.markPrice?.toString()).toBe('106');
  });
});

describe('closed rows', () => {
  it('records which signal closed the lot', async () => {
    const entry = await seedSignal();
    const exit = await seedSignal({ side: 'sell', dedupeKey: uniqueDedupeKey('exit') });

    const row = await appendTrackRecord(
      {
        signalId: entry.id,
        entryPrice: '100.00',
        exitPrice: '110.00',
        realizedPnl: '20.00',
        closedBySignalId: exit.id,
        status: 'closed',
      },
      db,
    );

    // The link is what makes a closed lot traceable to the approval that closed
    // it. Without it, a closed row asserts a PnL with no accountable decision
    // behind it — which is the opposite of what an auditable record is for.
    expect(row.closedBySignalId).toBe(exit.id);
  });
});

describe('openLotsForSymbol', () => {
  it('returns only lots for the requested symbol', async () => {
    const aapl = await seedSignal({ symbol: 'AAPL' });
    const msft = await seedSignal({ symbol: 'MSFT', dedupeKey: uniqueDedupeKey('msft') });
    await appendTrackRecord({ signalId: aapl.id, entryPrice: '100.00', status: 'open' }, db);
    await appendTrackRecord({ signalId: msft.id, entryPrice: '200.00', status: 'open' }, db);

    const lots = await openLotsForSymbol('AAPL', db);

    expect(lots.map((lot) => lot.signalId)).toEqual([aapl.id]);
  });

  it('excludes a lot a later row already closed', async () => {
    const signal = await seedSignal({ symbol: 'AAPL' });
    await appendTrackRecord(
      { signalId: signal.id, entryPrice: '100.00', status: 'open', recordedAt: new Date(1) },
      db,
    );
    await appendTrackRecord(
      {
        signalId: signal.id,
        entryPrice: '100.00',
        exitPrice: '110.00',
        realizedPnl: '20.00',
        status: 'closed',
        recordedAt: new Date(2),
      },
      db,
    );

    expect(await openLotsForSymbol('AAPL', db)).toHaveLength(0);
  });
});

describe('closeLots', () => {
  it('computes realized pnl from the entry price and quantity', async () => {
    const entry = await seedSignal({ quantity: '2' });
    const exit = await seedSignal({ side: 'sell', dedupeKey: uniqueDedupeKey('exit') });
    await appendTrackRecord({ signalId: entry.id, entryPrice: '100.00', status: 'open' }, db);

    const closed = await closeLots(
      { signalIds: [entry.id], exitPrice: '110.00', closedBySignalId: exit.id },
      db,
    );

    // (110 - 100) x 2. Hand-computed, because this number is the product.
    expect(closed).toHaveLength(1);
    expect(closed[0]?.realizedPnl?.toString()).toBe('20');
    expect(closed[0]?.status).toBe('closed');
    expect(closed[0]?.closedBySignalId).toBe(exit.id);
  });

  it('records a loss as a negative realized pnl rather than refusing it', async () => {
    const entry = await seedSignal({ quantity: '2' });
    const exit = await seedSignal({ side: 'sell', dedupeKey: uniqueDedupeKey('exit') });
    await appendTrackRecord({ signalId: entry.id, entryPrice: '100.00', status: 'open' }, db);

    const closed = await closeLots(
      { signalIds: [entry.id], exitPrice: '90.00', closedBySignalId: exit.id },
      db,
    );

    expect(closed[0]?.realizedPnl?.toString()).toBe('-20');
  });

  it('leaves no partial write when one lot in the batch is not open', async () => {
    const open = await seedSignal({ quantity: '2' });
    const never = await seedSignal({ dedupeKey: uniqueDedupeKey('never') });
    const exit = await seedSignal({ side: 'sell', dedupeKey: uniqueDedupeKey('exit') });
    await appendTrackRecord({ signalId: open.id, entryPrice: '100.00', status: 'open' }, db);

    await expect(
      closeLots(
        { signalIds: [open.id, never.id], exitPrice: '110.00', closedBySignalId: exit.id },
        db,
      ),
    ).rejects.toThrow();

    // The rows can never be deleted, so a half-applied close would be permanent.
    expect(await listOpenLots(db)).toHaveLength(1);
  });
});

describe('hasMarkForDay', () => {
  it('is false before a mark and true after one on the same day', async () => {
    const signal = await seedSignal();
    const day = new Date('2026-08-13T20:15:00Z');
    await appendTrackRecord({ signalId: signal.id, entryPrice: '100.00', status: 'open' }, db);

    expect(await hasMarkForDay(signal.id, day, db)).toBe(false);

    await appendTrackRecord(
      {
        signalId: signal.id,
        entryPrice: '100.00',
        unrealizedPnl: '5.00',
        markPrice: '102.50',
        status: 'open',
        recordedAt: day,
      },
      db,
    );

    expect(await hasMarkForDay(signal.id, day, db)).toBe(true);
  });

  it('does not count a mark from a different day', async () => {
    const signal = await seedSignal();
    await appendTrackRecord(
      {
        signalId: signal.id,
        entryPrice: '100.00',
        unrealizedPnl: '5.00',
        markPrice: '102.50',
        status: 'open',
        recordedAt: new Date('2026-08-12T20:15:00Z'),
      },
      db,
    );

    expect(await hasMarkForDay(signal.id, new Date('2026-08-13T20:15:00Z'), db)).toBe(false);
  });
});

/**
 * Regression guards, not TDD drivers — both passed the moment they were
 * written, because the triggers are table-wide and the ordering already exists.
 * They are here because 3.1 adds columns and functions that would silently
 * weaken either guarantee if someone later reached for the obvious shortcut.
 */
describe('append-only guarantees survive the new columns', () => {
  it('still refuses UPDATE and DELETE on a row carrying a mark price', async () => {
    const signal = await seedSignal();
    await appendTrackRecord(
      {
        signalId: signal.id,
        entryPrice: '100.00',
        unrealizedPnl: '5.00',
        markPrice: '102.50',
        status: 'open',
      },
      db,
    );

    // A mark row is still a track-record row. If the trigger were ever narrowed
    // to specific columns, correcting a bad quote in place would become
    // possible — which is exactly the edit the record must never allow.
    await expect(
      db.$executeRawUnsafe(`UPDATE track_record SET mark_price = 1`),
    ).rejects.toThrow();
    await expect(db.$executeRawUnsafe(`DELETE FROM track_record`)).rejects.toThrow();
  });

  it('still refuses UPDATE on a closed row carrying a closer', async () => {
    const entry = await seedSignal();
    const exit = await seedSignal({ side: 'sell', dedupeKey: uniqueDedupeKey('exit') });
    await appendTrackRecord({ signalId: entry.id, entryPrice: '100.00', status: 'open' }, db);
    await closeLots(
      { signalIds: [entry.id], exitPrice: '110.00', closedBySignalId: exit.id },
      db,
    );

    // Re-pointing a close at a different signal would rewrite who decided it.
    await expect(
      db.$executeRawUnsafe(`UPDATE track_record SET closed_by_signal_id = NULL`),
    ).rejects.toThrow();
  });
});

describe('closed lots are never resurrected by an older row', () => {
  it('keeps a lot closed when an open row is written with an earlier timestamp', async () => {
    const entry = await seedSignal({ symbol: 'AAPL' });
    const exit = await seedSignal({ side: 'sell', dedupeKey: uniqueDedupeKey('exit') });
    await appendTrackRecord(
      { signalId: entry.id, entryPrice: '100.00', status: 'open', recordedAt: new Date(1_000) },
      db,
    );
    await closeLots(
      {
        signalIds: [entry.id],
        exitPrice: '110.00',
        closedBySignalId: exit.id,
        recordedAt: new Date(3_000),
      },
      db,
    );

    // A late-arriving mark stamped *before* the close — the shape a backfill or
    // a clock skew produces. `WHERE status = 'open'` ahead of the row pick would
    // select this row and report the position open again.
    await appendTrackRecord(
      {
        signalId: entry.id,
        entryPrice: '100.00',
        unrealizedPnl: '4.00',
        markPrice: '102.00',
        status: 'open',
        recordedAt: new Date(2_000),
      },
      db,
    );

    expect(await listOpenLots(db)).toHaveLength(0);
    expect(await openLotsForSymbol('AAPL', db)).toHaveLength(0);
  });
});
