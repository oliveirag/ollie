import { describe, expect, it } from 'vitest';
import { simulate } from '../src/backtest/simulate.js';
import { summarize } from '../src/backtest/summarize.js';
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

const result = simulate({
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
  risk: {
    symbolAllowlist: ['AAPL'],
    maxPositionCents: 200_000,
    maxDailyTrades: 5,
    maxTotalExposureCents: 500_000,
  },
  slippageBps: 10,
});

describe('summarizing a run', () => {
  it('measures coverage against the bars the strategy could act on, not all of them', () => {
    // 64 bars, but MACD needs 35 before a rule can fire, so only 30 are
    // evaluable. Counting the warmup as uncovered would understate coverage.
    const summary = summarize(result);

    expect(summary.evaluableDays).toBe(30);
    expect(summary.coveredDays).toBe(9);
    expect(summary.coverageFraction).toBeCloseTo(0.3, 5);
  });

  it('reports the longest unbroken run of covered days', () => {
    // This is the milestone 3.8 number: a curve point exists only on a day a
    // lot was open, so consecutive covered days are consecutive curve points.
    expect(summarize(result).longestCoveredStreak).toBe(9);
  });

  it('reports the median holding period in bars', () => {
    expect(summarize(result).medianHoldingBars).toBe(9);
  });

  it('scales entries to a 21-day trading month', () => {
    // One entry across 30 evaluable days is 0.7 per 21-day month.
    expect(summarize(result).entriesPerMonth).toBeCloseTo(0.7, 5);
  });

  it('carries the closed-trade stats the published record would show', () => {
    const summary = summarize(result);

    expect(summary.closedTrades).toBe(1);
    expect(summary.wins).toBe(1);
    expect(summary.winRate).toBe(1);
    expect(summary.totalRealizedPnl).toBe('71.94');
  });

  it('reports no win rate rather than zero when nothing has closed', () => {
    const summary = summarize({ ...result, trades: [] });

    expect(summary.closedTrades).toBe(0);
    expect(summary.winRate).toBeNull();
  });
});

describe('streak distribution', () => {
  /** A run reduced to its covered/uncovered day pattern; nothing else matters here. */
  const withDays = (pattern: string) => ({
    ...result,
    trades: [],
    days: [...pattern].map((mark, index) => ({
      barTime: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
      openLots: mark === 'x' ? 1 : 0,
      evaluable: true,
    })),
  });

  it('reports every covered streak, longest first', () => {
    // Three runs of covered days, separated by flat days with no position.
    expect(summarize(withDays('xx..xxxxx.x')).coveredStreaks).toEqual([5, 2, 1]);
  });

  it('counts how many streaks reach the milestone 3.8 threshold', () => {
    // The criterion is 20 consecutive curve points, and a curve point exists
    // only on a covered day — so this is the number of times the run would
    // have cleared the bar, not merely the best it ever did.
    const twenty = 'x'.repeat(20);
    const summary = summarize(withDays(`${twenty}..${twenty}.xxx`));

    expect(summary.streaksReaching20).toBe(2);
  });
})
