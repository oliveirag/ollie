import { sharesForNotional } from '../../money.js';
import { macd, rsi } from './indicators.js';
import {
  TECHNICAL_RULES,
  dedupeKeyFor,
  type Candle,
  type CandidateSignal,
  type EvaluationResult,
  type PositionContext,
  type StrategyConfig,
  type TechnicalIndicators,
  type TechnicalRule,
} from './types.js';

export { dedupeKeyFor };

/**
 * The decision function. This is the part of Ollie that decides whether to
 * trade, and it is a pure function of the bars handed to it: no network, no
 * clock, no randomness, no database, no LLM. Give it the same candles and the
 * configuration and it returns the same answer, today or in three years.
 *
 * That constraint is what makes the track record defensible, so it is worth
 * being explicit about what is deliberately *not* here:
 *
 * - **Timestamps.** The pipeline stamps them. Reading a clock in here would
 *   make the function unreplayable.
 * - **Position awareness.** A sell rule can fire with no position to sell.
 *   Long-only gating is the risk gate's job (risk.ts), because it depends on
 *   live account state, which is not an input to a decision about price.
 * - **Dedupe.** The rules will happily fire on the same bar twice. The
 *   pipeline and a unique database constraint handle that.
 */
export function evaluateTechnical(
  symbol: string,
  candles: readonly Candle[],
  config: StrategyConfig,
  /** Read by the exit rules only; entries are unaffected by what is held. */
  position?: PositionContext,
): EvaluationResult {
  // Synthesized gap-fill bars carry no information — a fabricated close would
  // produce a fabricated crossing. The pipeline drops them too; doing it here
  // as well means no caller can hand a rule a bar that never traded.
  const bars = candles.filter((candle) => candle.interpolated !== true);

  const warmup = requiredBars(config);
  if (bars.length < warmup) {
    return { candidate: null, skipReason: 'insufficient_history', indicators: null, barTime: null };
  }

  const closes = bars.map((bar) => Number(bar.c));
  const rsiSeries = rsi(closes, config.rsiPeriod);
  const macdSeries = macd(closes, config.macdFast, config.macdSlow, config.macdSignal);

  const last = bars.length - 1;
  const prev = last - 1;

  const rsiNow = rsiSeries[last];
  const rsiPrev = rsiSeries[prev];
  const macdNow = macdSeries[last];
  const macdPrev = macdSeries[prev];

  if (
    rsiNow == null ||
    rsiPrev == null ||
    macdNow?.signal == null ||
    macdNow.histogram == null ||
    macdPrev?.signal == null ||
    macdPrev.histogram == null
  ) {
    return { candidate: null, skipReason: 'insufficient_history', indicators: null, barTime: null };
  }

  const barTime = bars[last]!.t;
  const referenceClose = bars[last]!.c;

  const indicators: TechnicalIndicators = {
    rsi: rsiNow,
    rsiPrev,
    rsiPeriod: config.rsiPeriod,
    rsiOversold: config.rsiOversold,
    rsiOverbought: config.rsiOverbought,
    macd: macdNow.macd,
    macdSignal: macdNow.signal,
    macdHistogram: macdNow.histogram,
    macdPrev: macdPrev.macd,
    macdSignalPrev: macdPrev.signal,
    macdHistogramPrev: macdPrev.histogram,
    macdFast: config.macdFast,
    macdSlow: config.macdSlow,
    macdSignalPeriod: config.macdSignal,
    close: closes[last]!,
    closePrev: closes[prev]!,
  };

  const fired = firstRuleThatFires(indicators);
  if (!fired) {
    return { candidate: null, skipReason: 'no_rule_fired', indicators, barTime };
  }

  // Sizing depends on which way the trade goes, because the two sides answer
  // different questions. An entry asks "how much should I buy" — a function of
  // the configured notional. An exit asks "how much do I hold" — a fact about
  // the position, and nothing else.
  let quantity: string;
  if (fired.side === 'sell') {
    const held = Number(position?.openQuantity ?? '0');
    if (!(held > 0)) {
      // Long-only: a sell is only ever a close. With nothing held there is no
      // trade to propose, and asking the owner to approve one the risk gate
      // would certainly refuse is worse than staying quiet.
      return { candidate: null, skipReason: 'no_open_position', indicators, barTime };
    }
    // Deliberately not notional-sized, and deliberately not subject to the
    // rounds-to-zero check below: on a symbol priced above one order notional
    // that check would suppress every exit, leaving a position the rules could
    // open and never close.
    quantity = position!.openQuantity;
  } else {
    const shares = sharesForNotional(config.orderNotionalCents, referenceClose);
    if (shares < 1) {
      // One share costs more than the configured order size. Not an error —
      // a $500 order simply cannot buy a $900 stock, and rounding up would
      // silently exceed a cap the owner set.
      return { candidate: null, skipReason: 'quantity_rounds_to_zero', indicators, barTime };
    }
    quantity = String(shares);
  }

  const candidate: CandidateSignal = {
    symbol,
    side: fired.side,
    signalType: 'technical',
    quantity,
    rule: fired.rule,
    indicators,
    barTime,
    referenceClose,
  };

  return { candidate, skipReason: null, indicators, barTime };
}

interface FiredRule {
  rule: TechnicalRule;
  side: 'buy' | 'sell';
}

/**
 * Rules are evaluated in one fixed order and the first match wins.
 *
 * Two of them can be true on the same bar — a washout day can put RSI below 30
 * while the MACD histogram is still turning negative — and "whichever the loop
 * happened to reach" is not a decision anyone can defend later. The order in
 * TECHNICAL_RULES is the tie-break, and it is stable.
 *
 * Every rule is a *crossing*: it compares the previous bar to this one. A
 * level test ("RSI is below 30") would re-fire every day for as long as the
 * condition held, proposing the same trade over and over.
 */
function firstRuleThatFires(i: TechnicalIndicators): FiredRule | null {
  for (const rule of TECHNICAL_RULES) {
    switch (rule) {
      case 'rsi_oversold':
        if (i.rsiPrev >= i.rsiOversold && i.rsi < i.rsiOversold) return { rule, side: 'buy' };
        break;
      case 'macd_bullish_cross':
        if (i.macdHistogramPrev <= 0 && i.macdHistogram > 0) return { rule, side: 'buy' };
        break;
      case 'rsi_overbought':
        if (i.rsiPrev <= i.rsiOverbought && i.rsi > i.rsiOverbought) return { rule, side: 'sell' };
        break;
      case 'macd_bearish_cross':
        if (i.macdHistogramPrev >= 0 && i.macdHistogram < 0) return { rule, side: 'sell' };
        break;
    }
  }
  return null;
}

/**
 * Bars needed before both indicators have a value on the current *and* the
 * previous bar, which every crossing rule requires. MACD is the binding
 * constraint: its signal line is an EMA over a series that itself only starts
 * once the slow EMA exists.
 */
export function requiredBars(config: StrategyConfig): number {
  const forRsi = config.rsiPeriod + 2;
  const forMacd = config.macdSlow + config.macdSignal;
  return Math.max(forRsi, forMacd);
}
