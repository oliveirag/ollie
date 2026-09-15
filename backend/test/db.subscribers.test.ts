import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IMMUTABILITY_ERRCODE } from '../src/db/client.js';
import { hasAccepted, listAcceptances, recordAcceptance } from '../src/db/disclaimerAcceptances.js';
import { hashSecret } from '../src/secrets.js';
import {
  hasLiveToken,
  listTokens,
  mintToken,
  revokeToken,
  verifyToken,
} from '../src/db/subscriberTokens.js';
import { createSubscriber, eraseEmail, findUserByAppleId, getUser } from '../src/db/users.js';
import { insertSignal } from '../src/db/signals.js';
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
  it('can read signals and track_record', async () => {
    const s = await insertSignal(
      {
        symbol: 'AAPL',
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
    await appendTrackRecord({ signalId: s.id, entryPrice: '1', status: 'open' }, db);

    expect(await signal.signal.count()).toBe(1);
    expect(await signal.trackRecord.count()).toBe(1);
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

  it.each(['oauth_state', 'app_settings', 'devices', 'executions', 'signal_events'])(
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
