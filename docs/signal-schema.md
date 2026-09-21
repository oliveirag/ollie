# The signal record

What a signal is, what each field means, and which parts of it are guaranteed
not to change. This describes the internal record. The subscriber-facing
published contract is a **subset** of this — see [Publication](#publication)
for what does and does not cross that line.

## Lifecycle

```
                        ┌─ approved   → executor writes a fill
pending (on creation) ──┼─ rejected   → permanent record, reason attached
                        └─ expired    → permanent record, reason attached
```

A signal is created `pending` and leaves that state exactly once. Every
transition writes a `signal_events` row recording the from/to statuses and the
reason. There is no path back to `pending`, no second decision, and no delete —
these are enforced by database triggers, not by the application (see
`backend/prisma/migrations/*_immutability_triggers`).

## Fields

| Field | Type | Notes |
| --- | --- | --- |
| `id` | uuid | Primary key. |
| `created_at` | timestamptz | When the signal fired. UTC, database-stamped. |
| `symbol` | text | Always from the configured allowlist. |
| `side` | `buy` \| `sell` | Long-only in v1: a sell is an exit and requires a position. |
| `signal_type` | `technical` \| `rebalance` | Only `technical` fires in Phase 1. |
| `quantity` | numeric(18,6) | Whole shares in v1, floored from the configured notional. |
| `thesis` | text, nullable | Plain-English rationale. Nullable because the LLM is allowed to fail. |
| `thesis_source` | text | `llm` or `fallback_template` — which path produced the thesis. |
| `indicators` | jsonb | Every input the rule read, including the previous bar's values. |
| `review_snapshot` | jsonb | Pre-trade review evidence. `NOT NULL`. See below. |
| `status` | enum | `pending`, `approved`, `rejected`, `expired`. |
| `execution_mode` | `paper` \| `live` | Fixed at creation; the signal settles in the mode it was created in. |
| `decided_at` | timestamptz, nullable | Required when leaving `pending`. |
| `decide_reason` | text, nullable | Why. Set once, alongside the status change. |
| `published` / `published_at` | boolean / timestamptz | One-way, set together in one statement after the approving fill is recorded. The trigger refuses every other change to either column. |
| `dedupe_key` | text, unique | `{rule}:{symbol}:{side}:{barTime}` — one signal per rule per bar. |
| `ref_id` | uuid | Broker idempotency key, allocated at creation, unused until Phase 5. |

### `indicators`

The values the rule compared, so the decision can be replayed and the thesis can
be checked against its inputs:

```json
{
  "rsi": 60.598, "rsiPrev": 51.36, "rsiPeriod": 14,
  "rsiOversold": 30, "rsiOverbought": 70,
  "macd": -0.75, "macdSignal": -1.13, "macdHistogram": 0.377,
  "macdPrev": -1.42, "macdSignalPrev": -0.29, "macdHistogramPrev": -1.126,
  "macdFast": 12, "macdSlow": 26, "macdSignalPeriod": 9,
  "close": 308.63, "closePrev": 294.38
}
```

Thresholds are recorded alongside the readings on purpose: a signal fired under
an old configuration must still be interpretable after that configuration
changes.

### `review_snapshot`

The evidence that a pre-trade review happened before the signal existed — a PRD
acceptance criterion, and the reason the column is `NOT NULL`.

```json
{
  "schema_version": 1,
  "estimated_price": "308.640000",
  "alerts": [{ "type": "EQUITY_NOT_ENOUGH_BP", "details": { } }],
  "requested": { "symbol": "AAPL", "side": "buy", "quantity": "1", "type": "market" },
  "captured_at": "2026-08-04T17:38:15.030Z",
  "raw": { }
}
```

`raw` is the broker's response, untouched. Everything above it is ours.

**`estimated_price` is derived, not quoted.** `review_equity_order` returns no
price estimate of its own — it returns a quote block. This is the ask for a buy
and the bid for a sell at review time, falling back to the last trade when a
side of the book is missing. Paper fills are computed from this number, so the
derivation is recorded next to the source it came from.

`alerts` normalizes the broker's `order_checks`, which arrives as an object
keyed by `alertType` (and `{}` when clean), not as the array its name suggests.
Alerts are recorded and surfaced; they do not by themselves block a signal.

## Related records

**`executions`** — one row per fill. Paper fills carry `broker_order_id: null`
because no broker was involved. Append-only.

**`track_record`** — the position's state over time, append-only. A correction
or an update is a **new row with a later `recorded_at`**, never an edit, so the
whole history of a published claim stays inspectable. The latest row per signal
is the current view.

**`signal_events`** — the audit trail of status transitions. Append-only.

## Publication

A signal is published **automatically when its approval's fill is recorded** —
the decision route flips `published` in the same request, after the
`executions` row is durable, and a reconciliation sweep (`PUBLISH_SWEEP_CRON`)
flips any signal a crash left approved-and-filled-but-unpublished. A subscriber
can therefore never see a signal the owner's own book has not already filled.
Rejected and expired signals are never published. The flip is one-way and
enforced by the `signals` update trigger: `published false → true` with
`published_at null → set` in one statement is the only legal change to the pair,
and a published row's pair is frozen for life.

The published payload is produced by exactly one function,
`toPublishedSignal` (`backend/src/published/signal.ts`), and every
subscriber-facing surface — the REST feed and the MCP tools — goes through it.
A redaction test asserts each forbidden field is absent from its output for a
fully-populated signal.

**What crosses:** `id`, `created_at`, `published_at`, `symbol`, `side`,
`signal_type`, `quantity`, `thesis`, `thesis_source`, `indicators`, and the
review snapshot's `estimated_price` only.

**What never crosses:**

- `ref_id` — a broker idempotency key for the owner's account.
- `review_snapshot` beyond `estimated_price` — `raw` is the owner's account
  state and `alerts` are the broker's checks against it.
- `execution_mode` and everything in `executions` — the owner's fills.
- `status`, `decided_at`, `decide_reason`, `dedupe_key` — the owner's decision
  process; the fact of publication already says the signal was approved.

What subscribers get is the generic, timestamped, non-personalized signal,
plus the per-signal `track_record` rows behind it (entry, marks with
`mark_price`, close with `closed_by_signal_id`, corrections) so every published
aggregate can be recomputed. Identical for every subscriber, with no
personalization — which is the distinction PRD §9 turns on.
