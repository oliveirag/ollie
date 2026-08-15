import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildConfig } from '../src/config/index.js';
import { PrismaOAuthStateStore, bootstrapOAuthState } from '../src/db/oauthState.js';
import { RhOAuthProvider } from '../src/orchestrator/robinhood/oauth.js';
import { closeTestPrisma, resetDatabase, testPrisma } from './helpers/db.js';

const db = testPrisma();

/**
 * The failure this exists to fix, observed in production on 2026-08-14: the
 * first unattended run died with `InvalidGrantError` because Robinhood rotates
 * refresh tokens on use. The token that had been copied into an environment
 * variable was invalidated by an earlier refresh elsewhere, and an environment
 * variable is not somewhere a running process can write the replacement.
 */
beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestPrisma();
});

const store = () => new PrismaOAuthStateStore(db);

describe('persisting oauth state', () => {
  it('round-trips a client and its tokens', async () => {
    await store().save({
      clientId: 'client-abc',
      tokens: { access_token: 'a1', refresh_token: 'r1', token_type: 'Bearer' },
    });

    const loaded = await store().load();
    expect(loaded?.clientId).toBe('client-abc');
    expect(loaded?.tokens?.refresh_token).toBe('r1');
  });

  it('returns undefined when nothing has been stored', async () => {
    expect(await store().load()).toBeUndefined();
  });

  it('replaces a refresh token when the server rotates it', async () => {
    await store().save({
      clientId: 'client-abc',
      tokens: { access_token: 'a1', refresh_token: 'r1', token_type: 'Bearer' },
    });

    // What the SDK does after a refresh: hands back a new pair, and on a
    // rotating server the refresh token differs from the one just used.
    await store().save({
      clientId: 'client-abc',
      tokens: { access_token: 'a2', refresh_token: 'r2', token_type: 'Bearer' },
    });

    const loaded = await store().load();
    expect(loaded?.tokens?.refresh_token).toBe('r2');
    expect(loaded?.tokens?.access_token).toBe('a2');
  });
});

describe('the provider writes rotations straight through', () => {
  it('persists a rotated token without any caller intervention', async () => {
    await store().save({
      clientId: 'client-abc',
      tokens: { access_token: 'a1', refresh_token: 'r1', token_type: 'Bearer' },
    });

    const provider = new RhOAuthProvider({ store: store() });
    // The SDK calls exactly this after every refresh.
    await provider.saveTokens({ access_token: 'a2', refresh_token: 'r2', token_type: 'Bearer' });

    // Survives the process: a fresh store instance reads the rotated value.
    expect((await store().load())?.tokens?.refresh_token).toBe('r2');
  });
});

describe('bootstrapping from the environment', () => {
  const config = (clientId: string, refresh: string) => {
    const base = buildConfig({
      DATABASE_URL: process.env.DATABASE_URL,
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    return {
      ...base,
      robinhood: { ...base.robinhood, oauthClientId: clientId, oauthRefreshToken: refresh },
    };
  };

  it('seeds the row from config when the database is empty', async () => {
    await bootstrapOAuthState(config('client-env', 'r-env'), db);

    // The migration path: an existing deploy carries its credential in the
    // environment, and the first boot moves it into the database.
    expect((await store().load())?.tokens?.refresh_token).toBe('r-env');
  });

  it('never overwrites a stored token with the stale environment one', async () => {
    await store().save({
      clientId: 'client-abc',
      tokens: { access_token: 'a9', refresh_token: 'r-rotated', token_type: 'Bearer' },
    });

    await bootstrapOAuthState(config('client-env', 'r-env'), db);

    // This is the whole bug, inverted. The environment holds whatever was
    // pasted at deploy time; the database holds what the server last issued.
    // Letting the environment win would re-break the credential on every boot.
    expect((await store().load())?.tokens?.refresh_token).toBe('r-rotated');
  });

  it('does nothing when the environment carries no credential', async () => {
    await bootstrapOAuthState(config('', ''), db);

    expect(await store().load()).toBeUndefined();
  });
});
