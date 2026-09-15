import type { PrismaClient, User } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken, type TokenKind } from '../db/subscriberTokens.js';
import { BEARER } from '../server/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireSubscriberToken`; absent on public routes. */
    subscriber?: User;
  }
}

/**
 * Subscriber authentication (Phase 4, decision 3): a per-user, hashed,
 * revocable bearer token of the right `kind`. The owner's pre-shared token is
 * not in this process's environment at all, so it is rejected here for the
 * same reason a random string is — the service has never heard of it.
 *
 * The 401 carries the same constant body the owner API uses. What it does not
 * carry is *why*: missing, malformed, unknown, revoked, and wrong-kind are one
 * indistinguishable response.
 */
export function requireSubscriberToken(prisma: PrismaClient, kind: TokenKind) {
  return async function subscriberAuthHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers.authorization;
    const presented = header?.match(BEARER)?.[1];
    const verified = presented ? await verifyToken(presented, kind, { prisma }) : null;

    if (!verified) {
      request.log.warn(
        { path: request.url, method: request.method, has_header: Boolean(header) },
        'rejected unauthenticated subscriber request',
      );
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    request.subscriber = verified.user;
  };
}

/**
 * The MCP endpoint's check, run before the transport sees the request. No
 * body at all (PRD §4.5: "an unauthenticated request returns nothing").
 * Returns the user or null; the caller ends the response.
 */
export async function authenticateMcpBearer(
  request: FastifyRequest,
  prisma: PrismaClient,
): Promise<User | null> {
  const presented = request.headers.authorization?.match(BEARER)?.[1];
  if (!presented) return null;
  const verified = await verifyToken(presented, 'mcp', { prisma });
  return verified?.user ?? null;
}
