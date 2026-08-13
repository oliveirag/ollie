import type { Candle } from '../robinhood/client.js';

export type { Candle };

/** The rules this version can fire, in the fixed order they are evaluated. */
export const TECHNICAL_RULES = [
  'rsi_oversold',
  'macd_bullish_cross',
  'rsi_overbought',
  'macd_bearish_cross',
] as const;

export type TechnicalRule = (typeof TECHNICAL_RULES)[number];

/**
 * What the strategy proposes, before any risk cap, review, or thesis. It is
 * not a signal yet — a candidate becomes a signal only once it has survived
 * the risk gate and has a review snapshot attached.
 */
export interface CandidateSignal {
  symbol: string;
  side: 'buy' | 'sell';
  signalType: 'technical';
  /** Whole shares as a decimal string. */
  quantity: string;
  rule: TechnicalRule;
  /**
   * Every input the rule looked at, including the previous bar's values. This
   * is what makes a signal replayable and what the thesis is written from —
   * the LLM is given these numbers and may not introduce others.
   */
  indicators: TechnicalIndicators;
  /** Close time of the bar the decision was made on. Feeds the dedupe key. */
  barTime: string;
  /** The close used for sizing, as a decimal string. */
  referenceClose: string;
}

export interface TechnicalIndicators {
  rsi: number;
  rsiPrev: number;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  macdPrev: number;
  macdSignalPrev: number;
  macdHistogramPrev: number;
  macdFast: number;
  macdSlow: number;
  macdSignalPeriod: number;
  close: number;
  closePrev: number;
  [key: string]: number;
}

export interface StrategyConfig {
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  orderNotionalCents: number;
}

/** Why no candidate was produced. Logged per symbol; never persisted. */
export type SkipReason =
  | 'insufficient_history'
  | 'no_rule_fired'
  | 'quantity_rounds_to_zero'
  | 'no_open_position';

/**
 * Position state the exit rules read. Entries ignore it entirely.
 *
 * This is the input that makes exit decisions impure with respect to OHLCV
 * (Phase 3 plan, decision 3). Replayability survives because the position
 * record is append-only: the holding at any past moment is reconstructible, so
 * the same bars plus the same record still give the same answer.
 */
export interface PositionContext {
  /** Shares currently held for this symbol, as a decimal string. */
  openQuantity: string;
}

export interface EvaluationResult {
  candidate: CandidateSignal | null;
  skipReason: SkipReason | null;
  /** Present whenever the indicators warmed up, fired or not. */
  indicators: TechnicalIndicators | null;
  barTime: string | null;
}

/** Dedupe identity of a candidate: one rule, one symbol, one side, one bar. */
export function dedupeKeyFor(candidate: CandidateSignal): string {
  return `${candidate.rule}:${candidate.symbol}:${candidate.side}:${candidate.barTime}`;
}
