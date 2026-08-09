import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { insertSignal, transitionSignal } from '../src/db/signals.js';
import { authHeader, buildTestApp } from './helpers/api.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';

const db = testPrisma();

/** A snapshot the executor would accept, so `estimated_price` survives the read. */
function validSnapshot(estimatedPrice = '182.50') {
  return {
    schema_version: 1,
    estimated_price: estimatedPrice,
    alerts: [{ type: 'EQUITY_NOT_ENOUGH_BP', details: { buying_power: '10.00' } }],
    requested: { symbol: 'AAPL', side: 'buy', quantity: '2', type: 'market' },
    captured_at: '2026-08-08T12:00:00.000Z',
    raw: { ok: true },
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

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
  await closeTestPrisma();
});

async function get(url: string, options: InjectOptions = {}) {
  app ??= await buildTestApp();
  return app.inject({ method: 'GET', url, headers: authHeader(), ...options });
}

describe('GET /v1/signals', () => {
  it('lists pending signals with a computed expiry', async () => {
    const signal = await seedSignal();

    const response = await get('/v1/signals');
    expect(response.statusCode).toBe(200);

    const { signals } = response.json();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      id: signal.id,
      symbol: 'AAPL',
      side: 'buy',
      status: 'pending',
      execution_mode: 'paper',
      quantity: '2',
      estimated_price: '182.50',
      thesis_source: 'llm',
    });

    // expires_at is created_at + SIGNAL_EXPIRY_MINUTES (15 by default), not a
    // stored column — the sweep stays the authority on actual expiry.
    const elapsed =
      new Date(signals[0].expires_at).getTime() - new Date(signals[0].created_at).getTime();
    expect(elapsed).toBe(15 * 60_000);
  });

  it('defaults to pending and excludes decided signals', async () => {
    await seedSignal();
    const decided = await seedSignal({ dedupeKey: uniqueDedupeKey() });
    await transitionSignal(decided.id, 'rejected', 'not today', { prisma: db });

    const { signals } = (await get('/v1/signals')).json();

    expect(signals).toHaveLength(1);
    expect(signals[0].id).not.toBe(decided.id);
  });

  it('returns decided signals with their reason and no expiry', async () => {
    const signal = await seedSignal();
    await transitionSignal(signal.id, 'rejected', 'thesis was thin', { prisma: db });

    const { signals } = (await get('/v1/signals?status=decided')).json();

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      id: signal.id,
      status: 'rejected',
      decide_reason: 'thesis was thin',
      // A decided signal has no countdown; leaving expires_at populated would
      // render a ticking clock on something already settled.
      expires_at: null,
    });
    expect(signals[0].decided_at).not.toBeNull();
  });

  it('reports an unreadable review snapshot as a null price rather than failing the list', async () => {
    // A malformed snapshot must not cost the owner the whole approvals screen.
    // The executor is the layer that refuses to guess at a fill price.
    await seedSignal({ reviewSnapshot: { estimated_price: '182.50' } });

    const response = await get('/v1/signals');

    expect(response.statusCode).toBe(200);
    expect(response.json().signals[0].estimated_price).toBeNull();
  });

  it('reports an unrecognized thesis source as null, never as llm', async () => {
    await seedSignal({ thesisSource: 'some_future_source' as 'llm' });

    const { signals } = (await get('/v1/signals')).json();

    expect(signals[0].thesis_source).toBeNull();
  });

  it('rejects an out-of-range limit instead of silently clamping', async () => {
    const response = await get('/v1/signals?status=decided&limit=9999');

    expect(response.statusCode).toBe(400);
  });
});
