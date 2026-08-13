import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config/index.js';
import { getAppSettings } from '../../db/settings.js';
import {
  getSignal,
  listDecidedSignals,
  listPendingSignals,
  listSignalEvents,
  SignalNotPendingError,
  transitionSignal,
  type DecidedStatus,
} from '../../db/signals.js';
import type { Logger } from 'pino';
import { executorFor } from '../../orchestrator/executor.js';
import type { BrokerAdapter } from '../../orchestrator/robinhood/client.js';
import {
  DecisionRequestSchema,
  DecisionResponseSchema,
  ErrorSchema,
  SignalDetailSchema,
  SignalListSchema,
  toSignalDetail,
  toSignalSummary,
} from '../schemas.js';

/**
 * The approvals surface. A thin, authenticated skin over the repository
 * functions the decide-signal CLI already calls — which is the point: the CLI
 * stays working as the break-glass path for a dead phone or a down API, and
 * both surfaces contend on the same database guarantees rather than on each
 * other. `SignalNotPendingError` is what makes a decision exactly-once; this
 * layer only translates it to a status code.
 */

export interface SignalRouteOptions {
  config: Config;
  /** Constructed by the caller so one adapter is shared, and closed, per process. */
  broker: BrokerAdapter;
  logger: Logger;
}

const ListQuerySchema = z.object({
  status: z
    .enum(['pending', 'decided'])
    .default('pending')
    .describe('pending = awaiting the owner; decided = approved, rejected, or expired'),
  limit: z.coerce.number().int().min(1).max(200).default(50).describe('Decided list only'),
});

const SignalParamsSchema = z.object({ id: z.string().uuid() });

export const registerSignalRoutes: FastifyPluginAsyncZod<SignalRouteOptions> = async (
  app,
  opts,
) => {
  const { config, broker, logger } = opts;

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
          400: ErrorSchema.describe('The request failed schema validation'),
          401: ErrorSchema.describe('Missing or invalid owner token'),
        },
      },
    },
    async (request) => {
      const { status, limit } = request.query;
      const signals =
        status === 'pending' ? await listPendingSignals() : await listDecidedSignals(limit);

      return {
        signals: signals.map((signal) => toSignalSummary(signal, config.signalExpiryMinutes)),
      };
    },
  );

  app.get(
    '/signals/:id',
    {
      schema: {
        operationId: 'getSignal',
        summary: 'Full detail for one signal',
        description:
          'Thesis and its source, the computed indicators, the parsed review snapshot ' +
          '(estimated price and any broker alerts), and the append-only status history.',
        tags: ['signals'],
        security: [{ ownerToken: [] }],
        params: SignalParamsSchema,
        response: {
          200: SignalDetailSchema,
          400: ErrorSchema.describe('The request failed schema validation'),
          401: ErrorSchema.describe('Missing or invalid owner token'),
          404: ErrorSchema.describe('No signal with that id'),
        },
      },
    },
    async (request, reply) => {
      const signal = await getSignal(request.params.id);
      if (!signal) return reply.code(404).send({ error: 'signal_not_found' });

      const events = await listSignalEvents(signal.id);
      return reply.code(200).send(toSignalDetail(signal, events, config.signalExpiryMinutes));
    },
  );

  app.post(
    '/signals/:id/decision',
    {
      schema: {
        operationId: 'decideSignal',
        summary: 'Approve or reject a pending signal',
        description:
          'Approving runs the executor for the signal\'s own execution mode and returns the ' +
          'resulting fill; in paper mode that never contacts the broker. Rejecting records ' +
          'the reason and executes nothing.\n\n' +
          'A signal that has already left `pending` — decided elsewhere, or expired by the ' +
          'sweep — returns 409 with its current status. That is the system working: the ' +
          'decision is exactly-once at the database tier.',
        tags: ['signals'],
        security: [{ ownerToken: [] }],
        params: SignalParamsSchema,
        body: DecisionRequestSchema,
        response: {
          200: DecisionResponseSchema,
          400: ErrorSchema.describe('The request failed schema validation'),
          401: ErrorSchema.describe('Missing or invalid owner token'),
          404: ErrorSchema.describe('No signal with that id'),
          409: ErrorSchema.describe(
            'Already decided or expired, the kill switch is engaged, or live mode is not enabled',
          ),
          500: ErrorSchema.describe('Approved, but the fill failed — see detail'),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { action, reason } = request.body;

      const signal = await getSignal(id);
      if (!signal) return reply.code(404).send({ error: 'signal_not_found' });
      if (signal.status !== 'pending') {
        return reply
          .code(409)
          .send({ error: 'signal_not_pending', status: signal.status });
      }

      const status: DecidedStatus = action === 'approve' ? 'approved' : 'rejected';
      // Built from `status`, not `action` — the past tense of "reject" is not
      // "rejectd", and this string lands in the append-only audit where a typo
      // cannot be corrected later.
      const decideReason = reason ?? `${status} from the owner app`;

      // Pre-flight the execution gates before the transition, not after.
      //
      // The status transition is irreversible — the immutability triggers only
      // permit pending -> terminal — so an approval that the executor then
      // refuses would leave a signal marked approved with no fill behind it and
      // no way back. Checking first means the common refusals (kill switch on,
      // live mode) return 409 with the signal still pending and still
      // decidable. The executor re-checks both; that check, not this one, is
      // the authority.
      if (status === 'approved') {
        const blocked = await preflightExecution(signal.executionMode, config);
        if (blocked) return reply.code(409).send(blocked);
      }

      let decided;
      try {
        decided = await transitionSignal(id, status, decideReason);
      } catch (error) {
        if (error instanceof SignalNotPendingError) {
          // Lost a race with the expiry sweep or another surface between the
          // read above and the write. Re-read so the app is told what actually
          // won rather than what we assumed.
          const current = await getSignal(id);
          return reply
            .code(409)
            .send({ error: 'signal_not_pending', ...(current ? { status: current.status } : {}) });
        }
        throw error;
      }

      const summary = toSignalSummary(decided, config.signalExpiryMinutes);
      if (status === 'rejected') {
        return reply.code(200).send({ signal: summary, execution: null });
      }

      try {
        const executor = executorFor(decided, { config, logger }, broker);
        const { execution } = await executor.execute(decided);

        return reply.code(200).send({
          signal: summary,
          execution: {
            id: execution.id,
            mode: execution.mode,
            fill_price: execution.fillPrice.toString(),
            quantity: execution.quantity.toString(),
            filled_at: execution.filledAt.toISOString(),
            broker_order_id: execution.brokerOrderId,
          },
        });
      } catch (error) {
        // The narrow window the pre-flight cannot close: the kill switch was
        // flipped between the check and the fill. The signal is approved and
        // unfilled, and it cannot be walked back, so say so plainly instead of
        // returning a bare 500 the app would render as "try again".
        request.log.error(
          { err: error, signal_id: id },
          'signal approved but execution failed; it has no fill',
        );
        return reply.code(500).send({
          error: 'execution_failed',
          detail:
            `signal ${id} is approved but was not filled: ` +
            (error instanceof Error ? error.message : String(error)),
          status: decided.status,
        });
      }
    },
  );
};

/**
 * Returns an error body when execution would be refused, or null when it would
 * proceed. Mirrors the executor's own gates without duplicating their
 * authority — this exists to keep a doomed approval from consuming the
 * signal's one allowed transition.
 */
async function preflightExecution(
  mode: 'paper' | 'live',
  config: Config,
): Promise<{ error: string; detail: string } | null> {
  if (config.killSwitchEnv) {
    return { error: 'kill_switch_engaged', detail: 'KILL_SWITCH is set in the environment' };
  }

  const settings = await getAppSettings();
  if (settings.killSwitch) {
    return { error: 'kill_switch_engaged', detail: 'the kill switch is on' };
  }

  if (mode === 'live') {
    // Phase 5. LiveExecutor throws even with both gates open, so surfacing the
    // refusal here keeps the signal pending rather than burning its transition.
    const reason = !config.liveTradingEnabled
      ? 'LIVE_TRADING_ENABLED is not set'
      : settings.executionMode !== 'live'
        ? 'app_settings.execution_mode is not live'
        : 'the live order path is not implemented until Phase 5';
    return { error: 'live_mode_not_enabled', detail: reason };
  }

  return null;
}
