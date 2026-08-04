/**
 * RSI, EMA and MACD, implemented here rather than pulled from a package.
 *
 * The reason is the determinism claim in the PRD: the track record is only
 * credible if a signal can be replayed years later and produce the same
 * answer. That requires knowing exactly how each series is seeded and smoothed.
 * The obvious npm option is unmaintained and its warm-up conventions are not
 * documented, which would have put an unverifiable step inside the one part of
 * the system that must be verifiable.
 *
 * All three return arrays aligned to the input, with `null` for every bar
 * before the indicator has warmed up. Alignment matters: the rules compare a
 * bar against the one before it, and an off-by-one there is a signal that
 * fires on the wrong day.
 *
 * These operate on doubles. That is deliberate — see the note in money.ts.
 */

/**
 * Exponential moving average, seeded with the simple average of the first
 * `period` values (Wilder's convention, and the one the reference values in
 * test/fixtures/indicators agree with).
 */
export function ema(values: readonly number[], period: number): (number | null)[] {
  if (period <= 0) throw new RangeError('ema period must be positive');
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i]!;
  let previous = sum / period;
  out[period - 1] = previous;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    previous = (values[i]! - previous) * k + previous;
    out[i] = previous;
  }
  return out;
}

/**
 * Relative Strength Index using Wilder's smoothing: the first value is the
 * simple average of the first `period` changes, and every value after that
 * decays the previous average by (period-1)/period.
 *
 * A period with no losses gives RSI 100 by definition; there is no division by
 * zero to guard beyond that.
 */
export function rsi(closes: readonly number[], period: number): (number | null)[] {
  if (period <= 0) throw new RangeError('rsi period must be positive');
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = closes[i]! - closes[i - 1]!;
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i += 1) {
    const change = closes[i]! - closes[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }

  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdPoint {
  macd: number;
  signal: number | null;
  histogram: number | null;
}

/**
 * MACD: the difference between a fast and a slow EMA, its own EMA (the signal
 * line), and the gap between them (the histogram).
 *
 * The signal line is an EMA over the MACD series only from the bar where MACD
 * first exists — feeding it leading nulls or zeros would drag the early signal
 * line toward zero and manufacture a crossing that never happened.
 */
export function macd(
  closes: readonly number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): (MacdPoint | null)[] {
  if (fastPeriod >= slowPeriod) {
    throw new RangeError('macd fast period must be shorter than the slow period');
  }
  const out: (MacdPoint | null)[] = new Array(closes.length).fill(null);

  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);

  const macdValues: number[] = [];
  const macdIndices: number[] = [];
  for (let i = 0; i < closes.length; i += 1) {
    const f = fast[i];
    const s = slow[i];
    if (f === null || f === undefined || s === null || s === undefined) continue;
    macdValues.push(f - s);
    macdIndices.push(i);
  }

  const signalValues = ema(macdValues, signalPeriod);

  for (let j = 0; j < macdValues.length; j += 1) {
    const index = macdIndices[j]!;
    const macdValue = macdValues[j]!;
    const signalValue = signalValues[j] ?? null;
    out[index] = {
      macd: macdValue,
      signal: signalValue,
      histogram: signalValue === null ? null : macdValue - signalValue,
    };
  }

  return out;
}
