import type { PrismaClient, Signal } from '@prisma/client';
import type { Logger } from 'pino';
import { newRunLogger } from '../logger.js';
import {
  SignalAlreadyPublishedError,
  listFilledUnpublishedSignals,
  publishSignal,
} from '../db/signals.js';

/**
 * The publication reconciliation sweep (Phase 4, decision 1).
 *
 * The decision route publishes a signal in the same request that fills it, so
 * in the normal case this finds nothing. It exists for the crash window: the
 * process died, or the flip failed, between the execution row landing and the
 * publish update. An approved signal with a fill and `published = false` is a
 * state that should last at most one sweep interval — a feed with silent holes
 * would be a curated record, which PRD §9 forbids.
 *
 * **Not gated on the kill switch**, unlike the pipeline, the executor and the
 * mark job. The switch halts *acting* — proposing and filling. Publication is
 * disclosure of a fill that has already happened, and withholding it during a
 * halt would make the feed less complete than the owner's own book, which is
 * the one ordering this product promises never to invert.
 */
export interface PublishSweepDeps {
  logger: Logger;
  prisma?: PrismaClient;
  clock?: () => Date;
}

export async function sweepUnpublishedSignals(deps: PublishSweepDeps): Promise<Signal[]> {
  const stale = await listFilledUnpublishedSignals(deps.prisma);
  if (stale.length === 0) return [];

  const log = newRunLogger('publish', deps.logger);
  const now = (deps.clock ?? (() => new Date()))();
  const published: Signal[] = [];

  for (const signal of stale) {
    try {
      const flipped = await publishSignal(signal.id, {
        now,
        ...(deps.prisma ? { prisma: deps.prisma } : {}),
      });
      published.push(flipped);
      log.warn(
        { signal_id: signal.id, symbol: signal.symbol, decided_at: signal.decidedAt?.toISOString() },
        'published a filled signal the decision route did not',
      );
    } catch (error) {
      if (error instanceof SignalAlreadyPublishedError) {
        // The route got there between the query and the update. Fine.
        log.info({ signal_id: signal.id }, 'signal was published before the sweep reached it');
        continue;
      }
      // One failure must not strand the rest of the backlog behind it.
      log.error({ err: error, signal_id: signal.id }, 'publish sweep failed for a signal');
    }
  }

  return published;
}
