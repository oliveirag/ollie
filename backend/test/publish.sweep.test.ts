import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recordExecution } from '../src/db/executions.js';
import { setKillSwitch } from '../src/db/settings.js';
import {
  getSignal,
  insertSignal,
  listFilledUnpublishedSignals,
  publishSignal,
  transitionSignal,
} from '../src/db/signals.js';
import { sweepUnpublishedSignals } from '../src/orchestrator/publish.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';

const db = testPrisma();
const logger = pino({ level: 'silent' });

async function seedSignal() {
  return insertSignal(
    {
      symbol: 'AAPL',
      side: 'buy',
      signalType: 'technical',
      quantity: '2',
      thesis: null,
      thesisSource: 'llm',
      indicators: {},
      reviewSnapshot: { estimated_price: '100.00' },
      executionMode: 'paper',
      dedupeKey: uniqueDedupeKey(),
    },
    db,
  );
}

/** The crash-window state: approved, filled, never published. */
async function seedFilledUnpublished() {
  const signal = await seedSignal();
  await transitionSignal(signal.id, 'approved', 'approved', { prisma: db });
  await recordExecution(
    { signalId: signal.id, mode: 'paper', fillPrice: '100.10', quantity: '2' },
    db,
  );
  return signal;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestPrisma();
});

describe('sweepUnpublishedSignals', () => {
  it('publishes a signal seeded approved-with-execution-but-unpublished in one firing', async () => {
    const signal = await seedFilledUnpublished();
    const now = new Date('2026-09-15T14:00:00.000Z');

    const published = await sweepUnpublishedSignals({ logger, prisma: db, clock: () => now });

    expect(published.map((s) => s.id)).toEqual([signal.id]);
    const after = await getSignal(signal.id, db);
    expect(after!.published).toBe(true);
    expect(after!.publishedAt).toEqual(now);
  });

  it('finds nothing to do on a second firing', async () => {
    await seedFilledUnpublished();
    await sweepUnpublishedSignals({ logger, prisma: db });

    expect(await sweepUnpublishedSignals({ logger, prisma: db })).toEqual([]);
  });

  it('never publishes an approved signal that has no fill', async () => {
    // Approved-but-unfilled is the execution_failed state. Publishing it would
    // show subscribers a signal the owner's book never held — the exact
    // ordering decision 1 exists to make impossible.
    const signal = await seedSignal();
    await transitionSignal(signal.id, 'approved', 'approved', { prisma: db });

    expect(await listFilledUnpublishedSignals(db)).toEqual([]);
    expect(await sweepUnpublishedSignals({ logger, prisma: db })).toEqual([]);
    expect((await getSignal(signal.id, db))!.published).toBe(false);
  });

  it.each(['rejected', 'expired'] as const)('never publishes a %s signal', async (status) => {
    const signal = await seedSignal();
    await transitionSignal(signal.id, status, status, { prisma: db });

    expect(await sweepUnpublishedSignals({ logger, prisma: db })).toEqual([]);
    expect((await getSignal(signal.id, db))!.published).toBe(false);
  });

  it('leaves an already-published signal alone', async () => {
    const signal = await seedFilledUnpublished();
    const first = await publishSignal(signal.id, { prisma: db });

    expect(await sweepUnpublishedSignals({ logger, prisma: db })).toEqual([]);
    expect((await getSignal(signal.id, db))!.publishedAt).toEqual(first.publishedAt);
  });

  it('runs with the kill switch on', async () => {
    // Publication discloses a fill that already happened; halting it would
    // make the feed less complete than the owner's book. See publish.ts.
    const signal = await seedFilledUnpublished();
    await setKillSwitch(true, db);

    const published = await sweepUnpublishedSignals({ logger, prisma: db });

    expect(published.map((s) => s.id)).toEqual([signal.id]);
  });

  it('publishes a backlog in fill order', async () => {
    const first = await seedFilledUnpublished();
    const second = await seedFilledUnpublished();

    const published = await sweepUnpublishedSignals({ logger, prisma: db });

    expect(published.map((s) => s.id)).toEqual([first.id, second.id]);
  });
});
