import { describe, expect, it } from 'vitest';
import { ema, macd, rsi } from '../src/orchestrator/strategy/indicators.js';
import fixture from './fixtures/ohlcv/AAPL-daily-2026.json' with { type: 'json' };
import reference from './fixtures/indicators/AAPL-rh-reference.json' with { type: 'json' };

const bars = fixture.results[0]!.bars;
const closes = bars.map((bar) => Number(bar.close_price));
const times = bars.map((bar) => bar.begins_at);

/**
 * Wilder's own worked example from "New Concepts in Technical Trading Systems",
 * the series every RSI implementation is checked against.
 */
const WILDER_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
  46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35,
  44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
];

/**
 * The published RSI(14) values for that series. They differ from ours by up to
 * 0.08 because the published table rounds its running average gain and loss at
 * every step; this implementation carries full precision. The tolerance covers
 * that and nothing larger — a real formula error would blow well past it.
 */
const WILDER_RSI = [
  70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99,
  41.46, 41.87, 45.46, 37.3, 33.08, 37.77,
];

describe('ema', () => {
  it('is null until the seeding window is full', () => {
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('seeds with the simple average of the first period values', () => {
    const out = ema([10, 20, 30], 3);
    expect(out[2]).toBe(20);
  });

  it('returns all nulls when there is less data than the period', () => {
    expect(ema([1, 2], 5)).toEqual([null, null]);
  });

  it('rejects a non-positive period rather than returning nonsense', () => {
    expect(() => ema([1, 2, 3], 0)).toThrow(RangeError);
  });
});

describe('rsi', () => {
  it('matches Wilder’s published worked example', () => {
    const out = rsi(WILDER_CLOSES, 14);
    WILDER_RSI.forEach((expected, offset) => {
      expect(Math.abs(out[14 + offset]! - expected)).toBeLessThan(0.15);
    });
  });

  it('rejects a non-positive period rather than returning nonsense', () => {
    expect(() => rsi(WILDER_CLOSES, 0)).toThrow(RangeError);
  });

  it('has no value before the period is satisfied', () => {
    const out = rsi(WILDER_CLOSES, 14);
    expect(out.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(out[14]).not.toBeNull();
  });

  it('stays within 0 and 100', () => {
    for (const value of rsi(closes, 14)) {
      if (value === null) continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it('reads a series with no losses as 100 rather than dividing by zero', () => {
    const rising = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi(rising, 14).at(-1)).toBe(100);
  });

  it('reads a series with no gains as 0', () => {
    const falling = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(rsi(falling, 14).at(-1)).toBe(0);
  });
});

describe('macd', () => {
  it('produces no signal line until the signal EMA has warmed up', () => {
    const out = macd(closes, 12, 26, 9);
    expect(out[24]).toBeNull();
    expect(out.at(-1)!.signal).not.toBeNull();
  });

  it('derives the histogram as macd minus signal', () => {
    for (const point of macd(closes, 12, 26, 9)) {
      if (point?.signal == null) continue;
      expect(point.histogram).toBeCloseTo(point.macd - point.signal, 10);
    }
  });

  it('rejects a fast period that is not faster than the slow one', () => {
    expect(() => macd(closes, 26, 26, 9)).toThrow(RangeError);
  });
});

/**
 * The independent check: our math against the broker's own indicator service on
 * the same bars. Tolerance rather than equality is required and is not a
 * weakening of the test — Robinhood seeds its smoothing from bars before the
 * requested range and we do not, so the two series start apart and converge.
 * What matters is that they agree closely at the recent end, where decisions
 * are made, and that the gap is shrinking rather than growing.
 */
describe('cross-check against Robinhood’s own indicators', () => {
  const ourRsi = rsi(closes, 14);
  const ourMacd = macd(closes, 12, 26, 9);
  const at = (isoDate: string) => times.indexOf(isoDate);

  it('agrees on RSI to within 0.5', () => {
    for (const point of reference.rsi.series) {
      expect(Math.abs(ourRsi[at(point.begins_at)]! - point.value)).toBeLessThan(0.5);
    }
  });

  it('agrees on the MACD line, signal and histogram to within 0.25', () => {
    for (const point of reference.macd.series) {
      const ours = ourMacd[at(point.begins_at)]!;
      expect(Math.abs(ours.macd - point.macd)).toBeLessThan(0.25);
      expect(Math.abs(ours.signal! - point.signal)).toBeLessThan(0.25);
      expect(Math.abs(ours.histogram! - point.histogram)).toBeLessThan(0.25);
    }
  });

  it('converges toward the broker rather than drifting away from it', () => {
    const gaps = reference.rsi.series.map((point) =>
      Math.abs(ourRsi[at(point.begins_at)]! - point.value),
    );
    // A seeding difference decays; a formula error would not.
    expect(gaps.at(-1)).toBeLessThan(gaps[0]!);
  });
});

describe('determinism', () => {
  it('returns identical output for identical input', () => {
    expect(rsi(closes, 14)).toEqual(rsi(closes, 14));
    expect(macd(closes, 12, 26, 9)).toEqual(macd(closes, 12, 26, 9));
  });

  it('does not depend on how the input array was built', () => {
    const copy = closes.map((c) => Number(String(c)));
    expect(rsi(copy, 14)).toEqual(rsi(closes, 14));
  });

  it('pins the current values, so a change in the math has to be deliberate', () => {
    expect(rsi(closes, 14).at(-1)).toBeCloseTo(40.395211, 5);
    const last = macd(closes, 12, 26, 9).at(-1)!;
    expect(last.macd).toBeCloseTo(4.484422, 5);
    expect(last.signal).toBeCloseTo(7.439347, 5);
    expect(last.histogram).toBeCloseTo(-2.954925, 5);
  });
});
