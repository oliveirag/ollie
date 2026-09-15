import type { Signal } from '@prisma/client';
import { z } from 'zod';
import { parseReviewSnapshot } from '../orchestrator/reviewSnapshot.js';
import {
  SignalSideSchema,
  SignalTypeSchema,
  ThesisSourceSchema,
  decimalString,
} from '../server/schemas.js';

/**
 * The published signal: the subset of the record that crosses to subscribers
 * (Phase 4 definitions; `docs/signal-schema.md` Publication section).
 *
 * One projection, three consumers — the subscriber REST feed, the MCP tools,
 * and the redaction test. There is deliberately no database view of this
 * shape: a view would be a second definition of the subset that could drift
 * from the function the servers actually call. What never crosses is listed
 * in `FORBIDDEN_FIELDS` below, and the test asserts each is absent.
 *
 * Identical for every subscriber. Nothing here takes a caller.
 */

export const PublishedSignalSchema = z
  .object({
    id: z.string().uuid(),
    created_at: z.string().datetime().describe('When the signal fired'),
    published_at: z
      .string()
      .datetime()
      .describe('When it reached the feed — after the owner\'s own fill was recorded, never before'),
    symbol: z.string(),
    side: SignalSideSchema,
    signal_type: SignalTypeSchema,
    quantity: decimalString.describe('Whole shares the owner\'s strategy sized. Not a recommendation for anyone else\'s size.'),
    thesis: z.string().nullable(),
    thesis_source: ThesisSourceSchema.nullable(),
    indicators: z
      .unknown()
      .describe('Every input the rule read, thresholds included, so the decision can be replayed'),
    estimated_price: decimalString
      .nullable()
      .describe('The pre-trade review estimate at proposal time; null if the stored snapshot is unreadable'),
  })
  .meta({ id: 'PublishedSignal' });

export type PublishedSignal = z.infer<typeof PublishedSignalSchema>;

/**
 * Columns of the signal record that must never appear in a published payload.
 * Snake-cased as they would be on the wire, because that is where the test
 * looks for them.
 */
export const FORBIDDEN_FIELDS = [
  'ref_id',
  'review_snapshot',
  'review',
  'raw',
  'alerts',
  'execution_mode',
  'executions',
  'execution',
  'decide_reason',
  'decided_at',
  'dedupe_key',
  'status',
  'expires_at',
] as const;

/** Asked to publish a signal that is not published. There is no such payload. */
export class UnpublishedSignalError extends Error {
  constructor(public readonly signalId: string) {
    super(`signal ${signalId} is not published; it has no published form`);
    this.name = 'UnpublishedSignalError';
  }
}

export function toPublishedSignal(signal: Signal): PublishedSignal {
  // Refusing here rather than trusting callers to filter is what makes "the
  // feed cannot leak an unpublished signal" a property of the projection and
  // not of every query that feeds it.
  if (!signal.published || !signal.publishedAt) throw new UnpublishedSignalError(signal.id);

  let estimatedPrice: string | null = null;
  try {
    estimatedPrice = parseReviewSnapshot(signal.reviewSnapshot).estimated_price;
  } catch {
    estimatedPrice = null;
  }

  const thesisSource = ThesisSourceSchema.safeParse(signal.thesisSource);

  return {
    id: signal.id,
    created_at: signal.createdAt.toISOString(),
    published_at: signal.publishedAt.toISOString(),
    symbol: signal.symbol,
    side: signal.side,
    signal_type: signal.signalType,
    quantity: signal.quantity.toString(),
    thesis: signal.thesis,
    thesis_source: thesisSource.success ? thesisSource.data : null,
    indicators: signal.indicators,
    estimated_price: estimatedPrice,
  };
}
