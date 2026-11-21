import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { setExecutionMode } from '../src/db/settings.js';
import { runPipeline } from '../src/orchestrator/pipeline.js';
import { MockBrokerAdapter } from '../src/orchestrator/robinhood/mockClient.js';
import { evaluateStopLoss } from '../src/orchestrator/strategy/exits.js';
import { templateThesis } from '../src/orchestrator/anthropic/thesis.js';
import type { Candle } from '../src/orchestrator/robinhood/client.js';
import { closeTestPrisma, resetDatabase, testPrisma } from './helpers/db.js';
import { pipelineConfig, quote, seedOpenLot, THROUGH_BULLISH_CROSS } from './helpers/factories.js';

const bar = (day: number, close: string, extra: Partial<Candle> = {}): Candle => ({
  t: new Date(Date.UTC(2026, 0, 1 + day)).toISOString(),
  o: close,
  h: close,
  l: close,
  c: close,
  v: 1000,
  ...extra,
});

describe('the stop loss rule', () => {
  const position = { quantity: '3', averageEntryPrice: '100' };

  it('is off when unset or zero', () => {
    const bars = [bar(0, '50')];
    expect(evaluateStopLoss('AAPL', bars, position, undefined)).toBeNull();
    expect(evaluateStopLoss('AAPL', bars, position, 0)).toBeNull();
  });

  it('stays quiet while the close is above the stop', () => {
    expect(evaluateStopLoss('AAPL', [bar(0, '92.01')], position, 0.08)).toBeNull();
  });

  it('fires exactly at the stop price and sells the whole position', () => {
    const stop = evaluateStopLoss('AAPL', [bar(0, '120'), bar(1, '92')], position, 0.08);

    expect(stop).not.toBeNull();
    expect(stop!.side).toBe('sell');
    expect(stop!.rule).toBe('stop_loss');
    expect(stop!.quantity).toBe('3');
    expect(stop!.barTime).toBe(bar(1, '92').t);
    expect(stop!.indicators).toEqual({
      close: 92,
      averageEntryPrice: 100,
      stopLossPct: 0.08,
      stopPrice: 92,
    });
  });

  it('reads the last bar that actually traded', () => {
    // A synthesized gap-fill bar never traded; its close cannot trigger anything.
    const bars = [bar(0, '95'), bar(1, '50', { interpolated: true })];
    expect(evaluateStopLoss('AAPL', bars, position, 0.08)).toBeNull();
  });

  it('gets its own thesis sentence, citing only what it read', () => {
    const stop = evaluateStopLoss('AAPL', [bar(1, '90')], position, 0.08)!;
    const text = templateThesis({ candidate: stop, estimatedPrice: '90.10' });

    expect(text).toContain('Sell 3 AAPL');
    expect(text).toContain('stop of 92');
    expect(text).toContain('8% under the average entry price of 100');
    expect(text).not.toMatch(/RSI|MACD/);
  });
});

describe('the stop loss in the pipeline', () => {
  const db = testPrisma();
  const logger = pino({ level: 'silent' });
  const now = new Date('2026-07-02T13:35:00Z');

  const deps = (overrides: Record<string, string>) => ({
    broker: new MockBrokerAdapter({
      candles: { AAPL: THROUGH_BULLISH_CROSS },
      quotes: { AAPL: quote('AAPL', '308.630000') },
    }),
    config: pipelineConfig({ MAX_HOLDING_DAYS: '0', ...overrides }),
    logger,
    prisma: db,
    clock: () => now,
    generateThesis: async () => ({ text: 'stop', source: 'fallback_template' as const }),
  });

  beforeEach(async () => {
    await resetDatabase();
    await setExecutionMode('paper', db);
  });

  afterAll(async () => {
    await closeTestPrisma();
  });

  it('outranks a buy cross on a position past the stop', async () => {
    // The last bar is a bullish MACD cross, which would otherwise propose
    // adding to a position that is already about 23% under cost.
    await seedOpenLot({ symbol: 'AAPL', quantity: '2', entryPrice: '400.00' }, db);

    const { signals } = await runPipeline(deps({ STOP_LOSS_PCT: '0.08' }));

    expect(signals).toHaveLength(1);
    expect(signals[0]!.side).toBe('sell');
    expect(signals[0]!.dedupeKey).toMatch(/^stop_loss:AAPL:sell:/);
    expect(signals[0]!.quantity.toString()).toBe('2');
  });

  it('changes nothing while it is off', async () => {
    await seedOpenLot({ symbol: 'AAPL', quantity: '2', entryPrice: '400.00' }, db);

    const { signals } = await runPipeline(deps({ STOP_LOSS_PCT: '0' }));

    expect(signals.map((s) => s.dedupeKey.split(':')[0])).toEqual(['macd_bullish_cross']);
  });

  it('stamps the strategy version, and the trigger freezes it', async () => {
    const { signals } = await runPipeline(deps({}));
    const signal = signals[0]!;

    expect(signal.strategyVersion).toMatch(/^r3-[0-9a-f]{8}$/);
    await expect(
      db.$executeRawUnsafe(`UPDATE signals SET strategy_version = 'r0-tampered' WHERE id = $1::uuid`, signal.id),
    ).rejects.toThrow(/OL001/);
  });
});
