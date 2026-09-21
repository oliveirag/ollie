import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildConfig, type Config } from '../src/config/index.js';
import { listExecutions } from '../src/db/executions.js';
import { setAutonomy, setKillSwitch } from '../src/db/settings.js';
import { getSignal, listSignalEvents, transitionSignal } from '../src/db/signals.js';
import { AUTO_APPROVE_REASON, sweepAutonomy } from '../src/orchestrator/autonomy.js';
import { runPipeline, sweepExpiredSignals } from '../src/orchestrator/pipeline.js';
import type { Candle, Quote } from '../src/orchestrator/robinhood/client.js';
import { MockBrokerAdapter } from '../src/orchestrator/robinhood/mockClient.js';
import { closeTestPrisma, resetDatabase, testPrisma } from './helpers/db.js';
import fixture from './fixtures/ohlcv/AAPL-daily-2026.json' with { type: 'json' };

/**
 * Phase 5, milestone 5.4: autonomy within caps, in paper. The pipeline stamps
 * the veto window, the sweep approves after it, the owner's veto inside it
 * wins, and the kill switch and either half of the gate stop it.
 */

const db = testPrisma();
const logger = pino({ level: 'silent' });

const ALL_BARS: Candle[] = fixture.results[0]!.bars.map((bar) => ({
  t: bar.begins_at,
  o: bar.open_price,
  h: bar.high_price,
  l: bar.low_price,
  c: bar.close_price,
  v: bar.volume,
}));

/** Through 2026-07-02, the bar where MACD crosses bullish on real data. */
const THROUGH_BULLISH_CROSS = ALL_BARS.slice(
  0,
  ALL_BARS.findIndex((b) => b.t.startsWith('2026-07-02')) + 1,
);

const now = new Date('2026-07-02T13:35:00Z');
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

function config(overrides: Record<string, string> = {}): Config {
  return buildConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    SYMBOL_ALLOWLIST: 'AAPL',
    ORDER_NOTIONAL_CENTS: '100000',
    MAX_POSITION_CENTS: '200000',
    MAX_DAILY_TRADES: '3',
    MAX_TOTAL_EXPOSURE_CENTS: '500000',
    SLIPPAGE_BPS: '10',
    SIGNAL_EXPIRY_MINUTES: '15',
    MAX_HOLDING_DAYS: '0',
    LOG_LEVEL: 'silent',
    AUTONOMY_ENABLED: 'true',
    AUTONOMY_VETO_MINUTES: '5',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

function quote(price: string): Quote {
  return {
    symbol: 'AAPL',
    lastTradePrice: price,
    bidPrice: price,
    askPrice: price,
    previousClose: price,
    officialClose: price,
    hasTraded: true,
    state: 'active',
  };
}

function deps(cfg = config(), clock = () => now) {
  return {
    broker: new MockBrokerAdapter({
      candles: { AAPL: THROUGH_BULLISH_CROSS },
      quotes: { AAPL: quote('308.630000') },
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
