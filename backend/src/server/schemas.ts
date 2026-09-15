import type { LiveOrder, Signal } from '@prisma/client';
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
export const SignalTypeSchema = z
  .enum(['technical', 'rebalance', 'time_stop'])
  .describe(
    'time_stop is an exit proposed by the holding-period rule. It consults no ' +
      'indicator, so its `indicators` payload carries bars_held and ' +
      'max_holding_period_bars rather than RSI and MACD figures.',
  )
  .meta({ id: 'SignalType' });
export const ExecModeSchema = z.enum(['paper', 'live']).meta({ id: 'ExecutionMode' });
export const ThesisSourceSchema = z
  .enum(['llm', 'fallback_template'])
  .meta({ id: 'ThesisSource' });

export const decimalString = z.string().describe(
  'Decimal number as a string. Never parse this into a float.\n\n' +
    'Stored prices are serialized verbatim from the database, so trailing zeros are not ' +
    'padded — "100" and "100.00" are the same value, and a fill of "182.6825" keeps all ' +
    'four places. Computed aggregates are fixed at two. Format for display on the client; ' +
    'do not assume a decimal-place count.',
);

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

/** A live order's broker-side state, on the signal that placed it (Phase 5). */
export const OrderSchema = z
  .object({
    broker_order_id: z.string(),
    state: z
      .string()
      .describe(
        "The broker's state, verbatim: new, queued, confirmed, unconfirmed, partially_filled, " +
          'filled, cancelled, rejected, failed, voided',
      ),
    cumulative_quantity: decimalString,
    average_price: decimalString.nullable(),
    placed_at: z.string().datetime(),
    terminal_at: z
      .string()
      .datetime()
      .nullable()
      .describe('Set once the order can no longer fill. Null while the poll is still watching it.'),
  })
  .meta({ id: 'Order' });

export type OrderView = z.infer<typeof OrderSchema>;

export function toOrderView(order: LiveOrder): OrderView {
  return {
    broker_order_id: order.brokerOrderId,
    state: order.state,
    cumulative_quantity: order.cumulativeQuantity.toString(),
    average_price: order.averagePrice?.toString() ?? null,
    placed_at: order.placedAt.toISOString(),
    terminal_at: order.terminalAt?.toISOString() ?? null,
  };
}

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
  published: z
    .boolean()
    .describe(
      'Whether this signal has reached the subscriber feed. Flipped once, after the ' +
        'approving fill is recorded, and never back.',
    ),
  published_at: z.string().datetime().nullable(),
  auto_decide_at: z
    .string()
    .datetime()
    .nullable()
    .describe(
      'Phase 5: when the autonomy sweep may approve this signal if nobody has. Null when ' +
        'autonomy was off at creation.',
    ),
  order: OrderSchema.nullable().describe(
    'The live order this approval placed. Null for paper signals and for live signals not yet approved.',
  ),
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

export function toSignalSummary(
  signal: Signal,
  expiryMinutes: number,
  order: LiveOrder | null = null,
): SignalSummary {
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
    published: signal.published,
    published_at: signal.publishedAt?.toISOString() ?? null,
    auto_decide_at: signal.autoDecideAt?.toISOString() ?? null,
    order: order ? toOrderView(order) : null,
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
    confirm_live: z
      .boolean()
      .optional()
      .describe(
        'Phase 5: must be true to approve a live-mode signal — the per-approval confirmation ' +
          'PRD §4.2 asks for. Only the live confirmation sheet sends it.',
      ),
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
      'The fill, on a paper approval. Null for a rejection, and for a live approval whose ' +
        'fill arrives later through the order poll.',
    ),
    order: OrderSchema.nullable().describe(
      'The live order this approval placed. Null for paper approvals and rejections.',
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
  order: LiveOrder | null = null,
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
    ...toSignalSummary(signal, expiryMinutes, order),
    indicators: signal.indicators,
    review,
    events: events.map(toSignalEvent),
  };
}

export const OpenLotSchema = z
  .object({
    signal_id: z.string().uuid(),
    symbol: z.string(),
    side: SignalSideSchema,
    quantity: decimalString,
    entry_price: decimalString,
    opened_at: z.string().datetime(),
    quote: decimalString
      .nullable()
      .describe('Last trade price. Null when the broker was unreachable.'),
    quote_age_seconds: z
      .number()
      .int()
      .nullable()
      .describe('How stale the quote is. Render it — a stale price read as current is a lie.'),
    unrealized_pnl: decimalString
      .nullable()
      .describe('(quote - entry) * quantity for a buy. Null whenever quote is null.'),
  })
  .meta({ id: 'OpenLot' });

export const DashboardSchema = z
  .object({
    lots: z.array(OpenLotSchema),
    totals: z.object({
      cost_basis: decimalString,
      market_value: decimalString
        .nullable()
        .describe('Null when any lot is missing a quote — a partial total is worse than none'),
      unrealized_pnl: decimalString.nullable(),
      realized_pnl: decimalString.describe(
        'Zero until Phase 3. Nothing closes a position yet, so this is the honest number ' +
          'rather than an invented one. A sell fill currently opens its own lot; matching it ' +
          'against the buy is Phase 3 work.',
      ),
    }),
    quotes_available: z
      .boolean()
      .describe('False when the broker could not be reached; lots then show entry basis only'),
  })
  .meta({ id: 'Dashboard' });

export const SettingsSchema = z
  .object({
    kill_switch: z.boolean(),
    execution_mode: ExecModeSchema,
    live_trading_enabled: z
      .boolean()
      .describe(
        'From the environment, read-only. The second of the two gates in front of real ' +
          'money; the app renders the mode toggle as locked while this is false.',
      ),
    autonomy: z
      .boolean()
      .describe(
        'Phase 5: the runtime half of the autonomy gate. Signals auto-approve after the veto ' +
          'window only while both halves are on.',
      ),
    autonomy_enabled: z
      .boolean()
      .describe(
        'AUTONOMY_ENABLED from the environment, read-only. The app renders the autonomy ' +
          'toggle as locked while this is false.',
      ),
    autonomy_veto_minutes: z
      .number()
      .int()
      .describe('How long the owner has to veto before the sweep approves. From the environment.'),
  })
  .meta({ id: 'Settings' });

export const SettingsUpdateSchema = z
  .object({
    kill_switch: z.boolean().optional(),
    execution_mode: ExecModeSchema.optional(),
    autonomy: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.kill_switch !== undefined ||
      body.execution_mode !== undefined ||
      body.autonomy !== undefined,
    { message: 'provide at least one of kill_switch, execution_mode, or autonomy' },
  )
  .meta({ id: 'SettingsUpdate' });

export const HealthReportSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    database: z.enum(['up', 'down']),
    killSwitch: z
      .boolean()
      .nullable()
      .describe(
        'Effective kill switch: true when either half is on, so the pipeline is halted. ' +
          'Null only when the database is unreachable AND the environment override is off, ' +
          'which is the one case where the answer is genuinely unknown',
      ),
    killSwitchEnv: z
      .boolean()
      .describe(
        'The KILL_SWITCH environment override. Clearing it requires a redeploy. ' +
          'Read from config, so it stays truthful even when the database is down',
      ),
    killSwitchDb: z
      .boolean()
      .nullable()
      .describe(
        'The runtime half in app_settings, flipped from the iOS app with no redeploy; ' +
          'null when the database is unreachable',
      ),
    executionMode: ExecModeSchema.nullable(),
    uptimeSeconds: z.number().int(),
    checkedAt: z.string().datetime(),
  })
  .meta({ id: 'HealthReport' });

export const CurvePointSchema = z
  .object({
    date: z.string().describe('UTC calendar day, YYYY-MM-DD'),
    value: z
      .number()
      .nullable()
      .describe(
        'Cumulative realized PnL through this day plus the day\'s marks. ' +
          'Null when withheld',
      ),
    withheld: z
      .boolean()
      .describe(
        'True when a lot open on this day had no mark, so no honest total exists. ' +
          'A partial sum would misstate a published curve, so the day is reported ' +
          'as absent rather than approximated',
      ),
  })
  .meta({ id: 'CurvePoint' });

export const TrackRecordSchema = z
  .object({
    closed_trades: z.number().int(),
    open_positions: z
      .number()
      .int()
      .describe('Reported alongside win rate so the exclusion below is visible, not hidden'),
    wins: z.number().int().describe('Strictly positive realized PnL; a scratch is not a win'),
    win_rate: z
      .number()
      .nullable()
      .describe(
        'Wins over closed trades. Open positions are excluded from the denominator ' +
          'because they have no outcome yet. Null with zero closed trades — no answer, ' +
          'rather than a claimed 0%',
      ),
    average_return: z
      .number()
      .nullable()
      .describe('Unweighted mean of realized_pnl / (entry_price x quantity) over closed trades'),
    total_realized_pnl: z.string().describe('Decimal string, two places'),
    curve: z.array(CurvePointSchema).describe('A PnL curve based at zero, not a portfolio value'),
    live_since: z
      .string()
      .datetime()
      .nullable()
      .describe(
        'When the first live-money signal was published. Everything before it settled on ' +
          'paper. Null while the whole record is paper.',
      ),
  })
  .meta({ id: 'TrackRecord' });
