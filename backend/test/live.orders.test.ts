import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listExecutions } from '../src/db/executions.js';
import { latestOrderForSignal, listOpenOrders } from '../src/db/liveOrders.js';
import { setExecutionMode, setKillSwitch } from '../src/db/settings.js';
import { getSignal, insertSignal } from '../src/db/signals.js';
import { latestTrackRecord, listOpenLots } from '../src/db/trackRecord.js';
import { pollOpenOrders } from '../src/orchestrator/orders.js';
import { sweepUnpublishedSignals } from '../src/orchestrator/publish.js';
import { MockBrokerAdapter, type OrderScript } from '../src/orchestrator/robinhood/mockClient.js';
import { GetEquityOrdersSchema } from '../src/orchestrator/robinhood/types.js';
import { computeTrackRecord } from '../src/orchestrator/trackRecordStats.js';
import { listAllTrackRecordRows } from '../src/db/trackRecord.js';
import { authHeader, buildTestApp, testConfig } from './helpers/api.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';

/**
 * Phase 5, milestones 5.1–5.3: the live order path, exercised end to end in
 * paper against a mock broker with scripted order lifecycles. Nothing here
 * touches a real broker; the real adapter's `placeEquityOrder` is reached by
 * exactly one function and that is asserted separately.
 */

const db = testPrisma();
const logger = pino({ level: 'silent' });

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/mcp/equity-order.json'), 'utf8'),
) as Record<string, unknown>;

function liveConfig() {
  return testConfig({ liveTradingEnabled: true });
}

async function seedLive(side: 'buy' | 'sell' = 'buy', quantity = '2') {
  return insertSignal(
    {
      symbol: 'AAPL',
      side,
      signalType: 'technical',
      quantity,
      thesis: 'live test',
      thesisSource: 'llm',
      indicators: {},
      reviewSnapshot: {
        schema_version: 1,
        estimated_price: '182.50',
        alerts: [],
        requested: { symbol: 'AAPL', side, quantity, type: 'market' },
        captured_at: '2026-10-01T13:35:00.000Z',
        raw: {},
      },
      executionMode: 'live',
      dedupeKey: uniqueDedupeKey('live'),
    },
    db,
  );
}

const FILLS: Record<string, OrderScript> = {
  fill: { states: [{ state: 'confirmed' }, { state: 'filled', cumulativeQuantity: '2', averagePrice: '182.6825' }] },
  partial: {
    states: [
      { state: 'confirmed' },
      { state: 'partially_filled', cumulativeQuantity: '1', averagePrice: '182.70' },
      { state: 'cancelled', cumulativeQuantity: '1', averagePrice: '182.70' },
    ],
  },
  reject: { states: [{ state: 'confirmed' }, { state: 'rejected', cumulativeQuantity: '0', averagePrice: null }] },
  stuck: { states: [{ state: 'confirmed' }] },
};

let app: FastifyInstance | null = null;
let mock: MockBrokerAdapter;

async function liveApp(script: OrderScript | null) {
  await app?.close();
  mock = new MockBrokerAdapter(script ? { orderScripts: { AAPL: script } } : {});
  app = await buildTestApp({ liveTradingEnabled: true }, mock);
  return app;
}

async function approve(id: string, body: Record<string, unknown> = { action: 'approve', confirm_live: true }) {
  return app!.inject({ method: 'POST', url: `/v1/signals/${id}/decision`, headers: authHeader(), payload: body });
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
  await closeTestPrisma();
});

describe('the order fixture', () => {
  it.each(['filled', 'partial_then_cancelled', 'rejected', 'confirmed'])('parses the %s payload', (key) => {
    const parsed = GetEquityOrdersSchema.parse(fixture[key]);
    expect(parsed.orders).toHaveLength(1);
  });

  it('refuses a payload with no state', () => {
    expect(() => GetEquityOrdersSchema.parse({ orders: [{ id: 'x' }] })).toThrow();
  });
});

describe('the three gates in front of a live order', () => {
  it('409s without LIVE_TRADING_ENABLED', async () => {
    await liveApp(FILLS.fill!);
    await app!.close();
    app = await buildTestApp({ liveTradingEnabled: false }, mock);
    await setExecutionMode('live', db);
    const signal = await seedLive();

    const response = await approve(signal.id);

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('live_mode_not_enabled');
    expect((await getSignal(signal.id, db))?.status).toBe('pending');
  });

  it('409s while app_settings.execution_mode is paper', async () => {
    await liveApp(FILLS.fill!);
    const signal = await seedLive();

    const response = await approve(signal.id);

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('live_mode_not_enabled');
  });

  it('409s without confirm_live, leaving the signal pending and the broker untouched', async () => {
    await liveApp(FILLS.fill!);
    await setExecutionMode('live', db);
    const signal = await seedLive();

    for (const body of [{ action: 'approve' }, { action: 'approve', confirm_live: false }]) {
      const response = await approve(signal.id, body);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('live_confirmation_required');
    }
    expect((await getSignal(signal.id, db))?.status).toBe('pending');
    expect(mock.callsTo('placeEquityOrder')).toHaveLength(0);
  });

  it('still lets a paper signal through without confirm_live', async () => {
    await liveApp(FILLS.fill!);
    await setExecutionMode('live', db);
    const paper = await insertSignal(
      {
        symbol: 'AAPL', side: 'buy', signalType: 'technical', quantity: '2', thesis: null, thesisSource: 'llm',
        indicators: {}, reviewSnapshot: { schema_version: 1, estimated_price: '100', alerts: [], requested: { symbol: 'AAPL', side: 'buy', quantity: '2', type: 'market' }, captured_at: 'x', raw: {} },
        executionMode: 'paper', dedupeKey: uniqueDedupeKey(),
      },
      db,
    );
    const response = await approve(paper.id, { action: 'approve' });
    expect(response.statusCode).toBe(200);
    expect(response.json().execution.mode).toBe('paper');
    expect(response.json().order).toBeNull();
    expect(mock.callsTo('placeEquityOrder')).toHaveLength(0);
  });

  it('refuses while the kill switch is on', async () => {
    await liveApp(FILLS.fill!);
    await setExecutionMode('live', db);
    await setKillSwitch(true, db);
    const signal = await seedLive();
    const response = await approve(signal.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('kill_switch_engaged');
    expect(mock.callsTo('placeEquityOrder')).toHaveLength(0);
  });
});

describe('approving a live signal', () => {
  it('reviews again, places with the ref_id, returns the order, and writes no execution', async () => {
    await liveApp(FILLS.fill!);
    await setExecutionMode('live', db);
    const signal = await seedLive();

    const response = await approve(signal.id);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.execution).toBeNull();
    expect(body.order).toMatchObject({ broker_order_id: 'mock-order-1', state: 'confirmed', terminal_at: null });
    expect(body.signal.status).toBe('approved');
    expect(body.signal.published).toBe(false);
    expect(body.signal.order.state).toBe('confirmed');

    // Review before place, on the same terms (PRD §3.5), then place with the key.
    expect(mock.callsTo('reviewEquityOrder').at(-1)!.args).toMatchObject({ symbol: 'AAPL', side: 'buy', quantity: '2' });
    expect(mock.callsTo('placeEquityOrder')[0]!.args).toMatchObject({ refId: signal.refId, quantity: '2' });

    expect(await listExecutions(signal.id, db)).toHaveLength(0);
    expect(await latestTrackRecord(signal.id, db)).toBeNull();
    expect((await latestOrderForSignal(signal.id, db))?.refId).toBe(signal.refId);
  });
});

describe('the order poll', () => {
  it('records the fill, opens the lot, and publishes — once', async () => {
    await liveApp(FILLS.fill!);
    await setExecutionMode('live', db);
    const signal = await seedLive();
    await approve(signal.id);

    // The feed must not see it before the fill.
    expect((await getSignal(signal.id, db))?.published).toBe(false);
    expect(await sweepUnpublishedSignals({ logger, prisma: db })).toEqual([]);

    const now = new Date('2026-10-01T13:36:05.000Z');
    const first = await pollOpenOrders({ broker: mock, logger, prisma: db, now: () => now });
    expect(first).toMatchObject({ polled: 1, filled: 1, endedUnfilled: 0, errors: 0 });

    const [execution] = await listExecutions(signal.id, db);
    expect(execution).toMatchObject({ mode: 'live', brokerOrderId: 'mock-order-1' });
    expect(execution!.fillPrice.toString()).toBe('182.6825');
    expect(execution!.quantity.toString()).toBe('2');

    const lot = await latestTrackRecord(signal.id, db);
    expect(lot?.status).toBe('open');
    expect(lot?.entryPrice.toString()).toBe('182.6825');
    expect(lot?.quantity).toBeNull(); // full fill: the signal's quantity applies

    const after = await getSignal(signal.id, db);
    expect(after?.published).toBe(true);
    expect(after?.publishedAt).toEqual(now);

    expect((await latestOrderForSignal(signal.id, db))?.terminalAt).toEqual(now);
    expect(await listOpenOrders(db)).toEqual([]);

    // Idempotent: nothing left to poll, nothing duplicated.
    const second = await pollOpenOrders({ broker: mock, logger, prisma: db });
    expect(second.polled).toBe(0);
    expect(await listExecutions(signal.id, db)).toHaveLength(1);
  });

  it('records a partial fill at the filled quantity when the order goes terminal', async () => {
    await liveApp(FILLS.partial!);
    await setExecutionMode('live', db);
    const signal = await seedLive('buy', '2');
    await approve(signal.id);

    // partially_filled, not terminal: wait.
    const first = await pollOpenOrders({ broker: mock, logger, prisma: db });
    expect(first).toMatchObject({ polled: 1, filled: 0 });
    expect(await listExecutions(signal.id, db)).toHaveLength(0);
    expect((await latestOrderForSignal(signal.id, db))?.state).toBe('partially_filled');

    // cancelled with 1 of 2 filled: that share is real.
    const second = await pollOpenOrders({ broker: mock, logger, prisma: db });
    expect(second).toMatchObject({ polled: 1, filled: 1, endedUnfilled: 0 });
    const [execution] = await listExecutions(signal.id, db);
    expect(execution!.quantity.toString()).toBe('1');

    const lot = await latestTrackRecord(signal.id, db);
    expect(lot?.quantity?.toString()).toBe('1');
    const [open] = await listOpenLots(db);
    expect(open).toMatchObject({ quantity: '1', quantityOverridden: true });

    // The stats see one share, not the signal's two.
    const stats = computeTrackRecord(await listAllTrackRecordRows(db));
    expect(stats.openPositions).toBe(1);
    expect((await listAllTrackRecordRows(db))[0]!.quantity).toBe('1');
    expect((await getSignal(signal.id, db))?.published).toBe(true);
  });

  it('marks a rejected order terminal with no execution, and the feed never sees it', async () => {
    await liveApp(FILLS.reject!);
    await setExecutionMode('live', db);
    const signal = await seedLive();
    await approve(signal.id);

    const result = await pollOpenOrders({ broker: mock, logger, prisma: db });
    expect(result).toMatchObject({ polled: 1, filled: 0, endedUnfilled: 1 });

    expect(await listExecutions(signal.id, db)).toHaveLength(0);
    expect(await latestTrackRecord(signal.id, db)).toBeNull();
    const after = await getSignal(signal.id, db);
    expect(after?.status).toBe('approved');
    expect(after?.published).toBe(false);
    expect((await latestOrderForSignal(signal.id, db))?.terminalAt).not.toBeNull();
    expect(await sweepUnpublishedSignals({ logger, prisma: db })).toEqual([]);
  });

  it('keeps polling an order that has not resolved', async () => {
    await liveApp(FILLS.stuck!);
    await setExecutionMode('live', db);
    const signal = await seedLive();
    await approve(signal.id);

    for (let i = 0; i < 3; i += 1) {
      const result = await pollOpenOrders({ broker: mock, logger, prisma: db });
      expect(result).toMatchObject({ polled: 1, filled: 0, endedUnfilled: 0 });
    }
    expect(await listOpenOrders(db)).toHaveLength(1);
    expect(await listExecutions(signal.id, db)).toHaveLength(0);
  });

  it('runs with the kill switch on, because a fill that happened is a fact', async () => {
    await liveApp(FILLS.fill!);
    await setExecutionMode('live', db);
    const signal = await seedLive();
    await approve(signal.id);
    await setKillSwitch(true, db);

    const result = await pollOpenOrders({ broker: mock, logger, prisma: db });
    expect(result.filled).toBe(1);
    expect(await listExecutions(signal.id, db)).toHaveLength(1);
  });

  it('closes a lot FIFO on a live sell fill', async () => {
    await liveApp(FILLS.fill!);
    await setExecutionMode('live', db);
    const entry = await seedLive('buy');
    await approve(entry.id);
    await pollOpenOrders({ broker: mock, logger, prisma: db });

    const exit = await seedLive('sell');
    const response = await approve(exit.id);
    expect(response.statusCode).toBe(200);
    await pollOpenOrders({ broker: mock, logger, prisma: db });

    const closed = await latestTrackRecord(entry.id, db);
    expect(closed?.status).toBe('closed');
    expect(closed?.closedBySignalId).toBe(exit.id);
    expect(closed?.exitPrice?.toString()).toBe('182.6825');
    expect(await listOpenLots(db)).toEqual([]);
  });
});

describe('live_since', () => {
  it('is null until a live signal publishes, then the first one\'s published_at on both sides', async () => {
    await liveApp(FILLS.fill!);
    const before = (await app!.inject({ method: 'GET', url: '/v1/track-record', headers: authHeader() })).json();
    expect(before.live_since).toBeNull();

    await setExecutionMode('live', db);
    const signal = await seedLive();
    await approve(signal.id);
    const now = new Date('2026-10-01T13:36:05.000Z');
    await pollOpenOrders({ broker: mock, logger, prisma: db, now: () => now });

    const after = (await app!.inject({ method: 'GET', url: '/v1/track-record', headers: authHeader() })).json();
    expect(after.live_since).toBe(now.toISOString());
  });
});
