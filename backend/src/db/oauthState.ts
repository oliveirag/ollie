import type { PrismaClient } from '@prisma/client';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Config } from '../config/index.js';
import { logger as rootLogger } from '../logger.js';
import type { OAuthStateStore, StoredOAuthState } from '../orchestrator/robinhood/oauth.js';
import { getPrisma } from './client.js';

const STATE_ID = 1;

/**
 * OAuth state backed by Postgres, so a rotated refresh token survives the
 * process that received it.
 *
 * The environment-variable version this replaces failed in production on
 * 2026-08-14 with `InvalidGrantError`: Robinhood rotates refresh tokens on use,
 * and the deployed value had already been invalidated by an earlier refresh
 * elsewhere. Nothing in the running service could write the replacement back,
 * so every subsequent run would have failed the same way.
 *
 * `RhOAuthProvider.saveTokens` already calls `save()` after every refresh, so
 * persistence needed no change beyond this implementation — which is the point
 * of `OAuthStateStore` having been an interface from the start.
 */
export class PrismaOAuthStateStore implements OAuthStateStore {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  async load(): Promise<StoredOAuthState | undefined> {
    const row = await this.prisma.oAuthState.findUnique({ where: { id: STATE_ID } });
    if (!row) return undefined;

    return {
      clientId: row.clientId,
      ...(row.clientSecret ? { clientSecret: row.clientSecret } : {}),
      ...(row.tokens ? { tokens: row.tokens as unknown as OAuthTokens } : {}),
      ...(row.codeVerifier ? { codeVerifier: row.codeVerifier } : {}),
    };
  }

  async save(state: StoredOAuthState): Promise<void> {
    const data = {
      clientId: state.clientId,
      clientSecret: state.clientSecret ?? null,
      tokens: (state.tokens ?? null) as never,
      codeVerifier: state.codeVerifier ?? null,
    };
    await this.prisma.oAuthState.upsert({
      where: { id: STATE_ID },
      update: data,
      create: { id: STATE_ID, ...data },
    });
  }
}

/**
 * Move a credential from the environment into the database, once.
 *
 * The migration path for a deploy that still carries `RH_OAUTH_REFRESH_TOKEN`:
 * first boot copies it in, and everything afterwards reads and writes the
 * database. Deliberately refuses to overwrite an existing row — the environment
 * holds whatever was pasted at deploy time, the database holds what the server
 * last issued, and letting the stale value win would re-break the credential on
 * every restart. That is the original bug with extra steps.
 */
export async function bootstrapOAuthState(
  config: Config,
  prisma: PrismaClient = getPrisma(),
): Promise<void> {
  const { oauthClientId, oauthRefreshToken } = config.robinhood;
  if (!oauthClientId || !oauthRefreshToken) return;

  const store = new PrismaOAuthStateStore(prisma);
  if (await store.load()) return;

  await store.save({
    clientId: oauthClientId,
    tokens: {
      access_token: '',
      refresh_token: oauthRefreshToken,
      token_type: 'Bearer',
    },
  });
  rootLogger.info('seeded oauth state from the environment; the database is authoritative now');
}
