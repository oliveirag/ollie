import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordExecution } from '../src/db/executions.js';
import { insertSignal, publishSignal, transitionSignal } from '../src/db/signals.js';
import { appendTrackRecord } from '../src/db/trackRecord.js';
import { DISCLAIMER_VERSION } from '../src/published/disclaimer.js';
import { FORBIDDEN_FIELDS } from '../src/published/signal.js';
import { MCP_TOOL_NAMES } from '../src/signal-server/mcp.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';
import { bearer, buildTestSignalApp, signIn } from './helpers/signalApi.js';

/**
 * The §4.5 battery, from the client side: a real MCP SDK client over real
 * HTTP against the listening service. The surface snapshot, the bodyless
 * 401, and tool round-trips against seeded rows.
 */

const db = testPrisma();
let app: FastifyInstance;
let baseUrl: string;

async function seedPublished(when: Date, overrides: Partial<Parameters<typeof insertSignal>[0]> = {}) {
  const signal = await insertSignal(
    {
      symbol: 'AAPL',
      side: 'buy',
      signalType: 'technical',
      quantity: '2',
      thesis: 'RSI(14) crossed below 30.',
      thesisSource: 'llm',
      indicators: { rsi: 27.3 },
      reviewSnapshot: {
        schema_version: 1,
        estimated_price: '100.00',
        alerts: [{ type: 'CANARY_ALERT', details: {} }],
        requested: { symbol: 'AAPL', side: 'buy', quantity: '2', type: 'market' },
        captured_at: when.toISOString(),
        raw: { account: 'CANARY_ACCOUNT' },
      },
      executionMode: 'paper',
      dedupeKey: uniqueDedupeKey(),
      ...overrides,
    },
    db,
  );
  await transitionSignal(signal.id, 'approved', 'approved', { prisma: db, now: when });
  await recordExecution(
    { signalId: signal.id, mode: 'paper', fillPrice: '100.10', quantity: '2', filledAt: when },
    db,
  );
  if (signal.side === 'buy') {
    await appendTrackRecord(
      { signalId: signal.id, entryPrice: '100.10', status: 'open', recordedAt: when },
      db,
    );
  }
  return publishSignal(signal.id, { prisma: db, now: when });
}

/** Onboard a subscriber and mint an MCP token; returns both plaintexts. */
async function mintMcpToken(sub = 'agent-owner'): Promise<{ app: string; mcp: string; id: string }> {
  const appToken = await signIn(app, sub);
  await app.inject({
    method: 'POST',
    url: '/v1/disclaimer/accept',
    headers: bearer(appToken),
    payload: { version: DISCLAIMER_VERSION },
  });
  const minted = (await app.inject({ method: 'POST', url: '/v1/mcp-tokens', headers: bearer(appToken) })).json();
  return { app: appToken, mcp: minted.token, id: minted.id };
}

async function connect(token: string | null): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    ...(token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}),
  });
  await client.connect(transport as Parameters<Client['connect']>[0]);
  return client;
}

function structured(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

beforeAll(async () => {
  app = await buildTestSignalApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await app.close();
  await closeTestPrisma();
});

describe('the surface', () => {
  it('lists exactly the four read-only tools, and nothing else', async () => {
    const { mcp } = await mintMcpToken();
    const client = await connect(mcp);
    try {
      const { tools } = await client.listTools();
      // The snapshot. Adding a tool fails here until this array is changed in
      // review — that is the acceptance criterion for PRD §4.5.
      expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES]);
      expect([...MCP_TOOL_NAMES]).toEqual(['get_disclaimer', 'get_signal', 'get_track_record', 'list_signals']);
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
        expect(tool.name).not.toMatch(/order|account|position|watchlist|quote|place|cancel|buy|sell/);
      }
    } finally {
      await client.close();
    }
  });

  it('carries the disclaimer in the server instructions', async () => {
    const { mcp } = await mintMcpToken();
    const client = await connect(mcp);
    try {
      const instructions = client.getInstructions() ?? '';
      expect(instructions).toContain('not financial advice');
      expect(instructions).toContain('nothing here can touch any brokerage account');
      expect(instructions).toContain(DISCLAIMER_VERSION);
    } finally {
      await client.close();
    }
  });

  it('exposes no resources and no prompts', async () => {
    const { mcp } = await mintMcpToken();
    const client = await connect(mcp);
    try {
      const capabilities = client.getServerCapabilities();
      expect(capabilities?.resources).toBeUndefined();
      expect(capabilities?.prompts).toBeUndefined();
    } finally {
      await client.close();
    }
  });
});

describe('unauthenticated requests return nothing', () => {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
  };

  async function post(token: string | null): Promise<Response> {
    return fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(initialize),
    });
  }

  it.each([
    ['no header', async () => null],
    ['a garbage token', async () => 'ollie_mcp_' + 'f'.repeat(64)],
    ['an app token', async () => (await mintMcpToken('app-holder')).app],
    [
      'a revoked token',
      async () => {
        const minted = await mintMcpToken('revoker');
        await app.inject({ method: 'DELETE', url: `/v1/mcp-tokens/${minted.id}`, headers: bearer(minted.app) });
        return minted.mcp;
      },
    ],
  ])('%s: 401 with an empty body and no tool list', async (_label, tokenFor) => {
    const response = await post(await tokenFor());
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('');
    expect(response.headers.get('www-authenticate')).toBeNull();

    await expect(connect(await tokenFor())).rejects.toThrow();
  });

  it('401s GET and DELETE the same way', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${baseUrl}/mcp`, { method });
      expect(response.status, method).toBe(401);
      expect(await response.text()).toBe('');
    }
  });

  it('cuts an agent off the moment its token is revoked', async () => {
    const minted = await mintMcpToken();
    const client = await connect(minted.mcp);
    try {
      expect((await client.listTools()).tools.length).toBe(4);
      await app.inject({ method: 'DELETE', url: `/v1/mcp-tokens/${minted.id}`, headers: bearer(minted.app) });
      await expect(client.listTools()).rejects.toThrow();
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

describe('the tools', () => {
  it('list_signals matches the REST feed exactly', async () => {
    const older = await seedPublished(new Date('2026-09-01T14:00:00Z'));
    const newer = await seedPublished(new Date('2026-09-02T14:00:00Z'), { symbol: 'MSFT' });
    const { app: appToken, mcp } = await mintMcpToken();

    const rest = (await app.inject({ method: 'GET', url: '/v1/feed', headers: bearer(appToken) })).json();
    const client = await connect(mcp);
    try {
      const result = structured(await client.callTool({ name: 'list_signals', arguments: {} }));
      expect(result).toEqual(rest);
      expect((result.signals as { id: string }[]).map((s) => s.id)).toEqual([newer.id, older.id]);
      for (const field of FORBIDDEN_FIELDS) expect((result.signals as object[])[0]).not.toHaveProperty(field);
      expect(JSON.stringify(result)).not.toContain('CANARY');

      const since = structured(
        await client.callTool({ name: 'list_signals', arguments: { since: '2026-09-02T00:00:00Z', limit: 10 } }),
      );
      expect((since.signals as { id: string }[]).map((s) => s.id)).toEqual([newer.id]);
    } finally {
      await client.close();
    }
  });

  it('get_signal returns the record rows, and is not found for the unpublished', async () => {
    const entry = await seedPublished(new Date('2026-09-01T14:00:00Z'));
    await appendTrackRecord(
      {
        signalId: entry.id,
        entryPrice: '100.10',
        unrealizedPnl: '3.80',
        markPrice: '102.00',
        status: 'open',
        recordedAt: new Date('2026-09-01T20:15:00Z'),
      },
      db,
    );
    const pending = await insertSignal(
      {
        symbol: 'SPY',
        side: 'buy',
        signalType: 'technical',
        quantity: '1',
        thesis: null,
        thesisSource: 'llm',
        indicators: {},
        reviewSnapshot: { estimated_price: '1' },
        executionMode: 'paper',
        dedupeKey: uniqueDedupeKey(),
      },
      db,
    );
    const { mcp } = await mintMcpToken();
    const client = await connect(mcp);
    try {
      const found = structured(await client.callTool({ name: 'get_signal', arguments: { id: entry.id } }));
      expect((found.signal as { id: string }).id).toBe(entry.id);
      expect((found.record as { mark_price: string | null }[]).map((r) => r.mark_price)).toEqual([null, '102']);

      const missing = await client.callTool({ name: 'get_signal', arguments: { id: pending.id } });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing)).not.toContain('SPY');
    } finally {
      await client.close();
    }
  });

  it('get_track_record reflects a correction row at the correction date', async () => {
    const opened = new Date('2026-09-01T14:00:00Z');
    const entry = await seedPublished(opened);
    await appendTrackRecord(
      { signalId: entry.id, entryPrice: '100.10', unrealizedPnl: '5.00', markPrice: '102.60', status: 'open', recordedAt: new Date('2026-09-02T20:15:00Z') },
      db,
    );
    const { mcp } = await mintMcpToken();
    const client = await connect(mcp);
    try {
      const before = structured(await client.callTool({ name: 'get_track_record', arguments: {} }));
      const day = (before.curve as { date: string; value: number | null }[]).find((p) => p.date === '2026-09-02');
      expect(day?.value).toBe(5);

      // The correction: a later row for the same day with the corrected mark.
      // Nothing is edited; the newer row supersedes. The curve moves at that
      // date and the rows say why.
      await appendTrackRecord(
        { signalId: entry.id, entryPrice: '100.10', unrealizedPnl: '2.00', markPrice: '101.10', status: 'open', recordedAt: new Date('2026-09-02T21:00:00Z') },
        db,
      );

      const after = structured(await client.callTool({ name: 'get_track_record', arguments: {} }));
      const corrected = (after.curve as { date: string; value: number | null }[]).find((p) => p.date === '2026-09-02');
      expect(corrected?.value).toBe(2);
      const [position] = after.positions as { latest_mark: { price: string; unrealized_pnl: string } }[];
      expect(position?.latest_mark).toMatchObject({ price: '101.1', unrealized_pnl: '2' });

      const rows = structured(await client.callTool({ name: 'get_signal', arguments: { id: entry.id } }));
      expect((rows.record as unknown[]).length).toBe(3);
    } finally {
      await client.close();
    }
  });

  it('get_disclaimer returns the current text and version', async () => {
    const { mcp } = await mintMcpToken();
    const client = await connect(mcp);
    try {
      const result = structured(await client.callTool({ name: 'get_disclaimer', arguments: {} }));
      expect(result.version).toBe(DISCLAIMER_VERSION);
      expect(String(result.text)).toContain('not financial advice');
    } finally {
      await client.close();
    }
  });

  it('stamps last_used_at on the token an agent used', async () => {
    const minted = await mintMcpToken();
    const client = await connect(minted.mcp);
    try {
      await client.callTool({ name: 'get_disclaimer', arguments: {} });
    } finally {
      await client.close();
    }
    const list = (await app.inject({ method: 'GET', url: '/v1/mcp-tokens', headers: bearer(minted.app) })).json();
    expect(list.tokens[0].last_used_at).not.toBeNull();
  });
});
