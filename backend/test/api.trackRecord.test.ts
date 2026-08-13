import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { insertSignal } from '../src/db/signals.js';
import { appendTrackRecord, closeLots } from '../src/db/trackRecord.js';
import { authHeader, buildTestApp } from './helpers/api.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';

const db = testPrisma();
let app: FastifyInstance | null = null;

async function get() {
  app ??= await buildTestApp();
  return app.inject({ method: 'GET', url: '/v1/track-record', headers: authHeader() });
}

async function seedLot(quantity: string, entryPrice: string) {
  const signal = await insertSignal(
    {
      symbol: 'AAPL',
      side: 'buy',
      signalType: 'technical',
      quantity,
      thesis: null,
      thesisSource: 'llm',
      indicators: {},
      reviewSnapshot: { estimated_price: entryPrice },
      executionMode: 'paper',
      dedupeKey: uniqueDedupeKey(),
    },
    db,
  );
  await appendTrackRecord(
    { signalId: signal.id, entryPrice, status: 'open', recordedAt: new Date('2026-08-01T00:00:00Z') },
    db,
  );
  return signal;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
  await closeTestPrisma();
});

describe('GET /v1/track-record', () => {
  it('requires the owner token', async () => {
    app ??= await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/v1/track-record' });

    expect(response.statusCode).toBe(401);
  });

  it('reports nulls rather than zeros before anything has closed', async () => {
    await seedLot('2', '100.00');

    const body = (await get()).json();

    expect(body.closed_trades).toBe(0);
    expect(body.open_positions).toBe(1);
    // A claimed 0% win rate would be a statement about performance.
    expect(body.win_rate).toBeNull();
    expect(body.average_return).toBeNull();
  });

  it('reports a closed trade with hand-checkable numbers', async () => {
    const entry = await seedLot('2', '100.00');
    const exit = await seedLot('2', '110.00');
    await closeLots(
      {
        signalIds: [entry.id],
        exitPrice: '110.00',
        closedBySignalId: exit.id,
        recordedAt: new Date('2026-08-05T00:00:00Z'),
      },
      db,
    );

    const body = (await get()).json();

    // (110 - 100) x 2 = 20 realized; one trade, and it won.
    expect(body.closed_trades).toBe(1);
    expect(body.wins).toBe(1);
    expect(body.win_rate).toBe(1);
    expect(body.total_realized_pnl).toBe('20.00');
    // 20 / (100 x 2) = 10%.
    expect(body.average_return).toBeCloseTo(0.1, 10);
  });

  it('marks a curve day withheld when a lot went unmarked', async () => {
    await seedLot('2', '100.00');

    const body = (await get()).json();

    // The lot opened on the 1st and was never marked, so that day has no
    // honest total. It is reported as absent rather than approximated.
    const day = body.curve.find((p: { date: string }) => p.date === '2026-08-01');
    expect(day.withheld).toBe(true);
    expect(day.value).toBeNull();
  });
});
