import { describe, expect, it } from 'vitest';
import { applyRiskCaps, type RiskInputs } from '../src/orchestrator/risk.js';
import type { RiskConfig } from '../src/config/index.js';
import type { Position } from '../src/orchestrator/robinhood/client.js';
import type { CandidateSignal } from '../src/orchestrator/strategy/index.js';

const CONFIG: RiskConfig = {
  symbolAllowlist: ['AAPL', 'MSFT', 'SPY'],
  maxPositionCents: 100_000, // $1,000
  maxDailyTrades: 3,
  maxTotalExposureCents: 500_000, // $5,000
};

function candidate(overrides: Partial<CandidateSignal> = {}): CandidateSignal {
  return {
    symbol: 'AAPL',
    side: 'buy',
    signalType: 'technical',
    quantity: '2',
    rule: 'macd_bullish_cross',
    barTime: '2026-07-02T00:00:00Z',
    referenceClose: '100.00',
    indicators: {
      rsi: 45,
      rsiPrev: 50,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      macd: 1,
      macdSignal: 0.5,
      macdHistogram: 0.5,
      macdPrev: 0.4,
      macdSignalPrev: 0.6,
      macdHistogramPrev: -0.2,
      macdFast: 12,
      macdSlow: 26,
      macdSignalPeriod: 9,
      close: 100,
      closePrev: 99,
    },
    ...overrides,
  };
}

function position(symbol: string, quantity: string, sellable = quantity): Position {
  return {
    symbol,
    quantity,
    sharesAvailableForSells: sellable,
    averageBuyPrice: '90.00',
  };
}

function inputs(overrides: Partial<RiskInputs> = {}): RiskInputs {
  return {
    candidates: [candidate()],
    account: { positions: [], prices: { AAPL: '100.00', MSFT: '100.00', SPY: '100.00' } },
    pendingSignals: [],
    signalsToday: 0,
    config: CONFIG,
    ...overrides,
  };
}

describe('symbol allowlist', () => {
  it('accepts an allowlisted symbol', () => {
    const { accepted, rejected } = applyRiskCaps(inputs());
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it('rejects anything not on the list', () => {
    const { accepted, rejected } = applyRiskCaps(
      inputs({ candidates: [candidate({ symbol: 'GME' })] }),
    );
    expect(accepted).toHaveLength(0);
    expect(rejected[0]!.reason).toBe('symbol_not_allowlisted');
  });
});

describe('long-only gating', () => {
  it('rejects a sell with no position at all', () => {
    const { rejected } = applyRiskCaps(inputs({ candidates: [candidate({ side: 'sell' })] }));
    expect(rejected[0]!.reason).toBe('sell_without_position');
  });

  it('accepts a sell that the position fully covers', () => {
    const { accepted } = applyRiskCaps(
      inputs({
        candidates: [candidate({ side: 'sell', quantity: '2' })],
        account: {
          positions: [position('AAPL', '5')],
          prices: { AAPL: '100.00' },
        },
      }),
    );
    expect(accepted).toHaveLength(1);
  });

  it('rejects a sell larger than the position', () => {
    const { rejected } = applyRiskCaps(
      inputs({
        candidates: [candidate({ side: 'sell', quantity: '6' })],
        account: { positions: [position('AAPL', '5')], prices: { AAPL: '100.00' } },
      }),
    );
    expect(rejected[0]!.reason).toBe('sell_without_position');
  });

  it('counts only shares that are sellable right now, not the whole position', () => {
    // Held or unsettled shares show in quantity but cannot be sold today.
    const { rejected } = applyRiskCaps(
      inputs({
        candidates: [candidate({ side: 'sell', quantity: '5' })],
        account: { positions: [position('AAPL', '5', '2')], prices: { AAPL: '100.00' } },
      }),
    );
    expect(rejected[0]!.reason).toBe('sell_without_position');
    expect(rejected[0]!.detail).toContain('2 shares sellable');
  });

  it('accepts a sell exactly at the sellable boundary', () => {
    const { accepted } = applyRiskCaps(
      inputs({
        candidates: [candidate({ side: 'sell', quantity: '2' })],
        account: { positions: [position('AAPL', '5', '2')], prices: { AAPL: '100.00' } },
      }),
    );
    expect(accepted).toHaveLength(1);
  });
});

describe('max position size', () => {
  it('accepts a buy that lands exactly on the cap', () => {
    // 10 shares at $100 = $1,000 = the cap.
    const { accepted } = applyRiskCaps(
      inputs({ candidates: [candidate({ quantity: '10' })] }),
    );
    expect(accepted).toHaveLength(1);
  });

  it('rejects a buy one share past the cap', () => {
    const { rejected } = applyRiskCaps(inputs({ candidates: [candidate({ quantity: '11' })] }));
    expect(rejected[0]!.reason).toBe('position_size_cap');
  });

  it('counts the existing position toward the cap', () => {
    const { rejected } = applyRiskCaps(
      inputs({
        candidates: [candidate({ quantity: '5' })],
        account: { positions: [position('AAPL', '6')], prices: { AAPL: '100.00' } },
      }),
    );
    expect(rejected[0]!.reason).toBe('position_size_cap');
    expect(rejected[0]!.detail).toContain('110000 cents');
  });

  it('does not apply the position cap to sells, which reduce the position', () => {
    const { accepted } = applyRiskCaps(
      inputs({
        candidates: [candidate({ side: 'sell', quantity: '20' })],
        account: { positions: [position('AAPL', '20')], prices: { AAPL: '100.00' } },
      }),
    );
    expect(accepted).toHaveLength(1);
  });
});

describe('max daily trades', () => {
  it('accepts up to the cap', () => {
    const { accepted, rejected } = applyRiskCaps(
      inputs({
        candidates: [
          candidate({ symbol: 'AAPL' }),
          candidate({ symbol: 'MSFT' }),
          candidate({ symbol: 'SPY' }),
        ],
      }),
    );
    expect(accepted).toHaveLength(3);
    expect(rejected).toHaveLength(0);
  });

  it('rejects the one past the cap', () => {
    const { accepted, rejected } = applyRiskCaps(
      inputs({
        candidates: [
          candidate({ symbol: 'AAPL' }),
          candidate({ symbol: 'MSFT' }),
          candidate({ symbol: 'SPY' }),
        ],
        signalsToday: 1,
      }),
    );
    expect(accepted).toHaveLength(2);
    expect(rejected[0]!.reason).toBe('daily_trade_cap');
  });

  it('counts signals already proposed today, however they were decided', () => {
    const { accepted, rejected } = applyRiskCaps(inputs({ signalsToday: 3 }));
    expect(accepted).toHaveLength(0);
    expect(rejected[0]!.reason).toBe('daily_trade_cap');
  });

  it('lets a sell consume a daily slot too', () => {
    const { accepted } = applyRiskCaps(
      inputs({
        candidates: [candidate({ side: 'sell', quantity: '1' })],
        account: { positions: [position('AAPL', '5')], prices: { AAPL: '100.00' } },
        signalsToday: 2,
      }),
    );
    expect(accepted).toHaveLength(1);
    expect(applyRiskCaps(inputs({ signalsToday: 3 })).accepted).toHaveLength(0);
  });
});

describe('max total exposure', () => {
  it('counts open positions toward the cap', () => {
    const { rejected } = applyRiskCaps(
      inputs({
        candidates: [candidate({ quantity: '5' })],
        account: {
          positions: [position('MSFT', '48')], // $4,800 of a $5,000 cap
          prices: { AAPL: '100.00', MSFT: '100.00' },
        },
      }),
    );
    expect(rejected[0]!.reason).toBe('total_exposure_cap');
  });

  it('counts pending signals as committed exposure', () => {
    // A pending signal can still be approved, so its notional is spoken for.
    const { rejected } = applyRiskCaps(
      inputs({
        candidates: [candidate({ quantity: '5' })],
        pendingSignals: [{ symbol: 'MSFT', quantity: '48' }],
      }),
    );
    expect(rejected[0]!.reason).toBe('total_exposure_cap');
  });

  it('accepts a buy that lands exactly on the exposure cap', () => {
    const { accepted } = applyRiskCaps(
      inputs({
        candidates: [candidate({ quantity: '10' })],
        account: {
          positions: [position('MSFT', '40')], // $4,000 + $1,000 = the $5,000 cap
          prices: { AAPL: '100.00', MSFT: '100.00' },
        },
      }),
    );
    expect(accepted).toHaveLength(1);
  });

  it('accumulates across candidates within a single run', () => {
    const { accepted, rejected } = applyRiskCaps(
      inputs({
        candidates: [
          candidate({ symbol: 'AAPL', quantity: '10' }),
          candidate({ symbol: 'MSFT', quantity: '10' }),
          candidate({ symbol: 'SPY', quantity: '10' }),
        ],
        account: {
          positions: [position('AAPL', '30')], // $3,000 already committed
          prices: { AAPL: '100.00', MSFT: '100.00', SPY: '100.00' },
        },
      }),
    );
    // $3,000 open leaves room for two $1,000 buys, not three. AAPL is also
    // over its own position cap, so it is the one rejected first.
    expect(accepted.map((c) => c.symbol)).toEqual(['MSFT', 'SPY']);
    expect(rejected.map((r) => r.reason)).toEqual(['position_size_cap']);
  });

  it('does not apply the exposure cap to sells', () => {
    const { accepted } = applyRiskCaps(
      inputs({
        candidates: [candidate({ side: 'sell', quantity: '10' })],
        account: {
          positions: [position('AAPL', '10'), position('MSFT', '60')],
          prices: { AAPL: '100.00', MSFT: '100.00' },
        },
      }),
    );
    expect(accepted).toHaveLength(1);
  });
});

describe('missing prices', () => {
  it('rejects a candidate whose symbol has no mark price and no reference close', () => {
    const { rejected } = applyRiskCaps(
      inputs({
        candidates: [{ ...candidate(), referenceClose: '' }],
        account: { positions: [], prices: {} },
      }),
    );
    expect(rejected[0]!.reason).toBe('no_price_available');
  });

  it('falls back to the decision bar close when there is no live quote', () => {
    const { accepted } = applyRiskCaps(
      inputs({
        candidates: [candidate({ referenceClose: '100.00' })],
        account: { positions: [], prices: {} },
      }),
    );
    expect(accepted).toHaveLength(1);
  });

  it('skips an unpriced holding rather than valuing it at zero', () => {
    // A holding with no price must not read as free exposure. Here the unpriced
    // MSFT position is excluded, so the AAPL buy is judged on what is known.
    const { accepted } = applyRiskCaps(
      inputs({
        account: { positions: [position('MSFT', '1000')], prices: { AAPL: '100.00' } },
      }),
    );
    expect(accepted).toHaveLength(1);
  });
});

describe('determinism', () => {
  it('does not depend on the order candidates arrive in', () => {
    const forwards = applyRiskCaps(
      inputs({
        candidates: [
          candidate({ symbol: 'SPY', quantity: '10' }),
          candidate({ symbol: 'AAPL', quantity: '10' }),
          candidate({ symbol: 'MSFT', quantity: '10' }),
        ],
        signalsToday: 1,
      }),
    );
    const backwards = applyRiskCaps(
      inputs({
        candidates: [
          candidate({ symbol: 'MSFT', quantity: '10' }),
          candidate({ symbol: 'AAPL', quantity: '10' }),
          candidate({ symbol: 'SPY', quantity: '10' }),
        ],
        signalsToday: 1,
      }),
    );

    // Two slots left and three candidates: which two win must not be decided
    // by iteration order.
    expect(forwards.accepted.map((c) => c.symbol)).toEqual(['AAPL', 'MSFT']);
    expect(backwards.accepted.map((c) => c.symbol)).toEqual(['AAPL', 'MSFT']);
  });

  it('returns the same decision for the same inputs', () => {
    expect(applyRiskCaps(inputs())).toEqual(applyRiskCaps(inputs()));
  });
});

describe('rejections carry a reason', () => {
  it('explains itself well enough to debug from a log line', () => {
    const { rejected } = applyRiskCaps(
      inputs({ candidates: [candidate({ symbol: 'GME' })] }),
    );
    expect(rejected[0]!.detail).toContain('GME');
    expect(rejected[0]!.detail).toContain('AAPL');
  });

  it('keeps the rejected candidate attached, since it is never persisted', () => {
    const { rejected } = applyRiskCaps(inputs({ signalsToday: 99 }));
    expect(rejected[0]!.candidate.symbol).toBe('AAPL');
  });
});
