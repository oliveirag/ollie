# Ollie backend

Node.js + TypeScript, one package with two entry points:

- **Orchestrator** (`npm start`): the scheduler, the owner REST API under `/v1`
  (bearer `OWNER_API_TOKEN`), and a public `/healthz`. It proposes trades, waits
  for the owner's decision, and settles approved signals on paper or, behind
  its gates, live.
- **Signal service** (`npm run start:signal`): the subscriber REST API and the
  read-only MCP server at `/mcp`. It connects as its own database role and
  cannot reach the broker or any owner-only table.

## Setup

Postgres 16 on `localhost:5432`, with a superuser role `ollie` (a migration
creates the `ollie_signal` role, and the test setup creates a database). On a
Mac, Homebrew `postgresql@16` works; `docker compose up -d` from the repo root
works where Docker is available.

```bash
cd backend
cp .env.example .env   # set OWNER_API_TOKEN (openssl rand -hex 32). ANTHROPIC_API_KEY is
                       # optional. Real-broker runs need RH_OAUTH_CLIENT_ID and
                       # RH_OAUTH_REFRESH_TOKEN from `npm run rh:authorize`.
npm install
npm run db:migrate
npm test
```

`npm test` creates and migrates a separate `ollie_test` database first, so it
never touches your working data.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Orchestrator in watch mode: owner API, `/healthz`, scheduler |
| `npm run dev:signal` | Signal service in watch mode |
| `npm run build` | `prisma generate` and compile to `dist/` |
| `npm start` / `npm run start:signal` | Run the built orchestrator / signal service |
| `npm test` | Full suite (sets up the test database first) |
| `npm run test:watch` | Vitest in watch mode (run `npm run db:test:setup` once first) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate` | Create and apply migrations against the dev database |
| `npm run db:deploy` | Apply migrations without creating new ones |
| `npm run db:generate` | Regenerate the Prisma client |
| `npm run db:studio` | Browse the database |
| `npm run rh:authorize` | One-time browser OAuth with Robinhood; prints the seed credential |
| `npm run introspect:mcp` | Dump live Robinhood MCP shapes (add `--review` to include a simulated order) |
| `npm run pipeline:once -- --broker=mock` | One pipeline run against checked-in fixtures, no network |
| `npm run pipeline:once -- --broker=real` | One pipeline run against the live broker |
| `npm run signal:decide -- --list` | Show pending signals |
| `npm run signal:decide -- <id> approve\|reject [--reason "…"] [--confirm-live]` | Break-glass decision from the CLI |
| `npm run backtest` | Replay the strategy over cached historical bars |
| `npm run seed:track-record` | Seed a local multi-trade record (localhost only) |
| `npm run openapi:write` | Regenerate `docs/openapi*.yaml` from the route schemas |
| `npm run disclaimer:write` | Regenerate `docs/disclaimer.md` from `src/published/disclaimer.ts` |
| `npm run signal:write-test` | Phase 0 check: write a fabricated signal and read it back |

## How a run works

```
kill switch → fetch bars → evaluate rules → dedupe → risk caps
    → review_equity_order → thesis → persist as pending → push to owner
                                          ↓
                 owner approves in the iOS app (or the autonomy sweep,
                 when enabled, after its veto window)
                                          ↓
          paper: PaperExecutor writes a simulated fill and opens a lot
          live:  LiveExecutor places the order; the order poll records the fill
```

The order is deliberate. The kill switch is checked before the first broker
call. Dedupe runs before the risk gate so duplicates don't consume daily-cap
slots. The pre-trade review runs last, so a candidate the risk gate rejects
never costs a broker call, and a failed review drops the candidate rather than
producing a signal with a gap where its evidence should be.

Other scheduled jobs: the expiry sweep, the 16:15 ET daily mark, the publish
sweep, the live order poll, and the autonomy sweep (`orchestrator/scheduler.ts`).

## Layout

```
src/
  config/         zod-validated env; throws at boot on a bad value
  money.ts        the only place money arithmetic happens
  db/             Prisma client + the entire sanctioned write surface
  orchestrator/
    strategy/     pure decision functions: no I/O, no clock, no randomness
    robinhood/    BrokerAdapter interface, real MCP client, fixture mock, OAuth
    anthropic/    thesis generation with a deterministic fallback
    push/         APNs notifications to the owner's devices
    risk.ts       pure risk caps
    pipeline.ts   generate, plus the expiry sweep
    executor.ts   PaperExecutor and LiveExecutor
    orders.ts     live order poll
    autonomy.ts   autonomy sweep
    marks.ts      daily mark-to-market
    publish.ts    publish sweep
    scheduler.ts  croner jobs
  server/         owner REST API and /healthz
  signal-server/  subscriber REST API and MCP server
  published/      the subscriber-facing signal projection and disclaimer
  backtest/       replay simulation and summary
scripts/          one-off and operator entry points
test/fixtures/    broker responses and OHLCV captured 2026-08-04; equity-order.json
                  is hand-written until a real order is captured
```

## Things that will bite you

**Money is decimal strings everywhere.** Prices and quantities cross the broker
adapter, the database, and the strategy engine as strings. Arithmetic happens
only in `money.ts`, on `Prisma.Decimal`. A `parseFloat` on a price is a defect,
not a style preference: a fill price that is almost right is wrong in a record
that cannot be edited.

Indicator math is the deliberate exception and uses doubles: RSI and MACD are
unitless statistics compared against thresholds, not amounts of money.

**Records cannot be edited or deleted.** Database triggers reject any update to
a signal outside its decision state machine, and reject every delete on
`signals`, `signal_events`, `executions`, and `track_record`. TRUNCATE is
refused too (`reject_truncate` migration). Test resets get past it with
`session_replication_role = 'replica'` in `test/helpers/db.ts`, against the
separate `ollie_test` database. If you need to change a track-record value,
append a new row: that is the design, not a limitation.

**A lot's latest row is not its opening row.** The daily mark appends an open
row per lot every trading day. `listOpenLots` returns both `recordedAt` (the
newest row) and `openedAt` (the first); anything about holding period or FIFO
order must use `openedAt`.

**Market holidays are a hand-kept table.** The mark job skips NYSE full-day
closures from `src/orchestrator/marketCalendar.ts`, which covers 2026 to 2028.
Daily bars cannot answer "was there a session today" at 16:15 ET because the
in-progress day is absent. A test fails once the table stops covering next
year; extend it from the exchange's published calendar.

**The strategy engine takes no dependencies.** `evaluateTechnical` gets bars and
config and returns a candidate or null. Adding a database read, a clock, or an
API call to it breaks the replayability the track record's credibility rests on.
Position awareness belongs in `risk.ts`, timestamps belong to the pipeline.

**Live execution is gated, and the tests assert it.** `placeEquityOrder` has one
call site, `LiveExecutor.execute`. It runs only with the kill switch off,
`LIVE_TRADING_ENABLED=true`, `app_settings.execution_mode = live`, and a signal
created in live mode; the decision route also requires `confirm_live: true`.
The autonomy sweep is the one caller that has no `confirm_live` (Phase 5,
decision 6): it acts only with `AUTONOMY_ENABLED` and `app_settings.autonomy`
both on and the signal's veto window passed.
`PaperExecutor` holds no broker reference at all. If you find yourself adding
one, that is the change that needs a second opinion.

## Deployment

See [../docs/deploy-railway.md](../docs/deploy-railway.md). Run one replica
only: `croner`'s overlap protection is per-process, so a second replica would
run the pipeline twice on the same bar.
