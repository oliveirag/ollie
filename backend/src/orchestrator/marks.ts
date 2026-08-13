import { Prisma, type PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { newRunLogger } from '../logger.js';
import { appendTrackRecord, hasMarkForDay, listOpenLots } from '../db/trackRecord.js';
import type { BrokerAdapter } from './robinhood/client.js';

/**
 * Daily mark-to-market.
 *
 * The dashboard already computes unrealised PnL live from quotes at read time,
 * and that stays untouched — it answers "what is this worth now". The equity
 * curve asks a different question: what were the open positions worth on each
 * *past* day. No read-time computation can recover that later, so it has to be
 * written down as it happens, one append-only row per open lot per trading day.
 *
 * **This job is exempt from the kill switch**, which is the first exception to
 * "either switch halts everything" and will look like a bug to anyone reading
 * the scheduler. The reasoning: marking observes, it does not act. This module
 * holds no executor and calls no order-capable broker method, so it cannot move
 * money by any path. A halt that also stopped marking would punch a permanent,
 * unfillable hole in the published curve — destroying history in order to stop
 * trading, when only the trading needed stopping.
 */
export interface MarkDeps {
  broker: BrokerAdapter;
  logger: Logger;
  prisma?: PrismaClient;
  now?: () => Date;
}

export interface MarkResult {
  runId: string;
  marked: number;
  skippedAlreadyMarked: number;
  /** Symbols whose quote was unavailable, so their lots were left unmarked. */
  gaps: string[];
}

export async function runMarkToMarket(deps: MarkDeps): Promise<MarkResult> {
  const log = newRunLogger('mark', deps.logger);
  const now = (deps.now ?? (() => new Date()))();

  const lots = await listOpenLots(deps.prisma);
  if (lots.length === 0) {
    log.info('no open lots to mark');
    return { runId: log.runId, marked: 0, skippedAlreadyMarked: 0, gaps: [] };
  }

  const symbols = [...new Set(lots.map((lot) => lot.symbol))];

  // A total quote failure is a gap for every symbol, not a crash. The next
  // firing will mark tomorrow; today is simply missing, and the curve says so.
  let quotes: Awaited<ReturnType<BrokerAdapter['getQuotes']>> = {};
  try {
    quotes = await deps.broker.getQuotes(symbols);
  } catch (error) {
    log.error({ err: error, symbols }, 'quote fetch failed; marking nothing today');
    return { runId: log.runId, marked: 0, skippedAlreadyMarked: 0, gaps: symbols };
  }

  let marked = 0;
  let skippedAlreadyMarked = 0;
  const gaps = new Set<string>();

  for (const lot of lots) {
    const price = quotes[lot.symbol]?.lastTradePrice;
    if (price == null) {
      // Never a guess. A fabricated mark is indistinguishable from a real one
      // forever, and these rows cannot be corrected in place.
      gaps.add(lot.symbol);
      log.warn({ symbol: lot.symbol, signal_id: lot.signalId }, 'no quote; leaving a gap');
      continue;
    }

    // Idempotence, because the alternative is permanent: a second mark for the
    // same lot on the same day would double-count it in that day's curve point.
    if (await hasMarkForDay(lot.signalId, now, deps.prisma)) {
      skippedAlreadyMarked += 1;
      continue;
    }

    const quantity = new Prisma.Decimal(lot.quantity);
    const unrealizedPnl = new Prisma.Decimal(price).minus(lot.entryPrice).times(quantity);

    await appendTrackRecord(
      {
        signalId: lot.signalId,
        entryPrice: lot.entryPrice,
        unrealizedPnl: unrealizedPnl.toString(),
        markPrice: price,
        status: 'open',
        recordedAt: now,
      },
      deps.prisma,
    );
    marked += 1;
  }

  log.info(
    { marked, skipped_already_marked: skippedAlreadyMarked, gaps: [...gaps] },
    'mark-to-market complete',
  );
  return { runId: log.runId, marked, skippedAlreadyMarked, gaps: [...gaps] };
}
