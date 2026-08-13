export { ema, macd, rsi, type MacdPoint } from './indicators.js';
export { evaluateTechnical, requiredBars, dedupeKeyFor } from './technical.js';
export { evaluateExit, type HeldLot } from './exits.js';
export {
  EXIT_RULES,
  TECHNICAL_RULES,
  type Candle,
  type CandidateSignal,
  type EvaluationResult,
  type ExitIndicators,
  type ExitRule,
  type SkipReason,
  type StrategyConfig,
  type TechnicalIndicators,
  type SignalRule,
  type TechnicalRule,
} from './types.js';
