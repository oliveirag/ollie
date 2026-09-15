import type { PrismaClient } from '@prisma/client';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySwagger from '@fastify/swagger';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import type { OllieApp } from '../server/app.js';
import { requireSubscriberToken } from './auth.js';
import { registerMcpEndpoint } from './mcp.js';
import { registerFeedRoutes } from './routes/feed.js';
import { registerOnboardingRoutes, registerSessionRoute } from './routes/onboarding.js';
import { SignalHealthSchema } from './schemas.js';
import type { SiwaVerifier } from './siwa.js';

/**
 * The signal service (Phase 4, decision 4): subscriber REST plus the Ollie
 * Signal MCP server, one process, one stranger-facing surface. It is built
 * from the same package as the orchestrator and shares its schemas, but its
 * import graph reaches no broker, executor, or push code — a test walks the
 * graph to prove it — and its database role cannot read the tables those
 * would need.
 */

export interface SignalAppDeps {
  config: Config;
  logger: Logger;
  /** Connected as `ollie_signal`. Every repository call receives it explicitly. */
  prisma: PrismaClient;
  siwa: SiwaVerifier;
  /** Per-IP. Overridable so a test can hit the ceiling in three requests. */
  rateLimit?: { max: number; timeWindow: string };
}

export const SUBSCRIBER_OPENAPI_INFO = {
  title: 'Ollie Signal API',
  version: '0.1.0',
  description:
    'Subscriber-facing API for the Ollie signal feed.\n\n' +
    '`POST /v1/session` is public and turns a Sign in with Apple identity token into an app ' +
    'session token; everything else under /v1 requires that token as a bearer. `/healthz` is ' +
    'public. The MCP endpoint at `/mcp` takes a separately minted MCP token and is not ' +
    'described by this document.\n\n' +
    'Nothing here can place, modify, or read an order on any brokerage account. Every ' +
    'response is identical for every subscriber.',
} as const;

export const SUBSCRIBER_OPENAPI_SERVERS = [
  { url: 'http://localhost:3100', description: 'Local development' },
  { url: 'https://ollie-signal.up.railway.app', description: 'Railway' },
];

export async function buildSignalApp(deps: SignalAppDeps): Promise<OllieApp> {
  const { config, logger, prisma, siwa } = deps;
  const rateLimit = deps.rateLimit ?? { max: 240, timeWindow: '1 minute' };

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Per-IP, at onRequest, ahead of authentication, so a stream of bad tokens
  // is throttled before it costs a hash and an index lookup each. A subscriber
  // is one person on one phone plus one agent; a per-IP budget covers both
  // with room, and a NAT shared by several invitees is fine at this scale.
  await app.register(fastifyRateLimit, {
    global: true,
    max: rateLimit.max,
    timeWindow: rateLimit.timeWindow,
    errorResponseBuilder: () => ({ statusCode: 429, error: 'rate_limited' }),
  });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: SUBSCRIBER_OPENAPI_INFO,
      servers: SUBSCRIBER_OPENAPI_SERVERS,
      components: {
        securitySchemes: {
          subscriberToken: {
            type: 'http',
            scheme: 'bearer',
            description:
              'The app session token from POST /v1/session. Per-subscriber, hashed at rest, ' +
              'revocable. Not accepted at /mcp, which takes an MCP token.',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  // Public. Deliberately reports nothing about kill switches or modes: this
  // process cannot read them, and a stranger should not learn them here.
  const startedAt = Date.now();
  app.get(
    '/healthz',
    {
      schema: {
        operationId: 'getSignalHealth',
        summary: 'Liveness check',
        response: { 200: SignalHealthSchema, 503: SignalHealthSchema },
      },
    },
    async (_request, reply) => {
      const checkedAt = new Date().toISOString();
      const uptimeSeconds = Math.round((Date.now() - startedAt) / 1000);
      try {
        await prisma.$queryRaw`SELECT 1`;
        return reply.code(200).send({ status: 'ok', database: 'up', uptimeSeconds, checkedAt });
      } catch {
        return reply
          .code(503)
          .send({ status: 'degraded', database: 'down', uptimeSeconds, checkedAt });
      }
    },
  );

  await app.register(
    async (scope) => {
      // The one public /v1 route: it is where tokens come from.
      await scope.register(registerSessionRoute, { config, prisma, siwa });

      await scope.register(async (authed) => {
        // preValidation, not onRequest: the rate limiter attaches itself as a
        // route-level onRequest hook, which Fastify runs *after* instance-level
        // onRequest hooks. Authenticating one stage later is what puts the
        // throttle in front of the token check.
        authed.addHook('preValidation', requireSubscriberToken(prisma, 'app'));
        await authed.register(registerOnboardingRoutes, { config, prisma, siwa });
        await authed.register(registerFeedRoutes, { prisma });
      });
    },
    { prefix: '/v1' },
  );

  await registerMcpEndpoint(app, { prisma, logger });

  return app;
}
