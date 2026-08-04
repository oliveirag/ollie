# Ollie orchestrator

Node.js + TypeScript service that proposes trades, waits for a human decision,
and settles approved signals on paper. Headless in Phases 0–1: the only HTTP
route is `/healthz`, and everything else is driven by the scheduler or by the
scripts below.

## Setup

```bash
docker compose up -d          # Postgres 16, from the repo root
cd backend
cp .env.example .env          # fill in ANTHROPIC_API_KEY and RH_MCP_AUTH_TOKEN
npm install
npm run db:migrate
npm test
```

`npm test` creates and migrates a separate `ollie_test` database first, so it
never touches your working data.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Watch mode: health server + scheduler |
| `npm start` | Run the built service (`npm run build` first) |
| `npm test` | Full suite; integration tests need Docker Postgres running |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate` | Apply migrations to the dev database |
| `npm run db:studio` | Browse the database |
| `npm run introspect:mcp` | Dump live Robinhood MCP shapes (add `--review` to include a simulated order) |
| `npm run pipeline:once -- --broker=mock` | One pipeline run against checked-in fixtures, no network |
| `npm run pipeline:once -- --broker=real` | One pipeline run against the live broker |
| `npm run signal:decide -- --list` | Show pending signals |
| `npm run signal:decide -- <id> approve\|reject [--reason "…"]` | Decide one |
| `npm run signal:write-test` | Phase 0 check: write a fabricated signal and read it back |

## How a run works

```
kill switch → fetch bars → evaluate rules → dedupe → risk caps
    → review_equity_order → thesis → persist as pending
                                          ↓
                          owner approves (CLI now, iOS in Phase 2)
                                          ↓
                          PaperExecutor: simulated fill + open position
```

The order is deliberate. The kill switch is checked before the first broker
call. Dedupe runs before the risk gate so duplicates don't consume daily-cap
slots. The pre-trade review runs last, so a candidate the risk gate rejects
never costs a broker call — and a failed review drops the candidate rather than
producing a signal with a gap where its evidence should be.

## Layout

```
src/
  config/         zod-validated env; throws at boot on a bad value
  money.ts        the only place money arithmetic happens
  db/             Prisma client + the entire sanctioned write surface
  orchestrator/
    strategy/     pure decision functions — no I/O, no clock, no randomness
    robinhood/    BrokerAdapter interface, real MCP client, fixture mock
    anthropic/    thesis generation with a deterministic fallback
    risk.ts       pure risk caps
    pipeline.ts   generate -> decide -> execute
    executor.ts   PaperExecutor (real), LiveExecutor (throws)
    scheduler.ts  croner jobs
  server/         /healthz
scripts/          one-off and operator entry points
test/fixtures/    real broker responses and OHLCV, captured 2026-08-04
```

## Things that will bite you

**Money is decimal strings everywhere.** Prices and quantities cross the broker
adapter, the database, and the strategy engine as strings. Arithmetic happens
only in `money.ts`, on `Prisma.Decimal`. A `parseFloat` on a price is a defect,
not a style preference — a fill price that is almost right is wrong in a record
that cannot be edited.

Indicator math is the deliberate exception and uses doubles: RSI and MACD are
unitless statistics compared against thresholds, not amounts of money.

**Records cannot be edited or deleted.** Database triggers reject any update to
a signal outside its decision state machine, and reject every delete on
`signals`, `signal_events`, `executions`, and `track_record`. Tests reset state
with `TRUNCATE`, which is statement-level and the one thing that gets past them.
If you need to change a track-record value, append a new row — that is the
design, not a limitation.

**The strategy engine takes no dependencies.** `evaluateTechnical` gets bars and
config and returns a candidate or null. Adding a database read, a clock, or an
API call to it breaks the replayability the track record's credibility rests on.
Position awareness belongs in `risk.ts`, timestamps belong to the pipeline.

**Live execution is unreachable, and the tests assert it.** `LiveExecutor`
requires two independent gates — a database flag and an environment variable —
and then still throws. `PaperExecutor` holds no broker reference at all. If you
find yourself adding one, that is the change that needs a second opinion.

## Deployment

See [../docs/deploy-railway.md](../docs/deploy-railway.md). Run one replica
only: `croner`'s overlap protection is per-process, so a second replica would
run the pipeline twice on the same bar.
