import { describe, expect, it } from 'vitest';
import { simulate } from '../src/backtest/simulate.js';
import type { Candle } from '../src/orchestrator/robinhood/client.js';
import type { StrategyConfig } from '../src/orchestrator/strategy/index.js';
import type { RiskConfig } from '../src/config/index.js';
import fixture from './fixtures/ohlcv/AAPL-daily-2026.json' with { type: 'json' };

/**
 * The same real AAPL bars technical.test.ts runs on, so the crossings this
 * suite depends on are the ones already pinned there: a bullish MACD cross on
 * 2026-07-02 and an overbought RSI cross on 2026-07-16.
 */
const BARS: Candle[] = fixture.results[0]!.bars.map((bar) => ({
  t: bar.begins_at,
  o: bar.open_price,
  h: bar.high_price,
  l: bar.low_price,
  c: bar.close_price,
  v: bar.volume,
}));

const STRATEGY: StrategyConfig = {
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  orderNotionalCents: 100_000,
  maxHoldingDays: 30,
};

const RISK: RiskConfig = {
  symbolAllowlist: ['AAPL'],
  maxPositionCents: 200_000,
  maxDailyTrades: 5,
  maxTotalExposureCents: 500_000,
};

const run = (overrides: Parameters<typeof simulate>[0] extends infer T ? Partial<T> : never = {}) =>
  simulate({
    bars: { AAPL: BARS },
    strategy: STRATEGY,
    risk: RISK,
    slippageBps: 10,
    ...overrides,
  });

describe('entries', () => {
  it('fills a bullish cross at the next bar open, worsened by slippage', () => {
    const { trades } = run();

    // 2026-07-02 is the crossing bar; the pipeline proposes the following
    // morning, so the fill is bar 2026-07-06's open of 307.36 plus 10bps.
    expect(trades[0]!.entryBarTime).toBe('2026-07-06T00:00:00Z');
    expect(trades[0]!.entryPrice).toBe('307.667360');
  });
});

describe('exits', () => {
  it('closes the lot at the next bar open, worsened by slippage the other way', () => {
    const { trades } = run();

    // RSI crosses up through 70 on 2026-07-16, so the exit trades into
    // 2026-07-17's open of 331.98 minus 10bps.
    expect(trades[0]!.exitRule).toBe('rsi_overbought');
    expect(trades[0]!.exitBarTime).toBe('2026-07-17T00:00:00Z');
    expect(trades[0]!.exitPrice).toBe('331.648020');
  });

  it('realizes the spread between both slipped fills', () => {
    const { trades } = run();

    // (331.648020 - 307.667360) * 3 shares, with slippage eating both legs.
    expect(trades[0]!.realizedPnl).toBe('71.94');
    expect(trades[0]!.holdingBars).toBe(9);
  });

  it('never opens a short when a sell crossing fires against no position', () => {
    const { trades, rejections } = run();

    // A bearish MACD cross fires on 2026-07-31, by which point the lot is
    // already closed. `evaluateTechnical` suppresses it as `no_open_position`
    // before the risk gate ever sees it, so it is not a rejection either.
    expect(trades).toHaveLength(1);
    expect(rejections.sell_without_position).toBe(0);
  });

  it('time-stops a position that no crossing closed', () => {
    // Three bars, so the stop fires well before the 2026-07-16 overbought cross.
    const { trades } = run({ strategy: { ...STRATEGY, maxHoldingDays: 3 } });

    expect(trades[0]!.exitRule).toBe('max_holding_period');
    // Held four bars, not three: the stop *fires* on the bar where three have
    // closed since entry, and the fill lands on the bar after that.
    expect(trades[0]!.holdingBars).toBe(4);
  });
});

describe('the risk gate', () => {
  it('tallies a rejection instead of opening a lot over the position cap', () => {
    // Three AAPL shares near $308 is roughly $924; a $100 cap refuses it.
    const { trades, rejections } = run({ risk: { ...RISK, maxPositionCents: 10_000 } });

    expect(trades).toHaveLength(0);
    expect(rejections.position_size_cap).toBe(1);
  });
});

describe('the approval window', () => {
  it('lets every signal expire when the owner approves nothing', () => {
    const { trades, expired, signalsProposed } = run({ approvalRate: 0 });

    expect(trades).toHaveLength(0);
    expect(expired).toBe(signalsProposed);
  });

  it('replays a partial approval rate identically for the same seed', () => {
    const a = run({ approvalRate: 0.5, seed: 7 });
    const b = run({ approvalRate: 0.5, seed: 7 });

    expect(a.trades).toEqual(b.trades);
  });
});

describe('position coverage', () => {
  it('counts a lot as open from its entry bar through the bar before its exit', () => {
    const { days } = run();

    // Entry fills 2026-07-06, exit fills 2026-07-17: open at the close of
    // every bar in between, which is what a curve point requires.
    const covered = days.filter((day) => day.openLots > 0);

    expect(covered.at(0)!.barTime).toBe('2026-07-06T00:00:00Z');
    expect(covered.at(-1)!.barTime).toBe('2026-07-16T00:00:00Z');
    expect(covered).toHaveLength(9);
  });
});
