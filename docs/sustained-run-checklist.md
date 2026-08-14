# The sustained run: weekly checklist

Phase 3 milestone 3.8 is not a build step. Once the kill switch clears, the
system proposes at 9:35am ET, marks at 4:15pm ET, and accrues a record that
cannot be edited or deleted. The milestone completes by *waiting* — at least 20
consecutive trading days of curve points, at least one closed trade, and no
signal stuck pending.

This checklist is the difference between "it ran" and "it ran correctly." Five
minutes, once a week. Everything below is answerable from the API and the logs;
none of it needs database access.

Set `OLLIE=https://ollie-production.up.railway.app` and
`TOKEN=<the owner API token>` first.

## 1. The system is actually running

```bash
curl -sS $OLLIE/healthz
```

Want: `status: ok`, `database: up`, `executionMode: paper`, and **both**
`killSwitchEnv` and `killSwitchDb` false. Either one true means nothing has been
proposed or marked since it was set — and marks halt with the switch too, so a
halted day is a permanent gap in the curve.

## 2. The curve has no unexplained gaps

```bash
curl -sS -H "Authorization: Bearer $TOKEN" $OLLIE/v1/track-record \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(*[p for p in d["curve"] if p["withheld"]], sep="\n")'
```

Every withheld day must be explainable by one of exactly two causes:

- **A quote outage.** The mark job logs `no quote; leaving a gap` with the
  symbol. Find it in the Railway logs for that afternoon.
- **A halt.** The kill switch was on, so nothing was marked.

A withheld day with neither in the logs is a real defect: it means a lot was
open, the job ran, and something else prevented the mark. Investigate before it
recurs, because these rows can never be backfilled — `hasMarkForDay` will not
let a later run write yesterday's mark, and that is deliberate.

## 3. Every signal reached a terminal status, with a reason

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "$OLLIE/v1/signals?status=pending"
```

Outside the 15-minute approval window this should be empty. A signal pending for
hours means the expiry sweep is not running — check that the scheduler started
(`scheduler started` in the logs, with `next_pipeline_run`).

Then skim the decided list for reasons that are missing or unhelpful:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "$OLLIE/v1/signals?status=decided&limit=50" \
  | python3 -c 'import json,sys; [print(s["decided_at"], s["symbol"], s["side"], s["status"], "|", s["decide_reason"]) for s in json.load(sys.stdin)["signals"]]'
```

An `expired` signal is not a failure — it is an honest record that a decision
window passed unanswered. A run of them is a signal about *you*, not the code:
the notification path is not reaching you, or the window is too short.

## 4. Real money is still unreachable

```bash
cd backend && grep -rn "placeEquityOrder" src/ | grep -v "^src/orchestrator/robinhood/"
```

Want: nothing but the comment in `executor.ts`. The adapter's own method throws
unconditionally, and `LIVE_TRADING_ENABLED` stays false until Phase 5. Three
independent barriers; this check confirms the outermost one has not been quietly
removed by a refactor.

## 5. The credential has not gone stale

Watch for `401` from the Robinhood MCP in the logs. **This is the one predicted
failure with no fix in place yet:** if Robinhood rotates the refresh token on
use, the value in `RH_OAUTH_REFRESH_TOKEN` is dead after the first refresh and
the credential has to move into Postgres. `OAuthStateStore` exists so that is a
new implementation rather than a rewrite, but it has not been needed — or
proven unnecessary — yet.

Re-running `npm run rh:authorize` locally and updating the Railway variable is
the stopgap.

## 6. Spend is where you expect

```bash
cd backend && railway usage
```

Set a hard limit if there still is not one. A month of unattended running is
exactly the window in which a wedged container turns into a surprise.

## What "done" looks like

```bash
curl -sS -H "Authorization: Bearer $TOKEN" $OLLIE/v1/track-record \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("closed:",d["closed_trades"],"open:",d["open_positions"],"win rate:",d["win_rate"],"curve days:",len([p for p in d["curve"] if not p["withheld"]]))'
```

Milestone 3.8 exits when that shows **at least 20 unwithheld curve days, at
least one closed trade, and nothing stuck pending** — with every withheld day
attributable to a logged cause.

Whether the record is *worth publishing* is a separate judgement, and a number
does not make it. Twenty days might close two trades or ten; a thin record means
extending the run rather than shipping Phase 4 early.
