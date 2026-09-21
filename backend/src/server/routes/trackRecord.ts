import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { firstLivePublishedAt } from '../../db/signals.js';
import { listAllTrackRecordRows } from '../../db/trackRecord.js';
import { computeTrackRecord } from '../../orchestrator/trackRecordStats.js';
import { ErrorSchema, TrackRecordSchema } from '../schemas.js';

/**
 * The published record. A thin skin over `computeTrackRecord`, deliberately:
 * the numbers are derived from the append-only rows at read time, never stored,
 * so anyone holding the rows can recompute them and get this same answer.
 */
export const registerTrackRecordRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/track-record',
    {
      schema: {
        operationId: 'getTrackRecord',
        summary: 'Performance to date and the equity curve',
        description:
          'Computed from the append-only track-record rows at read time, never stored — ' +
          'a stored copy could drift from the rows it summarises, and drift in published ' +
          'performance is the one failure this product cannot survive.\\n\\n' +
          'Win rate and average return are null until at least one trade has closed. ' +
          'Curve days on which an open lot had no mark are returned with `withheld: true` ' +
          'and a null value rather than a partial sum.',
        tags: ['track-record'],
        security: [{ ownerToken: [] }],
        response: {
          200: TrackRecordSchema,
          401: ErrorSchema.describe('Missing or invalid owner token'),
        },
      },
    },
    async (_request, reply) => {
      const stats = computeTrackRecord(await listAllTrackRecordRows());

      return reply.code(200).send({
        closed_trades: stats.closedTrades,
        open_positions: stats.openPositions,
        wins: stats.wins,
        win_rate: stats.winRate,
        average_return: stats.averageReturn,
        total_realized_pnl: stats.totalRealizedPnl.toFixed(2),
        curve: stats.curve,
        live_since: (await firstLivePublishedAt())?.toISOString() ?? null,
      });
    },
  );
};
