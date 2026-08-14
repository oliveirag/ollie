import type { Logger } from 'pino';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildConfig, type Config } from '../src/config/index.js';
import { getSignal, transitionSignal } from '../src/db/signals.js';
import {
  listAllTrackRecordRows,
  listOpenLots,
  listTrackRecord,
} from '../src/db/trackRecord.js';
import { PaperExecutor } from '../src/orchestrator/executor.js';
import { runMarkToMarket } from '../src/orchestrator/marks.js';
import { runPipeline } from '../src/orchestrator/pipeline.js';
import { MockBrokerAdapter } from '../src/orchestrator/robinhood/mockClient.js';
import type { Candle, Quote } from '../src/orchestrator/robinhood/client.js';
import { computeTrackRecord } from '../src/orchestrator/trackRecordStats.js';
import { closeTestPrisma, resetDatabase, testPrisma } from './helpers/db.js';
import fixture from './fixtures/ohlcv/AAPL-daily-2026.json' with { type: 'json' };

/**
 * One trade, start to finish, through every seam Phase 3 added.
 *
 * Each piece has its own unit tests. This exists because the pipeline is about
 * to start writing rows that can never be deleted or corrected, and a bug that
 * only appears when the parts are wired together would be discovered *in the
 * permanent record*. Cheaper to find here.
 */
const db = testPrisma();
const logger: Logger = pino({ level: 'silent' });

const ALL_BARS: Candle[] = fixture.results[0]!.bars.map((bar) => ({
  t: bar.begins_at,
  o: bar.open_price,
  h: bar.high_price,
  l: bar.low_price,
  c: bar.close_price,
  v: bar.volume,
}));

const through = (iso: string) =>
  ALL_BARS.slice(0, ALL_BARS.findIndex((b) => b.t.startsWith(iso)) + 1);

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
    LOG_LEVEL: 'silent',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

const stubThesis = async () => ({
  text: 'Stubbed.',
  source: 'fallback_template' as const,
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestPrisma();
});

describe('a trade from proposal to published statistics', () => {
  it('opens, marks, exits on the crossing, closes, and reports', async () => {
    const cfg = config();
    const executor = (at: string) =>
      new PaperExecutor({ config: cfg, logger, prisma: db, now: () => new Date(at) });

    // --- Entry: the bullish MACD cross on 2026-07-02 ------------------------
    const entryRun = await runPipeline({
      broker: new MockBrokerAdapter({
        candles: { AAPL: through('2026-07-02') },
        quotes: { AAPL: quote('308.630000') },
      }),
      config: cfg,
      logger,
      prisma: db,
      clock: () => new Date('2026-07-02T13:35:00Z'),
      generateThesis: stubThesis,
    });

    expect(entryRun.signals).toHaveLength(1);
    const entry = entryRun.signals[0]!;
    expect(entry.side).toBe('buy');
    expect(entry.quantity.toString()).toBe('3');

    await transitionSignal(entry.id, 'approved', 'owner approved', { prisma: db });
    await executor('2026-07-02T13:36:00Z').execute((await getSignal(entry.id, db))!);

    // Buy slippage is against the trader: 308.63 x 1.001.
    const opened = (await listTrackRecord(entry.id, db)).at(-1)!;
    expect(opened.status).toBe('open');
    expect(opened.entryPrice.toString()).toBe('308.93863');

    // --- A day's mark -------------------------------------------------------
    await runMarkToMarket({
      broker: new MockBrokerAdapter({ quotes: { AAPL: quote('320.000000') } }),
      config: cfg,
      logger,
      prisma: db,
      now: () => new Date('2026-07-03T20:15:00Z'),
    });

    const marked = (await listTrackRecord(entry.id, db)).at(-1)!;
    expect(marked.markPrice?.toString()).toBe('320');
    // (320 - 308.93863) x 3, to six places.
    expect(marked.unrealizedPnl?.toString()).toBe('33.18411');

    // --- Exit: the bearish MACD cross on 2026-07-31 -------------------------
    const exitRun = await runPipeline({
      broker: new MockBrokerAdapter({
        candles: { AAPL: through('2026-07-31') },
        quotes: { AAPL: quote('330.000000') },
      }),
      config: cfg,
      logger,
      prisma: db,
      clock: () => new Date('2026-07-31T13:35:00Z'),
      generateThesis: stubThesis,
    });

    const exit = exitRun.signals.find((s) => s.side === 'sell');
    expect(exit).toBeDefined();
    // Sized to the position, not the notional — three shares held, three sold.
    expect(exit!.quantity.toString()).toBe('3');

    await transitionSignal(exit!.id, 'approved', 'owner approved', { prisma: db });
    await executor('2026-07-31T13:36:00Z').execute((await getSignal(exit!.id, db))!);

    // --- The lot is closed and attributed -----------------------------------
    const closed = (await listTrackRecord(entry.id, db)).at(-1)!;
    expect(closed.status).toBe('closed');
    expect(closed.closedBySignalId).toBe(exit!.id);
    // Sell slippage is also against the trader: 330 x 0.999 = 329.67.
    expect(closed.exitPrice?.toString()).toBe('329.67');
    // (329.67 - 308.93863) x 3.
    expect(closed.realizedPnl?.toString()).toBe('62.19411');
    expect(await listOpenLots(db)).toHaveLength(0);

    // --- The published numbers ----------------------------------------------
    const stats = computeTrackRecord(await listAllTrackRecordRows(db));
    expect(stats.closedTrades).toBe(1);
    expect(stats.openPositions).toBe(0);
    expect(stats.wins).toBe(1);
    expect(stats.winRate).toBe(1);
    expect(stats.totalRealizedPnl).toBeCloseTo(62.19411, 5);
    // 62.19411 / (308.93863 x 3) = 6.71%.
    expect(stats.averageReturn).toBeCloseTo(0.0671, 4);
  });

  it('exits on the time stop when no crossing obliges', async () => {
    // The reason the time stop exists: a position that never gets a bearish
    // cross would otherwise stay open forever and never enter the record as a
    // closed trade, leaving a sustained run with nothing to publish.
    const cfg = config({ MAX_HOLDING_DAYS: '5' });
    const executor = (at: string) =>
      new PaperExecutor({ config: cfg, logger, prisma: db, now: () => new Date(at) });

    const entryRun = await runPipeline({
      broker: new MockBrokerAdapter({
        candles: { AAPL: through('2026-07-02') },
        quotes: { AAPL: quote('308.630000') },
      }),
      config: cfg,
      logger,
      prisma: db,
      clock: () => new Date('2026-07-02T13:35:00Z'),
      generateThesis: stubThesis,
    });
    const entry = entryRun.signals[0]!;
    await transitionSignal(entry.id, 'approved', 'ok', { prisma: db });
    await executor('2026-07-02T13:36:00Z').execute((await getSignal(entry.id, db))!);

    // Five bars on, at a bar where no crossing fires — verified against the
    // fixture, so the time stop is the only thing that can propose this exit.
    const exitRun = await runPipeline({
      broker: new MockBrokerAdapter({
        candles: { AAPL: through('2026-07-10') },
        quotes: { AAPL: quote('315.000000') },
      }),
      config: cfg,
      logger,
      prisma: db,
      clock: () => new Date('2026-07-10T13:35:00Z'),
      generateThesis: stubThesis,
    });

    const exit = exitRun.signals.find((s) => s.side === 'sell');
    expect(exit).toBeDefined();
    // Labelled honestly: it read the holding period, not an indicator.
    expect(exit!.signalType).toBe('time_stop');
    expect(exit!.quantity.toString()).toBe('3');

    await transitionSignal(exit!.id, 'approved', 'ok', { prisma: db });
    await executor('2026-07-10T13:36:00Z').execute((await getSignal(exit!.id, db))!);

    expect(await listOpenLots(db)).toHaveLength(0);
    expect(computeTrackRecord(await listAllTrackRecordRows(db)).closedTrades).toBe(1);
  });
});
