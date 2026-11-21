import { createHash } from 'node:crypto';
import type { StrategyConfig } from './strategy/index.js';

/**
 * Lives outside strategy/ on purpose: the decision functions may import
 * nothing but the decimal type, and a hash needs node:crypto.
 *
 * Bumped whenever the rule logic changes, as opposed to its configuration.
 *
 * - r1: RSI and MACD crossings plus the time stop.
 * - r2: the MACD exit fires only above cost (2026-11-21).
 * - r3: the stop loss exists (off unless STOP_LOSS_PCT is set).
 */
export const STRATEGY_RULES_REVISION = 3;

/**
 * Names the strategy that produced a signal: the rules revision plus a short
 * fingerprint of everything configurable that changes a decision, the
 * universe included. Two signals with the same version came from the same
 * rules under the same settings, so the track record can be split wherever
 * the strategy changed instead of blending versions into one win rate.
 *
 * Pure and order-insensitive: the keys are sorted before hashing, so an
 * unrelated change to how the config object is built cannot change it.
 */
export function strategyVersion(config: StrategyConfig, universe: readonly string[]): string {
  const settings = Object.fromEntries(
    Object.entries({ ...config, stopLossPct: config.stopLossPct ?? 0 }).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
  const canonical = JSON.stringify({ settings, universe: [...universe].sort() });
  const fingerprint = createHash('sha256').update(canonical).digest('hex').slice(0, 8);
  return `r${STRATEGY_RULES_REVISION}-${fingerprint}`;
}
