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
[phase 2](docs/implementation-plan-phase-2.md) (built, pending device E2E) ·
[phase 3](docs/implementation-plan-phase-3.md) (built; sustained run in progress) ·
[phase 4](docs/implementation-plan-phase-4.md) (built; deploy and soft launch gated) ·
[phase 5](docs/implementation-plan-phase-5.md) (built; flips are owner actions).
Running it: [sustained-run checklist](docs/sustained-run-checklist.md) ·
[live-flip checklist](docs/live-flip-checklist.md).
Design reference: [docs/design/owner-app-design.html](docs/design/owner-app-design.html).

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Repo, Postgres, data model, immutable signal logging | complete |
| 1 | Headless orchestrator: strategy, review snapshot, thesis, paper execute seam | complete (pending live E2E) |
| 2 | iOS owner app (approve/reject, dashboard, kill switch) | complete: push and approval proven on a real iPhone (2026-09-24) |
| 3 | Track record accrual | built (3.1–3.7, record screen verified against a seeded multi-trade record); the 3.8 sustained run remains |
| 4 | Subscriber side: signal service, MCP server, onboarding, feed | built (4.1–4.6); 4.7 deploy and soft launch wait on the Phase 3 record |
| 5 | Gated flips: live money, then autonomy within caps | built (5.1–5.5) and tested against a mock broker; 5.6, the flips themselves, is the owner's checklist |

The paid Apple Developer membership is active (team `NL5855QHYU`), so device builds and push work:
fill the four `APNS_*` values in `backend/.env` and the server's scheduled pipeline pushes each new
signal to the owner's registered devices. `pipeline:once` does not push. Sign in with Apple is
wired but not yet run on a device; the simulator onboards subscribers with a Debug-only test
identity that the backend accepts only with `SIWA_STUB=true`, which it refuses in production.

## Repo layout

```text
backend/     Node.js + TypeScript: the orchestrator (npm start) and the
             subscriber-facing signal service (npm run start:signal) — see backend/README.md
ios/         SwiftUI app, owner and subscriber sides — see ios/README.md
docs/        Both API contracts, published signal schema, disclaimer, runbooks, build plans
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
4. **`place_equity_order` has one call site**, in `LiveExecutor`, behind three gates: the
   `LIVE_TRADING_ENABLED` deploy variable, the runtime execution mode, and `confirm_live` on the
   approval itself. A test greps for it. The subscriber service cannot reach it at all — its import
   graph and its database role are both tested.
5. **Risk caps and the kill switch are enforced in the pipeline** from day one, so paper runs
   exercise the same guardrails live runs will.
