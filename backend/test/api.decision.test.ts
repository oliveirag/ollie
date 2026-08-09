import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listExecutions } from '../src/db/executions.js';
import { setExecutionMode, setKillSwitch } from '../src/db/settings.js';
import { getSignal, insertSignal, listSignalEvents } from '../src/db/signals.js';
import { latestTrackRecord } from '../src/db/trackRecord.js';
import { sweepExpiredSignals } from '../src/orchestrator/pipeline.js';
import { authHeader, buildTestApp, testConfig } from './helpers/api.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';

const db = testPrisma();
const silentLogger = pino({ level: 'silent' });

function validSnapshot(estimatedPrice = '100.00') {
  return {
    schema_version: 1,
    estimated_price: estimatedPrice,
    alerts: [],
    requested: { symbol: 'AAPL', side: 'buy', quantity: '2', type: 'market' },
    captured_at: '2026-08-08T12:00:00.000Z',
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
      thesis: 'RSI(14) crossed below 30.',
      thesisSource: 'llm',
      indicators: { rsi14: 27.3 },
      reviewSnapshot: validSnapshot(),
      executionMode: 'paper',
      dedupeKey: uniqueDedupeKey(),
      ...overrides,
    },
    db,
  );
}

let app: FastifyInstance;

async function getApp(): Promise<FastifyInstance> {
  app ??= await buildTestApp();
  return app;
}

async function decide(id: string, body: { action: string; reason?: string }) {
  return (await getApp()).inject({
    method: 'POST',
    url: `/v1/signals/${id}/decision`,
    headers: authHeader(),
    payload: body,
  });
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
  await closeTestPrisma();
});

describe('POST /v1/signals/:id/decision — approve', () => {
  it('records a paper fill and opens a track-record position', async () => {
    const signal = await seedSignal();

    const response = await decide(signal.id, { action: 'approve', reason: 'looks right' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.signal.status).toBe('approved');
    expect(body.signal.decide_reason).toBe('looks right');
    expect(body.execution.mode).toBe('paper');
    expect(body.execution.broker_order_id).toBeNull();

    // Slippage is applied against the trader: a buy fills above the estimate.
    const { slippageBps } = testConfig();
    const expected = (100 * (1 + slippageBps / 10_000)).toFixed(2);
    expect(Number(body.execution.fill_price)).toBeCloseTo(Number(expected), 2);

    const track = await latestTrackRecord(signal.id, db);
    expect(track?.status).toBe('open');
    expect(track?.entryPrice.toString()).toBe(body.execution.fill_price);
  });

  it('writes exactly one execution row', async () => {
    const signal = await seedSignal();
    await decide(signal.id, { action: 'approve' });

    expect(await listExecutions(signal.id, db)).toHaveLength(1);
  });

  it('records the transition in the append-only audit', async () => {
    const signal = await seedSignal();
    await decide(signal.id, { action: 'approve', reason: 'audit me' });

    const events = await listSignalEvents(signal.id, db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromStatus: 'pending',
      toStatus: 'approved',
      reason: 'audit me',
    });
  });
});

describe('POST /v1/signals/:id/decision — reject', () => {
  it('keeps the record with its reason and executes nothing', async () => {
    const signal = await seedSignal();

    const response = await decide(signal.id, { action: 'reject', reason: 'thesis is thin' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      signal: { status: 'rejected', decide_reason: 'thesis is thin' },
      execution: null,
    });

    expect(await listExecutions(signal.id, db)).toHaveLength(0);
    expect(await latestTrackRecord(signal.id, db)).toBeNull();
  });
});

describe('POST /v1/signals/:id/decision — default reason', () => {
  it.each([
    ['approve', 'approved'],
    ['reject', 'rejected'],
  ])('writes a grammatical default reason for %s', async (action, expected) => {
    // The default reason is persisted into the append-only audit, so a typo
    // here is permanent. Both branches, because only one of them reads
    // correctly if the string is built by appending to the action verb.
    const signal = await seedSignal();

    const response = await decide(signal.id, { action });

    expect(response.statusCode).toBe(200);
    expect(response.json().signal.decide_reason).toBe(`${expected} from the owner app`);

    const events = await listSignalEvents(signal.id, db);
    expect(events[0]?.reason).toBe(`${expected} from the owner app`);
  });
});

describe('POST /v1/signals/:id/decision — exactly once', () => {
  it('rejects a second decision with 409 and the current status', async () => {
    const signal = await seedSignal();
    await decide(signal.id, { action: 'approve' });

    const second = await decide(signal.id, { action: 'reject' });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'signal_not_pending', status: 'approved' });
    // The first decision's fill is not duplicated by the second attempt.
    expect(await listExecutions(signal.id, db)).toHaveLength(1);
  });

  it('surfaces a signal the expiry sweep already claimed', async () => {
    // The race the owner actually hits: they tap approve on a signal the sweep
    // expired a moment earlier. Exactly one transition must win, and the app
    // must be told which.
    const signal = await seedSignal();

    // Advance the sweep's clock rather than backdating created_at — the
    // immutability triggers refuse that write, correctly, so the only honest
    // way to age a signal is to move "now".
    const config = testConfig();
    const expired = await sweepExpiredSignals({
      config,
      logger: silentLogger,
      prisma: db,
      clock: () => new Date(Date.now() + (config.signalExpiryMinutes + 1) * 60_000),
    });
    expect(expired.map((s) => s.id)).toContain(signal.id);

    const response = await decide(signal.id, { action: 'approve' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'signal_not_pending', status: 'expired' });
    expect(await listExecutions(signal.id, db)).toHaveLength(0);
  });

  it('returns 404 for a signal that does not exist', async () => {
    const response = await decide('00000000-0000-4000-8000-000000000000', { action: 'approve' });

    expect(response.statusCode).toBe(404);
  });

  it('rejects a malformed action before touching the signal', async () => {
    const signal = await seedSignal();

    const response = await decide(signal.id, { action: 'maybe' });

    expect(response.statusCode).toBe(400);
    expect((await getSignal(signal.id, db))?.status).toBe('pending');
  });
});

describe('POST /v1/signals/:id/decision — gates', () => {
  it('refuses to approve while the kill switch is on, leaving the signal pending', async () => {
    const signal = await seedSignal();
    await setKillSwitch(true, db);

    const response = await decide(signal.id, { action: 'approve' });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('kill_switch_engaged');

    // The important half: the signal did not burn its one allowed transition,
    // so the owner can still approve it once the switch is off.
    expect((await getSignal(signal.id, db))?.status).toBe('pending');
    expect(await listExecutions(signal.id, db)).toHaveLength(0);
  });

  it('still allows rejecting while the kill switch is on', async () => {
    // The switch blocks execution, not the owner's ability to clear the queue.
    const signal = await seedSignal();
    await setKillSwitch(true, db);

    const response = await decide(signal.id, { action: 'reject', reason: 'halted' });

    expect(response.statusCode).toBe(200);
    expect((await getSignal(signal.id, db))?.status).toBe('rejected');
  });

  it('refuses to approve a live-mode signal until Phase 5', async () => {
    const signal = await seedSignal({ executionMode: 'live' });
    await setExecutionMode('live', db);

    const response = await decide(signal.id, { action: 'approve' });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('live_mode_not_enabled');
    expect((await getSignal(signal.id, db))?.status).toBe('pending');
    expect(await listExecutions(signal.id, db)).toHaveLength(0);
  });
});

describe('GET /v1/signals/:id', () => {
  it('returns indicators, the parsed review, and the status history', async () => {
    const signal = await seedSignal({
      reviewSnapshot: {
        ...validSnapshot('123.45'),
        alerts: [{ type: 'EQUITY_NOT_ENOUGH_BP', details: { buying_power: '1.00' } }],
      },
    });
    await decide(signal.id, { action: 'reject', reason: 'no thanks' });

    const response = await (
      await getApp()
    ).inject({ method: 'GET', url: `/v1/signals/${signal.id}`, headers: authHeader() });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.indicators).toEqual({ rsi14: 27.3 });
    expect(body.review.estimated_price).toBe('123.45');
    expect(body.review.alerts[0].type).toBe('EQUITY_NOT_ENOUGH_BP');
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      from_status: 'pending',
      to_status: 'rejected',
      reason: 'no thanks',
    });
  });

  it('returns a null review rather than failing on an unreadable snapshot', async () => {
    const signal = await seedSignal({ reviewSnapshot: { estimated_price: '1.00' } });

    const response = await (
      await getApp()
    ).inject({ method: 'GET', url: `/v1/signals/${signal.id}`, headers: authHeader() });

    expect(response.statusCode).toBe(200);
    expect(response.json().review).toBeNull();
  });

  it('404s on an unknown id and 400s on a non-uuid', async () => {
    const app = await getApp();
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/signals/00000000-0000-4000-8000-000000000000',
      headers: authHeader(),
    });
    const malformed = await app.inject({
      method: 'GET',
      url: '/v1/signals/not-a-uuid',
      headers: authHeader(),
    });

    expect(missing.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(400);
  });
});
