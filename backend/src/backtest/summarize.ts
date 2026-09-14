import { dec } from '../money.js';
import type { BacktestResult } from './simulate.js';

/**
 * The report, derived from a run rather than accumulated during one.
 *
 * Keeping this separate from `simulate` is what lets the simulation stay a
 * statement of what happened: it records fills, lots, and days, and every
 * number below is recomputed from those. A metric that drifted from the trades
 * it claims to summarise would be undetectable if the two were interleaved.
 */

/** Trading days in a month, near enough for a rate that is only ever a scale. */
const TRADING_DAYS_PER_MONTH = 21;

/** Consecutive curve points milestone 3.8 requires. */
const MILESTONE_STREAK = 20;

export interface BacktestSummary {
  /** Bars on which some symbol had enough history for a rule to fire. */
  evaluableDays: number;
  /** Evaluable days that ended with at least one lot open. */
  coveredDays: number;
  coverageFraction: number;
  /**
   * The longest unbroken run of covered days — the milestone 3.8 number, since
   * `buildCurve` emits a point only for a day a track-record row exists, and a
   * row exists only while a lot is open.
   */
  longestCoveredStreak: number;
  /** Every unbroken run of covered days, longest first. */
  coveredStreaks: number[];
  /**
   * How many of those runs reached 20 — the number milestone 3.8 actually
   * turns on. The longest streak says the bar was cleared once; this says how
   * often, which is what tells you whether to expect it again.
   */
  streaksReaching20: number;
  entries: number;
  entriesPerMonth: number;
  /** Null when nothing has closed: no answer beats a fabricated zero. */
  medianHoldingBars: number | null;
  closedTrades: number;
  openPositions: number;
  wins: number;
  winRate: number | null;
  averageReturn: number | null;
  totalRealizedPnl: string;
}

export function summarize(result: BacktestResult): BacktestSummary {
  const evaluable = result.days.filter((day) => day.evaluable);
  const coveredDays = evaluable.filter((day) => day.openLots > 0).length;

  const coveredStreaks: number[] = [];
  let streak = 0;
  for (const day of evaluable) {
    if (day.openLots > 0) {
      streak += 1;
      continue;
    }
    if (streak > 0) coveredStreaks.push(streak);
    streak = 0;
  }
  if (streak > 0) coveredStreaks.push(streak);
  coveredStreaks.sort((a, b) => b - a);

  const closed = result.trades.filter((trade) => trade.exitBarTime !== null);
  const holdings = closed
    .map((trade) => trade.holdingBars!)
    .sort((a, b) => a - b);

  const wins = closed.filter((trade) => Number(trade.realizedPnl) > 0).length;

  const returns = closed.map((trade) => {
    const basis = dec(trade.entryPrice).times(trade.quantity);
    return basis.isZero() ? 0 : dec(trade.realizedPnl!).dividedBy(basis).toNumber();
  });

  const totalRealizedPnl = closed.reduce((sum, trade) => sum.plus(trade.realizedPnl!), dec(0));

  return {
    evaluableDays: evaluable.length,
    coveredDays,
    coverageFraction: evaluable.length === 0 ? 0 : coveredDays / evaluable.length,
    longestCoveredStreak: coveredStreaks[0] ?? 0,
    coveredStreaks,
    streaksReaching20: coveredStreaks.filter((run) => run >= MILESTONE_STREAK).length,
    entries: result.trades.length,
    entriesPerMonth:
      evaluable.length === 0
        ? 0
        : result.trades.length / (evaluable.length / TRADING_DAYS_PER_MONTH),
    medianHoldingBars: median(holdings),
    closedTrades: closed.length,
    openPositions: result.trades.length - closed.length,
    wins,
    winRate: closed.length === 0 ? null : wins / closed.length,
    averageReturn:
      returns.length === 0 ? null : returns.reduce((a, b) => a + b, 0) / returns.length,
    totalRealizedPnl: totalRealizedPnl.toFixed(2),
  };
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
