import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import { getConfig } from '../../config/index.js';
import { logger as rootLogger } from '../../logger.js';
import type { CandidateSignal, ExitIndicators, TechnicalIndicators } from '../strategy/index.js';

/**
 * Thesis generation — the only place an LLM touches this system, and it touches
 * only prose.
 *
 * PRD §3.1 draws the line: the trade is decided by pure functions before this
 * module is called, and nothing it returns can change the symbol, the side, the
 * quantity, or whether the signal exists. Claude is given the numbers the rules
 * already computed and asked to say them in English.
 *
 * Consequently this never throws and never blocks a signal. Every failure path
 * — network, timeout, refusal, empty response, missing API key — lands on a
 * deterministic template built from the same indicators. A signal without a
 * thesis is still a signal; a signal that never fired because an API was down
 * would be a bug.
 */

export type ThesisSource = 'llm' | 'fallback_template';

export interface ThesisResult {
  text: string;
  source: ThesisSource;
  /** Populated when the LLM path failed, for the run log. */
  failureReason?: string;
}

export interface ThesisInput {
  candidate: CandidateSignal;
  /** Estimated fill price from the review snapshot, decimal string. */
  estimatedPrice: string;
  /** Pre-trade alert types from the broker, if any. */
  reviewWarnings: readonly string[];
}

const SYSTEM_PROMPT = `You write the one-paragraph rationale that accompanies an equities trading signal.

The trade has already been decided by a deterministic rule engine. You are not evaluating it, and nothing you write changes it. Your job is to state, in plain English, what the indicators did.

Write 2-3 sentences. Use only the numbers in the data you are given. Do not introduce any number, price, date, or fact that is not in that data. Do not predict what the price will do, set a target, estimate a probability, or characterise the trade as good, bad, safe, or risky. Do not address the reader or give advice — no "you should", no "consider". Write it as a factual note a trader would leave for themselves.

Respond with the rationale text only: no preamble, no headings, no bullet points, no XML or internal tags.`;

export interface ThesisDeps {
  client?: Pick<Anthropic, 'messages'>;
  logger?: Logger;
  model?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * `max_tokens` covers thinking plus response text on this model family, so a
 * budget sized for three sentences would truncate the answer before it starts.
 * The output is capped by the prompt, not by this number.
 */
const MAX_TOKENS = 4096;

export async function generateThesis(
  input: ThesisInput,
  deps: ThesisDeps = {},
): Promise<ThesisResult> {
  const config = getConfig();
  const log = (deps.logger ?? rootLogger).child({ component: 'thesis' });
  const model = deps.model ?? config.anthropic.model;

  const fallback = (failureReason: string): ThesisResult => {
    const text = templateThesis(input);
    log.warn({ symbol: input.candidate.symbol, failureReason }, 'using template thesis');
    return { text, source: 'fallback_template', failureReason };
  };

  if (!config.anthropic.apiKey && !deps.client) {
    return fallback('ANTHROPIC_API_KEY is not set');
  }

  const client = deps.client ?? new Anthropic({ apiKey: config.anthropic.apiKey });
  const userContent = JSON.stringify(promptPayload(input));

  try {
    const response = await client.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
        // Naming the numbers in a fixed format is not a reasoning problem, and
        // the pipeline is waiting on this call.
        output_config: { effort: 'low' },
      },
      { timeout: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );

    // PRD §11: log the prompt and the completion on every call, so a published
    // thesis can always be traced back to what produced it.
    log.info(
      {
        symbol: input.candidate.symbol,
        model,
        prompt: userContent,
        stop_reason: response.stop_reason,
        usage: response.usage,
      },
      'thesis request completed',
    );

    if (response.stop_reason === 'refusal') {
      return fallback('model declined the request');
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (text.length === 0) return fallback('model returned no text');

    log.info({ symbol: input.candidate.symbol, thesis: text }, 'thesis generated');
    return { text, source: 'llm' };
  } catch (error) {
    return fallback(error instanceof Error ? error.message : String(error));
  }
}

/** Narrows the union so each rule family cites only what it actually read. */
function isExitIndicators(
  indicators: TechnicalIndicators | ExitIndicators,
): indicators is ExitIndicators {
  return 'barsHeld' in indicators;
}


function exitPayload(
  indicators: TechnicalIndicators | ExitIndicators,
): Record<string, unknown> | null {
  if (!isExitIndicators(indicators)) return null;
  return {
    bars_held: indicators.barsHeld,
    max_holding_period_bars: indicators.maxHoldingDays,
  };
}

function technicalPayload(indicators: TechnicalIndicators | ExitIndicators): Record<string, unknown> {
  const i = indicators as TechnicalIndicators;
  return {
    rsi: round(i.rsi, 1),
    rsi_previous_bar: round(i.rsiPrev, 1),
    rsi_period: i.rsiPeriod,
    rsi_oversold_threshold: i.rsiOversold,
    rsi_overbought_threshold: i.rsiOverbought,
    macd_line: round(i.macd, 2),
    macd_signal_line: round(i.macdSignal, 2),
    macd_histogram: round(i.macdHistogram, 2),
    macd_histogram_previous_bar: round(i.macdHistogramPrev, 2),
    close: round(i.close, 2),
    close_previous_bar: round(i.closePrev, 2),
  };
}

/** Exactly the numbers the rule used — nothing else is available to cite. */
function promptPayload(input: ThesisInput): Record<string, unknown> {
  const { candidate } = input;
  return {
    symbol: candidate.symbol,
    side: candidate.side,
    quantity: candidate.quantity,
    rule: candidate.rule,
    estimated_price: input.estimatedPrice,
    review_warnings: input.reviewWarnings,
    // A time stop consulted no indicators, so it is given none. Handing the
    // model zeroed-out RSI and MACD fields would invite a thesis citing a
    // crossing that never happened — the one thing the narration must never do.
    indicators: exitPayload(candidate.indicators) ?? technicalPayload(candidate.indicators),
    decision_bar: candidate.barTime,
  };
}

/**
 * The deterministic fallback. Reads like the LLM output because it is built
 * from the same numbers — the difference is only in the phrasing, and
 * `thesis_source` on the signal records which path produced it.
 */
export function templateThesis(input: ThesisInput): string {
  const { candidate } = input;

  // A time stop has its own sentence because it has its own reason. Reusing the
  // indicator phrasing would state an RSI and a MACD figure that played no part
  // in the decision, in a record that is meant to explain why the trade fired.
  if (isExitIndicators(candidate.indicators)) {
    const { barsHeld, maxHoldingDays } = candidate.indicators;
    const warnings =
      input.reviewWarnings.length > 0
        ? ` Broker pre-trade alerts: ${input.reviewWarnings.join(', ')}.`
        : '';
    return (
      `Sell ${candidate.quantity} ${candidate.symbol} at an estimated ${input.estimatedPrice}. ` +
      `The position has been held ${barsHeld} trading days, reaching the ${maxHoldingDays}-day ` +
      `maximum holding period. No entry or exit rule fired; this exit is the holding ` +
      `period alone.${warnings}`
    );
  }

  const i = candidate.indicators;
  const rsi = round(i.rsi, 1);
  const rsiPrev = round(i.rsiPrev, 1);
  const hist = round(i.macdHistogram, 2);
  const histPrev = round(i.macdHistogramPrev, 2);

  const trigger = (() => {
    switch (candidate.rule) {
      case 'rsi_oversold':
        return `RSI(${i.rsiPeriod}) fell from ${rsiPrev} to ${rsi}, crossing below the oversold threshold of ${i.rsiOversold}`;
      case 'rsi_overbought':
        return `RSI(${i.rsiPeriod}) rose from ${rsiPrev} to ${rsi}, crossing above the overbought threshold of ${i.rsiOverbought}`;
      case 'macd_bullish_cross':
        return `the MACD histogram turned positive, moving from ${histPrev} to ${hist}`;
      case 'macd_bearish_cross':
        return `the MACD histogram turned negative, moving from ${histPrev} to ${hist}`;
    }
  })();

  const verb = candidate.side === 'buy' ? 'Buy' : 'Sell';
  const warnings =
    input.reviewWarnings.length > 0
      ? ` Broker pre-trade alerts: ${input.reviewWarnings.join(', ')}.`
      : '';

  return (
    `${verb} ${candidate.quantity} ${candidate.symbol} at an estimated ${input.estimatedPrice}. ` +
    `On the bar closing ${candidate.barTime}, ${trigger}. ` +
    `RSI(${i.rsiPeriod}) is ${rsi} and the MACD histogram is ${hist}.${warnings}`
  );
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
