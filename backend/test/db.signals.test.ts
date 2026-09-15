import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, Signal } from '@prisma/client';
import {
  DuplicateSignalError,
  SignalNotPendingError,
  countSignalsSince,
  findExistingDedupeKeys,
  getSignal,
  insertSignal,
  listExpiredPendingSignals,
  listPendingSignals,
  listSignalEvents,
  publishSignal,
  SignalAlreadyPublishedError,
  transitionSignal,
} from '../src/db/signals.js';
import { IMMUTABILITY_ERRCODE, isImmutabilityViolation } from '../src/db/client.js';
import { recordExecution } from '../src/db/executions.js';
import { appendTrackRecord } from '../src/db/trackRecord.js';
import { getAppSettings, setExecutionMode, setKillSwitch } from '../src/db/settings.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';

const db: PrismaClient = testPrisma();

async function seedSignal(overrides: Partial<Parameters<typeof insertSignal>[0]> = {}) {
  return insertSignal(
    {
      symbol: 'AAPL',
      side: 'buy',
      signalType: 'technical',
      quantity: '2',
      thesis: 'RSI(14) crossed below 30.',
      thesisSource: 'llm',
      indicators: { rsi14: 27.3, macdHist: -0.42 },
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

describe('signal round-trip', () => {
  it('persists every field and reads back identical values', async () => {
    const created = await seedSignal();
    const read = await getSignal(created.id, db);

    expect(read).not.toBeNull();
    expect(read!.symbol).toBe('AAPL');
    expect(read!.side).toBe('buy');
    expect(read!.signalType).toBe('technical');
    expect(read!.quantity.toString()).toBe('2');
    expect(read!.status).toBe('pending');
    expect(read!.executionMode).toBe('paper');
    expect(read!.thesisSource).toBe('llm');
    expect(read!.indicators).toEqual({ rsi14: 27.3, macdHist: -0.42 });
    expect(read!.reviewSnapshot).toEqual({ estimated_price: '182.50', alerts: [] });
    expect(read!.decidedAt).toBeNull();
    expect(read!.published).toBe(false);
  });

  it('allocates a broker idempotency key up front', async () => {
    const created = await seedSignal();
    expect(created.refId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('rejects a second signal with the same dedupe key', async () => {
    const dedupeKey = uniqueDedupeKey();
    await seedSignal({ dedupeKey });
    await expect(seedSignal({ dedupeKey })).rejects.toThrow(DuplicateSignalError);
  });
});

describe('decision transitions', () => {
  it('records an audit event alongside the status change', async () => {
    const signal = await seedSignal();
    const approved = await transitionSignal(signal.id, 'approved', 'owner approved', {
      prisma: db,
    });

    expect(approved.status).toBe('approved');
    expect(approved.decidedAt).not.toBeNull();
    expect(approved.decideReason).toBe('owner approved');

    const events = await listSignalEvents(signal.id, db);
    expect(events).toHaveLength(1);
    expect(events[0]!.fromStatus).toBe('pending');
    expect(events[0]!.toStatus).toBe('approved');
    expect(events[0]!.reason).toBe('owner approved');
  });

  it.each(['approved', 'rejected', 'expired'] as const)(
    'accepts pending -> %s',
    async (to) => {
      const signal = await seedSignal();
      const decided = await transitionSignal(signal.id, to, `moved to ${to}`, { prisma: db });
      expect(decided.status).toBe(to);
    },
  );

  it('refuses to decide the same signal twice', async () => {
    const signal = await seedSignal();
    await transitionSignal(signal.id, 'approved', 'first', { prisma: db });
    await expect(
      transitionSignal(signal.id, 'rejected', 'second', { prisma: db }),
    ).rejects.toThrow(SignalNotPendingError);
  });

  it('leaves no audit event behind when a transition is refused', async () => {
    const signal = await seedSignal();
    await transitionSignal(signal.id, 'rejected', 'first', { prisma: db });
    await expect(
      transitionSignal(signal.id, 'approved', 'second', { prisma: db }),
    ).rejects.toThrow(SignalNotPendingError);

    const events = await listSignalEvents(signal.id, db);
    expect(events).toHaveLength(1);
  });

  it('stamps publication once and never unstamps it', async () => {
    const signal = await seedSignal();
    const published = await publishSignal(signal.id, { prisma: db });
    expect(published.published).toBe(true);
    expect(published.publishedAt).not.toBeNull();

    await expect(publishSignal(signal.id, { prisma: db })).rejects.toThrow(
      SignalAlreadyPublishedError,
    );
  });
});

// These assert the database triggers directly, bypassing the repository layer.
// The repository is not the guarantee — it is one caller of a guarantee that
// has to hold against psql and against future code that does not exist yet.
describe('immutability enforced by the database', () => {
  // OL001 is the SQLSTATE the immutability triggers raise. Asserting on the
  // code rather than the prose means a reworded message stays a passing test
  // while a write that slips through a trigger entirely still fails.
  const isImmutabilityError = (error: unknown) => {
    expect(String(error)).toContain(IMMUTABILITY_ERRCODE);
    expect(isImmutabilityViolation(error)).toBe(true);
  };

  async function expectRejected(promise: Promise<unknown>): Promise<void> {
    await promise.then(
      () => {
        throw new Error('expected the database to reject this write');
      },
      isImmutabilityError,
    );
  }

  it('refuses to change a signal core field', async () => {
    const signal = await seedSignal();
    await expectRejected(
      db.$executeRawUnsafe(`UPDATE signals SET symbol = 'TSLA' WHERE id = $1::uuid`, signal.id),
    );
    expect((await getSignal(signal.id, db))!.symbol).toBe('AAPL');
  });

  it.each([
    ['quantity', `quantity = 999`],
    ['indicators', `indicators = '{"rsi14": 0}'::jsonb`],
    ['review_snapshot', `review_snapshot = '{}'::jsonb`],
    ['thesis', `thesis = 'rewritten after the fact'`],
    ['execution_mode', `execution_mode = 'live'`],
    ['dedupe_key', `dedupe_key = 'rewritten'`],
    ['ref_id', `ref_id = gen_random_uuid()`],
    ['created_at', `created_at = now()`],
  ])('refuses to change signals.%s', async (_column, assignment) => {
    const signal = await seedSignal();
    await expectRejected(
      db.$executeRawUnsafe(`UPDATE signals SET ${assignment} WHERE id = $1::uuid`, signal.id),
    );
  });

  it('refuses to delete a signal', async () => {
    const signal = await seedSignal();
    await expectRejected(
      db.$executeRawUnsafe(`DELETE FROM signals WHERE id = $1::uuid`, signal.id),
    );
  });

  it('refuses a decision that leaves decided_at null', async () => {
    const signal = await seedSignal();
    await expectRejected(
      db.$executeRawUnsafe(
        `UPDATE signals SET status = 'approved' WHERE id = $1::uuid`,
        signal.id,
      ),
    );
  });

  it('refuses to move a decided signal back to pending', async () => {
    const signal = await seedSignal();
    await transitionSignal(signal.id, 'approved', 'approved', { prisma: db });
    await expectRejected(
      db.$executeRawUnsafe(
        `UPDATE signals SET status = 'pending', decided_at = NULL WHERE id = $1::uuid`,
        signal.id,
      ),
    );
  });

  it('refuses to rewrite a decision reason after the fact', async () => {
    const signal = await seedSignal();
    await transitionSignal(signal.id, 'rejected', 'not convinced', { prisma: db });
    await expectRejected(
      db.$executeRawUnsafe(
        `UPDATE signals SET decide_reason = 'actually it looked great' WHERE id = $1::uuid`,
        signal.id,
      ),
    );
  });

  // Publication is one-way and the pair moves together, or not at all
  // (Phase 4, decision 2). Every illegal direction is pinned individually.
  it('refuses to unpublish a signal', async () => {
    const signal = await seedSignal();
    await publishSignal(signal.id, { prisma: db });
    await expectRejected(
      db.$executeRawUnsafe(
        `UPDATE signals SET published = false WHERE id = $1::uuid`,
        signal.id,
      ),
    );
    await expectRejected(
      db.$executeRawUnsafe(
        `UPDATE signals SET published = false, published_at = NULL WHERE id = $1::uuid`,
        signal.id,
      ),
    );
  });

  it('refuses to re-date a published signal', async () => {
    const signal = await seedSignal();
    await publishSignal(signal.id, { prisma: db });
    await expectRejected(
      db.$executeRawUnsafe(
        `UPDATE signals SET published_at = now() - interval '1 day' WHERE id = $1::uuid`,
        signal.id,
      ),
    );
  });

  it('refuses to publish without a published_at', async () => {
    const signal = await seedSignal();
    await expectRejected(
      db.$executeRawUnsafe(`UPDATE signals SET published = true WHERE id = $1::uuid`, signal.id),
    );
  });

  it('refuses a published_at on a signal that is not published', async () => {
    const signal = await seedSignal();
    await expectRejected(
      db.$executeRawUnsafe(
        `UPDATE signals SET published_at = now() WHERE id = $1::uuid`,
        signal.id,
      ),
    );
    expect((await getSignal(signal.id, db))!.publishedAt).toBeNull();
  });

  it('accepts the one legal publication statement', async () => {
    const signal = await seedSignal();
    await db.$executeRawUnsafe(
      `UPDATE signals SET published = true, published_at = now() WHERE id = $1::uuid`,
      signal.id,
    );
    expect((await getSignal(signal.id, db))!.published).toBe(true);
  });

  it('refuses UPDATE and DELETE on signal_events', async () => {
    const signal = await seedSignal();
    await transitionSignal(signal.id, 'approved', 'approved', { prisma: db });
    await expectRejected(db.$executeRawUnsafe(`UPDATE signal_events SET reason = 'edited'`));
    await expectRejected(db.$executeRawUnsafe(`DELETE FROM signal_events`));
  });

  it('refuses UPDATE and DELETE on executions', async () => {
    const signal = await seedSignal();
    await recordExecution(
      { signalId: signal.id, mode: 'paper', fillPrice: '182.68', quantity: '2' },
      db,
    );
    await expectRejected(db.$executeRawUnsafe(`UPDATE executions SET fill_price = 1`));
    await expectRejected(db.$executeRawUnsafe(`DELETE FROM executions`));
  });

  it('refuses UPDATE and DELETE on track_record', async () => {
    const signal = await seedSignal();
    await appendTrackRecord(
      { signalId: signal.id, entryPrice: '182.68', status: 'open' },
      db,
    );
    await expectRejected(db.$executeRawUnsafe(`UPDATE track_record SET realized_pnl = 100`));
    await expectRejected(db.$executeRawUnsafe(`DELETE FROM track_record`));
  });

  it('keeps corrections as new rows rather than edits', async () => {
    const signal = await seedSignal();
    await appendTrackRecord(
      { signalId: signal.id, entryPrice: '182.68', status: 'open' },
      db,
    );
    await appendTrackRecord(
      {
        signalId: signal.id,
        entryPrice: '182.68',
        exitPrice: '190.00',
        realizedPnl: '14.64',
        status: 'closed',
      },
      db,
    );

    const rows = await db.trackRecord.findMany({ where: { signalId: signal.id } });
    expect(rows).toHaveLength(2);
  });

  it('refuses to delete the app_settings row', async () => {
    await getAppSettings(db);
    await expectRejected(db.$executeRawUnsafe(`DELETE FROM app_settings`));
  });
});

describe('queries the pipeline depends on', () => {
  it('lists only pending signals', async () => {
    const a = await seedSignal();
    const b = await seedSignal();
    await transitionSignal(b.id, 'rejected', 'nope', { prisma: db });

    const pending = await listPendingSignals(db);
    expect(pending.map((s: Signal) => s.id)).toEqual([a.id]);
  });

  it('finds pending signals older than the expiry cutoff', async () => {
    const signal = await seedSignal();
    expect(await listExpiredPendingSignals(new Date(Date.now() - 60_000), db)).toHaveLength(0);
    expect(await listExpiredPendingSignals(new Date(Date.now() + 60_000), db)).toHaveLength(1);
    expect((await listExpiredPendingSignals(new Date(Date.now() + 60_000), db))[0]!.id).toBe(
      signal.id,
    );
  });

  it('reports which dedupe keys are already taken', async () => {
    const taken = uniqueDedupeKey();
    const free = uniqueDedupeKey();
    await seedSignal({ dedupeKey: taken });

    const existing = await findExistingDedupeKeys([taken, free], db);
    expect(existing.has(taken)).toBe(true);
    expect(existing.has(free)).toBe(false);
  });

  it('counts proposals for the daily cap regardless of how they were decided', async () => {
    const a = await seedSignal();
    await seedSignal();
    await transitionSignal(a.id, 'rejected', 'nope', { prisma: db });

    const since = new Date(Date.now() - 60_000);
    expect(await countSignalsSince(since, db)).toBe(2);
  });
});

describe('app settings', () => {
  it('defaults to paper mode with the kill switch off', async () => {
    const settings = await getAppSettings(db);
    expect(settings.killSwitch).toBe(false);
    expect(settings.executionMode).toBe('paper');
  });

  it('persists a kill switch flip', async () => {
    await setKillSwitch(true, db);
    expect((await getAppSettings(db)).killSwitch).toBe(true);
    await setKillSwitch(false, db);
    expect((await getAppSettings(db)).killSwitch).toBe(false);
  });

  it('persists an execution mode change', async () => {
    await setExecutionMode('live', db);
    expect((await getAppSettings(db)).executionMode).toBe('live');
  });
});
