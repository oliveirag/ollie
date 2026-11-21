import { describe, expect, it } from 'vitest';
import { STRATEGY_RULES_REVISION, strategyVersion } from '../src/orchestrator/strategyVersion.js';
import type { StrategyConfig } from '../src/orchestrator/strategy/index.js';

const CONFIG: StrategyConfig = {
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  orderNotionalCents: 50_000,
  maxHoldingDays: 30,
  stopLossPct: 0,
};

describe('strategyVersion', () => {
  it('leads with the rules revision', () => {
    expect(strategyVersion(CONFIG, ['AAPL'])).toMatch(new RegExp(`^r${STRATEGY_RULES_REVISION}-[0-9a-f]{8}$`));
  });

  it('ignores key order and universe order', () => {
    const reordered = Object.fromEntries(Object.entries(CONFIG).reverse()) as unknown as StrategyConfig;
    expect(strategyVersion(reordered, ['MSFT', 'AAPL'])).toBe(strategyVersion(CONFIG, ['AAPL', 'MSFT']));
  });

  it('treats a missing stop as no stop', () => {
    const { stopLossPct: _ignored, ...withoutStop } = CONFIG;
    expect(strategyVersion(withoutStop, ['AAPL'])).toBe(strategyVersion(CONFIG, ['AAPL']));
  });

  it('changes when a setting or the universe changes', () => {
    const base = strategyVersion(CONFIG, ['AAPL']);
    expect(strategyVersion({ ...CONFIG, stopLossPct: 0.08 }, ['AAPL'])).not.toBe(base);
    expect(strategyVersion({ ...CONFIG, maxHoldingDays: 20 }, ['AAPL'])).not.toBe(base);
    expect(strategyVersion(CONFIG, ['AAPL', 'SPY'])).not.toBe(base);
  });
});
