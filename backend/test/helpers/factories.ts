import type { PrismaClient, Signal } from '@prisma/client';
import { buildConfig, type Config } from '../../src/config/index.js';
import { insertSignal, type InsertSignalInput } from '../../src/db/signals.js';
import { appendTrackRecord } from '../../src/db/trackRecord.js';
import type { Candle, Quote } from '../../src/orchestrator/robinhood/client.js';
import fixture from '../fixtures/ohlcv/AAPL-daily-2026.json' with { type: 'json' };
import { testPrisma, uniqueDedupeKey } from './db.js';

/**
 * Shared test fixtures. Each test file used to carry its own copy of these,
 * and the copies drifted. Defaults here are the plainest values that pass the
 * code under test; a file that needs something specific passes overrides, so
 * what a test depends on stays visible in the test.
 */

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** The thesis text most tests use when a thesis matters at all. */
export const RSI_THESIS = 'RSI(14) crossed below 30.';

/**
 * A review snapshot `ReviewSnapshotSchema` accepts, so the executor can fill
 * from it. Overrides replace top-level keys.
 */
export function validSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    estimated_price: '182.50',
    alerts: [] as unknown[],
    requested: { symbol: 'AAPL', side: 'buy', quantity: '2', type: 'market' },
    captured_at: '2026-08-08T12:00:00.000Z',
    raw: {} as unknown,
    ...overrides,
  };
}

/**
 * A complete `insertSignal` input: a 2-share AAPL paper buy with no thesis,
 * no indicators, a bare `{ estimated_price }` snapshot and a fresh dedupe key.
 */
export function signalInput(overrides: Partial<InsertSignalInput> = {}): InsertSignalInput {
  return {
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
    ...overrides,
  };
}

export async function seedSignal(
  overrides: Partial<InsertSignalInput> = {},
  prisma: PrismaClient = testPrisma(),
): Promise<Signal> {
  return insertSignal(signalInput(overrides), prisma);
}

export interface OpenLotOptions {
  symbol?: string;
  side?: InsertSignalInput['side'];
  quantity?: string;
  entryPrice?: string;
  /** The lot's first row time; omitted, the row defaults to now. */
  recordedAt?: Date;
  /** Defaults to `{ estimated_price: entryPrice }`. */
  reviewSnapshot?: unknown;
  executionMode?: InsertSignalInput['executionMode'];
  dedupePrefix?: string;
}

/** A signal plus its opening track-record row: an open position. */
export async function seedOpenLot(
  options: OpenLotOptions = {},
  prisma: PrismaClient = testPrisma(),
): Promise<Signal> {
  const entryPrice = options.entryPrice ?? '100.00';
  const signal = await seedSignal(
    {
      symbol: options.symbol ?? 'AAPL',
      side: options.side ?? 'buy',
      quantity: options.quantity ?? '2',
      reviewSnapshot: options.reviewSnapshot ?? { estimated_price: entryPrice },
      executionMode: options.executionMode ?? 'paper',
      dedupeKey: uniqueDedupeKey(options.dedupePrefix),
    },
    prisma,
  );
  await appendTrackRecord(
    {
      signalId: signal.id,
      entryPrice,
      status: 'open',
      ...(options.recordedAt ? { recordedAt: options.recordedAt } : {}),
    },
    prisma,
  );
  return signal;
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

/** A quote whose every price is `price`, trading normally. */
export function quote(symbol: string, price: string): Quote {
  return {
    symbol,
    lastTradePrice: price,
    bidPrice: price,
    askPrice: price,
    previousClose: price,
    officialClose: price,
    hasTraded: true,
    state: 'active',
  };
}

/** The real AAPL daily bars in `fixtures/ohlcv/AAPL-daily-2026.json`, as candles. */
export const AAPL_BARS: Candle[] = fixture.results[0]!.bars.map((bar) => ({
  t: bar.begins_at,
  o: bar.open_price,
  h: bar.high_price,
  l: bar.low_price,
  c: bar.close_price,
  v: bar.volume,
}));

/** AAPL bars up to and including the bar dated `isoDate` (YYYY-MM-DD). */
export function barsThrough(isoDate: string): Candle[] {
  return AAPL_BARS.slice(0, AAPL_BARS.findIndex((b) => b.t.startsWith(isoDate)) + 1);
}

/** Through 2026-07-02, the bar where MACD crosses bullish on real data. */
export const THROUGH_BULLISH_CROSS = barsThrough('2026-07-02');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Config built from an explicit environment, not `process.env`, so nothing in
 * a developer's `.env` leaks in. AAPL only, silent logging.
 */
export function envConfig(overrides: Record<string, string> = {}): Config {
  return buildConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    SYMBOL_ALLOWLIST: 'AAPL',
    LOG_LEVEL: 'silent',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

/**
 * The caps the pipeline tests run under: $1,000 a trade, $2,000 a symbol, three
 * trades a day, 10 bps slippage, a fixed 15-minute expiry.
 */
export function pipelineConfig(overrides: Record<string, string> = {}): Config {
  return envConfig({
    ORDER_NOTIONAL_CENTS: '100000',
    MAX_POSITION_CENTS: '200000',
    MAX_DAILY_TRADES: '3',
    MAX_TOTAL_EXPOSURE_CENTS: '500000',
    SLIPPAGE_BPS: '10',
    SIGNAL_EXPIRY_MINUTES: '15',
    // created_at is stamped by the database with the real time, so a window
    // that runs to the close would make these depend on when the suite runs.
    SIGNAL_EXPIRES_AT_CLOSE: 'false',
    ...overrides,
  });
}
