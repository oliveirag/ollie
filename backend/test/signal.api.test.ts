import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recordExecution } from '../src/db/executions.js';
import { insertSignal, publishSignal, transitionSignal } from '../src/db/signals.js';
import { appendTrackRecord, closeLots } from '../src/db/trackRecord.js';
import { DISCLAIMER_VERSION } from '../src/published/disclaimer.js';
import { FORBIDDEN_FIELDS } from '../src/published/signal.js';
import { hashSecret } from '../src/secrets.js';
import { authHeader, buildTestApp, TEST_OWNER_TOKEN } from './helpers/api.js';
import { closeTestPrisma, resetDatabase, testPrisma, uniqueDedupeKey } from './helpers/db.js';
import {
  bearer,
  buildTestSignalApp,
  fakeIdentityToken,
  signIn,
  TEST_PUBLIC_URL,
} from './helpers/signalApi.js';

const db = testPrisma();
let app: FastifyInstance;
let ownerApp: FastifyInstance | null = null;

async function seedSignal(overrides: Partial<Parameters<typeof insertSignal>[0]> = {}) {
  return insertSignal(
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
        captured_at: '2026-09-01T13:34:59.000Z',
        raw: { account: 'CANARY_ACCOUNT' },
      },
      executionMode: 'paper',
      dedupeKey: uniqueDedupeKey(),
      ...overrides,
    },
    db,
  );
}

/** Approve, fill, open a lot, publish — the state a feed entry is in. */
async function seedPublished(when: Date, overrides: Parameters<typeof seedSignal>[0] = {}) {
  const signal = await seedSignal(overrides);
  await transitionSignal(signal.id, 'approved', 'approved', { prisma: db, now: when });
  await recordExecution(
    { signalId: signal.id, mode: 'paper', fillPrice: '100.10', quantity: '2', filledAt: when },
    db,
  );
  // A sell closes a lot; it never opens one.
  if (signal.side === 'buy') {
    await appendTrackRecord(
      { signalId: signal.id, entryPrice: '100.10', status: 'open', recordedAt: when },
      db,
    );
  }
  return publishSignal(signal.id, { prisma: db, now: when });
}

async function onboard(sub = 'sub-1'): Promise<string> {
  const token = await signIn(app, sub);
  await app.inject({
    method: 'POST',
    url: '/v1/disclaimer/accept',
    headers: bearer(token),
    payload: { version: DISCLAIMER_VERSION },
  });
  return token;
}

beforeEach(async () => {
  await resetDatabase();
  app ??= await buildTestSignalApp();
});

afterAll(async () => {
  await app?.close();
  await ownerApp?.close();
  await closeTestPrisma();
});

describe('POST /v1/session', () => {
  it('creates the subscriber on first sign-in with an invite code', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/session',
      payload: {
        identity_token: fakeIdentityToken('apple-1', 'relay@privaterelay.appleid.com'),
        invite_code: 'FRIENDS-2',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.token).toMatch(/^ollie_app_/);
    expect(body.subscriber.email).toBe('relay@privaterelay.appleid.com');

    const user = await db.user.findUnique({ where: { appleUserId: 'apple-1' } });
    expect(user?.inviteCode).toBe('FRIENDS-2');
    // Hash at rest, never the plaintext.
    const [row] = await db.subscriberToken.findMany({ where: { userId: user!.id } });
    expect(row?.tokenHash).toBe(hashSecret(body.token));
  });

  it('refuses a first sign-in without a valid invite code', async () => {
    for (const invite_code of [undefined, '', 'WRONG', 'friends-1']) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/session',
        payload: { identity_token: fakeIdentityToken('apple-2'), invite_code },
      });
      expect(response.statusCode, `invite ${String(invite_code)}`).toBe(403);
      expect(response.json()).toEqual({ error: 'invite_required' });
    }
    expect(await db.user.count()).toBe(0);
  });

  it('lets a returning subscriber in without a code', async () => {
    await signIn(app, 'apple-3');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/session',
      payload: { identity_token: fakeIdentityToken('apple-3') },
    });

    expect(response.statusCode).toBe(200);
    expect(await db.user.count()).toBe(1);
  });

  it('401s an identity token that does not verify', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/session',
      payload: { identity_token: 'eyJ.not.apple', invite_code: 'FRIENDS-1' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'invalid_identity_token' });
  });
});

describe('the onboarding sequence', () => {
  it('session -> onboarding -> accept -> mint, with every step visible from rows', async () => {
    const token = await signIn(app, 'sub-1');

    let onboarding = await app.inject({ method: 'GET', url: '/v1/onboarding', headers: bearer(token) });
    expect(onboarding.statusCode).toBe(200);
    expect(onboarding.json()).toMatchObject({
      disclaimer: { version: DISCLAIMER_VERSION },
      accepted_current_version: false,
      has_mcp_token: false,
      mcp_url: `${TEST_PUBLIC_URL}/mcp`,
    });
    expect(onboarding.json().disclaimer.text).toContain('not financial advice');

    // The enforcement point: no acceptance, no token.
    const refused = await app.inject({ method: 'POST', url: '/v1/mcp-tokens', headers: bearer(token) });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('disclaimer_not_accepted');

    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/disclaimer/accept',
      headers: bearer(token),
      payload: { version: DISCLAIMER_VERSION },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().version).toBe(DISCLAIMER_VERSION);

    const minted = await app.inject({ method: 'POST', url: '/v1/mcp-tokens', headers: bearer(token) });
    expect(minted.statusCode).toBe(200);
    expect(minted.json().token).toMatch(/^ollie_mcp_/);
    expect(minted.json().mcp_url).toBe(`${TEST_PUBLIC_URL}/mcp`);

    onboarding = await app.inject({ method: 'GET', url: '/v1/onboarding', headers: bearer(token) });
    expect(onboarding.json()).toMatchObject({ accepted_current_version: true, has_mcp_token: true });

    // The acceptance row predates the token row: structural, not polite.
    const [acceptance] = await db.disclaimerAcceptance.findMany();
    const mcpToken = await db.subscriberToken.findFirst({ where: { kind: 'mcp' } });
    expect(acceptance!.acceptedAt.getTime()).toBeLessThanOrEqual(mcpToken!.createdAt.getTime());
  });

  it('409s an acceptance of a stale version', async () => {
    const token = await signIn(app, 'sub-1');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/disclaimer/accept',
      headers: bearer(token),
      payload: { version: 'deadbeef' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('disclaimer_version_mismatch');
    expect(await db.disclaimerAcceptance.count()).toBe(0);
  });

  it('lists tokens without the plaintext and revokes only its own', async () => {
    const mine = await onboard('sub-1');
    const theirs = await onboard('sub-2');
    const minted = (await app.inject({ method: 'POST', url: '/v1/mcp-tokens', headers: bearer(mine) })).json();

    const list = (await app.inject({ method: 'GET', url: '/v1/mcp-tokens', headers: bearer(mine) })).json();
    expect(list.tokens).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(minted.token);
    expect(list.tokens[0]).toMatchObject({ id: minted.id, revoked_at: null });

    const foreign = await app.inject({
      method: 'DELETE',
      url: `/v1/mcp-tokens/${minted.id}`,
      headers: bearer(theirs),
    });
    expect(foreign.statusCode).toBe(404);

    const revoked = await app.inject({ method: 'DELETE', url: `/v1/mcp-tokens/${minted.id}`, headers: bearer(mine) });
    expect(revoked.statusCode).toBe(204);
    const again = await app.inject({ method: 'DELETE', url: `/v1/mcp-tokens/${minted.id}`, headers: bearer(mine) });
    expect(again.statusCode).toBe(204);

    const after = (await app.inject({ method: 'GET', url: '/v1/mcp-tokens', headers: bearer(mine) })).json();
    expect(after.tokens[0].revoked_at).not.toBeNull();
  });
});

describe('the wall between the two token surfaces', () => {
  it('rejects the owner token on the signal service', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/feed', headers: authHeader(TEST_OWNER_TOKEN) });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an app token on the owner API', async () => {
    const token = await signIn(app, 'sub-1');
    ownerApp ??= await buildTestApp();
    const response = await ownerApp.inject({ method: 'GET', url: '/v1/signals', headers: bearer(token) });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an MCP token on the subscriber REST surface', async () => {
    const token = await onboard('sub-1');
    const minted = (await app.inject({ method: 'POST', url: '/v1/mcp-tokens', headers: bearer(token) })).json();
    const response = await app.inject({ method: 'GET', url: '/v1/feed', headers: bearer(minted.token) });
    expect(response.statusCode).toBe(401);
  });

  it.each([
    ['no header', undefined],
    ['garbage', { authorization: 'Bearer ollie_app_nope' }],
    ['the raw scheme-less token', { authorization: 'ollie_app_nope' }],
  ])('401s %s on every authenticated route', async (_label, headers) => {
    for (const url of ['/v1/onboarding', '/v1/feed', '/v1/track-record', '/v1/mcp-tokens']) {
      const response = await app.inject({ method: 'GET', url, ...(headers ? { headers } : {}) });
      expect(response.statusCode, url).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });
    }
  });

  it('serves /healthz without a token and says nothing about the kill switch', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', database: 'up' });
    expect(response.json()).not.toHaveProperty('killSwitch');
  });
});

describe('GET /v1/feed', () => {
  it('returns exactly the published signals, newest first, with forbidden fields absent', async () => {
    const older = await seedPublished(new Date('2026-09-01T14:00:00Z'));
    const newer = await seedPublished(new Date('2026-09-02T14:00:00Z'), { symbol: 'MSFT' });
    await seedSignal({ symbol: 'SPY' }); // pending: never published
    const rejected = await seedSignal({ symbol: 'JPM' });
    await transitionSignal(rejected.id, 'rejected', 'no', { prisma: db });
    const approvedUnfilled = await seedSignal({ symbol: 'XLE' });
    await transitionSignal(approvedUnfilled.id, 'approved', 'yes', { prisma: db });

    const token = await onboard();
    const response = await app.inject({ method: 'GET', url: '/v1/feed', headers: bearer(token) });

    expect(response.statusCode).toBe(200);
    const { signals, next_before } = response.json();
    expect(signals.map((s: { id: string }) => s.id)).toEqual([newer.id, older.id]);
    expect(next_before).toBeNull();

    for (const field of FORBIDDEN_FIELDS) expect(signals[0]).not.toHaveProperty(field);
    expect(response.body).not.toContain('CANARY');
    expect(signals[0]).toMatchObject({
      symbol: 'MSFT',
      side: 'buy',
      quantity: '2',
      estimated_price: '100.00',
      thesis_source: 'llm',
      published_at: '2026-09-02T14:00:00.000Z',
    });
  });

  it('pages by published_at', async () => {
    for (let day = 1; day <= 5; day += 1) {
      await seedPublished(new Date(`2026-09-0${day}T14:00:00Z`));
    }
    const token = await onboard();

    const first = (await app.inject({ method: 'GET', url: '/v1/feed?limit=2', headers: bearer(token) })).json();
    expect(first.signals.map((s: { published_at: string }) => s.published_at.slice(0, 10))).toEqual([
      '2026-09-05',
      '2026-09-04',
    ]);
    expect(first.next_before).toBe('2026-09-04T14:00:00.000Z');

    const second = (
      await app.inject({ method: 'GET', url: `/v1/feed?limit=2&before=${first.next_before}`, headers: bearer(token) })
    ).json();
    expect(second.signals.map((s: { published_at: string }) => s.published_at.slice(0, 10))).toEqual([
      '2026-09-03',
      '2026-09-02',
    ]);

    const third = (
      await app.inject({ method: 'GET', url: `/v1/feed?limit=2&before=${second.next_before}`, headers: bearer(token) })
    ).json();
    expect(third.signals).toHaveLength(1);
    expect(third.next_before).toBeNull();
  });
});

describe('GET /v1/signals/:id', () => {
  it('returns the signal and its per-signal record rows', async () => {
    const when = new Date('2026-09-01T14:00:00Z');
    const entry = await seedPublished(when);
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
    const exit = await seedPublished(new Date('2026-09-03T14:00:00Z'), { side: 'sell' });
    await closeLots(
      { signalIds: [entry.id], exitPrice: '105.00', closedBySignalId: exit.id, recordedAt: new Date('2026-09-03T14:00:00Z') },
      db,
    );

    const token = await onboard();
    const response = await app.inject({ method: 'GET', url: `/v1/signals/${entry.id}`, headers: bearer(token) });

    expect(response.statusCode).toBe(200);
    const { signal, record } = response.json();
    expect(signal.id).toBe(entry.id);
    expect(record.map((r: { status: string }) => r.status)).toEqual(['open', 'open', 'closed']);
    expect(record[1]).toMatchObject({ mark_price: '102', unrealized_pnl: '3.8' });
    expect(record[2]).toMatchObject({ exit_price: '105', realized_pnl: '9.8', closed_by_signal_id: exit.id });
    expect(response.body).not.toContain('CANARY');
  });

  it('404s an unpublished signal and an unknown id identically', async () => {
    const pending = await seedSignal();
    const token = await onboard();

    const unpublished = await app.inject({ method: 'GET', url: `/v1/signals/${pending.id}`, headers: bearer(token) });
    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/signals/00000000-0000-4000-8000-000000000000',
      headers: bearer(token),
    });

    expect(unpublished.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(unpublished.body).toBe(unknown.body);
  });
});

describe('GET /v1/track-record', () => {
  it('matches the owner endpoint number for number and adds positions at mark granularity', async () => {
    const opened = new Date('2026-09-01T14:00:00Z');
    const entry = await seedPublished(opened);
    await appendTrackRecord(
      {
        signalId: entry.id,
        entryPrice: '100.10',
        unrealizedPnl: '3.80',
        markPrice: '102.00',
        status: 'open',
        recordedAt: new Date('2026-09-03T20:15:00Z'),
      },
      db,
    );
    const winner = await seedPublished(new Date('2026-08-20T14:00:00Z'), { symbol: 'MSFT' });
    const exit = await seedPublished(new Date('2026-08-25T14:00:00Z'), { symbol: 'MSFT', side: 'sell' });
    await closeLots(
      { signalIds: [winner.id], exitPrice: '110.10', closedBySignalId: exit.id, recordedAt: new Date('2026-08-25T14:00:00Z') },
      db,
    );

    const token = await onboard();
    const subscriber = (await app.inject({ method: 'GET', url: '/v1/track-record', headers: bearer(token) })).json();
    ownerApp ??= await buildTestApp();
    const owner = (await ownerApp.inject({ method: 'GET', url: '/v1/track-record', headers: authHeader() })).json();

    const { positions, ...shared } = subscriber;
    expect(shared).toEqual(owner);
    expect(owner.closed_trades).toBe(1);

    expect(positions).toEqual([
      {
        signal_id: entry.id,
        symbol: 'AAPL',
        side: 'buy',
        quantity: '2',
        entry_price: '100.1',
        opened_at: opened.toISOString(),
        latest_mark: {
          price: '102',
          unrealized_pnl: '3.8',
          as_of: '2026-09-03T20:15:00.000Z',
          days_held: 2,
        },
      },
    ]);
  });

  it('reports a never-marked lot with a null mark rather than a guess', async () => {
    await seedPublished(new Date('2026-09-01T14:00:00Z'));
    const token = await onboard();

    const body = (await app.inject({ method: 'GET', url: '/v1/track-record', headers: bearer(token) })).json();

    expect(body.positions[0].latest_mark).toBeNull();
    expect(body.win_rate).toBeNull();
  });
});

describe('rate limiting', () => {
  it('throttles by IP before authentication', async () => {
    const tight = await buildTestSignalApp({ rateLimit: { max: 2, timeWindow: '1 minute' } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        statuses.push((await tight.inject({ method: 'GET', url: '/v1/feed' })).statusCode);
      }
      expect(statuses).toEqual([401, 401, 429]);
    } finally {
      await tight.close();
    }
  });
});
