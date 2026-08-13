import type { Signal } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import { listDevices, upsertDevice } from '../src/db/devices.js';
import { insertSignal } from '../src/db/signals.js';
import { runPipeline } from '../src/orchestrator/pipeline.js';
import type { ApnsClient, ApnsResult } from '../src/orchestrator/push/apns.js';
import { ApnsNotifier, buildNotifier, buildPayload } from '../src/orchestrator/push/notify.js';
import type { Candle } from '../src/orchestrator/robinhood/client.js';
import { MockBrokerAdapter } from '../src/orchestrator/robinhood/mockClient.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';
import fixture from './fixtures/ohlcv/AAPL-daily-2026.json' with { type: 'json' };

const db = testPrisma();
const silent = pino({ level: 'silent' });

/**
 * The same real-data fixture the pipeline integration test uses: bars through
 * 2026-07-02, where MACD crosses bullish and the strategy actually fires.
 * Without it the pipeline produces nothing and the assertion below would pass
 * vacuously.
 */
const ALL_BARS: Candle[] = fixture.results[0]!.bars.map((bar) => ({
  t: bar.begins_at,
  o: bar.open_price,
  h: bar.high_price,
  l: bar.low_price,
  c: bar.close_price,
  v: bar.volume,
}));
const THROUGH_BULLISH_CROSS = ALL_BARS.slice(
  0,
  ALL_BARS.findIndex((b) => b.t.startsWith('2026-07-02')) + 1,
);
const NOW = new Date('2026-07-02T13:35:00Z');

function pipelineConfig() {
  return buildConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    SYMBOL_ALLOWLIST: 'AAPL',
    ORDER_NOTIONAL_CENTS: '100000',
    MAX_POSITION_CENTS: '200000',
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv);
}

function validSnapshot() {
  return {
    schema_version: 1,
    estimated_price: '182.50',
    alerts: [],
    requested: { symbol: 'AAPL', side: 'buy', quantity: '2', type: 'market' },
    captured_at: '2026-08-09T12:00:00.000Z',
    raw: {},
  };
}

async function seedSignal(overrides: Partial<Parameters<typeof insertSignal>[0]> = {}) {
  return insertSignal(
    {
      symbol: 'AAPL',
      side: 'buy',
      signalType: 'technical',
      quantity: '2',
      thesis: 'RSI crossed below 30.',
      thesisSource: 'llm',
      indicators: {},
      reviewSnapshot: validSnapshot(),
      executionMode: 'paper',
      dedupeKey: uniqueDedupeKey(),
      ...overrides,
    },
    db,
  );
}

/** An ApnsClient stand-in whose result each test dictates. */
function fakeClient(result: ApnsResult | (() => ApnsResult)) {
  const sent: Array<{ deviceToken: string }> = [];
  const client = {
    send: vi.fn(async (notification: { deviceToken: string }) => {
      sent.push({ deviceToken: notification.deviceToken });
      return typeof result === 'function' ? result() : result;
    }),
    close: vi.fn(async () => {}),
  };
  return { client: client as unknown as ApnsClient, sent, spy: client.send };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestPrisma();
});

describe('buildPayload', () => {
  it('carries the order and the deadline, and nothing from the raw snapshot', async () => {
    const signal = await seedSignal();

    const payload = buildPayload(signal, 15);

    expect(payload.title).toBe('Buy AAPL');
    expect(payload.body).toContain('2 shares');
    expect(payload.body).toContain('182.50');
    expect(payload.body).toContain('15 min');
    expect(payload.data.signal_id).toBe(signal.id);
    // A lock screen is not the place for a broker's JSON.
    expect(JSON.stringify(payload)).not.toContain('schema_version');
  });

  it('still builds a payload when the snapshot is unreadable', async () => {
    const signal = await seedSignal({ reviewSnapshot: { nope: true } });

    const payload = buildPayload(signal, 15);

    expect(payload.title).toBe('Buy AAPL');
    expect(payload.data.estimated_price).toBeNull();
  });

  it('says share, not shares, for a single share', async () => {
    const signal = await seedSignal({ quantity: '1', dedupeKey: uniqueDedupeKey() });

    expect(buildPayload(signal, 15).body).toContain('1 share at');
  });
});

describe('ApnsNotifier', () => {
  const config = buildConfig();

  it('pushes to every registered device', async () => {
    await upsertDevice({ apnsToken: 'token-a', environment: 'production' }, db);
    await upsertDevice({ apnsToken: 'token-b', environment: 'sandbox' }, db);
    const signal = await seedSignal();
    const { client, sent } = fakeClient({ ok: true });

    await new ApnsNotifier(client, config, silent).notifyNewSignal(signal);

    expect(sent.map((s) => s.deviceToken).sort()).toEqual(['token-a', 'token-b']);
  });

  it('prunes a token the service reports as gone', async () => {
    await upsertDevice({ apnsToken: 'dead-token', environment: 'production' }, db);
    const signal = await seedSignal();
    const { client } = fakeClient({ ok: false, unregistered: true, reason: 'Unregistered' });

    await new ApnsNotifier(client, config, silent).notifyNewSignal(signal);

    expect(await listDevices(db)).toHaveLength(0);
  });

  it('keeps a token when the failure is transient', async () => {
    await upsertDevice({ apnsToken: 'live-token', environment: 'production' }, db);
    const signal = await seedSignal();
    const { client } = fakeClient({
      ok: false,
      unregistered: false,
      retryable: true,
      reason: 'ServiceUnavailable',
    });

    await new ApnsNotifier(client, config, silent).notifyNewSignal(signal);

    // A 503 is Apple's problem, not evidence the device is gone.
    expect(await listDevices(db)).toHaveLength(1);
  });

  it('swallows a thrown transport error', async () => {
    await upsertDevice({ apnsToken: 'token', environment: 'production' }, db);
    const signal = await seedSignal();
    const client = {
      send: vi.fn(async () => {
        throw new Error('socket exploded');
      }),
    } as unknown as ApnsClient;

    await expect(
      new ApnsNotifier(client, config, silent).notifyNewSignal(signal),
    ).resolves.toBeUndefined();
  });

  it('does nothing when no device is registered', async () => {
    const signal = await seedSignal();
    const { spy } = fakeClient({ ok: true });

    await new ApnsNotifier(
      { send: spy } as unknown as ApnsClient,
      config,
      silent,
    ).notifyNewSignal(signal);

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('buildNotifier', () => {
  it('is a no-op when APNs is unconfigured', async () => {
    // The default state. Push being off must never be an error.
    const notifier = buildNotifier(buildConfig(), silent);
    const signal = await seedSignal();

    await expect(notifier.notifyNewSignal(signal)).resolves.toBeUndefined();
  });
});

describe('push never blocks a signal', () => {
  it('persists the signal even when every push throws', async () => {
    await upsertDevice({ apnsToken: 'token', environment: 'production' }, db);

    const exploding = {
      async notifyNewSignal(): Promise<void> {
        throw new Error('push subsystem is on fire');
      },
    };

    const result = await runPipeline({
      broker: new MockBrokerAdapter({ candles: { AAPL: THROUGH_BULLISH_CROSS } }),
      config: pipelineConfig(),
      logger: silent,
      clock: () => NOW,
      prisma: db,
      generateThesis: async () => ({
        text: 'Stubbed thesis.',
        source: 'fallback_template' as const,
      }),
      notifier: exploding,
    });

    // The whole doctrine in one assertion: a notification failure cannot cost
    // the owner a signal.
    expect(result.status).toBe('completed');
    expect(result.signals.length).toBeGreaterThan(0);

    const persisted: Signal[] = await db.signal.findMany();
    expect(persisted.length).toBe(result.signals.length);
  });
});
