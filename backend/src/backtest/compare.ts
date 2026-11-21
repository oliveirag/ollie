import type { RiskConfig } from '../config/index.js';
import type { Candle, StrategyConfig } from '../orchestrator/strategy/index.js';
import { simulate, type BacktestResult } from './simulate.js';

/**
 * Comparing strategy variants without fooling ourselves.
 *
 * A variant is the production strategy with some configuration overridden.
 * Nothing here encodes a rule: every run goes through `simulate`, which calls
 * the same decision functions the pipeline does. What this module adds is the
 * discipline around the comparison, fixed before any result is seen:
 *
 * - **Windows.** A change is chosen on one stretch of history and confirmed on
 *   another. Picking on 2019-22 and checking 2023-26 is what keeps a variant
 *   that fits one market's noise from looking like an edge.
 * - **Uncertainty.** Every expectancy difference comes with a bootstrap
 *   interval. A few hundred trades cannot tell a $1 edge from luck, and an
 *   interval that spans zero says so out loud.
 * - **Drawdown next to profit.** A protective rule is expected to cost a
 *   little expectancy and buy a smaller worst case; both numbers are needed to
 *   judge it.
 */

export interface Variant {
  name: string;
  strategy?: Partial<StrategyConfig>;
  risk?: Partial<RiskConfig>;
}

export interface Window {
  label: string;
  /** ISO date, inclusive. */
  from: string;
  /** ISO date, exclusive. */
  to: string;
}

/**
 * The windows the strategy revision plan fixed on 2026-11-21. The older ones
 * apply only when the bars reach back far enough to warm up before them.
 */
export const PLAN_WINDOWS: readonly Window[] = [
  { label: 'older era 2006-18', from: '2006-01-01', to: '2019-01-01' },
  { label: 'GFC 2008', from: '2008-01-01', to: '2009-01-01' },
  { label: 'in-sample 2019-22', from: '2019-01-01', to: '2023-01-01' },
  { label: 'out-of-sample 2023+', from: '2023-01-01', to: '2100-01-01' },
  { label: 'bear 2022', from: '2022-01-01', to: '2023-01-01' },
];

export interface WindowStats {
  trades: number;
  winRate: number | null;
  /** Mean realized P&L per closed trade, dollars. */
  expectancy: number | null;
  totalPnl: number;
  profitFactor: number | null;
  /** Largest peak-to-trough fall of realized plus open P&L, dollars. */
  maxDrawdown: number;
  /** Worst single closed trade, as a fraction of its entry. */
  worstReturn: number | null;
  /** Mean worst excursion while held, as a fraction of entry. */
  meanAdverseExcursion: number | null;
  /** Realized P&L of each closed trade, for the bootstrap. */
  pnls: number[];
}

export interface VariantInputs {
  bars: Readonly<Record<string, readonly Candle[]>>;
  strategy: StrategyConfig;
  risk: RiskConfig;
  slippageBps: number;
  approvalRate?: number;
  seed?: number;
  /** CANDLE_LOOKBACK_DAYS, so each bar sees the history production would. */
  lookbackDays?: number;
}

export function runVariant(inputs: VariantInputs, variant: Variant, window: Window): BacktestResult {
  return simulate({
    bars: inputs.bars,
    strategy: { ...inputs.strategy, ...variant.strategy },
    risk: { ...inputs.risk, ...variant.risk },
    slippageBps: inputs.slippageBps,
    ...(inputs.approvalRate === undefined ? {} : { approvalRate: inputs.approvalRate }),
    ...(inputs.seed === undefined ? {} : { seed: inputs.seed }),
    ...(inputs.lookbackDays === undefined ? {} : { lookbackDays: inputs.lookbackDays }),
    entryWindow: { from: window.from, to: window.to },
  });
}

export function windowStats(result: BacktestResult, window: Window): WindowStats {
  const closed = result.trades.filter((trade) => trade.realizedPnl !== null);
  const pnls = closed.map((trade) => Number(trade.realizedPnl));
  const wins = pnls.filter((pnl) => pnl > 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -pnls.filter((pnl) => pnl <= 0).reduce((a, b) => a + b, 0);
  const returns = closed.map((trade) => Number(trade.exitPrice) / Number(trade.entryPrice) - 1);
  const totalPnl = pnls.reduce((a, b) => a + b, 0);

  let peak = 0;
  let maxDrawdown = 0;
  for (const day of result.days) {
    if (day.barTime < window.from) continue;
    const equity = Number(day.equity);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }

  return {
    trades: closed.length,
    winRate: closed.length === 0 ? null : wins.length / closed.length,
    expectancy: closed.length === 0 ? null : totalPnl / closed.length,
    totalPnl,
    profitFactor: grossLoss === 0 ? null : grossWin / grossLoss,
    maxDrawdown,
    worstReturn: returns.length === 0 ? null : Math.min(...returns),
    meanAdverseExcursion:
      closed.length === 0
        ? null
        : closed.reduce((sum, trade) => sum + trade.maxAdverseExcursion, 0) / closed.length,
    pnls,
  };
}

/**
 * 90% interval for mean(a) - mean(b), resampling each side independently.
 * Seeded, so the same inputs print the same interval every run. Null when
 * either side has no trades.
 */
export function bootstrapMeanDifference(
  a: readonly number[],
  b: readonly number[],
  options: { iterations?: number; seed?: number } = {},
): [number, number] | null {
  if (a.length === 0 || b.length === 0) return null;
  const iterations = options.iterations ?? 2000;
  const next = seeded(options.seed ?? 7);
  const resampledMean = (xs: readonly number[]): number => {
    let sum = 0;
    for (let i = 0; i < xs.length; i++) sum += xs[Math.floor(next() * xs.length)]!;
    return sum / xs.length;
  };

  const diffs: number[] = [];
  for (let k = 0; k < iterations; k++) diffs.push(resampledMean(a) - resampledMean(b));
  diffs.sort((x, y) => x - y);
  return [diffs[Math.floor(iterations * 0.05)]!, diffs[Math.floor(iterations * 0.95)]!];
}

/**
 * Windows the bars can support. Every symbol has to be warmed up before a
 * window's first entries, or the basket would quietly shrink inside it. A
 * window the bars only partly cover is kept, relabelled with the date its
 * entries can actually start; one they cannot reach at all is dropped.
 */
export function supportedWindows(
  bars: Readonly<Record<string, readonly Candle[]>>,
  windows: readonly Window[] = PLAN_WINDOWS,
  warmupBars = 35,
): Window[] {
  const starts = Object.values(bars)
    .map((series) => series[Math.min(warmupBars, series.length - 1)]?.t)
    .filter((t): t is string => t !== undefined)
    .sort();
  const latestWarm = starts.at(-1)?.slice(0, 10);
  if (latestWarm === undefined) return [];
  return windows
    .filter((window) => latestWarm < window.to)
    .map((window) =>
      latestWarm <= window.from
        ? window
        : { ...window, label: `${window.label} (from ${latestWarm})`, from: latestWarm },
    );
}

function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
