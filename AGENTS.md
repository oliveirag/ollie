# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, and others) working in Ollie.

Ollie is a trading-signal product on Robinhood Agentic Trading. Owner side proposes trades on the
owner's own account and waits for human approval; subscriber side gets read-only signals. Read
`README.md` for status and `Ollie.md` for the spec before large changes.

## Layout

- `backend/`: Node.js + TypeScript + Prisma + Postgres. The orchestrator (`npm start`) and the
  subscriber signal service (`npm run start:signal`). Read `backend/README.md`, especially
  "Things that will bite you", before changing backend code.
- `ios/`: SwiftUI app (owner and subscriber sides), generated with XcodeGen. Team `NL5855QHYU`,
  automatic signing. For any UI, icon or symbol work, load the `apple-dev-resources` skill first.
  Screens follow Apple's iOS 27 Figma kit (fileKey `LrqMNPpVF6rQhdnnEuxkcP`), symbols come from SF
  Symbols (checked against the iOS 17 deployment target), and the app icon is an Icon Composer
  `.icon` built on the App Icon Template (fileKey `0CvTzsKcWrX0k5hZfIKjxH`).
- `docs/`: API contracts, signal schema, runbooks, phase build plans.

## Commands

Backend (from `backend/`, Postgres via `docker compose up -d` at the repo root):

- `npm test` (sets up the test DB first), `npm run typecheck`, `npm run build`
- `npm run dev` / `npm run dev:signal`
- `npm run db:migrate`, `npm run db:generate`, `npm run db:studio`
- `npm run pipeline:once -- --broker=mock` for a full run against fixtures

iOS (from `ios/`):

- `xcodegen` regenerates `Ollie.xcodeproj`. Edit `project.yml`, never the generated project.
- Tests: `xcodebuild test -project Ollie.xcodeproj -scheme Ollie -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -skipPackagePluginValidation`

## Non-negotiables

These are enforced in code and tests. Never weaken them:

1. Trade decisions are deterministic pure functions over OHLCV. The LLM writes thesis text only.
2. Every signal is an immutable record. DB triggers block disallowed status changes and all
   deletes. Don't add migrations that bypass them.
3. No signal without a `review_equity_order` snapshot.
4. `place_equity_order` has exactly one call site, in `LiveExecutor`, behind
   `LIVE_TRADING_ENABLED`, the runtime execution mode, and `confirm_live`. The subscriber service
   must never be able to reach it.
5. Risk caps and the kill switch are enforced in the pipeline for paper and live runs alike.

Never flip live trading, autonomy, or real-money settings. Those are owner actions from
`docs/live-flip-checklist.md`.

## Secrets

`backend/.env` holds real credentials. Never print it or commit it. Copy from `.env.example`.
