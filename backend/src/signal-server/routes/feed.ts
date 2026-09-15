import type { PrismaClient } from '@prisma/client';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  firstLivePublishedAt,
  getPublishedSignal,
  listPublishedSignals,
} from '../../db/signals.js';
import {
  latestMarkForLot,
  listAllTrackRecordRows,
  listOpenLots,
  listTrackRecord,
  lotOpenedAt,
} from '../../db/trackRecord.js';
import { computeTrackRecord } from '../../orchestrator/trackRecordStats.js';
import { toPublishedSignal, type PublishedSignal } from '../../published/signal.js';
import {
  ErrorSchema,
  FeedQuerySchema,
  FeedSchema,
  PublishedSignalDetailSchema,
  SubscriberTrackRecordSchema,
  toRecordRow,
} from '../schemas.js';

/**
 * The feed and the record, as subscribers see them. The same repository
 * functions the MCP tools call (4.4) — one projection, three consumers — and
 * the same `computeTrackRecord` the owner's endpoint wraps, over the same
 * rows. Identical numbers on both sides of the wall is the point.
 */

export interface FeedRouteOptions {
  prisma: PrismaClient;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shared with the MCP tools so the two surfaces cannot drift. */
export async function readFeed(
  prisma: PrismaClient,
  query: { limit: number; before?: Date; since?: Date },
): Promise<{ signals: PublishedSignal[]; nextBefore: string | null }> {
  const rows = await listPublishedSignals(
    {
      limit: query.limit,
      ...(query.before ? { before: query.before } : {}),
      ...(query.since ? { since: query.since } : {}),
    },
    prisma,
  );
  const signals = rows.map(toPublishedSignal);
  const last = signals.at(-1);
  return {
    signals,
    nextBefore: rows.length === query.limit && last ? last.published_at : null,
  };
}

export async function readPublishedSignalDetail(prisma: PrismaClient, id: string) {
  const signal = await getPublishedSignal(id, prisma);
  if (!signal) return null;
  const record = await listTrackRecord(signal.id, prisma);
  return { signal: toPublishedSignal(signal), record: record.map(toRecordRow) };
}

export async function readSubscriberTrackRecord(prisma: PrismaClient) {
  const stats = computeTrackRecord(await listAllTrackRecordRows(prisma));
  const lots = await listOpenLots(prisma);

  const positions = await Promise.all(
    lots.map(async (lot) => {
      const mark = await latestMarkForLot(lot.signalId, prisma);
      const openedAt = (await lotOpenedAt(lot.signalId, prisma)) ?? lot.recordedAt;
      return {
        signal_id: lot.signalId,
        symbol: lot.symbol,
        side: lot.side as 'buy' | 'sell',
        quantity: lot.quantity,
        entry_price: lot.entryPrice,
        opened_at: openedAt.toISOString(),
        latest_mark:
          mark && mark.markPrice && mark.unrealizedPnl
            ? {
                price: mark.markPrice.toString(),
                unrealized_pnl: mark.unrealizedPnl.toString(),
                as_of: mark.recordedAt.toISOString(),
                days_held: Math.max(
                  0,
                  Math.floor((mark.recordedAt.getTime() - openedAt.getTime()) / DAY_MS),
                ),
              }
            : null,
      };
    }),
  );

  return {
    closed_trades: stats.closedTrades,
    open_positions: stats.openPositions,
    wins: stats.wins,
    win_rate: stats.winRate,
    average_return: stats.averageReturn,
    total_realized_pnl: stats.totalRealizedPnl.toFixed(2),
    curve: stats.curve,
    live_since: (await firstLivePublishedAt(prisma))?.toISOString() ?? null,
    positions,
  };
}

export const registerFeedRoutes: FastifyPluginAsyncZod<FeedRouteOptions> = async (app, opts) => {
  const { prisma } = opts;

  app.get(
    '/feed',
    {
      schema: {
        operationId: 'getFeed',
        summary: 'Published signals, newest first',
        description:
          'Only signals the owner approved and whose fill was recorded appear here, and they ' +
          'appear only after that fill. Rejected and expired proposals are not signals. The ' +
          'payload is identical for every subscriber.',
        tags: ['feed'],
        security: [{ subscriberToken: [] }],
        querystring: FeedQuerySchema,
        response: {
          200: FeedSchema,
          400: ErrorSchema.describe('The request failed schema validation'),
          401: ErrorSchema.describe('Missing or invalid app token'),
        },
      },
    },
    async (request) => {
      const { limit, before } = request.query;
      const page = await readFeed(prisma, {
        limit,
        ...(before ? { before: new Date(before) } : {}),
      });
      return { signals: page.signals, next_before: page.nextBefore };
    },
  );

  app.get(
    '/signals/:id',
    {
      schema: {
        operationId: 'getPublishedSignal',
        summary: 'One published signal and its full per-signal record',
        description:
          'The record rows are the recompute path: entry, every daily mark with the price ' +
          'it was taken at, the close, and any correction. An unpublished or unknown id ' +
          'returns the same 404, on purpose.',
        tags: ['feed'],
        security: [{ subscriberToken: [] }],
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: PublishedSignalDetailSchema,
          400: ErrorSchema.describe('The request failed schema validation'),
          401: ErrorSchema.describe('Missing or invalid app token'),
          404: ErrorSchema.describe('No published signal with that id'),
        },
      },
    },
    async (request, reply) => {
      const detail = await readPublishedSignalDetail(prisma, request.params.id);
      if (!detail) return reply.code(404).send({ error: 'signal_not_found' });
      return reply.code(200).send(detail);
    },
  );

  app.get(
    '/track-record',
    {
      schema: {
        operationId: 'getSubscriberTrackRecord',
        summary: 'Performance to date, the curve, and open positions at daily marks',
        description:
          'Byte-for-byte the owner\'s numbers: the same pure function over the same ' +
          'append-only rows, computed at read time. Open positions carry their latest daily ' +
          'mark and its date — there is no live quote on this side of the wall, by design.',
        tags: ['feed'],
        security: [{ subscriberToken: [] }],
        response: {
          200: SubscriberTrackRecordSchema,
          401: ErrorSchema.describe('Missing or invalid app token'),
        },
      },
    },
    async () => readSubscriberTrackRecord(prisma),
  );
};
