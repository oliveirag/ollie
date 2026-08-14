import { describe, expect, it } from 'vitest';
import { evaluateExit } from '../src/orchestrator/strategy/exits.js';
import type { Candle } from '../src/orchestrator/robinhood/client.js';

/**
 * Daily bars from a fixed epoch, so "held for N bars" is countable by hand.
 * Bar 0 is 2026-01-01, bar 1 is 2026-01-02, and so on.
 */
const BARS: Candle[] = Array.from({ length: 60 }, (_, i) => {
  const day = new Date(Date.UTC(2026, 0, 1 + i));
  return {
    t: day.toISOString(),
    o: '100',
    h: '101',
    l: '99',
    c: String(100 + i),
    v: 1000,
  };
});

const openedAt = (barIndex: number) => new Date(Date.UTC(2026, 0, 1 + barIndex));

describe('the time stop', () => {
  it('proposes an exit once a lot has been held the full holding period', () => {
    // Opened on bar 0; the series runs to bar 59, so 59 bars have closed since.
    const candidate = evaluateExit('AAPL', BARS, { openedAt: openedAt(0), quantity: '4' }, 30);

    expect(candidate).not.toBeNull();
    expect(candidate!.side).toBe('sell');
    expect(candidate!.rule).toBe('max_holding_period');
    // The whole position, like every other exit.
    expect(candidate!.quantity).toBe('4');
  });

  it('stays quiet one bar short of the threshold', () => {
    // Opened on bar 30, series ends at bar 59: 29 bars held, one short of 30.
    expect(evaluateExit('AAPL', BARS, { openedAt: openedAt(30), quantity: '4' }, 30)).toBeNull();
  });

  it('fires exactly on the threshold bar', () => {
    // Opened on bar 29: 30 bars held.
    const candidate = evaluateExit('AAPL', BARS, { openedAt: openedAt(29), quantity: '4' }, 30);

    expect(candidate).not.toBeNull();
  });

  it('is disabled by a zero holding period', () => {
    // The escape hatch: a run that should never time-stop sets 0 rather than a
    // number large enough to hope it never triggers.
    expect(evaluateExit('AAPL', BARS, { openedAt: openedAt(0), quantity: '4' }, 0)).toBeNull();
  });

  it('stamps the candidate with the latest bar so it re-proposes daily', () => {
    const candidate = evaluateExit('AAPL', BARS, { openedAt: openedAt(0), quantity: '4' }, 30);

    // The dedupe key carries barTime. An exit the owner never got to stays
    // true tomorrow and is proposed again under a new key — unlike a crossing
    // rule, which fires once and may not recur for weeks.
    expect(candidate!.barTime).toBe(BARS.at(-1)!.t);
  });

  it('declares itself a time stop rather than a technical signal', () => {
    const candidate = evaluateExit('AAPL', BARS, { openedAt: openedAt(0), quantity: '4' }, 30);

    // It consulted no indicator. Persisting it as `technical` would put a claim
    // about provenance into a permanent, uneditable row that is not true — in
    // exactly the field a subscriber inspecting the record would read first.
    expect(candidate!.signalType).toBe('time_stop');
  });

  it('reports the closing price of the bar it fired on', () => {
    const candidate = evaluateExit('AAPL', BARS, { openedAt: openedAt(0), quantity: '4' }, 30);

    expect(candidate!.referenceClose).toBe('159');
  });

  it('is deterministic: identical inputs give an identical candidate', () => {
    const a = evaluateExit('AAPL', BARS, { openedAt: openedAt(0), quantity: '4' }, 30);
    const b = evaluateExit('AAPL', BARS, { openedAt: openedAt(0), quantity: '4' }, 30);

    expect(a).toEqual(b);
  });

  it('proposes nothing when there are no bars to measure against', () => {
    expect(evaluateExit('AAPL', [], { openedAt: openedAt(0), quantity: '4' }, 30)).toBeNull();
  });

  it('ignores interpolated bars when counting the holding period', () => {
    // A synthesized gap-fill bar never traded, so counting it would time-stop a
    // position a day early on any symbol with a hole in its history.
    const withGaps: Candle[] = BARS.slice(0, 40).map((bar, i) =>
      i >= 10 && i < 20 ? { ...bar, interpolated: true } : bar,
    );

    // Opened at bar 0: 39 bars follow, but 10 are fabricated, so 29 real ones.
    expect(evaluateExit('AAPL', withGaps, { openedAt: openedAt(0), quantity: '4' }, 30)).toBeNull();
  });
});
