import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import { listDecidedSignals, listPendingSignals } from '../../db/signals.js';
import { ErrorSchema, SignalListSchema, toSignalSummary } from '../schemas.js';

/**
 * The approvals surface. In Phase 2 this is a thin, authenticated skin over
 * repository functions the decide-signal CLI already calls — which is the
 * point: the CLI stays working as the break-glass path, and both surfaces
 * contend on the same database guarantees rather than on each other.
 */

const ListQuerySchema = z.object({
  status: z
    .enum(['pending', 'decided'])
    .default('pending')
    .describe('pending = awaiting the owner; decided = approved, rejected, or expired'),
  limit: z.coerce.number().int().min(1).max(200).default(50).describe('Decided list only'),
});

export const registerSignalRoutes: FastifyPluginAsyncZod<{ config: Config }> = async (
  app,
  opts,
) => {
  const { config } = opts;

  app.get(
    '/signals',
    {
      schema: {
        operationId: 'listSignals',
        summary: 'List pending or decided signals',
        description:
          'Pending items carry `expires_at`, computed at read time from the current ' +
          'SIGNAL_EXPIRY_MINUTES. The expiry sweep remains the authority on what is ' +
          'actually expired; the timestamp drives the countdown UI and nothing else.',
        tags: ['signals'],
        security: [{ ownerToken: [] }],
        querystring: ListQuerySchema,
        response: {
          200: SignalListSchema,
          401: ErrorSchema.describe('Missing or invalid owner token'),
        },
      },
    },
    async (request) => {
      const { status, limit } = request.query;
      const signals =
        status === 'pending' ? await listPendingSignals() : await listDecidedSignals(limit);

      return {
        signals: signals.map((signal) =>
          toSignalSummary(signal, config.signalExpiryMinutes),
        ),
      };
    },
  );
};
