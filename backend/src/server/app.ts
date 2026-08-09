import type { IncomingMessage, ServerResponse } from 'node:http';
import fastifySwagger from '@fastify/swagger';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawServerDefault,
} from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import type { Config } from '../config/index.js';
import type { BrokerAdapter } from '../orchestrator/robinhood/client.js';
import { MissingOwnerTokenError, requireOwnerToken } from './auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerSignalRoutes } from './routes/signals.js';

/**
 * The owner API (PRD §4.2-4.3, Phase 2).
 *
 * Fastify rather than the `node:http` server this replaces: that one served a
 * single health route, which was right for a health check and wrong for an API
 * with auth, validation, and a generated client on the other side. zod stays
 * the only validation idiom in the codebase — it already guards the
 * environment and every broker response — and the OpenAPI document the Swift
 * client is generated from falls out of the same schemas.
 */

export interface ApiDeps {
  config: Config;
  logger: Logger;
  /**
   * Only reached by a live-mode approval, which throws until Phase 5, and by
   * the dashboard's best-effort quotes. Injected rather than constructed here
   * so tests can pass a mock and so the process owns exactly one adapter's
   * lifecycle.
   */
  broker: BrokerAdapter;
}

/**
 * The app type every route plugin is written against.
 *
 * The logger slot is deliberately `FastifyBaseLogger` rather than pino's
 * concrete `Logger`: passing a real pino instance specializes that generic,
 * and a specialized instance no longer structurally matches
 * `FastifyPluginAsyncZod`, which silently costs every route its inferred
 * request types. Widening here keeps schema inference working in the plugins.
 */
export type OllieApp = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export const OPENAPI_INFO = {
  title: 'Ollie Orchestrator API',
  version: '0.2.0',
  description:
    'Owner-facing API for the Ollie trading-signal orchestrator.\n\n' +
    'Every route under /v1 requires the owner bearer token. `/healthz` is public so the ' +
    'platform health check can reach it.\n\n' +
    'The subscriber-facing signal feed is a separate read-only MCP server in Phase 4 and is ' +
    'not described by this document.',
} as const;

export const OPENAPI_SERVERS = [
  { url: 'http://localhost:3000', description: 'Local development' },
  { url: 'https://ollie.up.railway.app', description: 'Railway' },
];

/**
 * Build the API without listening, so tests can drive it through
 * `app.inject()` and the spec writer can render the document without opening a
 * port.
 *
 * Throws when the owner token is absent. Refusing to boot is the point: an API
 * that serves the approval and kill-switch surface with authentication
 * silently disabled is worse than one that is down.
 */
export async function buildApp(deps: ApiDeps): Promise<OllieApp> {
  const { config, logger, broker } = deps;
  if (!config.ownerApiToken) throw new MissingOwnerTokenError();

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    // Railway terminates TLS and forwards; without this the logged client IP
    // is the proxy's on every request.
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: OPENAPI_INFO,
      servers: OPENAPI_SERVERS,
      components: {
        securitySchemes: {
          ownerToken: {
            type: 'http',
            scheme: 'bearer',
            description:
              'The pre-shared owner token (OWNER_API_TOKEN). Phase 2 has one user; ' +
              'Sign in with Apple arrives in Phase 4 with the subscriber side.',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    // Lifts every schema carrying a `.meta({ id })` into components/schemas and
    // leaves $refs behind at the use sites, so the generated Swift client has
    // one `SignalSummary` type rather than a fresh anonymous one per endpoint.
    transformObject: jsonSchemaTransformObject,
  });

  // Public: the platform health check must not need a credential.
  await app.register(registerHealthRoutes);

  // Everything else. Registering the auth hook inside the same encapsulation
  // context as the /v1 routes is what keeps it from leaking onto /healthz —
  // and, more importantly, what makes forgetting it on a new route impossible
  // rather than merely unlikely.
  await app.register(
    async (scope) => {
      scope.addHook('onRequest', requireOwnerToken(config.ownerApiToken!));
      await scope.register(registerSignalRoutes, { config, broker, logger });
    },
    { prefix: '/v1' },
  );

  return app;
}
