import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import { hasAccepted, recordAcceptance } from '../../db/disclaimerAcceptances.js';
import {
  APP_TOKENS_KEPT,
  hasLiveToken,
  listTokens,
  mintToken,
  ownsToken,
  revokeAllButNewest,
  revokeToken,
} from '../../db/subscriberTokens.js';
import { createSubscriber, deleteSubscriberAccount, findUserByAppleId } from '../../db/users.js';
import { currentDisclaimer } from '../../published/disclaimer.js';
import { secretsMatch } from '../../secrets.js';
import {
  AcceptDisclaimerRequestSchema,
  DeleteAccountRequestSchema,
  DisclaimerAcceptanceSchema,
  ErrorSchema,
  McpTokenListSchema,
  McpTokenMintedSchema,
  OnboardingSchema,
  SessionRequestSchema,
  SessionSchema,
} from '../schemas.js';
import { InvalidIdentityTokenError, SiwaRevokeError, type SiwaRevoker, type SiwaVerifier } from '../siwa.js';

/**
 * Onboarding (Phase 4, decisions 3, 6, 8). Every step's completion is a row,
 * never an app-side flag: a user exists, an acceptance for the current text
 * exists, an unrevoked MCP token exists. The token mint is the enforcement
 * point for consent — it refuses without a current-version acceptance, so an
 * agent credential cannot exist without the consent row predating it.
 */

export interface OnboardingRouteOptions {
  config: Config;
  prisma: PrismaClient;
  siwa: SiwaVerifier;
  /** null when no Sign in with Apple key is configured; deletion then skips revocation. */
  siwaRevoker?: SiwaRevoker | null;
}

function mcpUrl(config: Config): string | null {
  return config.signalService.publicUrl ? `${config.signalService.publicUrl}/mcp` : null;
}

/** Constant-time against every configured code, so timing cannot rank them. */
function inviteCodeAccepted(presented: string | undefined, codes: readonly string[]): boolean {
  if (!presented) return false;
  let matched = false;
  for (const code of codes) matched = secretsMatch(presented, code) || matched;
  return matched;
}

/** Public: the session route is how a subscriber gets a token in the first place. */
export const registerSessionRoute: FastifyPluginAsyncZod<OnboardingRouteOptions> = async (
  app,
  opts,
) => {
  const { config, prisma, siwa } = opts;

  app.post(
    '/session',
    {
      schema: {
        operationId: 'createSession',
        summary: 'Sign in with Apple and receive an app session token',
        description:
          'Verifies the identity token against Apple\'s keys, then finds or creates the ' +
          'subscriber by Apple subject. A first sign-in needs a valid invite code while the ' +
          'soft launch is gated; a returning subscriber does not.\n\n' +
          'The token in the response is the only time it is shown.',
        tags: ['onboarding'],
        body: SessionRequestSchema,
        response: {
          200: SessionSchema,
          400: ErrorSchema.describe('The request failed schema validation'),
          401: ErrorSchema.describe('The identity token did not verify'),
          403: ErrorSchema.describe('First sign-in without a valid invite code'),
        },
      },
    },
    async (request, reply) => {
      let identity;
      try {
        identity = await siwa.verify(request.body.identity_token);
      } catch (error) {
        if (error instanceof InvalidIdentityTokenError) {
          request.log.warn({ reason: error.reason }, 'identity token rejected');
          return reply.code(401).send({ error: 'invalid_identity_token' });
        }
        throw error;
      }

      let user = await findUserByAppleId(identity.appleUserId, prisma);
      if (!user) {
        if (!inviteCodeAccepted(request.body.invite_code, config.signalService.inviteCodes)) {
          request.log.warn('first sign-in refused: no valid invite code');
          return reply.code(403).send({ error: 'invite_required' });
        }
        try {
          user = await createSubscriber(
            {
              appleUserId: identity.appleUserId,
              email: identity.email,
              inviteCode: request.body.invite_code ?? null,
            },
            prisma,
          );
          request.log.info({ user_id: user.id }, 'subscriber created');
        } catch (error) {
          // Two first sign-ins raced (a double tap, a retry): the other one
          // created the row. That subscriber is this subscriber.
          const raced =
            error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
              ? await findUserByAppleId(identity.appleUserId, prisma)
              : null;
          if (!raced) throw error;
          user = raced;
        }
      }

      const minted = await mintToken(user.id, 'app', prisma);
      await revokeAllButNewest(user.id, 'app', APP_TOKENS_KEPT, { prisma });
      return reply.code(200).send({
        token: minted.plaintext,
        subscriber: {
          id: user.id,
          email: user.email,
          created_at: user.createdAt.toISOString(),
        },
      });
    },
  );
};

/** Everything here runs behind `requireSubscriberToken('app')`. */
export const registerOnboardingRoutes: FastifyPluginAsyncZod<OnboardingRouteOptions> = async (
  app,
  opts,
) => {
  const { config, prisma } = opts;
  const siwaRevoker = opts.siwaRevoker ?? null;

  app.get(
    '/onboarding',
    {
      schema: {
        operationId: 'getOnboarding',
        summary: 'Where this subscriber is in onboarding, from rows',
        tags: ['onboarding'],
        security: [{ subscriberToken: [] }],
        response: {
          200: OnboardingSchema,
          401: ErrorSchema.describe('Missing or invalid app token'),
        },
      },
    },
    async (request) => {
      const user = request.subscriber!;
      const disclaimer = currentDisclaimer();
      return {
        disclaimer,
        accepted_current_version: await hasAccepted(user.id, disclaimer.version, prisma),
        has_mcp_token: await hasLiveToken(user.id, 'mcp', prisma),
        mcp_url: mcpUrl(config),
      };
    },
  );

  app.post(
    '/disclaimer/accept',
    {
      schema: {
        operationId: 'acceptDisclaimer',
        summary: 'Record that this subscriber accepted the disclaimer',
        description:
          'The version must be the one currently served. A mismatch means the text changed ' +
          'under the client: re-fetch onboarding, re-display, and accept the new version.',
        tags: ['onboarding'],
        security: [{ subscriberToken: [] }],
        body: AcceptDisclaimerRequestSchema,
        response: {
          200: DisclaimerAcceptanceSchema,
          400: ErrorSchema.describe('The request failed schema validation'),
          401: ErrorSchema.describe('Missing or invalid app token'),
          409: ErrorSchema.describe('The version accepted is not the version served'),
        },
      },
    },
    async (request, reply) => {
      const user = request.subscriber!;
      const disclaimer = currentDisclaimer();
      if (request.body.version !== disclaimer.version) {
        return reply.code(409).send({
          error: 'disclaimer_version_mismatch',
          detail: 'the disclaimer changed; re-display the current text and accept its version',
        });
      }

      const row = await recordAcceptance(
        { userId: user.id, disclaimerVersion: disclaimer.version },
        prisma,
      );
      request.log.info({ user_id: user.id, version: disclaimer.version }, 'disclaimer accepted');
      return reply.code(200).send({
        version: row.disclaimerVersion,
        accepted_at: row.acceptedAt.toISOString(),
      });
    },
  );

  app.post(
    '/mcp-tokens',
    {
      schema: {
        operationId: 'mintMcpToken',
        summary: 'Mint an agent-facing MCP token',
        description:
          'Refused with 409 until the current disclaimer version has been accepted — the ' +
          'credential cannot exist without the consent row predating it. The plaintext is ' +
          'returned once; only its hash is stored. Lost it? Revoke and mint again.',
        tags: ['tokens'],
        security: [{ subscriberToken: [] }],
        response: {
          200: McpTokenMintedSchema,
          401: ErrorSchema.describe('Missing or invalid app token'),
          409: ErrorSchema.describe('The current disclaimer has not been accepted'),
        },
      },
    },
    async (request, reply) => {
      const user = request.subscriber!;
      const disclaimer = currentDisclaimer();
      if (!(await hasAccepted(user.id, disclaimer.version, prisma))) {
        return reply.code(409).send({
          error: 'disclaimer_not_accepted',
          detail: 'accept the current disclaimer before minting an MCP token',
        });
      }

      const minted = await mintToken(user.id, 'mcp', prisma);
      request.log.info({ user_id: user.id, token_id: minted.token.id }, 'mcp token minted');
      return reply.code(200).send({
        id: minted.token.id,
        token: minted.plaintext,
        mcp_url: mcpUrl(config),
        created_at: minted.token.createdAt.toISOString(),
        last_used_at: null,
        revoked_at: null,
      });
    },
  );

  app.get(
    '/mcp-tokens',
    {
      schema: {
        operationId: 'listMcpTokens',
        summary: 'This subscriber\'s MCP tokens, never the plaintext',
        tags: ['tokens'],
        security: [{ subscriberToken: [] }],
        response: {
          200: McpTokenListSchema,
          401: ErrorSchema.describe('Missing or invalid app token'),
        },
      },
    },
    async (request) => {
      const tokens = await listTokens(request.subscriber!.id, 'mcp', prisma);
      return {
        tokens: tokens.map((token) => ({
          id: token.id,
          created_at: token.createdAt.toISOString(),
          last_used_at: token.lastUsedAt?.toISOString() ?? null,
          revoked_at: token.revokedAt?.toISOString() ?? null,
        })),
      };
    },
  );

  app.delete(
    '/mcp-tokens/:id',
    {
      schema: {
        operationId: 'revokeMcpToken',
        summary: 'Revoke an MCP token',
        description: 'Idempotent. The row remains as history with `revoked_at` set.',
        tags: ['tokens'],
        security: [{ subscriberToken: [] }],
        params: z.object({ id: z.string().uuid() }),
        response: {
          204: z.null().describe('Revoked, or already was'),
          400: ErrorSchema.describe('The request failed schema validation'),
          401: ErrorSchema.describe('Missing or invalid app token'),
          404: ErrorSchema.describe('No such token belongs to this subscriber'),
        },
      },
    },
    async (request, reply) => {
      const user = request.subscriber!;
      const owned = await ownsToken(request.params.id, user.id, 'mcp', prisma);
      if (!owned) return reply.code(404).send({ error: 'token_not_found' });

      if (await revokeToken(request.params.id, user.id, { prisma })) {
        request.log.info({ user_id: user.id, token_id: request.params.id }, 'mcp token revoked');
      }
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/account/delete',
    {
      schema: {
        operationId: 'deleteAccount',
        summary: 'Delete this subscriber\'s account',
        description:
          'App Store guideline 5.1.1(v). Revokes the subscriber\'s Sign in with Apple tokens ' +
          'when an authorization code is supplied, then tombstones the account: the Apple ' +
          'subject, email and invite code are removed and every app and MCP token is revoked, ' +
          'so the session token used for this call stops working with it. Disclaimer ' +
          'acceptances stay, attached to the anonymous row, because they are an append-only ' +
          'record. A failed revocation is logged and does not stop the deletion.',
        tags: ['onboarding'],
        security: [{ subscriberToken: [] }],
        body: DeleteAccountRequestSchema,
        response: {
          204: z.null().describe('Deleted'),
          400: ErrorSchema.describe('The request failed schema validation'),
          401: ErrorSchema.describe('Missing or invalid app token'),
        },
      },
    },
    async (request, reply) => {
      const user = request.subscriber!;
      const code = request.body.authorization_code;

      if (code && siwaRevoker) {
        try {
          await siwaRevoker.revokeAuthorizationCode(code);
          request.log.info({ user_id: user.id }, 'apple tokens revoked');
        } catch (error) {
          // Apple's guidance is that the deletion must happen even when the
          // tokens cannot be revoked, so this is logged, not returned.
          const detail =
            error instanceof SiwaRevokeError
              ? { stage: error.stage, status: error.status, reason: error.reason }
              : { reason: error instanceof Error ? error.message : 'unknown' };
          request.log.warn({ user_id: user.id, ...detail }, 'apple token revocation failed');
        }
      } else {
        request.log.warn(
          { user_id: user.id, has_code: Boolean(code), revoker: Boolean(siwaRevoker) },
          'apple token revocation skipped',
        );
      }

      await deleteSubscriberAccount(user.id, prisma);
      request.log.info({ user_id: user.id }, 'subscriber account deleted');
      return reply.code(204).send(null);
    },
  );
};
