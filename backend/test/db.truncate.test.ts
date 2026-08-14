import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestPrisma, resetDatabase, testPrisma } from './helpers/db.js';

const db = testPrisma();

/**
 * The record is meant to be un-editable, and until this trigger existed that
 * claim had a hole big enough to drive the whole table through: the Phase 0
 * immutability triggers are row-level and fire on UPDATE and DELETE, but
 * TRUNCATE is a statement-level operation that bypasses them completely.
 *
 * "Cannot be edited but can be erased in one statement" is a materially weaker
 * promise than the docs make, and PRD §9 puts the record's credibility at the
 * centre of the product. A subscriber who understood the distinction would be
 * right to discount it.
 */
beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestPrisma();
});

describe('TRUNCATE is refused on the record tables', () => {
  it.each(['signals', 'executions', 'signal_events', 'track_record'])(
    'refuses TRUNCATE on %s',
    async (table) => {
      await expect(db.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`)).rejects.toThrow();
    },
  );

  it('refuses a truncate that names several tables at once', async () => {
    // The multi-table form is the one a clean-slate script actually reaches
    // for, so it is the form most worth pinning.
    await expect(
      db.$executeRawUnsafe(
        'TRUNCATE TABLE "track_record", "executions", "signal_events", "signals" RESTART IDENTITY CASCADE',
      ),
    ).rejects.toThrow();
  });

  it('leaves the rows in place after a refused truncate', async () => {
    await db.appSettings.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, killSwitch: false, executionMode: 'paper' },
    });

    await expect(db.$executeRawUnsafe('TRUNCATE TABLE "signals" CASCADE')).rejects.toThrow();

    // A trigger that raised but let the statement through would be worse than
    // no trigger, because it would read as protection while providing none.
    expect(await db.appSettings.count()).toBe(1);
  });
});
