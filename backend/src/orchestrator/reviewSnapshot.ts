import { z } from 'zod';
import type { OrderSide, ReviewResult } from './robinhood/client.js';

/**
 * What gets persisted in `signals.review_snapshot`.
 *
 * The broker's raw response is kept verbatim under `raw` — it is the evidence
 * that a pre-trade review happened, and its shape is the broker's to change.
 * Everything above it is ours: the fields the pipeline and the executor need
 * to read without having to re-interpret a third party's JSON months later.
 *
 * In particular `estimated_price` is derived, not quoted: `review_equity_order`
 * returns no estimate of its own, so this is the ask (for a buy) or the bid
 * (for a sell) at review time. Recording the derivation alongside the source
 * is what makes a paper fill auditable.
 */
export const ReviewSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    estimated_price: z.string(),
    alerts: z.array(z.object({ type: z.string(), details: z.unknown() })).default([]),
    requested: z.object({
      symbol: z.string(),
      side: z.enum(['buy', 'sell']),
      quantity: z.string(),
      type: z.literal('market'),
    }),
    captured_at: z.string(),
    raw: z.unknown(),
  })
  .passthrough();

export type ReviewSnapshot = z.infer<typeof ReviewSnapshotSchema>;

export function buildReviewSnapshot(
  review: ReviewResult,
  requested: { symbol: string; side: OrderSide; quantity: string },
  capturedAt: Date,
): ReviewSnapshot {
  return {
    schema_version: 1,
    estimated_price: review.estimatedPrice,
    alerts: review.alerts.map((alert) => ({ type: alert.type, details: alert.details })),
    requested: { ...requested, type: 'market' },
    captured_at: capturedAt.toISOString(),
    raw: review.raw,
  };
}

/** Throws if a persisted snapshot is unreadable — a fill must never be guessed. */
export function parseReviewSnapshot(value: unknown): ReviewSnapshot {
  const parsed = ReviewSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `review_snapshot is not readable: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}
