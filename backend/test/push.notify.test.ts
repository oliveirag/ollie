import type { Signal } from '@prisma/client';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import { listDevices, upsertDevice } from '../src/db/devices.js';
import { insertSignal, type InsertSignalInput } from '../src/db/signals.js';
import { runPipeline } from '../src/orchestrator/pipeline.js';
import type { ApnsClient, ApnsResult } from '../src/orchestrator/push/apns.js';
import {
  ApnsNotifier,
  PUSH_CATEGORY,
  buildNotifier,
  buildPayload,
  buildReminderPayload,
} from '../src/orchestrator/push/notify.js';
import { MockBrokerAdapter } from '../src/orchestrator/robinhood/mockClient.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';
import { envConfig, signalInput, THROUGH_BULLISH_CROSS, validSnapshot } from './helpers/factories.js';

const db = testPrisma();
const silent = pino({ level: 'silent' });

const NOW = new Date('2026-07-02T13:35:00Z');

const pipelineConfig = () =>
  envConfig({ ORDER_NOTIONAL_CENTS: '100000', MAX_POSITION_CENTS: '200000' });

async function seedSignal(overrides: Partial<InsertSignalInput> = {}) {
  return insertSignal(
    signalInput({
      thesis: 'RSI crossed below 30.',
      reviewSnapshot: validSnapshot({ captured_at: '2026-08-09T12:00:00.000Z' }),
      ...overrides,
    }),
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

// 16:00 EDT on a session day.
const CLOSE = new Date('2026-08-10T20:00:00.000Z');

describe('buildPayload', () => {
  it('carries the order and the deadline, and nothing from the raw snapshot', async () => {
    const signal = await seedSignal();

    const payload = buildPayload(signal, CLOSE);

    expect(payload.title).toBe('Buy AAPL');
    expect(payload.body).toContain('2 shares');
    expect(payload.body).toContain('182.50');
    expect(payload.body).toContain('Decide by 4:00 PM ET');
    expect(payload.data.signal_id).toBe(signal.id);
    expect(payload.data.kind).toBe('new_signal');
    expect(payload.data.expires_at).toBe(CLOSE.toISOString());
    // A lock screen is not the place for a broker's JSON.
    expect(JSON.stringify(payload)).not.toContain('schema_version');
  });

  it('still builds a payload when the snapshot is unreadable', async () => {
    const signal = await seedSignal({ reviewSnapshot: { nope: true } });

    const payload = buildPayload(signal, CLOSE);

    expect(payload.title).toBe('Buy AAPL');
    expect(payload.data.estimated_price).toBeNull();
  });

  it('says share, not shares, for a single share', async () => {
    const signal = await seedSignal({ quantity: '1' });

    expect(buildPayload(signal, CLOSE).body).toContain('1 share at');
  });

  it('offers approve and decline on a paper signal, decline only on a live one', async () => {
    const paper = await seedSignal();
    const live = await seedSignal({ executionMode: 'live', dedupeKey: uniqueDedupeKey() });

    expect(buildPayload(paper, CLOSE).category).toBe(PUSH_CATEGORY.paper);
    expect(buildPayload(live, CLOSE).category).toBe(PUSH_CATEGORY.live);
    expect(buildPayload(live, CLOSE).data.execution_mode).toBe('live');
  });
});

describe('buildReminderPayload', () => {
  it('says the signal is still undecided and when it expires', async () => {
    const signal = await seedSignal();

    const payload = buildReminderPayload(signal, CLOSE);

    expect(payload.title).toBe('Still undecided: Buy AAPL');
    expect(payload.body).toContain('2 shares at ~182.50');
    expect(payload.body).toContain('Expires at 4:00 PM ET');
    expect(payload.data.kind).toBe('reminder');
    expect(payload.data.signal_id).toBe(signal.id);
    expect(payload.category).toBe(PUSH_CATEGORY.paper);
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

  it('sends the reminder with the signal as its collapse id and the action category', async () => {
    await upsertDevice({ apnsToken: 'token-a', environment: 'production' }, db);
    const signal = await seedSignal();
    const { client, spy } = fakeClient({ ok: true });

    await new ApnsNotifier(client, config, silent).remindPendingSignal(signal, CLOSE);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      title: 'Still undecided: Buy AAPL',
      collapseId: signal.id,
      category: PUSH_CATEGORY.paper,
    });
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
      async remindPendingSignal(): Promise<void> {
        throw new Error('push subsystem is on fire');
      },
    };

    const result = await runPipeline({
      // Bars through 2026-07-02, where MACD crosses bullish and the strategy
      // actually fires. Without them the pipeline produces nothing and the
      // assertion below would pass vacuously.
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
