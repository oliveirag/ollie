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

export interface VerifiedToken {
  token: SubscriberToken;
  user: User;
}

/**
 * Resolve a presented plaintext to its user, or null. The kind is part of the
 * check, not a filter applied afterwards, so an `app` token presented at the
 * MCP endpoint is exactly as unknown as a random string. Touches
 * `last_used_at` on success; that is the only write on the read path and it
 * is what the soft-launch exit criterion reads.
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

  await prisma.subscriberToken.update({
    where: { id: token.id },
    data: { lastUsedAt: options.now ?? new Date() },
  });

  const { user, ...row } = token;
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
