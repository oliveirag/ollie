import type { FastifyReply, FastifyRequest } from 'fastify';
import { secretsMatch } from '../secrets.js';

/**
 * Owner authentication for Phase 2: a single pre-shared bearer token.
 *
 * This is deliberate drift from PRD §5, which specifies Sign in with Apple.
 * SIWA solves onboarding strangers, and Phase 2 has exactly one user who is
 * already known — standing it up now would mean inventing an owner-binding
 * rule and building the `users` table a phase before anything reads it. SIWA
 * arrives in Phase 4 with the subscriber side, where strangers make it earn
 * its place. Until then the token lives in Railway secrets and the iOS
 * Keychain, and every /v1 route requires it.
 */

/** The service was started without OWNER_API_TOKEN set. */
export class MissingOwnerTokenError extends Error {
  constructor() {
    super(
      'OWNER_API_TOKEN is not set; the owner API refuses to serve /v1 unauthenticated. ' +
        'Generate one with `openssl rand -hex 32`.',
    );
    this.name = 'MissingOwnerTokenError';
  }
}

export const BEARER = /^Bearer (.+)$/;

/**
 * Fastify `onRequest` hook guarding the /v1 surface. A missing, malformed, or
 * wrong token is an indistinguishable 401 with no detail: the owner already
 * knows their token, and anyone else learns nothing about why they failed.
 */
export function requireOwnerToken(expected: string) {
  return async function ownerAuthHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers.authorization;
    const presented = header?.match(BEARER)?.[1];

    if (!presented || !secretsMatch(presented, expected)) {
      request.log.warn(
        { path: request.url, method: request.method, has_header: Boolean(header) },
        'rejected unauthenticated request',
      );
      // `.send` and return — throwing here would run the error handler and
      // risk leaking a stack shape difference between the two failure modes.
      await reply.code(401).send({ error: 'unauthorized' });
    }
  };
}
