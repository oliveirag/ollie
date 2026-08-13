import { describe, expect, it } from 'vitest';
import {
  computeTrackRecord,
  type TrackRecordRow,
} from '../src/orchestrator/trackRecordStats.js';

/**
 * Fixtures are plain rows, not database reads: every formula in the plan's
 * Definitions section is checked against a number worked out by hand, because
 * these are the numbers the product publishes.
 */
function row(over: Partial<TrackRecordRow> & Pick<TrackRecordRow, 'signalId' | 'status'>): TrackRecordRow {
  return {
    entryPrice: '100',
    quantity: '2',
    exitPrice: null,
    realizedPnl: null,
    unrealizedPnl: null,
    markPrice: null,
    recordedAt: new Date('2026-08-01T00:00:00Z'),
    ...over,
  };
}

const closed = (signalId: string, realizedPnl: string, recordedAt: string, entryPrice = '100') =>
  row({
    signalId,
    status: 'closed',
    entryPrice,
    realizedPnl,
    exitPrice: '110',
    recordedAt: new Date(recordedAt),
  });

const mark = (signalId: string, unrealizedPnl: string, recordedAt: string) =>
  row({
    signalId,
    status: 'open',
    unrealizedPnl,
    markPrice: '105',
    recordedAt: new Date(recordedAt),
  });

describe('win rate', () => {
  it('counts only strictly positive trades as wins', () => {
    const stats = computeTrackRecord([
      closed('a', '10', '2026-08-01T00:00:00Z'),
      closed('b', '-5', '2026-08-02T00:00:00Z'),
      // A scratch. Counting ties as wins inflates the headline number.
      closed('c', '0', '2026-08-03T00:00:00Z'),
    ]);

    expect(stats.closedTrades).toBe(3);
    expect(stats.wins).toBe(1);
    expect(stats.winRate).toBeCloseTo(1 / 3, 10);
  });

  it('is null rather than zero with nothing closed', () => {
    const stats = computeTrackRecord([mark('a', '4', '2026-08-01T00:00:00Z')]);

    // Zero would assert a 0% win rate, which is a claim about performance. Null
    // says the question has no answer yet — the same honesty convention the
    // dashboard uses for a total it cannot compute.
    expect(stats.winRate).toBeNull();
    expect(stats.closedTrades).toBe(0);
  });

  it('excludes open positions from the denominator', () => {
    const stats = computeTrackRecord([
      closed('a', '10', '2026-08-01T00:00:00Z'),
      mark('b', '-50', '2026-08-01T00:00:00Z'),
    ]);

    // The open loser has no outcome yet. Guessing one corrupts the statistic
    // in whichever direction the guesser prefers; the open count is reported
    // alongside so the exclusion is visible rather than hidden.
    expect(stats.winRate).toBe(1);
    expect(stats.openPositions).toBe(1);
  });
});

describe('average return', () => {
  it('is the unweighted mean of per-trade returns', () => {
    const stats = computeTrackRecord([
      // 20 / (100 x 2) = 10%
      closed('a', '20', '2026-08-01T00:00:00Z', '100'),
      // -10 / (50 x 2) = -10%
      closed('b', '-10', '2026-08-02T00:00:00Z', '50'),
    ]);

    // Unweighted: entries are sized to a fixed notional, and it matches how a
    // subscriber acting on each signal at fixed size experiences the record.
    expect(stats.averageReturn).toBeCloseTo(0, 10);
  });

  it('is null with nothing closed', () => {
    expect(computeTrackRecord([]).averageReturn).toBeNull();
  });
});

describe('the equity curve', () => {
  it('accumulates realized pnl across days', () => {
    const stats = computeTrackRecord([
      closed('a', '10', '2026-08-01T15:00:00Z'),
      closed('b', '5', '2026-08-03T15:00:00Z'),
    ]);

    expect(stats.curve).toEqual([
      { date: '2026-08-01', value: 10, withheld: false },
      { date: '2026-08-03', value: 15, withheld: false },
    ]);
  });

  it('adds the unrealized value of that day open positions', () => {
    const stats = computeTrackRecord([
      closed('a', '10', '2026-08-01T15:00:00Z'),
      mark('b', '4', '2026-08-01T20:15:00Z'),
    ]);

    // Realized to date plus what the open lots were worth that day.
    expect(stats.curve).toEqual([{ date: '2026-08-01', value: 14, withheld: false }]);
  });

  it('withholds a day when an open lot has no mark', () => {
    const stats = computeTrackRecord([
      // Two lots opened, only one marked on the 2nd.
      row({ signalId: 'a', status: 'open', recordedAt: new Date('2026-08-01T15:00:00Z') }),
      row({ signalId: 'b', status: 'open', recordedAt: new Date('2026-08-01T15:00:00Z') }),
      mark('a', '4', '2026-08-02T20:15:00Z'),
    ]);

    const day = stats.curve.find((p) => p.date === '2026-08-02')!;
    // A partial sum misstates the curve. Same rule as the dashboard totals, and
    // it matters more here because these points get published.
    expect(day.withheld).toBe(true);
    expect(day.value).toBeNull();
  });

  it('is a pnl curve based at zero, not a portfolio value', () => {
    const stats = computeTrackRecord([closed('a', '10', '2026-08-01T15:00:00Z')]);

    // There is no cash ledger and paper mode has no real cash, so a NAV would
    // need an invented denominator.
    expect(stats.curve[0]!.value).toBe(10);
  });
});

describe('corrections', () => {
  it('takes the latest row per signal so a correction supersedes', () => {
    const stats = computeTrackRecord([
      closed('a', '10', '2026-08-01T15:00:00Z'),
      // A correction written later: the real result was a loss.
      closed('a', '-3', '2026-08-05T15:00:00Z'),
    ]);

    // Not two trades, and not the original number. One trade, latest row wins.
    expect(stats.closedTrades).toBe(1);
    expect(stats.totalRealizedPnl).toBe(-3);
    expect(stats.wins).toBe(0);
  });
});
