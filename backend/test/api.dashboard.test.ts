import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getAppSettings, setKillSwitch } from '../src/db/settings.js';
import { insertSignal } from '../src/db/signals.js';
import { appendTrackRecord, listOpenLots } from '../src/db/trackRecord.js';
import { runPipeline } from '../src/orchestrator/pipeline.js';
import type { Quote } from '../src/orchestrator/robinhood/client.js';
import { MockBrokerAdapter } from '../src/orchestrator/robinhood/mockClient.js';
import { authHeader, buildTestApp, testConfig } from './helpers/api.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';

const db = testPrisma();
const silentLogger = pino({ level: 'silent' });

/** A full Quote pinned to one last-trade price; the rest is filler. */
function quote(symbol: string, lastTradePrice: string): Quote {
  return {
    symbol,
    lastTradePrice,
    bidPrice: lastTradePrice,
    askPrice: lastTradePrice,
    previousClose: lastTradePrice,
    officialClose: lastTradePrice,
    hasTraded: true,
    state: 'active',
  };
}

async function seedOpenLot(overrides: {
  symbol?: string;
  side?: 'buy' | 'sell';
  quantity?: string;
  entryPrice?: string;
} = {}) {
  const signal = await insertSignal(
    {
      symbol: overrides.symbol ?? 'AAPL',
      side: overrides.side ?? 'buy',
      signalType: 'technical',
      quantity: overrides.quantity ?? '2',
      thesis: null,
      thesisSource: 'llm',
      indicators: {},
      reviewSnapshot: { estimated_price: '100.00' },
      executionMode: 'paper',
      dedupeKey: uniqueDedupeKey(),
    },
    db,
  );
  await appendTrackRecord(
    { signalId: signal.id, entryPrice: overrides.entryPrice ?? '100.00', status: 'open' },
    db,
  );
  return signal;
}

let app: FastifyInstance | null = null;

async function dashboard(broker?: MockBrokerAdapter) {
  await app?.close();
  app = await buildTestApp({}, broker ?? new MockBrokerAdapter());
  return app.inject({ method: 'GET', url: '/v1/dashboard', headers: authHeader() });
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await app?.close();
  await closeTestPrisma();
});

describe('GET /v1/dashboard', () => {
  it('returns zeroed totals with no open positions', async () => {
    const response = await dashboard();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      lots: [],
      totals: { cost_basis: '0.00', market_value: '0.00', unrealized_pnl: '0.00' },
    });
  });

  it('computes unrealized PnL for a buy lot from the current quote', async () => {
    await seedOpenLot({ symbol: 'AAPL', quantity: '2', entryPrice: '100.00' });
    const broker = new MockBrokerAdapter({ quotes: { AAPL: quote('AAPL', '110.00') } });

    const body = (await dashboard(broker)).json();

    expect(body.lots).toHaveLength(1);
    expect(body.lots[0]).toMatchObject({
      symbol: 'AAPL',
      // Verbatim from the database — Decimal does not pad trailing zeros, and
      // padding here would mean rounding a 4-decimal fill price elsewhere.
      entry_price: '100',
      quote: '110.00',
      unrealized_pnl: '20.00',
    });
    expect(body.totals).toMatchObject({
      cost_basis: '200.00',
      market_value: '220.00',
      unrealized_pnl: '20.00',
    });
  });

  it('reports realized PnL as zero until Phase 3', async () => {
    await seedOpenLot();
    const broker = new MockBrokerAdapter({ quotes: { AAPL: quote('AAPL', '150.00') } });

    // Nothing closes a position yet, so any other number would be invented.
    expect((await dashboard(broker)).json().totals.realized_pnl).toBe('0.00');
  });

  it('degrades to entry basis when the broker is unreachable', async () => {
    await seedOpenLot();
    const broker = new MockBrokerAdapter();
    broker.getQuotes = async () => {
      throw new Error('broker down');
    };

    const response = await dashboard(broker);

    // The positions are database truth; a broker outage must not cost the
    // owner the whole screen.
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.quotes_available).toBe(false);
    expect(body.lots[0]).toMatchObject({ quote: null, unrealized_pnl: null });
    expect(body.totals.cost_basis).toBe('200.00');
    expect(body.totals.market_value).toBeNull();
  });

  it('withholds totals when only some lots are quoted', async () => {
    await seedOpenLot({ symbol: 'AAPL' });
    await seedOpenLot({ symbol: 'MSFT' });

    // The mock fills in a default quote for any symbol it is asked about, so a
    // genuine gap has to be forced: the broker answering about one symbol and
    // simply omitting the other is what a thin real response looks like.
    const broker = new MockBrokerAdapter();
    broker.getQuotes = async () => ({ AAPL: quote('AAPL', '110.00') });

    const body = (await dashboard(broker)).json();

    // A partial sum understates the portfolio, which is worse than no number.
    expect(body.totals.market_value).toBeNull();
    expect(body.totals.unrealized_pnl).toBeNull();
    expect(body.totals.cost_basis).toBe('400.00');
  });

  it('profits a sell lot when the price falls', async () => {
    await seedOpenLot({ symbol: 'AAPL', side: 'sell', quantity: '2', entryPrice: '100.00' });
    const broker = new MockBrokerAdapter({ quotes: { AAPL: quote('AAPL', '90.00') } });

    expect((await dashboard(broker)).json().lots[0].unrealized_pnl).toBe('20.00');
  });
});

describe('listOpenLots', () => {
  it('does not resurrect a position closed by a later row', async () => {
    // The append-only trap: filtering for status='open' before taking the
    // latest row per signal would return the stale open row forever.
    const signal = await seedOpenLot();
    await appendTrackRecord(
      {
        signalId: signal.id,
        entryPrice: '100.00',
        exitPrice: '120.00',
        realizedPnl: '40.00',
        status: 'closed',
        recordedAt: new Date(Date.now() + 1000),
      },
      db,
    );

    expect(await listOpenLots(db)).toHaveLength(0);
  });
});

describe('kill switch through the API', () => {
  it('halts the next pipeline run before its first broker call', async () => {
    const app = await buildTestApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: authHeader(),
        payload: { kill_switch: true },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().kill_switch).toBe(true);
      expect((await getAppSettings(db)).killSwitch).toBe(true);
    } finally {
      await app.close();
    }

    const broker = new MockBrokerAdapter();
    const result = await runPipeline({
      broker,
      config: testConfig(),
      logger: silentLogger,
      prisma: db,
    });

    expect(result.status).toBe('halted_kill_switch');
    // The switch has to stop the run before it touches the broker, not merely
    // before it writes a signal — that is the difference between a halt and a
    // filter (PRD §8).
    expect(broker.calls).toHaveLength(0);
  });
});

describe('GET/PUT /v1/settings', () => {
  it('reports the live gate as read-only', async () => {
    const app = await buildTestApp();
    try {
      const body = (
        await app.inject({ method: 'GET', url: '/v1/settings', headers: authHeader() })
      ).json();

      expect(body).toMatchObject({
        kill_switch: false,
        execution_mode: 'paper',
        live_trading_enabled: false,
      });
    } finally {
      await app.close();
    }
  });

  it('refuses live mode while LIVE_TRADING_ENABLED is false', async () => {
    const app = await buildTestApp({ liveTradingEnabled: false });
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: authHeader(),
        payload: { execution_mode: 'live' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('live_mode_not_enabled');
      // The refusal must not have partially applied.
      expect((await getAppSettings(db)).executionMode).toBe('paper');
    } finally {
      await app.close();
    }
  });

  it('rejects an empty update rather than silently doing nothing', async () => {
    const app = await buildTestApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: authHeader(),
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('turns the kill switch back off', async () => {
    await setKillSwitch(true, db);
    const app = await buildTestApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/v1/settings',
        headers: authHeader(),
        payload: { kill_switch: false },
      });

      expect(response.statusCode).toBe(200);
      expect((await getAppSettings(db)).killSwitch).toBe(false);
    } finally {
      await app.close();
    }
  });
});
