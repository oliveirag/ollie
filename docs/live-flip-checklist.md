# The flips: live money, then autonomy

Phase 5 milestone 5.6. Everything before this is code, and it is built and
tested against a mock broker. This is the part only the owner can do: two
config changes for real money, two more for autonomy, each preceded by a check
and followed by a watch.

**Gate.** Do not start until the Phase 3 sustained run has exited
([sustained-run checklist](sustained-run-checklist.md), "What done looks like")
and you have read the record and judged it worth risking money on. A number
does not make that call.

Set `OLLIE=https://ollie-production.up.railway.app` and
`TOKEN=<the owner API token>` first.

## 0. Before anything

- [ ] **Replace the hand-written order fixture with a real one.**
  `backend/test/fixtures/mcp/equity-order.json` was written from the tool's
  documentation, not captured — no order had ever been placed from this
  account. The parser requires only `id`, `state`, `cumulative_quantity` and
  `average_price`; if production's payload differs, the poll leaves the order
  open and logs `order poll failed` rather than guessing a fill. Capture one
  order read (any state) from the Agentic account and diff it against the
  fixture before the first live approval.
- [ ] `cd backend && npm test` passes, including `live.orders.test.ts` and
  `autonomy.test.ts`.
- [ ] `grep -rn "placeEquityOrder(" backend/src` shows the interface, the two
  adapters, and exactly one call site in `executor.ts`. The test asserts this;
  look anyway.
- [ ] Push works. Live approvals happen on the phone, and autonomy's veto window
  is only a check if the notification reaches you.

## 1. Fund the Agentic account

The pipeline reads broker positions in live mode, and a buy with no buying
power is rejected by Robinhood (`EQUITY_NOT_ENOUGH_BP`), which the poll records
as an approved signal with no fill. Fund it with at most what the caps allow
you to lose:

- `ORDER_NOTIONAL_CENTS` per entry (default $500)
- `MAX_TOTAL_EXPOSURE_CENTS` across everything (default $5,000)

**During the live run the Agentic account is Ollie's.** Ollie will not oversell
a share you sold by hand (it asks the broker before a sell), but it will not
know about a share you bought by hand either.

## 2. Flip to live

1. In Railway, set `LIVE_TRADING_ENABLED=true` on the **orchestrator** service
   and redeploy. Never on the signal service — it has no broker and must not
   carry any `RH_*` or live variable.
2. Confirm: `curl -sS -H "Authorization: Bearer $TOKEN" $OLLIE/v1/settings`
   shows `live_trading_enabled: true`, `execution_mode: "paper"`.
3. In the app, Controls → the mode toggle is now unlocked. Flip it to live. The
   rail turns solid red.
4. Signals proposed **from now on** are live. Anything still pending from
   before settles on paper, and its approval sheet says so.

## 3. The first live order — make it small

Before the next 9:35 run, lower `ORDER_NOTIONAL_CENTS` to the smallest value
that still buys one share of the cheapest allowlisted symbol, and redeploy. The
first live order exists to prove the path, not to make money.

When it proposes:

- [ ] The approval sheet is red, shows the dollar amount, and the confirm button
  stays disabled until "I understand this uses real money" is on.
- [ ] After approving, the app says "Real order placed". The signal is approved
  and **not** published.
- [ ] Within a minute or two the history row reads "Filled N @ price". Logs show
  `LIVE ORDER PLACED` then `LIVE FILL RECORDED` with the same order id.
- [ ] The Robinhood app shows the same order, same quantity, same price.
- [ ] `curl -sS -H "Authorization: Bearer $TOKEN" $OLLIE/v1/track-record` now
  has `live_since` set, and the subscriber `get_track_record` shows the same
  timestamp.
- [ ] The feed (subscriber `list_signals`) has the signal, published at or after
  the fill, with no order or account detail in it.

If the fill never arrives: the order row stays open and the poll keeps asking.
Check `order poll failed` in the logs — a parse failure is the likely cause and
the fixture step above is the fix. **Do not** hand-write an execution row.

Then restore `ORDER_NOTIONAL_CENTS` and redeploy.

## 4. Watch the live run

Weekly, on top of the sustained-run checklist:

- [ ] Every approved live signal has either a fill or a terminal order state.
  An order open past the close is a poll or parse problem.
- [ ] Partial fills: the lot's quantity matches the Robinhood position, not the
  signal's.
- [ ] The kill switch still halts new orders (flip it, confirm a live approval
  409s, flip it back). The poll keeps recording fills while it is on — that is
  intended.

## 5. Autonomy — only after a live record you trust

1. Set `AUTONOMY_ENABLED=true` and `AUTONOMY_VETO_MINUTES=15` on the
   orchestrator and redeploy. Fifteen, not the default five, for the rehearsal.
2. Controls → Autonomy is unlocked. Turn it on.
3. On the next proposal: the push arrives, the signal shows its auto-approve
   time, and you do nothing. At the window's end it is approved with
   "auto-approved after veto window" in its history, then placed and filled as
   before.
4. On a later proposal, reject it inside the window. It stays rejected.
5. With the kill switch on, a signal's window passes and nothing is approved;
   the expiry sweep expires it.

Shorten the window only with evidence — a missed veto you wished you had
caught is the evidence against it.

## Rolling back

- **Stop acting now:** the kill switch, from the app. Orders already placed
  still record their fills.
- **Back to paper:** flip the mode toggle to paper. Live signals already
  approved finish their orders; new signals are paper. `live_since` stays —
  the record went live once, and that is a fact.
- **Off entirely:** `LIVE_TRADING_ENABLED=false` and `AUTONOMY_ENABLED=false`,
  redeploy.
