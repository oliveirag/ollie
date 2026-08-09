import type { Signal } from '@prisma/client';
import { z } from 'zod';
import { parseReviewSnapshot } from '../orchestrator/reviewSnapshot.js';

/**
 * The wire shapes for the owner API. These zod schemas are the authoring
 * surface for `docs/openapi.yaml` — the spec is generated from them and the
 * drift test fails if the checked-in file falls behind. Hand-editing the YAML
 * is not how a route changes.
 *
 * Two conventions collide here on purpose. `/healthz` predates this file and
 * keeps its camelCase body, because a health contract already consumed by
 * Railway is not worth breaking. Everything under /v1 is new and snake_case,
 * matching the persisted review snapshot and the published signal schema.
 *
 * Money and quantities cross the wire as decimal strings, never numbers. The
 * database stores `numeric`, the app renders text, and a float in the middle
 * is how a fill price silently loses a cent.
 */

/**
 * `.meta({ id })` registers a schema in zod's global registry, which is what
 * makes it a named `#/components/schemas/X` entry instead of an inlined blob.
 * That naming is the whole value of the spec to the Swift side: generated
 * clients get `SignalSummary`, not an anonymous nested struct per endpoint.
 */
export const SignalSideSchema = z.enum(['buy', 'sell']).meta({ id: 'SignalSide' });
export const SignalStatusSchema = z
  .enum(['pending', 'approved', 'rejected', 'expired'])
  .meta({ id: 'SignalStatus' });
export const SignalTypeSchema = z.enum(['technical', 'rebalance']).meta({ id: 'SignalType' });
export const ExecModeSchema = z.enum(['paper', 'live']).meta({ id: 'ExecutionMode' });
export const ThesisSourceSchema = z
  .enum(['llm', 'fallback_template'])
  .meta({ id: 'ThesisSource' });

const decimalString = z
  .string()
  .describe('Decimal number as a string. Never parse this into a float.');

export const ErrorSchema = z
  .object({
    error: z.string(),
    detail: z.string().optional(),
    /** Present on 409s from a decision that lost a race, so the app can re-render. */
    status: SignalStatusSchema.optional(),
  })
  .meta({ id: 'Error', description: 'Error response' });

export const ReviewAlertSchema = z
  .object({
    type: z.string().describe('Broker alert code, e.g. EQUITY_NOT_ENOUGH_BP'),
    details: z.unknown().describe('Broker-supplied payload; shape is not ours to declare'),
  })
  .meta({ id: 'ReviewAlert' });

/**
 * List-view signal. Deliberately excludes `indicators` and the raw review
 * snapshot: the approvals list renders dozens of these and neither belongs in
 * a list payload.
 */
export const SignalSummarySchema = z.object({
  id: z.string().uuid(),
  created_at: z.string().datetime(),
  symbol: z.string(),
  side: SignalSideSchema,
  signal_type: SignalTypeSchema,
  quantity: decimalString,
  status: SignalStatusSchema,
  execution_mode: ExecModeSchema,
  estimated_price: decimalString
    .nullable()
    .describe('From the review snapshot at proposal time; null if unreadable'),
  thesis: z.string().nullable(),
  thesis_source: ThesisSourceSchema.nullable().describe(
    'null when the stored value is not one the app knows how to render. The app uses this ' +
      'to mark a fallback-template thesis, so an unrecognized value must not be shown as "llm".',
  ),
  expires_at: z
    .string()
    .datetime()
    .nullable()
    .describe(
      'created_at + SIGNAL_EXPIRY_MINUTES, computed at read time, for pending signals only. ' +
        'The expiry sweep remains the authority; this is a countdown hint, not a promise.',
    ),
  decided_at: z.string().datetime().nullable(),
  decide_reason: z.string().nullable(),
}).meta({ id: 'SignalSummary' });

export type SignalSummary = z.infer<typeof SignalSummarySchema>;

export const SignalListSchema = z
  .object({ signals: z.array(SignalSummarySchema) })
  .meta({ id: 'SignalList' });

/**
 * A persisted snapshot that will not parse is reported as a null price rather
 * than a 500. The owner should still see that the signal exists and be able to
 * reject it; a list that dies because one row is malformed is worse than a
 * list with one gap in it. The executor is the layer that refuses to guess.
 */
function readEstimatedPrice(snapshot: unknown): string | null {
  try {
    return parseReviewSnapshot(snapshot).estimated_price;
  } catch {
    return null;
  }
}

/**
 * `signals.thesis_source` is a plain text column, not a database enum, so the
 * schema cannot vouch for it the way it can for `side` or `status`. The write
 * surface only ever sets the two known values; anything else means a hand-edit
 * or a future source this build predates, and null is the honest rendering.
 */
function readThesisSource(value: string): SignalSummary['thesis_source'] {
  const parsed = ThesisSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function toSignalSummary(signal: Signal, expiryMinutes: number): SignalSummary {
  return {
    id: signal.id,
    created_at: signal.createdAt.toISOString(),
    symbol: signal.symbol,
    side: signal.side,
    signal_type: signal.signalType,
    quantity: signal.quantity.toString(),
    status: signal.status,
    execution_mode: signal.executionMode,
    estimated_price: readEstimatedPrice(signal.reviewSnapshot),
    thesis: signal.thesis,
    thesis_source: readThesisSource(signal.thesisSource),
    expires_at:
      signal.status === 'pending'
        ? new Date(signal.createdAt.getTime() + expiryMinutes * 60_000).toISOString()
        : null,
    decided_at: signal.decidedAt?.toISOString() ?? null,
    decide_reason: signal.decideReason ?? null,
  };
}

/**
 * One row of the append-only `signal_events` audit. The app renders this as
 * the status history, which is the honest answer to "why is this expired" —
 * the sweep writes its reason here the same way a decision does.
 */
export const SignalEventSchema = z
  .object({
    from_status: SignalStatusSchema,
    to_status: SignalStatusSchema,
    reason: z.string().nullable(),
    created_at: z.string().datetime(),
  })
  .meta({ id: 'SignalEvent' });

export const SignalDetailSchema = SignalSummarySchema.extend({
  indicators: z
    .unknown()
    .describe('Computed strategy inputs at proposal time (rsi14, macd line/signal/hist, …)'),
  review: z
    .object({
      estimated_price: decimalString,
      captured_at: z.string(),
      alerts: z.array(ReviewAlertSchema),
    })
    .nullable()
    .describe('Parsed review snapshot; null when the stored snapshot is unreadable'),
  events: z.array(SignalEventSchema),
}).meta({ id: 'SignalDetail' });

export type SignalDetail = z.infer<typeof SignalDetailSchema>;

export const DecisionRequestSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    reason: z.string().max(500).optional(),
  })
  .meta({ id: 'DecisionRequest' });

export const ExecutionSchema = z
  .object({
    id: z.string().uuid(),
    mode: ExecModeSchema,
    fill_price: decimalString,
    quantity: decimalString,
    filled_at: z.string().datetime(),
    broker_order_id: z.string().nullable().describe('Null for paper fills'),
  })
  .meta({ id: 'Execution' });

export const DecisionResponseSchema = z
  .object({
    signal: SignalSummarySchema,
    execution: ExecutionSchema.nullable().describe(
      'The fill, on approval. Null for a rejection — nothing is executed.',
    ),
  })
  .meta({ id: 'DecisionResponse' });

export function toSignalEvent(event: {
  fromStatus: string;
  toStatus: string;
  reason: string | null;
  createdAt: Date;
}): z.infer<typeof SignalEventSchema> {
  return {
    from_status: event.fromStatus as z.infer<typeof SignalStatusSchema>,
    to_status: event.toStatus as z.infer<typeof SignalStatusSchema>,
    reason: event.reason,
    created_at: event.createdAt.toISOString(),
  };
}

/**
 * The detail view exposes the parsed review, not the raw broker payload. The
 * app needs the estimated price and the alert codes — an `EQUITY_NOT_ENOUGH_BP`
 * chip rather than buried JSON — and shipping the vendor's whole response to a
 * client would make its shape our contract.
 */
export function toSignalDetail(
  signal: Signal,
  events: Parameters<typeof toSignalEvent>[0][],
  expiryMinutes: number,
): SignalDetail {
  let review: SignalDetail['review'] = null;
  try {
    const parsed = parseReviewSnapshot(signal.reviewSnapshot);
    review = {
      estimated_price: parsed.estimated_price,
      captured_at: parsed.captured_at,
      alerts: parsed.alerts,
    };
  } catch {
    review = null;
  }

  return {
    ...toSignalSummary(signal, expiryMinutes),
    indicators: signal.indicators,
    review,
    events: events.map(toSignalEvent),
  };
}

export const HealthReportSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    database: z.enum(['up', 'down']),
    killSwitch: z
      .boolean()
      .nullable()
      .describe('Runtime kill switch from app_settings; null when the database is unreachable'),
    executionMode: ExecModeSchema.nullable(),
    uptimeSeconds: z.number().int(),
    checkedAt: z.string().datetime(),
  })
  .meta({ id: 'HealthReport' });
