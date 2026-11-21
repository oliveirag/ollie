import { describe, expect, it } from 'vitest';
import {
  bootstrapMeanDifference,
  runVariant,
  supportedWindows,
  windowStats,
} from '../src/backtest/compare.js';
import type { BacktestResult } from '../src/backtest/simulate.js';
import type { Candle } from '../src/orchestrator/robinhood/client.js';
import fixture from './fixtures/ohlcv/AAPL-daily-2026.json' with { type: 'json' };

const BARS: Candle[] = fixture.results[0]!.bars.map((bar) => ({
  t: bar.begins_at,
  o: bar.open_price,
  h: bar.high_price,
  l: bar.low_price,
  c: bar.close_price,
  v: bar.volume,
}));

const INPUTS = {
  bars: { AAPL: BARS },
  strategy: {
    rsiPeriod: 14,
    rsiOversold: 30,
    rsiOverbought: 70,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    orderNotionalCents: 100_000,
    maxHoldingDays: 30,
  },
  risk: { symbolAllowlist: ['AAPL'], maxPositionCents: 200_000, maxDailyTrades: 5, maxTotalExposureCents: 500_000 },
  slippageBps: 10,
};

const ALL = { label: 'all', from: '2000-01-01', to: '2100-01-01' };

describe('bootstrapMeanDifference', () => {
  it('is reproducible and brackets a clear difference', () => {
    const a = [5, 6, 7, 5, 6, 7, 5, 6];
    const b = [0, 1, -1, 0, 1, -1, 0, 1];

    const first = bootstrapMeanDifference(a, b);
    expect(first).toEqual(bootstrapMeanDifference(a, b));
    expect(first![0]).toBeGreaterThan(0);
    expect(first![1]).toBeGreaterThan(first![0]);
  });

  it('spans zero when the two sides are the same', () => {
    const xs = [3, -2, 4, -1, 2, -3, 1, 0];
    const [lo, hi] = bootstrapMeanDifference(xs, xs)!;
    expect(lo).toBeLessThan(0);
    expect(hi).toBeGreaterThan(0);
  });

  it('has no answer without trades on both sides', () => {
    expect(bootstrapMeanDifference([], [1])).toBeNull();
  });
});

describe('windowStats', () => {
  it('summarises a variant run through the production simulator', () => {
    const stats = windowStats(runVariant(INPUTS, { name: 'production' }, ALL), ALL);

    // The one pinned trade in this fixture: +71.94 on the overbought exit.
    expect(stats.trades).toBe(1);
    expect(stats.totalPnl).toBeCloseTo(71.94, 2);
    expect(stats.winRate).toBe(1);
    expect(stats.profitFactor).toBeNull();
  });

  it('measures drawdown from the equity curve inside the window', () => {
    const result = {
      trades: [],
      days: ['10', '25', '5', '30', '20'].map((equity, i) => ({
        barTime: `2026-01-0${i + 1}T00:00:00Z`,
        openLots: 1,
        evaluable: true,
        equity,
      })),
    } as unknown as BacktestResult;

    expect(windowStats(result, ALL).maxDrawdown).toBe(20);
  });

  it('applies a variant override without touching the inputs', () => {
    const shorter = runVariant(INPUTS, { name: 'three-bar hold', strategy: { maxHoldingDays: 3 } }, ALL);
    expect(shorter.trades[0]!.exitRule).toBe('max_holding_period');
    expect(INPUTS.strategy.maxHoldingDays).toBe(30);
  });
});

describe('supportedWindows', () => {
  it('drops windows the bars cannot reach and trims the one they start inside', () => {
    const windows = supportedWindows({ AAPL: BARS });
    const first = BARS[35]!.t.slice(0, 10);

    expect(windows.map((w) => w.label)).toEqual([`out-of-sample 2023+ (from ${first})`]);
    expect(windows[0]!.from).toBe(first);
  });
});
