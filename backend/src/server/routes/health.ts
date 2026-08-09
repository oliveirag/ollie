import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { checkHealth } from '../health.js';
import { HealthReportSchema } from '../schemas.js';

/**
 * Public liveness check. Unchanged in body and status codes from the
 * `node:http` server it replaces — Railway's health check keys on the 503, and
 * the camelCase field names are an existing contract not worth breaking for
 * consistency with the newer /v1 routes.
 */
export const registerHealthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/healthz',
    {
      schema: {
        operationId: 'getHealth',
        summary: 'Liveness and configuration check',
        description:
          'Reports database reachability and the runtime safety flags as the service ' +
          'currently sees them. The flags are included deliberately: the fastest way to ' +
          'answer "what mode is production actually in" should not be reading deploy ' +
          'variables and hoping they match.\n\n' +
          'Returns 503 when the database is unreachable, which is what the platform ' +
          'health check keys on.',
        response: {
          200: HealthReportSchema.describe('Service healthy'),
          503: HealthReportSchema.describe('Service degraded — the database is unreachable'),
        },
      },
    },
    async (request, reply) => {
      const report = await checkHealth();
      if (report.status !== 'ok') {
        request.log.error({ report }, 'health check degraded');
        return reply.code(503).send(report);
      }
      return reply.code(200).send(report);
    },
  );
};
