import type { TrackRecord } from '@prisma/client';
import { z } from 'zod';
import { PublishedSignalSchema } from '../published/signal.js';
import {
  ErrorSchema,
  SignalSideSchema,
  TrackRecordSchema,
  decimalString,
} from '../server/schemas.js';

/**
 * Wire shapes for the subscriber REST API (Phase 4, milestone 4.3). Same
 * machinery as the owner API — zod is the authoring surface,
 * `docs/openapi-subscriber.yaml` is generated, a drift test guards it — and
 * the schemas the two surfaces genuinely share (`TrackRecord`, the enums,
 * `Error`) are imported rather than redeclared, so they cannot diverge.
 */

export { ErrorSchema };

export const SessionRequestSchema = z
  .object({
    identity_token: z
      .string()
      .min(1)
      .describe('The Sign in with Apple identity token, verbatim from ASAuthorization'),
    invite_code: z
      .string()
      .max(64)
      .optional()
      .describe('Required on the first sign-in while the soft launch is invite-gated'),
  })
  .meta({ id: 'SessionRequest' });

export const SubscriberSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().nullable().describe('May be a private-relay address or null'),
    created_at: z.string().datetime(),
  })
  .meta({ id: 'Subscriber' });

export const SessionSchema = z
  .object({
    token: z
      .string()
      .describe('The app session bearer token. Store it in the Keychain; it is not shown again.'),
    subscriber: SubscriberSchema,
  })
  .meta({ id: 'Session' });

export const DisclaimerSchema = z
  .object({
    version: z.string().describe('sha256 of the text. Send it back on accept.'),
    text: z.string().describe('Markdown'),
  })
  .meta({ id: 'Disclaimer' });

export const OnboardingSchema = z
  .object({
    disclaimer: DisclaimerSchema,
    accepted_current_version: z
      .boolean()
      .describe('Whether this subscriber has an acceptance row for the version above'),
    has_mcp_token: z.boolean().describe('Whether an unrevoked MCP token exists'),
    mcp_url: z
      .string()
      .nullable()
      .describe('Where to point an agent. Null only when the service has no public URL configured.'),
  })
  .meta({ id: 'Onboarding' });

export const AcceptDisclaimerRequestSchema = z
  .object({
    version: z.string().describe('The version the client displayed; must match the current one'),
  })
  .meta({ id: 'AcceptDisclaimerRequest' });

export const DisclaimerAcceptanceSchema = z
  .object({
    version: z.string(),
    accepted_at: z.string().datetime(),
  })
  .meta({ id: 'DisclaimerAcceptance' });

export const McpTokenSchema = z
  .object({
    id: z.string().uuid(),
    created_at: z.string().datetime(),
    last_used_at: z.string().datetime().nullable(),
    revoked_at: z.string().datetime().nullable(),
  })
  .meta({ id: 'McpToken' });

export const McpTokenMintedSchema = McpTokenSchema.extend({
  token: z.string().describe('Shown exactly once. Only its hash is stored.'),
  mcp_url: z.string().nullable(),
}).meta({ id: 'McpTokenMinted' });

export const McpTokenListSchema = z
  .object({ tokens: z.array(McpTokenSchema) })
  .meta({ id: 'McpTokenList' });

export const FeedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z
    .string()
    .datetime()
    .optional()
    .describe('Keyset cursor: return signals published strictly before this instant'),
});

export const FeedSchema = z
  .object({
    signals: z.array(PublishedSignalSchema).describe('Newest publication first'),
    next_before: z
      .string()
      .datetime()
      .nullable()
      .describe('Pass as `before` for the next page; null when this page was the last'),
  })
  .meta({ id: 'Feed' });

/**
 * One track-record row, verbatim. The recompute path: a subscriber holding
 * these can rerun the published aggregates and get the same numbers.
 */
export const RecordRowSchema = z
  .object({
    status: z.enum(['open', 'closed']),
    entry_price: decimalString,
    exit_price: decimalString.nullable(),
    realized_pnl: decimalString.nullable(),
    unrealized_pnl: decimalString.nullable(),
    mark_price: decimalString
      .nullable()
      .describe('The quote a mark was computed against; present on mark rows only'),
    closed_by_signal_id: z
      .string()
      .uuid()
      .nullable()
      .describe('The published sell signal whose approval closed this lot'),
    recorded_at: z.string().datetime(),
  })
  .meta({ id: 'RecordRow' });

export const PublishedSignalDetailSchema = z
  .object({
    signal: PublishedSignalSchema,
    record: z
      .array(RecordRowSchema)
      .describe(
        'Every track-record row for this signal, oldest first. Append-only: a later row ' +
          'supersedes an earlier one, never edits it.',
      ),
  })
  .meta({ id: 'PublishedSignalDetail' });

export const OpenPositionSchema = z
  .object({
    signal_id: z.string().uuid(),
    symbol: z.string(),
    side: SignalSideSchema,
    quantity: decimalString,
    entry_price: decimalString,
    opened_at: z.string().datetime(),
    latest_mark: z
      .object({
        price: decimalString,
        unrealized_pnl: decimalString,
        as_of: z.string().datetime().describe('When the mark was taken — the prior close, not now'),
        days_held: z.number().int().describe('Calendar days from opened_at to as_of'),
      })
      .nullable()
      .describe('Null when the lot has never been marked. There is no live quote here by design.'),
  })
  .meta({ id: 'OpenPosition' });

export const SubscriberTrackRecordSchema = TrackRecordSchema.extend({
  positions: z
    .array(OpenPositionSchema)
    .describe('Open lots at daily-mark granularity. Same rows the curve is drawn from.'),
}).meta({ id: 'SubscriberTrackRecord' });

export const SignalHealthSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    database: z.enum(['up', 'down']),
    uptimeSeconds: z.number().int(),
    checkedAt: z.string().datetime(),
  })
  .meta({ id: 'SignalHealth' });

export function toRecordRow(row: TrackRecord): z.infer<typeof RecordRowSchema> {
  return {
    status: row.status,
    entry_price: row.entryPrice.toString(),
    exit_price: row.exitPrice?.toString() ?? null,
    realized_pnl: row.realizedPnl?.toString() ?? null,
    unrealized_pnl: row.unrealizedPnl?.toString() ?? null,
    mark_price: row.markPrice?.toString() ?? null,
    closed_by_signal_id: row.closedBySignalId,
    recorded_at: row.recordedAt.toISOString(),
  };
}
