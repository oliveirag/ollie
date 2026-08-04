import { describe, expect, it } from 'vitest';
import {
  dedupeKeyFor,
  evaluateTechnical,
  requiredBars,
} from '../src/orchestrator/strategy/index.js';
import type { Candle, StrategyConfig } from '../src/orchestrator/strategy/index.js';
import fixture from './fixtures/ohlcv/AAPL-daily-2026.json' with { type: 'json' };

const ALL_BARS: Candle[] = fixture.results[0]!.bars.map((bar) => ({
  t: bar.begins_at,
  o: bar.open_price,
  h: bar.high_price,
  l: bar.low_price,
  c: bar.close_price,
  v: bar.volume,
}));

const BASE: StrategyConfig = {
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  orderNotionalCents: 100_000,
};

const config = (overrides: Partial<StrategyConfig> = {}): StrategyConfig => ({
  ...BASE,
  ...overrides,
});

/** Bars up to and including the given date, as the pipeline would have seen them. */
function through(isoDate: string): Candle[] {
  const index = ALL_BARS.findIndex((bar) => bar.t.startsWith(isoDate));
  if (index === -1) throw new Error(`no bar for ${isoDate}`);
  return ALL_BARS.slice(0, index + 1);
}

// Every case below runs on real AAPL bars rather than a hand-tuned series, so
// the rules are exercised against the kind of data they will actually see.
describe('rules firing on real bars', () => {
  it('fires a bullish MACD cross when the histogram turns positive', () => {
    const { candidate } = evaluateTechnical('AAPL', through('2026-07-02'), config());

    expect(candidate).not.toBeNull();
    expect(candidate!.rule).toBe('macd_bullish_cross');
    expect(candidate!.side).toBe('buy');
    expect(candidate!.indicators.macdHistogramPrev).toBeLessThan(0);
    expect(candidate!.indicators.macdHistogram).toBeGreaterThan(0);
  });

  it('fires a bearish MACD cross when the histogram turns negative', () => {
    const { candidate } = evaluateTechnical('AAPL', through('2026-07-31'), config());

    expect(candidate!.rule).toBe('macd_bearish_cross');
    expect(candidate!.side).toBe('sell');
  });

  it('fires an overbought RSI signal when RSI crosses up through the threshold', () => {
    const { candidate } = evaluateTechnical('AAPL', through('2026-07-16'), config());

    expect(candidate!.rule).toBe('rsi_overbought');
    expect(candidate!.side).toBe('sell');
    expect(candidate!.indicators.rsiPrev).toBeLessThan(70);
    expect(candidate!.indicators.rsi).toBeGreaterThan(70);
  });

  it('fires an oversold RSI signal when RSI crosses down through the threshold', () => {
    const { candidate } = evaluateTechnical(
      'AAPL',
      through('2026-06-25'),
      config({ rsiOversold: 35 }),
    );

    expect(candidate!.rule).toBe('rsi_oversold');
    expect(candidate!.side).toBe('buy');
  });

  it('produces nothing on a bar where no threshold is crossed', () => {
    const result = evaluateTechnical('AAPL', through('2026-08-03'), config());

    expect(result.candidate).toBeNull();
    expect(result.skipReason).toBe('no_rule_fired');
    // Indicators are still reported, so a quiet run is explainable from logs.
    expect(result.indicators!.rsi).toBeCloseTo(40.4, 1);
  });
});

// A level test ("RSI is under 30") re-proposes the same trade every day the
// condition holds. These assert the rules are crossings instead.
describe('crossings do not re-fire', () => {
  it('stays quiet on the day after a bullish cross while the histogram is still positive', () => {
    const before = evaluateTechnical('AAPL', through('2026-07-02'), config());
    const after = evaluateTechnical('AAPL', through('2026-07-06'), config());

    expect(before.candidate!.rule).toBe('macd_bullish_cross');
    expect(after.indicators!.macdHistogram).toBeGreaterThan(0);
    expect(after.candidate).toBeNull();
  });

  it('stays quiet while RSI remains above the overbought threshold', () => {
    const crossing = evaluateTechnical('AAPL', through('2026-07-16'), config());
    const stillHigh = evaluateTechnical('AAPL', through('2026-07-17'), config());

    expect(crossing.candidate!.rule).toBe('rsi_overbought');
    expect(stillHigh.indicators!.rsi).toBeGreaterThan(70);
    expect(stillHigh.candidate).toBeNull();
  });
});

describe('rule precedence', () => {
  it('resolves a bar where two rules fire by the fixed rule order', () => {
    // 2026-07-31 is a washout: the MACD histogram turns negative (a sell) on
    // the same bar RSI drops through 50 (a buy, at this threshold). Without a
    // fixed order the answer would depend on evaluation order, which is not
    // something anyone could defend after the fact.
    const result = evaluateTechnical('AAPL', through('2026-07-31'), config({ rsiOversold: 50 }));

    expect(result.indicators!.rsiPrev).toBeGreaterThanOrEqual(50);
    expect(result.indicators!.rsi).toBeLessThan(50);
    expect(result.indicators!.macdHistogramPrev).toBeGreaterThan(0);
    expect(result.indicators!.macdHistogram).toBeLessThan(0);

    expect(result.candidate!.rule).toBe('rsi_oversold');
    expect(result.candidate!.side).toBe('buy');
  });
});

describe('position sizing', () => {
  it('floors to whole shares, never rounding up past the configured notional', () => {
    // $1,000 target against a $308.63 close: three shares, not 3.24.
    const { candidate } = evaluateTechnical(
      'AAPL',
      through('2026-07-02'),
      config({ orderNotionalCents: 100_000 }),
    );
    expect(candidate!.quantity).toBe('3');
    expect(candidate!.referenceClose).toBe('308.630000');
  });

  it('declines to signal when one share costs more than the whole order', () => {
    const result = evaluateTechnical(
      'AAPL',
      through('2026-07-02'),
      config({ orderNotionalCents: 10_000 }),
    );

    expect(result.candidate).toBeNull();
    expect(result.skipReason).toBe('quantity_rounds_to_zero');
  });
});

describe('input handling', () => {
  it('reports insufficient history rather than guessing', () => {
    const result = evaluateTechnical('AAPL', ALL_BARS.slice(0, 10), config());

    expect(result.candidate).toBeNull();
    expect(result.skipReason).toBe('insufficient_history');
    expect(result.indicators).toBeNull();
  });

  it('needs enough bars for both indicators on the current and previous bar', () => {
    expect(requiredBars(BASE)).toBe(35);
    expect(evaluateTechnical('AAPL', ALL_BARS.slice(0, 34), config()).skipReason).toBe(
      'insufficient_history',
    );
    expect(evaluateTechnical('AAPL', ALL_BARS.slice(0, 35), config()).skipReason).not.toBe(
      'insufficient_history',
    );
  });

  it('ignores synthesized gap-fill bars entirely', () => {
    const bars = through('2026-07-02');
    const withGapFill: Candle[] = [
      ...bars,
      { t: '2026-07-03T00:00:00Z', o: '1', h: '1', l: '1', c: '1', v: 0, interpolated: true },
    ];

    // A fabricated close of $1 would otherwise be a catastrophic RSI crash.
    expect(evaluateTechnical('AAPL', withGapFill, config())).toEqual(
      evaluateTechnical('AAPL', bars, config()),
    );
  });
});

describe('determinism', () => {
  it('returns deeply equal results for the same inputs', () => {
    const bars = through('2026-07-02');
    expect(evaluateTechnical('AAPL', bars, config())).toEqual(
      evaluateTechnical('AAPL', bars, config()),
    );
  });

  it('pins a full candidate, so any change to the decision is visible in a diff', () => {
    const { candidate } = evaluateTechnical('AAPL', through('2026-07-02'), config());

    expect({
      ...candidate!,
      indicators: {
        rsi: Number(candidate!.indicators.rsi.toFixed(4)),
        macdHistogram: Number(candidate!.indicators.macdHistogram.toFixed(4)),
        macdHistogramPrev: Number(candidate!.indicators.macdHistogramPrev.toFixed(4)),
      },
    }).toMatchInlineSnapshot(`
      {
        "barTime": "2026-07-02T00:00:00Z",
        "indicators": {
          "macdHistogram": 0.3768,
          "macdHistogramPrev": -1.1261,
          "rsi": 60.5981,
        },
        "quantity": "3",
        "referenceClose": "308.630000",
        "rule": "macd_bullish_cross",
        "side": "buy",
        "signalType": "technical",
        "symbol": "AAPL",
      }
    `);
  });

  it('does not read the clock: the same bars evaluated twice agree', () => {
    const bars = through('2026-07-02');
    const first = evaluateTechnical('AAPL', bars, config());
    const second = evaluateTechnical('AAPL', bars, config());
    expect(first.barTime).toBe(second.barTime);
    expect(first.barTime).toBe('2026-07-02T00:00:00Z');
  });
});

describe('dedupe key', () => {
  it('identifies one rule firing on one symbol, side and bar', () => {
    const { candidate } = evaluateTechnical('AAPL', through('2026-07-02'), config());
    expect(dedupeKeyFor(candidate!)).toBe('macd_bullish_cross:AAPL:buy:2026-07-02T00:00:00Z');
  });

  it('differs across symbols and bars', () => {
    const a = evaluateTechnical('AAPL', through('2026-07-02'), config()).candidate!;
    const b = evaluateTechnical('MSFT', through('2026-07-02'), config()).candidate!;
    expect(dedupeKeyFor(a)).not.toBe(dedupeKeyFor(b));
  });
});
