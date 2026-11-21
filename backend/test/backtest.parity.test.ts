import { describe, expect, it } from 'vitest';
import { checkParity, decisionBarDate, type ProductionSignal } from '../src/backtest/parity.js';
import { simulate } from '../src/backtest/simulate.js';
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

const STRATEGY = {
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  orderNotionalCents: 100_000,
  maxHoldingDays: 30,
};
const RISK = { symbolAllowlist: ['AAPL'], maxPositionCents: 200_000, maxDailyTrades: 5, maxTotalExposureCents: 500_000 };
const DAYS = BARS.map((bar) => bar.t.slice(0, 10));

describe('decisionBarDate', () => {
  it('puts a morning signal on the previous trading day', () => {
    // 2026-07-06 09:35 ET; 07-03 is the Independence Day holiday (observed),
    // so the last completed bar is 07-02.
    expect(decisionBarDate('2026-07-06T13:35:00Z', DAYS)).toBe('2026-07-02');
  });

  it('lets a signal written after the close see that day', () => {
    expect(decisionBarDate('2026-07-06T20:30:00Z', DAYS)).toBe('2026-07-06');
  });
});

/** Production's record, written as if it had run every morning and approved everything. */
function productionFromReplay(): ProductionSignal[] {
  const { trades } = simulate({ bars: { AAPL: BARS }, strategy: STRATEGY, risk: RISK, slippageBps: 10 });
  const morningAfter = (barTime: string) => {
    const next = DAYS[DAYS.indexOf(barTime.slice(0, 10)) + 1]!;
    return `${next}T13:35:00.000Z`;
  };
  const prevDay = (barTime: string) => DAYS[DAYS.indexOf(barTime.slice(0, 10)) - 1]!;
  return trades.flatMap((t) => [
    {
      created_at: morningAfter(prevDay(t.entryBarTime)),
      symbol: t.symbol,
      side: 'buy' as const,
      signal_type: 'technical',
      status: 'approved',
      quantity: t.quantity,
      estimated_price: t.entryPrice,
    },
    ...(t.exitBarTime
      ? [
          {
            created_at: morningAfter(prevDay(t.exitBarTime)),
            symbol: t.symbol,
            side: 'sell' as const,
            signal_type: 'technical',
            status: 'approved',
            quantity: t.quantity,
            estimated_price: t.exitPrice,
          },
        ]
      : []),
  ]);
}

describe('checkParity', () => {
  const window = { from: '2026-06-01', to: DAYS.at(-1)! };

  it('matches every signal of a production record the replay itself would write', () => {
    const signals = productionFromReplay();
    const report = checkParity({ bars: { AAPL: BARS }, strategy: STRATEGY, risk: RISK, signals, ...window });

    expect(report.matched.map((r) => `${r.side}:${r.barDate}`)).toEqual(['buy:2026-07-02', 'sell:2026-07-16']);
    expect(report.productionOnly).toEqual([]);
  });

  it('flags a production signal the rules would not have produced', () => {
    const invented: ProductionSignal = {
      created_at: '2026-07-09T13:35:00.000Z',
      symbol: 'AAPL',
      side: 'buy',
      signal_type: 'technical',
      status: 'expired',
      quantity: '3',
      estimated_price: '310',
    };
    const report = checkParity({
      bars: { AAPL: BARS },
      strategy: STRATEGY,
      risk: RISK,
      signals: [...productionFromReplay(), invented],
      ...window,
    });

    expect(report.productionOnly).toEqual([
      { symbol: 'AAPL', side: 'buy', barDate: '2026-07-08', productionStatus: 'expired' },
    ]);
  });

  it('flags a day production missed', () => {
    const report = checkParity({ bars: { AAPL: BARS }, strategy: STRATEGY, risk: RISK, signals: [], ...window });

    expect(report.replayOnly.map((r) => `${r.side}:${r.barDate}:${r.replayRule}`)).toContain(
      'buy:2026-07-02:macd_bullish_cross',
    );
  });
});
