import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IMMUTABILITY_ERRCODE } from '../src/db/client.js';
import { hasAccepted, listAcceptances, recordAcceptance } from '../src/db/disclaimerAcceptances.js';
import { hashSecret } from '../src/secrets.js';
import {
  APP_TOKEN_IDLE_MS,
  hasLiveToken,
  listTokens,
  mintToken,
  revokeAllButNewest,
  revokeToken,
  verifyToken,
} from '../src/db/subscriberTokens.js';
import {
  createSubscriber,
  deleteSubscriberAccount,
  eraseEmail,
  findUserByAppleId,
  getUser,
} from '../src/db/users.js';
import { insertSignal, publishSignal, transitionSignal } from '../src/db/signals.js';
import { OWNER_ONLY_TABLES } from '../src/signal-server/wall.js';
import { appendTrackRecord } from '../src/db/trackRecord.js';
import {
  closeTestPrisma,
  resetDatabase,
  signalPrisma,
  testPrisma,
  uniqueDedupeKey,
} from './helpers/db.js';

const db = testPrisma();
/** Connected as `ollie_signal` — the subscriber service's own role. */
const signal = signalPrisma();

let seq = 0;
async function seedUser(overrides: Partial<Parameters<typeof createSubscriber>[0]> = {}) {
  seq += 1;
  return createSubscriber(
    {
      appleUserId: `001234.${process.pid}.${Date.now()}.${seq}`,
      email: 'relay@privaterelay.appleid.com',
      inviteCode: 'FRIENDS-1',
      ...overrides,
    },
    db,
  );
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestPrisma();
});

describe('users', () => {
  it('is keyed by the Apple subject and records the admitting invite code', async () => {
    const user = await seedUser({ appleUserId: 'apple-subject-1' });

    expect(user.role).toBe('subscriber');
    expect(user.inviteCode).toBe('FRIENDS-1');
    expect((await findUserByAppleId('apple-subject-1', db))?.id).toBe(user.id);
  });

  it('refuses two users with the same Apple subject', async () => {
    await seedUser({ appleUserId: 'dup' });
    await expect(seedUser({ appleUserId: 'dup' })).rejects.toThrow();
  });

  it('erases the email and nothing else', async () => {
    const user = await seedUser();
    await eraseEmail(user.id, db);

    const after = await getUser(user.id, db);
    expect(after?.email).toBeNull();
    expect(after?.appleUserId).toBe(user.appleUserId);
  });
});

describe('subscriber tokens', () => {
  it('round-trips: mint -> verify plaintext -> revoke -> verify fails', async () => {
    const user = await seedUser();

    const minted = await mintToken(user.id, 'mcp', db);
    expect(minted.plaintext).toMatch(/^ollie_mcp_[0-9a-f]{64}$/);
    // Only the hash is at rest.
    expect(minted.token.tokenHash).toBe(hashSecret(minted.plaintext));
    expect(minted.token.tokenHash).not.toContain(minted.plaintext);

    const verified = await verifyToken(minted.plaintext, 'mcp', { prisma: db });
    expect(verified?.user.id).toBe(user.id);
    expect(verified?.token.id).toBe(minted.token.id);

    expect(await revokeToken(minted.token.id, user.id, { prisma: db })).toBe(true);
    expect(await verifyToken(minted.plaintext, 'mcp', { prisma: db })).toBeNull();

    // Idempotent, and the row is still there as history.
    expect(await revokeToken(minted.token.id, user.id, { prisma: db })).toBe(false);
    expect(await listTokens(user.id, 'mcp', db)).toHaveLength(1);
    expect(await hasLiveToken(user.id, 'mcp', db)).toBe(false);
  });

  it('rejects an unknown token and a tampered one', async () => {
    const user = await seedUser();
    const minted = await mintToken(user.id, 'app', db);

    expect(await verifyToken('ollie_app_' + '0'.repeat(64), 'app', { prisma: db })).toBeNull();
    expect(await verifyToken(minted.plaintext.slice(0, -1) + 'x', 'app', { prisma: db })).toBeNull();
  });

  it('refuses a token of the other kind', async () => {
    // An app token at the MCP endpoint, or an MCP token at the REST API, is
    // as unknown as a random string. The kind is part of the identity.
    const user = await seedUser();
    const app = await mintToken(user.id, 'app', db);
    const mcp = await mintToken(user.id, 'mcp', db);

    expect(await verifyToken(app.plaintext, 'mcp', { prisma: db })).toBeNull();
    expect(await verifyToken(mcp.plaintext, 'app', { prisma: db })).toBeNull();
  });

  it('cannot be revoked by another user', async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const minted = await mintToken(owner.id, 'mcp', db);

    expect(await revokeToken(minted.token.id, other.id, { prisma: db })).toBe(false);
    expect(await verifyToken(minted.plaintext, 'mcp', { prisma: db })).not.toBeNull();
  });

  it('stamps last_used_at on a successful verification', async () => {
    const user = await seedUser();
    const minted = await mintToken(user.id, 'mcp', db);
    const now = new Date('2026-09-20T12:00:00.000Z');

    await verifyToken(minted.plaintext, 'mcp', { prisma: db, now });

    const [row] = await listTokens(user.id, 'mcp', db);
    expect(row?.lastUsedAt).toEqual(now);
  });

  it('rewrites last_used_at at most once a minute', async () => {
    const user = await seedUser();
    const minted = await mintToken(user.id, 'mcp', db);
    const first = new Date('2026-09-20T12:00:00.000Z');

    await verifyToken(minted.plaintext, 'mcp', { prisma: db, now: first });
    await verifyToken(minted.plaintext, 'mcp', { prisma: db, now: new Date(first.getTime() + 59_000) });
    expect((await listTokens(user.id, 'mcp', db))[0]?.lastUsedAt).toEqual(first);

    const later = new Date(first.getTime() + 60_000);
    await verifyToken(minted.plaintext, 'mcp', { prisma: db, now: later });
    expect((await listTokens(user.id, 'mcp', db))[0]?.lastUsedAt).toEqual(later);
  });

  it('lapses an app token left unused past the idle limit, but not an mcp token', async () => {
    const user = await seedUser();
    const app = await mintToken(user.id, 'app', db);
    const mcp = await mintToken(user.id, 'mcp', db);
    const idle = new Date(app.token.createdAt.getTime() + APP_TOKEN_IDLE_MS + 1000);

    expect(await verifyToken(app.plaintext, 'app', { prisma: db, now: idle })).toBeNull();
    expect(await verifyToken(mcp.plaintext, 'mcp', { prisma: db, now: idle })).not.toBeNull();
  });

  it('keeps only the newest app tokens live', async () => {
    const user = await seedUser();
    const minted = [];
    for (let i = 0; i < 4; i += 1) minted.push(await mintToken(user.id, 'app', db));
    const mcp = await mintToken(user.id, 'mcp', db);

    expect(await revokeAllButNewest(user.id, 'app', 2, { prisma: db })).toBe(2);

    expect(await verifyToken(minted[0]!.plaintext, 'app', { prisma: db })).toBeNull();
    expect(await verifyToken(minted[1]!.plaintext, 'app', { prisma: db })).toBeNull();
    expect(await verifyToken(minted[2]!.plaintext, 'app', { prisma: db })).not.toBeNull();
    expect(await verifyToken(minted[3]!.plaintext, 'app', { prisma: db })).not.toBeNull();
    expect(await verifyToken(mcp.plaintext, 'mcp', { prisma: db })).not.toBeNull();
  });
});

describe('disclaimer acceptances', () => {
  const isImmutabilityError = (error: unknown) => {
    expect(String(error)).toContain(IMMUTABILITY_ERRCODE);
  };
  async function expectRejected(promise: Promise<unknown>): Promise<void> {
    await promise.then(
      () => {
        throw new Error('expected the database to reject this write');
      },
      isImmutabilityError,
    );
  }

  it('records which version was accepted, and only that version counts', async () => {
    const user = await seedUser();
    await recordAcceptance({ userId: user.id, disclaimerVersion: 'v1' }, db);

    expect(await hasAccepted(user.id, 'v1', db)).toBe(true);
    expect(await hasAccepted(user.id, 'v2', db)).toBe(false);
  });

  it('refuses UPDATE, DELETE, and TRUNCATE', async () => {
    const user = await seedUser();
    await recordAcceptance({ userId: user.id, disclaimerVersion: 'v1' }, db);

    await expectRejected(db.$executeRawUnsafe(`UPDATE disclaimer_acceptances SET disclaimer_version = 'v2'`));
    await expectRejected(db.$executeRawUnsafe(`DELETE FROM disclaimer_acceptances`));
    await expectRejected(db.$executeRawUnsafe(`TRUNCATE TABLE disclaimer_acceptances`));

    expect(await listAcceptances(user.id, db)).toHaveLength(1);
  });
});

/**
 * The §4.5 credential-isolation proof at the data tier (Phase 4, decision 4).
 *
 * Each grant and each denial is asserted individually rather than through a
 * single "can it do the job" round-trip, because the denials are the point:
 * the subscriber service must be unable to reach the broker credential, the
 * kill switch, the owner's phone, and the owner's fills even if every line of
 * its own code is compromised.
 */
describe('the ollie_signal role', () => {
  async function seedRoleSignal(published: boolean) {
    const s = await insertSignal(
      {
        symbol: 'AAPL',
        side: 'buy',
        signalType: 'technical',
        quantity: '1',
        thesis: null,
        thesisSource: 'llm',
        indicators: {},
        reviewSnapshot: { estimated_price: '1.25', raw: { order_checks: 'CANARY_BP' } },
        executionMode: 'paper',
        dedupeKey: uniqueDedupeKey(),
      },
      db,
    );
    await appendTrackRecord({ signalId: s.id, entryPrice: '1', status: 'open' }, db);
    if (published) {
      await transitionSignal(s.id, 'approved', 'approved', { prisma: db });
      await publishSignal(s.id, { prisma: db });
    }
    return s;
  }

  it('sees only published signals and their track_record rows', async () => {
    const pending = await seedRoleSignal(false);
    const published = await seedRoleSignal(true);

    const signals = await signal.signal.findMany({ select: { id: true } });
    expect(signals.map((r) => r.id)).toEqual([published.id]);
    const rows = await signal.trackRecord.findMany({ select: { signalId: true } });
    expect(rows.map((r) => r.signalId)).toEqual([published.id]);
    expect(await signal.signal.findFirst({ where: { id: pending.id }, select: { id: true } })).toBeNull();
  });

  it('cannot read review_snapshot or the decision columns, even on a published signal', async () => {
    await seedRoleSignal(true);
    for (const column of ['review_snapshot', 'status', 'decide_reason', 'dedupe_key', 'ref_id']) {
      await expect(signal.$queryRawUnsafe(`SELECT "${column}" FROM signals`)).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it('reads the estimate of published signals only, through the view', async () => {
    const pending = await seedRoleSignal(false);
    const published = await seedRoleSignal(true);
    const rows = await signal.$queryRawUnsafe<Array<{ signal_id: string; estimated_price: string }>>(
      'SELECT signal_id::text AS signal_id, estimated_price FROM published_signal_estimates',
    );
    expect(rows).toEqual([{ signal_id: published.id, estimated_price: '1.25' }]);
    expect(rows.some((r) => r.signal_id === pending.id)).toBe(false);
  });

  it('can create a user, insert an acceptance, and mint and revoke a token', async () => {
    const user = await createSubscriber(
      { appleUserId: 'role-test', email: null, inviteCode: null },
      signal,
    );
    await recordAcceptance({ userId: user.id, disclaimerVersion: 'v1' }, signal);
    const minted = await mintToken(user.id, 'mcp', signal);
    expect(await verifyToken(minted.plaintext, 'mcp', { prisma: signal })).not.toBeNull();
    expect(await revokeToken(minted.token.id, user.id, { prisma: signal })).toBe(true);
    await eraseEmail(user.id, signal);
  });

  it.each(OWNER_ONLY_TABLES)(
    'is denied SELECT on %s',
    async (table) => {
      await expect(signal.$queryRawUnsafe(`SELECT * FROM "${table}"`)).rejects.toThrow(
        /permission denied/,
      );
    },
  );

  it.each(['signals', 'track_record'])('is denied every write on %s', async (table) => {
    await expect(signal.$executeRawUnsafe(`DELETE FROM "${table}"`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      signal.$executeRawUnsafe(`UPDATE "${table}" SET id = id`),
    ).rejects.toThrow(/permission denied/);
  });

  it('cannot delete a user, a token, or an acceptance', async () => {
    for (const table of ['users', 'subscriber_tokens', 'disclaimer_acceptances']) {
      await expect(signal.$executeRawUnsafe(`DELETE FROM "${table}"`)).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it('can update a token only in last_used_at and revoked_at', async () => {
    const user = await seedUser();
    await mintToken(user.id, 'mcp', db);
    await expect(
      signal.$executeRawUnsafe(`UPDATE subscriber_tokens SET kind = 'app'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      signal.$executeRawUnsafe(`UPDATE subscriber_tokens SET token_hash = 'x'`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      signal.$executeRawUnsafe(`UPDATE subscriber_tokens SET last_used_at = now(), revoked_at = now()`),
    ).resolves.toBe(1);
  });

  it('cannot rewrite a user beyond the email column', async () => {
    const user = await seedUser({ appleUserId: 'pinned' });
    await expect(
      signal.$executeRawUnsafe(
        `UPDATE users SET apple_user_id = 'someone-else' WHERE id = $1::uuid`,
        user.id,
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('account deletion', () => {
  it('tombstones the user, revokes every token, and keeps the acceptances', async () => {
    const user = await seedUser({ appleUserId: 'to-delete' });
    await recordAcceptance({ userId: user.id, disclaimerVersion: 'v1' }, db);
    const app = await mintToken(user.id, 'app', db);
    const mcp = await mintToken(user.id, 'mcp', db);

    expect(await deleteSubscriberAccount(user.id, signal)).toBe(true);

    const after = await getUser(user.id, db);
    expect(after).toMatchObject({
      appleUserId: `deleted:${user.id}`,
      email: null,
      inviteCode: null,
    });
    expect(after?.deletedAt).toBeInstanceOf(Date);
    expect(await findUserByAppleId('to-delete', db)).toBeNull();
    expect(await verifyToken(app.plaintext, 'app', { prisma: db })).toBeNull();
    expect(await verifyToken(mcp.plaintext, 'mcp', { prisma: db })).toBeNull();
    expect(await listAcceptances(user.id, db)).toHaveLength(1);
  });

  it('deletes only once, and never the owner or an unknown id', async () => {
    const user = await seedUser();
    expect(await deleteSubscriberAccount(user.id, signal)).toBe(true);
    expect(await deleteSubscriberAccount(user.id, signal)).toBe(false);

    const owner = await db.user.create({ data: { role: 'owner', appleUserId: 'the-owner' } });
    expect(await deleteSubscriberAccount(owner.id, signal)).toBe(false);
    expect((await getUser(owner.id, db))?.appleUserId).toBe('the-owner');

    expect(await deleteSubscriberAccount('00000000-0000-0000-0000-000000000000', signal)).toBe(false);
  });

  it('leaves other subscribers alone', async () => {
    const gone = await seedUser();
    const kept = await seedUser({ appleUserId: 'kept' });
    const keptToken = await mintToken(kept.id, 'mcp', db);

    await deleteSubscriberAccount(gone.id, signal);

    expect((await getUser(kept.id, db))?.appleUserId).toBe('kept');
    expect(await verifyToken(keptToken.plaintext, 'mcp', { prisma: db })).not.toBeNull();
  });
});

