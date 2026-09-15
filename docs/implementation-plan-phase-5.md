# Ollie — Phase 5 Implementation Plan (gated flips: live money, then autonomy)

## Context

Phases 0–4 are code complete. The pipeline proposes and exits on schedule, the owner decides on the phone, paper fills open and close lots, marks accrue, the record is computed from append-only rows at read time, and — since Phase 4 — approved-and-filled signals publish automatically to a subscriber feed served by a second process that cannot read the broker credential. Every one of those paths settles in **paper**: `PaperExecutor` prices a fill from the review snapshot plus slippage and touches no broker. The live path exists only as a shape. `LiveExecutor` throws after checking its two gates; `McpBrokerAdapter.placeEquityOrder` throws unconditionally; the mock refuses to place; and three tests assert exactly that.

Phase 5 fills the shape. **Exit (PRD §10): real-money live mode for the owner, then autonomy within the pre-wired caps. Each flip is a config change against an already-built seam, not a rewrite.** The PRD's lawyer gate on this phase is void (owner decision, 2026-09-14); the track-record gate is not. Phase 5's *code* is built and verified now, in paper, against a mock broker that behaves like the real one — asynchronous fills, partial fills, rejections. The *flips* are owner actions with their own checklist, and the second cannot precede the first.

What Phase 5 must not do is loosen anything Phases 0–4 hardened. The record stays append-only. The subscriber wall stays total. `place_equity_order` stays unreachable from the signal service, from the pipeline, and from paper mode — it becomes reachable from exactly one function, behind three gates, and the tests that pinned its unreachability are widened to pin the new shape instead of deleted.

## Decisions (proposed 2026-09-15; built on these defaults, every one reversible by config before the live flip)

1. **A live fill is asynchronous: approval places the order, a poll job records the fill, and the signal publishes only when the fill lands.**
   `place_equity_order` returns an order, not a fill. A market order on a liquid name during regular hours usually fills in seconds, but "usually" is not a state machine. So `LiveExecutor.execute` re-runs `review_equity_order` (PRD §3.5: review before place, on the same signal, in the same request), places the order with the signal's `ref_id` as the idempotency key, writes a `live_orders` row in state `placed`, and returns — no execution row yet. A new `ORDER_POLL_CRON` job (every minute, weekdays, ET) reads each open order back from the broker: on `filled` it writes the execution row from the broker's average price and cumulative quantity, opens or closes the lot exactly as the paper path does, and publishes; on `cancelled`/`rejected`/`failed`/`voided` it marks the order terminal-unfilled and the signal stays approved-with-no-fill, which the owner sees and the feed never does. This is the re-derivation Phase 4's risk 7 asked for: **publish-when-filled** holds in live mode by construction because the execution row *is* the fill, and the existing publish sweep needs no change.

2. **`live_orders` is operational state, mutable; `executions` stays the record.**
   An order's state is the broker's fact, refreshed on every poll — `placed → open → filled`, or `→ cancelled`. Freezing those rows would mean one row per poll for nothing. What is published and what the owner's record is built from remains `executions` and `track_record`, both append-only, both written exactly once per fill by the poll job. `live_orders` gets no immutability trigger and the `ollie_signal` role gets no grant on it: subscribers see fills, never orders.

3. **A partial fill that goes terminal is recorded at the filled quantity, and the lot's quantity comes from the execution, not the signal.**
   Today `track_record` rows lean on `signal.quantity` for basis and return math. Paper fills are always whole, so it never mattered. A live market order can fill 7 of 10 shares and then be cancelled at the close. Recording 10 would invent shares; recording nothing would hide a real position. So the poll job writes the execution with `cumulative_quantity`, and `track_record` gains a `quantity` column set from the execution at lot open (paper: the signal's quantity, unchanged in value). `listAllTrackRecordRows`, `computeTrackRecord`, and the exit FIFO read the row's quantity where they read the signal's today. Additive migration, backfilled from `signals.quantity` for existing rows, no published number changes.

4. **A live approval needs a per-approval confirmation the paper path does not.**
   PRD §4.2: "The live path is gated behind an explicit account-level `execution_mode = live` flag plus a per-approval confirmation." The decision route's body gains `confirm_live: true`; a live-mode approval without it is `409 live_confirmation_required` with the signal still pending. The app's decision sheet in live mode is a different sheet — red, with the notional in dollars, the words "real order", and a second tap — and it is the only thing that sends the flag. The CLI (`signal:decide`) gains `--confirm-live` for the break-glass path. Three gates then stand between a tap and a real order: the deploy variable, the runtime mode, and the confirmation in the request.

5. **The live flip is a checklist and two config changes, in that order, and the record marks where it happened.**
   `LIVE_TRADING_ENABLED=true` in Railway (a deploy), then `execution_mode = live` from the app (the toggle that has been visibly locked since Phase 2). Signals created after the flip carry `execution_mode: live` and settle live; signals created before it settle paper even if approved after — the record and its settlement always agree, as `executorFor` already ensures. The track record gains `live_since`: the `filled_at` of the first live execution, computed at read time, null until then. It is reported on both sides of the wall. Phase 4 decided `execution_mode` never crosses to subscribers per signal; a single epoch timestamp is not a per-signal fact about the owner's account, it is a fact about the record, and a subscriber deserves to know which part of the curve was paper.

6. **Autonomy is the pipeline approving its own signals after a veto window, under the same caps, behind the same double gate pattern.**
   PRD §3.3 wants autonomy to be a mode flag on the existing seam, and §8 pre-wired the caps for it. So: `AUTONOMY_ENABLED=true` (deploy) plus `app_settings.autonomy = true` (runtime, from the app) enable it; a signal generated while both are on gets `auto_decide_at = created_at + AUTONOMY_VETO_MINUTES` (default 5); the owner can reject it during the window exactly as today; a new `AUTONOMY_SWEEP_CRON` job (every minute) approves anything still pending past its `auto_decide_at` and executes it through the same executor the tap would have used. Push still fires at creation, so the owner has the window to veto. A veto window of 0 is fully autonomous; the default is not. Autonomy runs in paper mode too — that is how it is tested and how the owner rehearses it before the second flip. **The kill switch halts the autonomy sweep like everything else**; the expiry sweep still expires an undecided signal whose `auto_decide_at` never came (autonomy off, or the switch on). The risk caps are unchanged: they bound what the strategy may *propose* per day and per position, and autonomy changes who says yes, not what may be asked.

7. **`auto_decide_at` is stamped at creation and immutable; the sweep records its approval in the audit like any decision.**
   It joins the signals trigger's frozen list. The approval it produces is an ordinary `pending → approved` transition with `decide_reason = 'auto-approved after veto window'`, so history reads honestly: a subscriber's `get_signal` shows nothing different (decision reasons never cross), and the owner's history shows exactly which approvals were theirs.

8. **Live positions come from the broker; live lot ages come from the record.**
   The pipeline already reads positions from the broker in live mode (truth for what can be sold) and left the time stop silent there because it had no lot-open date. With live fills opening `track_record` lots (decision 1), `listOpenLots` is the lot record in both modes; the time stop reads it in both. The long-only check keeps reading the broker in live mode, so a share the owner sold by hand in the Robinhood app is not double-sold by Ollie.

## Definitions

- **An open order** is a `live_orders` row whose `state` is not terminal. Terminal states: `filled`, `cancelled`, `rejected`, `failed`, `voided`.
- **A live fill** is an `executions` row with `mode = live`, `broker_order_id` set, `fill_price = average_price`, `quantity = cumulative_quantity`, written once by the poll job when the order first reads `filled` (or terminal with a non-zero cumulative quantity).
- **`live_since`** = min `filled_at` over live executions; null with none.
- **Autonomy is on** when both `AUTONOMY_ENABLED` and `app_settings.autonomy` are true *and* the kill switch is off.
- **A veto window** is the interval `[created_at, auto_decide_at)`; a signal with `auto_decide_at = null` is never auto-approved.

## What already exists → what wraps it

| Phase 5 need | Existing code it builds on |
|---|---|
| The order path | `LiveExecutor` — gates in place, body throws; `BrokerAdapter.placeEquityOrder` — declared, never called |
| Review-before-place | `McpBrokerAdapter.reviewEquityOrder` — the same call, re-run at execution time |
| Idempotency | `Signal.refId` — allocated in Phase 0 for exactly this |
| Reading orders back | `McpBrokerAdapter.call` + zod response schemas in `types.ts` — a `get_equity_orders` schema joins them |
| Fill → lot | `recordExecution`, `appendTrackRecord`, `closeLots`, `selectLotsToClose` — the paper path's writes, called by the poll job with broker numbers |
| Publish on fill | `publishSignal` + the publish sweep — unchanged; a live execution row is what they wait for |
| The confirmation gate | `preflightExecution` in `routes/signals.ts` — one more refusal, same pre-flight doctrine |
| Autonomy's approval | `transitionSignal` + `executorFor` — the sweep calls what the route calls |
| Cron jobs | `scheduler.ts` — two more `Cron` entries in the same mold |
| Double gates | `LIVE_TRADING_ENABLED` + `app_settings.execution_mode` — `AUTONOMY_ENABLED` + `app_settings.autonomy` copy the pattern |
| The mock broker | `MockBrokerAdapter` — gains an order book with scripted fills so the poll job is testable |
| iOS | `DecisionSheet`, `ControlsView`, `SignalStore` — a live variant of the sheet, an autonomy section, order-placed states |

## Database changes

```sql
CREATE TABLE live_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id           uuid NOT NULL REFERENCES signals(id),
  broker_order_id     text NOT NULL UNIQUE,
  ref_id              uuid NOT NULL,                   -- the signal's; recorded so a re-place is provably the same order
  state               text NOT NULL,                   -- broker state, verbatim
  cumulative_quantity numeric(18,6) NOT NULL DEFAULT 0,
  average_price       numeric(18,6),
  placed_at           timestamptz NOT NULL DEFAULT now(),
  last_polled_at      timestamptz,
  terminal_at         timestamptz,
  last_response       jsonb                            -- the broker's latest order payload, verbatim
);
ALTER TABLE track_record ADD COLUMN quantity numeric(18,6);  -- backfilled from signals.quantity, then NOT NULL
ALTER TABLE signals ADD COLUMN auto_decide_at timestamptz;   -- frozen by the trigger
ALTER TABLE app_settings ADD COLUMN autonomy boolean NOT NULL DEFAULT false;
```

No grant on `live_orders` to `ollie_signal`; the wall test's denial list grows by one. Config additions: `ORDER_POLL_CRON=* 9-16 * * 1-5`, `AUTONOMY_ENABLED=false`, `AUTONOMY_VETO_MINUTES=5`, `AUTONOMY_SWEEP_CRON=* * * * *`.

## API contract summary

- `POST /v1/signals/{id}/decision` body gains `confirm_live?: boolean`. Response `execution` stays nullable and gains a sibling `order: { broker_order_id, state, placed_at } | null` — a live approval returns `execution: null, order: {...}`; a paper approval returns `execution: {...}, order: null`. New `409 live_confirmation_required`.
- Signal summary and detail gain `order: { state, cumulative_quantity, average_price, placed_at, terminal_at } | null`, so the app can render "order placed, awaiting fill" and "order cancelled, no fill".
- `GET/PUT /v1/settings` gain `autonomy: boolean` and read-only `autonomy_enabled: boolean` (the env gate), mirroring `live_trading_enabled`. `PUT` with `autonomy: true` while the env gate is off → `409 autonomy_not_enabled`.
- `GET /v1/track-record` (owner) and the subscriber track record / `get_track_record` gain `live_since: string | null`.
- Subscriber surfaces gain nothing else. The tool list stays four.

## Milestones

**Exit: the owner can flip to live money and then to autonomy with two config changes each, every gate having been exercised in paper first; a real fill publishes only when the broker says it filled; and the subscriber surface is unchanged except for `live_since`.**

- [x] 5.1 **The order path, in paper.** `types.ts` schema for `get_equity_orders`; `BrokerAdapter.getEquityOrder(brokerOrderId)`; `McpBrokerAdapter.placeEquityOrder` implemented (review → place, `ref_id` as the idempotency key, market, regular hours, gfd); the mock gains an order book (`state.orderFills`: per-symbol scripts of fill/partial/reject) and stops throwing on place; `live_orders` repo module; `LiveExecutor.execute` body; `ExecutionOutcome` becomes a union (`filled` | `placed`); the decision route and CLI handle `placed`. **Exit:** with the mock scripted to fill, a live-mode approval (both gates open in the test config) places an order, returns `order`, writes no execution; the schema for orders is pinned by a captured fixture.
- [x] 5.2 **The fill.** *(Built as a nullable `track_record.quantity` — null means the signal's quantity — rather than a backfilled NOT NULL column, so no existing record row was ever updated.)* `ORDER_POLL_CRON` job: read each open order, update the row, on fill write the execution + lot (open on buy, FIFO close on sell) with the broker's numbers, publish; on terminal-unfilled mark it and log at warn. `track_record.quantity` migration and the reads that move from the signal to the row. **Exit:** scripted fill → execution row, lot, and `published_at` all land on the poll; scripted partial-then-cancel → execution at the partial quantity, lot at that quantity, record stats consistent; scripted reject → no execution, signal approved-unfilled, feed unchanged; a second poll is idempotent.
- [x] 5.3 **The confirmation gate and the live markers.** *(`live_since` is the first live signal's `published_at`, read from `signals` so both database roles compute it from the same row.)* `confirm_live` in the route and CLI, the 409, `live_since` in both track records, `order` on summaries. Owner OpenAPI and subscriber OpenAPI regenerated. **Exit:** a live-mode approval without the flag is 409 and the signal is still pending; the subscriber track record's `live_since` equals the owner's; with no live fills it is null on both.
- [x] 5.4 **Autonomy.** Settings column and env gate; `auto_decide_at` stamped in the pipeline when autonomy is on; the sweep approving past-window signals through the executor; kill switch halts it; expiry still closes windows that never come. **Exit:** in paper with autonomy on and a 0-minute window, a pipeline run's signal is approved and filled by the next sweep with the audit reason; with a 5-minute window the owner's reject inside the window wins; with the switch on nothing is approved and the expiry sweep expires it.
- [x] 5.5 **iOS.** *(Built and compiled; the live-sheet XCUITest is not written — it needs the orchestrator to run against a scripted mock broker, which has no server mode yet. The gate itself is covered by the backend tests.)* The live confirmation sheet; order-placed / awaiting-fill / cancelled states on the approvals list and detail; the autonomy section under Controls (locked while the env gate is off, mirroring the mode toggle); `live_since` on both Record screens as a visible boundary on the curve. **Exit:** on the simulator against the local backend in live mode with the mock broker, approving shows the red sheet, requires the second tap, and lands on "order placed"; XCUITest-driven.
- [ ] 5.6 **The flips.** `docs/live-flip-checklist.md`: fund the Agentic account, set `LIVE_TRADING_ENABLED`, flip the mode from the phone, approve one deliberately small signal with the confirmation, watch the poll fill it and the feed publish it, confirm `live_since` appears on both sides; then, after a live record the owner judges sufficient, `AUTONOMY_ENABLED`, the toggle, and a rehearsal at a 15-minute window before shortening it. **Gate: does not begin until the Phase 3 sustained run has exited and the owner has read the record.** Owner-only; nothing here is automatable.

## Verification

1. **Unit:** order schema parsing against the fixture (filled, partial, rejected payloads); the executor union; `live_since` computation; veto-window arithmetic.
2. **DB:** `auto_decide_at` frozen by the trigger; `live_orders` denied to `ollie_signal` (the wall test's list grows); `track_record.quantity` backfill leaves every published number unchanged (assert stats before and after the migration on a seeded record).
3. **Integration (mock broker, paper database, live-mode test config):** the whole 5.1–5.4 lifecycle — approve → placed → poll → filled → published; partial; reject; autonomy sweep approving and the kill switch stopping it; the confirmation 409; the publish sweep still finding nothing to do.
4. **Safety regression:** `placeEquityOrder` has exactly one call site (`LiveExecutor`), asserted by grep in the test; the paper executor still holds no broker reference; the import-graph test still passes; the tool snapshot still pins four; the mock's place is reachable only when a test scripts an order book, otherwise it throws as before.
5. **Manual (owner, 5.6):** the checklist.

## Risks / open questions

1. **The broker's order payload is modelled from one captured fixture.** Robinhood's states are documented (`new, queued, confirmed, unconfirmed, partially_filled, filled, cancelled, rejected, failed, voided`) and the fixture pins the fields the poll job reads; anything else the parser refuses, leaving the order open and logging — it never guesses a fill. If production shows a field shape the fixture did not, the order stays open until the parser is fixed, which is the safe failure.
2. **Market orders, regular hours only, gfd.** An order placed at 9:36 fills in seconds; one that somehow does not is cancelled by the broker at the close and recorded as such. Limit orders are deliberately out of scope — a limit price is a second decision the strategy does not make.
3. **A real-money bug is unrecoverable in a way a paper bug is not.** Mitigations are structural: three gates on the route, the kill switch re-checked at both place and poll, order notional capped by the existing risk config, and 5.6's first live order deliberately tiny.
4. **Autonomy makes the veto window the only human check.** Push must reach the owner for the window to mean anything, and push needs the Apple Developer membership. The default window is short because a long one makes a daily-bar strategy stale, but the first rehearsal uses 15 minutes and the owner shortens it with evidence, not by default.
5. **The subscriber feed now carries live signals identically to paper ones, distinguished only by `live_since`.** Phase 4's non-personalization rule holds; what changes is that a subscriber acting on a live-era signal is following real money. The disclaimer already says the owner acts in their own account; the framing does not change.
6. **Hand trades in the Robinhood app during live mode.** Ollie reads broker positions for the long-only gate, so it will not oversell, but it does not know about a share the owner bought by hand and will not manage it. Documented in the checklist: during the live run, the Agentic account is Ollie's.
