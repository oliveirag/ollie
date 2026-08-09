# Ollie

Multi-user trading-signal product built on Robinhood Agentic Trading.

Two strictly separated sides:

- **Owner side** — a private orchestrator runs a deterministic equities strategy, proposes trades
  against the owner's own Robinhood Agentic account, and waits for a human approve/reject. Paper
  (simulated) fills first; real money is a later, gated flip.
- **Subscriber side** — approved signals are published read-only. Subscribers point their own agent
  at the signal feed and act on it themselves. Ollie never holds subscriber credentials and never
  places a trade for anyone but the owner.

Full product spec: [Ollie.md](Ollie.md).
Build plans: [phases 0–1](docs/implementation-plan-phases-0-1.md) (done, pending live E2E) ·
[phase 2](docs/implementation-plan-phase-2.md) (planned).

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Repo, Postgres, data model, immutable signal logging | complete |
| 1 | Headless orchestrator: strategy, review snapshot, thesis, paper execute seam | complete (pending live E2E) |
| 2 | iOS owner app (approve/reject, dashboard, kill switch) | planned |
| 3 | Track record accrual | not started |
| 4 | Subscriber Signal MCP server | not started |
| 5 | Gated flips: live money, then autonomy within caps | not started |

Phases 0–1 are backend-only and verified through logs, tests, and the database. There is no app yet.

## Repo layout

```text
backend/     Node.js + TypeScript orchestrator — see backend/README.md
docs/        API contract, published signal schema, deploy runbook, build plans
Ollie.md     Product requirements document
```

## Getting started

Everything runs locally against a Docker Postgres:

```bash
docker compose up -d
cd backend && cp .env.example .env && npm install && npm run db:migrate
npm test
npm run pipeline:once -- --broker=mock   # a full run against checked-in fixtures
```

[backend/README.md](backend/README.md) has the full command list and the
constraints worth knowing before changing anything.

## Non-negotiables

These are enforced in code, not by convention:

1. **Decisions are deterministic.** The strategy engine is pure functions over OHLCV. The LLM writes
   the thesis text and nothing else — it never decides a trade.
2. **Every signal is an immutable record** the moment it fires, approved or not, paper or live.
   Database triggers reject any update outside the allowed status transitions, and reject all deletes.
3. **No signal without a `review_equity_order` snapshot.** Enforced by the pipeline and by a
   `NOT NULL` column.
4. **`place_equity_order` is unreachable** in Phases 0–1. The only code path referencing it throws
   unless two independent gates are both open.
5. **Risk caps and the kill switch are enforced in the pipeline** from day one, so paper runs
   exercise the same guardrails live runs will.
