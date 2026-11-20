import type { PrismaClient, SubscriberToken, User } from '@prisma/client';
import { generateSecret, hashSecret } from '../secrets.js';
import { getPrisma } from './client.js';

/**
 * Per-subscriber bearer tokens, hashed at rest (Phase 4, decision 3).
 *
 * Two kinds, and neither surface accepts the other's: `app` authenticates the
 * subscriber app's REST calls; `mcp` authenticates an agent at the MCP
 * endpoint. A credential that worked on both would let a leaked agent config
 * mint more agent configs. The plaintext is returned exactly once, from
 * `mintToken`, and exists nowhere else.
 */

export type TokenKind = 'app' | 'mcp';

export interface MintedToken {
  /** Shown once. Never logged, never stored. */
  plaintext: string;
  token: SubscriberToken;
}

export async function mintToken(
  userId: string,
  kind: TokenKind,
  prisma: PrismaClient = getPrisma(),
): Promise<MintedToken> {
  const plaintext = generateSecret(`ollie_${kind}`);
  const token = await prisma.subscriberToken.create({
    data: { userId, kind, tokenHash: hashSecret(plaintext) },
  });
  return { plaintext, token };
}

/** How often a token's `last_used_at` is rewritten. Every MCP call verifies. */
export const LAST_USED_RESOLUTION_MS = 60 * 1000;

/**
 * App session tokens are minted on every sign-in and never shown again, so a
 * subscriber cannot revoke them by hand. They lapse after this long unused,
 * and only the newest few stay live.
 */
export const APP_TOKEN_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
export const APP_TOKENS_KEPT = 5;

export interface VerifiedToken {
  token: SubscriberToken;
  user: User;
}

/**
 * Resolve a presented plaintext to its user, or null. The kind is part of the
 * check, not a filter applied afterwards, so an `app` token presented at the
 * MCP endpoint is exactly as unknown as a random string. An app token idle
 * for `APP_TOKEN_IDLE_MS` is as unknown too. Touches `last_used_at` on
 * success, at most once per `LAST_USED_RESOLUTION_MS`; that is the only write
 * on the read path and it is what the soft-launch exit criterion reads.
 */
export async function verifyToken(
  plaintext: string,
  kind: TokenKind,
  options: { now?: Date; prisma?: PrismaClient } = {},
): Promise<VerifiedToken | null> {
  const prisma = options.prisma ?? getPrisma();
  const token = await prisma.subscriberToken.findUnique({
    where: { tokenHash: hashSecret(plaintext) },
    include: { user: true },
  });
  if (!token || token.kind !== kind || token.revokedAt !== null) return null;

  const now = options.now ?? new Date();
  const lastSeen = token.lastUsedAt ?? token.createdAt;
  if (kind === 'app' && now.getTime() - lastSeen.getTime() > APP_TOKEN_IDLE_MS) return null;

  const { user, ...row } = token;
  if (!token.lastUsedAt || now.getTime() - token.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS) {
    await prisma.subscriberToken.update({ where: { id: token.id }, data: { lastUsedAt: now } });
    row.lastUsedAt = now;
  }
  return { token: row, user };
}

/**
 * Soft revoke, scoped to the owner of the token so one subscriber cannot
 * revoke another's by guessing an id. Idempotent; returns whether a live token
 * was revoked by this call.
 */
export async function revokeToken(
  id: string,
  userId: string,
  options: { now?: Date; prisma?: PrismaClient } = {},
): Promise<boolean> {
  const prisma = options.prisma ?? getPrisma();
  const updated = await prisma.subscriberToken.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: options.now ?? new Date() },
  });
  return updated.count > 0;
}

/**
 * Revoke every live token of `kind` for the user beyond the newest `keep`.
 * Called after each sign-in so session tokens do not pile up. Returns how
 * many were revoked.
 */
export async function revokeAllButNewest(
  userId: string,
  kind: TokenKind,
  keep: number,
  options: { now?: Date; prisma?: PrismaClient } = {},
): Promise<number> {
  const prisma = options.prisma ?? getPrisma();
  const stale = await prisma.subscriberToken.findMany({
    where: { userId, kind, revokedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: keep,
    select: { id: true },
  });
  if (stale.length === 0) return 0;
  const updated = await prisma.subscriberToken.updateMany({
    where: { id: { in: stale.map((t) => t.id) }, revokedAt: null },
    data: { revokedAt: options.now ?? new Date() },
  });
  return updated.count;
}

export async function listTokens(
  userId: string,
  kind: TokenKind,
  prisma: PrismaClient = getPrisma(),
): Promise<SubscriberToken[]> {
  return prisma.subscriberToken.findMany({
    where: { userId, kind },
    orderBy: { createdAt: 'desc' },
  });
}

export async function hasLiveToken(
  userId: string,
  kind: TokenKind,
  prisma: PrismaClient = getPrisma(),
): Promise<boolean> {
  const count = await prisma.subscriberToken.count({
    where: { userId, kind, revokedAt: null },
  });
  return count > 0;
}
