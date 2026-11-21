import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config/index.js';
import { listExecutions } from '../src/db/executions.js';
import { setAutonomy, setExecutionMode, setKillSwitch } from '../src/db/settings.js';
import { getSignal, listSignalEvents, transitionSignal } from '../src/db/signals.js';
import { listOpenLots } from '../src/db/trackRecord.js';
import { AUTO_APPROVE_REASON, sweepAutonomy } from '../src/orchestrator/autonomy.js';
import { runPipeline, sweepExpiredSignals } from '../src/orchestrator/pipeline.js';
import { MockBrokerAdapter } from '../src/orchestrator/robinhood/mockClient.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';
import {
  pipelineConfig,
  quote,
  seedOpenLot,
  seedSignal,
  THROUGH_BULLISH_CROSS,
  validSnapshot,
} from './helpers/factories.js';

/**
 * Phase 5, milestone 5.4: autonomy within caps, in paper. The pipeline stamps
 * the veto window, the sweep approves after it, the owner's veto inside it
 * wins, and the kill switch and either half of the gate stop it.
 */

const db = testPrisma();
const logger = pino({ level: 'silent' });

const now = new Date('2026-07-02T13:35:00Z');
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

function config(overrides: Record<string, string> = {}): Config {
  return pipelineConfig({
    MAX_HOLDING_DAYS: '0',
    AUTONOMY_ENABLED: 'true',
    AUTONOMY_VETO_MINUTES: '5',
    ...overrides,
  });
}

function deps(cfg = config(), clock = () => now) {
  return {
    broker: new MockBrokerAdapter({
      candles: { AAPL: THROUGH_BULLISH_CROSS },
      quotes: { AAPL: quote('AAPL', '308.630000') },
    }),
    config: cfg,
    logger,
    prisma: db,
    clock,
    generateThesis: async () => ({ text: 'auto', source: 'fallback_template' as const }),
  };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestPrisma();
});

describe('stamping the veto window', () => {
  it('sets auto_decide_at only when both halves of the gate are on', async () => {
    await setAutonomy(true, db);
    const on = await runPipeline(deps());
    expect(on.signals).toHaveLength(1);
    expect(on.signals[0]!.autoDecideAt).toEqual(later(5));

    await resetDatabase();
    await setAutonomy(true, db);
    const envOff = await runPipeline(deps(config({ AUTONOMY_ENABLED: 'false' })));
    expect(envOff.signals[0]!.autoDecideAt).toBeNull();

    await resetDatabase(); // resets app_settings.autonomy to its default, off
    const dbOff = await runPipeline(deps());
    expect(dbOff.signals[0]!.autoDecideAt).toBeNull();
  });

  it('is frozen by the trigger once stamped', async () => {
    await setAutonomy(true, db);
    const { signals } = await runPipeline(deps());
    const id = signals[0]!.id;

    await expect(
      db.$executeRawUnsafe(
        `UPDATE signals SET auto_decide_at = now() + interval '1 day' WHERE id = $1::uuid`,
        id,
      ),
    ).rejects.toThrow(/OL001/);
    await expect(
      db.$executeRawUnsafe(`UPDATE signals SET auto_decide_at = NULL WHERE id = $1::uuid`, id),
    ).rejects.toThrow(/OL001/);
  });
});

describe('the autonomy sweep', () => {
  it('approves, fills, and publishes a signal once its window has closed', async () => {
    await setAutonomy(true, db);
    const { signals } = await runPipeline(deps());
    const signal = signals[0]!;

    const early = await sweepAutonomy({ ...deps(), clock: () => later(4) });
    expect(early).toMatchObject({ status: 'completed', approved: [], skipped: 0 });
    expect((await getSignal(signal.id, db))?.status).toBe('pending');

    const due = await sweepAutonomy({ ...deps(), clock: () => later(5) });
    expect(due.approved.map((s) => s.id)).toEqual([signal.id]);

    const after = await getSignal(signal.id, db);
    expect(after?.status).toBe('approved');
    expect(after?.decideReason).toBe(AUTO_APPROVE_REASON);
    expect(after?.published).toBe(true);
    expect(await listExecutions(signal.id, db)).toHaveLength(1);
    expect((await listSignalEvents(signal.id, db))[0]?.reason).toBe(AUTO_APPROVE_REASON);
  });

  it('is fully autonomous at a zero-minute window', async () => {
    await setAutonomy(true, db);
    const cfg = config({ AUTONOMY_VETO_MINUTES: '0' });
    const { signals } = await runPipeline(deps(cfg));

    const result = await sweepAutonomy({ ...deps(cfg), clock: () => now });

    expect(result.approved.map((s) => s.id)).toEqual([signals[0]!.id]);
  });

  it("lets the owner's veto inside the window win", async () => {
    await setAutonomy(true, db);
    const { signals } = await runPipeline(deps());
    await transitionSignal(signals[0]!.id, 'rejected', 'owner vetoed', { prisma: db, now: later(2) });

    const result = await sweepAutonomy({ ...deps(), clock: () => later(10) });

    expect(result.approved).toEqual([]);
    expect((await getSignal(signals[0]!.id, db))?.status).toBe('rejected');
    expect(await listExecutions(signals[0]!.id, db)).toHaveLength(0);
  });

  it('halts on the kill switch, and the expiry sweep then expires the signal', async () => {
    await setAutonomy(true, db);
    const { signals } = await runPipeline(deps());
    await setKillSwitch(true, db);

    const halted = await sweepAutonomy({ ...deps(), clock: () => later(10) });
    expect(halted.status).toBe('halted_kill_switch');
    expect((await getSignal(signals[0]!.id, db))?.status).toBe('pending');

    // created_at is stamped by the database at insert, not by the pipeline's
    // clock, so expiry is measured from the real now.
    const expired = await sweepExpiredSignals({
      config: config(),
      logger,
      prisma: db,
      clock: () => new Date(Date.now() + 20 * 60_000),
    });
    expect(expired.map((s) => s.id)).toEqual([signals[0]!.id]);
  });

  it.each([
    ['the env half off', { AUTONOMY_ENABLED: 'false' }, true],
    ['the db half off', {}, false],
  ] as const)('does nothing with %s, even for a stamped signal', async (_label, env, dbHalf) => {
    await setAutonomy(true, db);
    const { signals } = await runPipeline(deps());
    await setAutonomy(dbHalf, db);

    const result = await sweepAutonomy({ ...deps(config(env)), clock: () => later(10) });

    expect(result.status).toBe('autonomy_off');
    expect((await getSignal(signals[0]!.id, db))?.status).toBe('pending');
  });

  it('never touches a signal created without a window', async () => {
    const { signals } = await runPipeline(deps());
    expect(signals[0]!.autoDecideAt).toBeNull();
    await setAutonomy(true, db);

    const result = await sweepAutonomy({ ...deps(), clock: () => later(60) });

    expect(result.approved).toEqual([]);
    expect((await getSignal(signals[0]!.id, db))?.status).toBe('pending');
  });
});

describe('an auto-decidable exit whose oldest lot is bigger than it', () => {
  it('is skipped and left pending, not approved into a fill that closes nothing', async () => {
    await setAutonomy(true, db);
    const snap = (side: 'buy' | 'sell', quantity: string) =>
      validSnapshot({
        estimated_price: '300.00',
        requested: { symbol: 'AAPL', side, quantity, type: 'market' },
        captured_at: '2026-07-02T13:35:00.000Z',
      });
    const entry = await seedOpenLot({
      quantity: '3',
      entryPrice: '300.00',
      recordedAt: later(-60),
      reviewSnapshot: snap('buy', '3'),
      dedupePrefix: 'entry',
    });
    const exit = await seedSignal({
      side: 'sell',
      reviewSnapshot: snap('sell', '2'),
      dedupeKey: uniqueDedupeKey('exit'),
      autoDecideAt: later(5),
    });

    const result = await sweepAutonomy({ ...deps(), clock: () => later(6) });

    // "Some lot is open" is not enough: the executor closes whole lots only,
    // and a 3-share lot does not fit a 2-share exit.
    expect(result).toMatchObject({ status: 'completed', approved: [], skipped: 1 });
    expect((await getSignal(exit.id, db))?.status).toBe('pending');
    expect(await listExecutions(exit.id, db)).toHaveLength(0);
    expect((await listOpenLots(db)).map((l) => l.signalId)).toEqual([entry.id]);
  });
});

/**
 * Autonomy is the one path to a live order without `confirm_live` (Phase 5,
 * decision 6; README non-negotiable 4). These pin both halves of that: the
 * sweep does place a live order once every other gate is open, and it places
 * nothing while LIVE_TRADING_ENABLED is off.
 */
describe('autonomy with a live signal', () => {
  async function seedLiveDue() {
    return seedSignal({
      thesis: 'live autonomy',
      thesisSource: 'fallback_template',
      reviewSnapshot: validSnapshot({
        estimated_price: '308.63',
        captured_at: '2026-07-02T13:35:00.000Z',
      }),
      executionMode: 'live',
      dedupeKey: uniqueDedupeKey('live-auto'),
      autoDecideAt: later(5),
    });
  }

  it('places the live order with no confirm_live once every gate is open', async () => {
    await setAutonomy(true, db);
    await setExecutionMode('live', db);
    const signal = await seedLiveDue();
    const broker = new MockBrokerAdapter({ orderScripts: { AAPL: { states: [{ state: 'confirmed' }] } } });

    const result = await sweepAutonomy({
      ...deps(config({ LIVE_TRADING_ENABLED: 'true' })),
      broker,
      clock: () => later(6),
    });

    expect(result.approved.map((s) => s.id)).toEqual([signal.id]);
    expect(broker.callsTo('placeEquityOrder')).toHaveLength(1);
  });

  it.each([
    ['LIVE_TRADING_ENABLED is off', 'false', 'live'],
    ['the runtime mode is paper', 'true', 'paper'],
  ] as const)('places nothing and leaves the signal pending while %s', async (_label, env, mode) => {
    await setAutonomy(true, db);
    await setExecutionMode(mode, db);
    const signal = await seedLiveDue();
    const broker = new MockBrokerAdapter({ orderScripts: { AAPL: { states: [{ state: 'confirmed' }] } } });

    const result = await sweepAutonomy({
      ...deps(config({ LIVE_TRADING_ENABLED: env })),
      broker,
      clock: () => later(6),
    });

    expect(result).toMatchObject({ approved: [], skipped: 1 });
    expect(broker.callsTo('placeEquityOrder')).toHaveLength(0);
    expect((await getSignal(signal.id, db))?.status).toBe('pending');
  });
});
