import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import { listOpenLots, type OpenLot } from '../../db/trackRecord.js';
import { dec } from '../../money.js';
import type { BrokerAdapter, Quote } from '../../orchestrator/robinhood/client.js';
import { DashboardSchema, ErrorSchema } from '../schemas.js';

/**
 * Positions and PnL (PRD §4.3).
 *
 * Two honesty rules shape this endpoint. Quotes are best-effort: the broker
 * being unreachable degrades the view to entry basis rather than failing it,
 * because a dashboard that 500s when Robinhood hiccups is useless exactly when
 * the owner is anxious. And realized PnL reads zero until Phase 3 — nothing
 * closes a position yet, so any other number would be invented.
 */

export interface DashboardRouteOptions {
  broker: BrokerAdapter;
  logger: Logger;
}

/** Unrealized PnL for an open lot. A sell lot profits when the price falls. */
function unrealizedPnl(lot: OpenLot, quotePrice: string): string {
  const move = dec(quotePrice).minus(dec(lot.entryPrice));
  const signed = lot.side === 'sell' ? move.negated() : move;
  return signed.times(dec(lot.quantity)).toFixed(2);
}

export const registerDashboardRoutes: FastifyPluginAsyncZod<DashboardRouteOptions> = async (
  app,
  opts,
) => {
  const { broker, logger } = opts;

  app.get(
    '/dashboard',
    {
      schema: {
        operationId: 'getDashboard',
        summary: 'Open positions and PnL',
        description:
          'Open lots are the latest track-record row per signal that is still open, each ' +
          'with its entry price, current quote, and unrealized PnL.\n\n' +
          'Quotes are best-effort. If the broker is unreachable every lot still returns ' +
          'with `quote: null` and the app shows entry basis only; `quotes_available` says ' +
          'which happened. Quote age is reported so a stale price is never read as current.',
        tags: ['dashboard'],
        security: [{ ownerToken: [] }],
        response: {
          200: DashboardSchema,
          401: ErrorSchema.describe('Missing or invalid owner token'),
        },
      },
    },
    async () => {
      const lots = await listOpenLots();

      let quotes: Record<string, Quote> = {};
      let quotesAvailable = true;
      let quotedAt: Date | null = null;

      if (lots.length > 0) {
        const symbols = [...new Set(lots.map((lot) => lot.symbol))];
        try {
          quotes = await broker.getQuotes(symbols);
          quotedAt = new Date();
        } catch (error) {
          // Logged, never thrown: the positions themselves are database truth
          // and the owner should still see them.
          logger.warn({ err: error, symbols }, 'dashboard quotes unavailable; entry basis only');
          quotesAvailable = false;
        }
      }

      const quoteAgeSeconds = quotedAt
        ? Math.max(0, Math.round((Date.now() - quotedAt.getTime()) / 1000))
        : null;

      const rendered = lots.map((lot) => {
        const price = quotes[lot.symbol]?.lastTradePrice ?? null;
        return {
          signal_id: lot.signalId,
          symbol: lot.symbol,
          side: lot.side as 'buy' | 'sell',
          quantity: lot.quantity,
          entry_price: lot.entryPrice,
          opened_at: lot.recordedAt.toISOString(),
          quote: price,
          quote_age_seconds: price === null ? null : quoteAgeSeconds,
          unrealized_pnl: price === null ? null : unrealizedPnl(lot, price),
        };
      });

      const costBasis = lots.reduce(
        (sum, lot) => sum.plus(dec(lot.entryPrice).times(dec(lot.quantity))),
        dec(0),
      );

      // A total is only meaningful if every lot contributed to it. One missing
      // quote makes the sum understate the portfolio, which is worse than
      // admitting the number is unavailable. Vacuously true with no lots, which
      // is what we want: an empty portfolio is worth zero, not unknown.
      const everyLotQuoted = rendered.every((lot) => lot.quote !== null);
      const marketValue = everyLotQuoted
        ? rendered.reduce((sum, lot) => sum.plus(dec(lot.quote!).times(dec(lot.quantity))), dec(0))
        : null;
      const unrealizedTotal = everyLotQuoted
        ? rendered.reduce((sum, lot) => sum.plus(dec(lot.unrealized_pnl!)), dec(0))
        : null;

      return {
        lots: rendered,
        totals: {
          cost_basis: costBasis.toFixed(2),
          market_value: marketValue === null ? null : marketValue.toFixed(2),
          unrealized_pnl: unrealizedTotal === null ? null : unrealizedTotal.toFixed(2),
          // Phase 3's job. Reporting anything else here would be inventing a
          // number the track record cannot yet support.
          realized_pnl: '0.00',
        },
        quotes_available: quotesAvailable,
      };
    },
  );
};
