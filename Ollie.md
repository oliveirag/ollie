# Ollie

**Product Requirements Document**

Version 0.1 (draft) · July 6, 2026 · Owner: Guilherme Oliveira
Status: pre-build. This document is the handoff spec for building Ollie in Claude Code.

---

## 1. Overview and Objectives

Ollie is a multi-user trading signal product built on top of Robinhood Agentic Trading. It has two sides that stay strictly separated:

**Owner side (you only).** A private orchestrator runs a deterministic equities strategy, proposes trades against your own Robinhood Agentic account, and waits for you to approve or reject each one inside the Ollie iOS app. Trades run on paper (simulated) first and switch to real money only after the strategy has a real track record. This side replaces your current web page plus Discord workflow.

**Subscriber side (everyone else).** Every approved signal is published to a read-only "Ollie Signal" MCP server and to a signal feed in the app. Subscribers connect their own AI agent and their own Robinhood account to that MCP server and act on the signals themselves. You never hold subscriber credentials and never place a trade for anyone but yourself.

### Primary objectives
1. Ship an iOS app where you approve or reject your own trades with one tap, backed by a working orchestrator, on paper money.
2. Build a credible, immutable track record from day one so the signal product has something to sell.
3. Publish signals to subscribers through an MCP server without ever executing on their behalf.
4. Keep the architecture ready for two later flips (real money, then autonomy within limits) without a rewrite.

### Non-goals for v1
- No autonomous execution (human approves every order).
- No options (equities only).
- No Android.
- No trade execution or credential handling for subscribers, ever.

---

## 2. Target Audience

- **Owner (you):** the sole trader whose account Ollie operates. You need fast approvals, a clear paper-vs-live indicator, live position and PnL visibility, and a kill switch.
- **Subscribers:** retail investors who already use (or want to use) an AI agent with a Robinhood Agentic account and want a vetted signal source. They need a trustworthy track record, a clean feed, and simple onboarding to point their own agent at your MCP server.

---

## 3. Core Principles (read before building)

1. **Deterministic decisions, LLM for narration only.** The buy/sell decision is computed by pure, unit-testable rule functions from market data. Claude (via the Anthropic API) only fetches and formats data and writes the human-readable thesis. Claude is never the sole arbiter of a trade. This keeps signals replayable, keeps the track record credible, and prevents a model hallucination from moving money. This matches the established Robinhood-MCP pattern where scripts compute, the AI fetches, and the human approves (reference: https://github.com/Oft3r/agentic-trading-desk).
2. **Paper first, always logged.** Every proposed signal is written as an immutable record the moment it fires, whether or not it is approved, and whether paper or live.
3. **The seam, not the feature.** Build a clean `generate -> decide -> execute` pipeline so switching to autonomy later is a mode flag, not a rewrite. Ship with the mode set to human-approve.
4. **Publisher, not adviser.** Signals are generic, non-personalized, and identical for all subscribers. See Section 9.
5. **Safety pair is mandatory.** Every order runs through `review_equity_order` and the review result is shown before `place_equity_order` is ever called (reference: https://secprove.com/trading-agent-safety/robinhood-trading-mcp-url).

---

## 4. Core Features and Functionality

### 4.1 Orchestrator (owner-only backend service)
The trading loop. Runs on a schedule or trigger.

- Pull market data and account state from the Robinhood Trading MCP (`https://agent.robinhood.com/mcp/trading`): portfolio and buying power, equity historicals, quotes, fundamentals, and built-in technical indicators.
- Run the deterministic strategy engine over that data to produce zero or more candidate signals.
- For each candidate, call `review_equity_order` to get an estimated price and any pre-trade warnings.
- Ask the Anthropic API to write a short plain-English thesis for the signal from the computed inputs.
- Persist the signal as an immutable record and push a notification to the owner app.

**Technical considerations:** the strategy engine is a set of pure functions (input: OHLCV plus indicators; output: signal or null). No network calls or LLM calls inside the decision function. The LLM call and the MCP calls happen in the surrounding pipeline, not in the decision.

**Acceptance criteria:**
- Given seeded historical data, the strategy engine returns the same signals every run (deterministic).
- Every generated signal has a `review_snapshot` populated before it reaches the owner.
- No `place_equity_order` call can occur without a prior `review_equity_order` for the same signal.

### 4.2 Owner approval flow (iOS)
- Push notification on a new pending signal.
- Approval screen shows symbol, side, quantity, estimated price, review warnings, and the thesis.
- One-tap Approve or Reject. Approve in paper mode records a simulated fill; Approve in live mode (later) calls `place_equity_order`.
- Signals expire after a configurable window (default 15 minutes) if not acted on, and are logged as expired.

**Acceptance criteria:**
- Approving a paper signal writes a paper fill and never touches the broker.
- Rejecting or expiring a signal still leaves a permanent record with the reason.
- The live path is gated behind an explicit account-level `execution_mode = live` flag plus a per-approval confirmation.

### 4.3 Owner dashboard and controls (iOS)
- Current positions, realized and unrealized PnL, paper-vs-live indicator that is always visible.
- Kill switch: a single control that halts all new proposals and blocks any execution immediately.
- Mode toggle: paper / live (live disabled until unlocked).

**Acceptance criteria:**
- With the kill switch on, the orchestrator generates no proposals and rejects any execution attempt.
- The paper-vs-live state is unmistakable on every screen.

### 4.4 Signal publishing and track record
- On owner approval, the signal is published to the Ollie Signal MCP server and the subscriber feed.
- The track record accrues per signal: entry, thesis, outcome, realized and unrealized PnL, open or closed status, updated over time.
- Track record surfaces an equity curve, win rate, and average return.

**Acceptance criteria:**
- Track record records are append-only. Corrections are new rows, never edits.
- A published signal is identical for every subscriber (no personalization).

### 4.5 Ollie Signal MCP server (subscriber-facing, read-only)
- Exposes read-only tools/resources such as latest signals, signal detail, and track record.
- Requires a subscriber auth token. No write, no order, no account access.
- This is the "connect your own agent" surface. The mcp-builder skill in Claude Code is the right tool to scaffold it.

**Acceptance criteria:**
- The server exposes no tool that can place, modify, or read any Robinhood order or account.
- An unauthenticated request returns nothing.

### 4.6 Subscriber app view (iOS)
- Signal feed, track record with equity curve, and onboarding that hands the subscriber the MCP URL plus setup steps.
- Prominent disclaimer shown before onboarding completes (see Section 9).

---

## 5. Technical Stack

### Backend and orchestrator
- **Runtime:** Node.js with TypeScript.
- **Hosting:** Railway or Fly.io (single always-on service to start).
- **Database:** PostgreSQL. Optional Redis later for scheduling and queues.
- **Robinhood integration:** Robinhood Trading MCP over HTTP. Owner credentials live only in backend secrets, never in the app.
- **LLM:** Anthropic API for thesis generation only.
- **Scheduling:** cron-style trigger inside the service to start.

### iOS app
- **Language and UI:** Swift, SwiftUI, iOS 17+.
- **State:** the Observation framework (`@Observable`) with an MVVM structure.
- **Networking:** URLSession with async/await, talking to the Ollie backend REST API.
- **Auth:** Sign in with Apple.
- **Push:** APNs with token-based auth (`.p8` key), dispatched from the Node backend over the APNs HTTP/2 API.

### Cross-language contract
Swift and TypeScript do not share types, so the REST API is defined in an OpenAPI spec (`docs/openapi.yaml`) that is the single source of truth. Generate the Swift client and validate the Node handlers against it. This is the tradeoff for going native instead of React Native; the OpenAPI file is how you keep both sides in sync.

---

## 6. Conceptual Data Model

All monetary fields are integer cents or `numeric`, never floats. All timestamps are UTC.

**users**
- `id` (uuid, pk)
- `role` (enum: owner, subscriber)
- `email` (string, unique)
- `apple_user_id` (string, unique, from Sign in with Apple)
- `apns_token` (string, nullable)
- `created_at` (timestamp)
- Note: no Robinhood credentials are ever stored on any user.

**subscriptions**
- `id` (uuid, pk)
- `user_id` (uuid, fk users)
- `tier` (enum: free, paid)
- `status` (enum: active, canceled, expired)
- `started_at` (timestamp)

**signals**
- `id` (uuid, pk)
- `created_at` (timestamp)
- `symbol` (string)
- `side` (enum: buy, sell)
- `signal_type` (enum: technical, rebalance)
- `quantity` (numeric)
- `thesis` (text, LLM-generated)
- `indicators` (jsonb: the computed inputs, e.g. rsi, macd, ema values)
- `review_snapshot` (jsonb: estimated price, warnings from review_equity_order)
- `status` (enum: pending, approved, rejected, expired)
- `execution_mode` (enum: paper, live)
- `decided_at` (timestamp, nullable)
- `published` (bool)
- `published_at` (timestamp, nullable)

**executions**
- `id` (uuid, pk)
- `signal_id` (uuid, fk signals)
- `mode` (enum: paper, live)
- `fill_price` (numeric)
- `quantity` (numeric)
- `filled_at` (timestamp)
- `broker_order_id` (string, nullable, live only)

**track_record** (append-only)
- `id` (uuid, pk)
- `signal_id` (uuid, fk signals)
- `entry_price` (numeric)
- `exit_price` (numeric, nullable)
- `realized_pnl` (numeric, nullable)
- `unrealized_pnl` (numeric, nullable)
- `status` (enum: open, closed)
- `recorded_at` (timestamp)

---

## 7. Folder Structure

Single git repo so you get one history and one place to commit. Backend and iOS live side by side because Swift and TS cannot share a package.

```
ollie/
  README.md
  Ollie.md                     # this PRD
  .gitignore
  docs/
    openapi.yaml               # API contract, source of truth across Swift and TS
    signal-schema.md           # the published signal contract for subscribers
  backend/
    src/
      orchestrator/
        strategy/
          technical.ts         # pure, deterministic signal functions
          rebalance.ts
          index.ts
        robinhood/
          client.ts            # Robinhood Trading MCP wrapper
        anthropic/
          thesis.ts            # LLM rationale only
        pipeline.ts            # generate -> decide -> execute seam
        scheduler.ts
      api/
        routes/
        auth/                  # Sign in with Apple verification
        push/                  # APNs dispatch
      mcp-server/              # Ollie Signal MCP, read-only for subscribers
      db/
        migrations/
        models/
      config/
      index.ts
    package.json
    tsconfig.json
    .env.example
  ios/
    Ollie.xcodeproj
    Ollie/
      App/
      Features/
        Owner/                 # approvals, dashboard, kill switch
        Subscriber/            # feed, track record, onboarding
        Shared/
      Networking/              # API client generated from openapi.yaml
      Models/
      Resources/
```

---

## 8. Security Considerations

- Robinhood Agentic credentials exist only for your own account, only in backend secrets (Railway/Fly secret store), never in the app or the repo.
- The app never sees any Robinhood credentials, yours or subscribers'.
- Subscribers authenticate to Ollie with Sign in with Apple. They connect their own agent to their own Robinhood account entirely outside Ollie.
- The Signal MCP server is read-only and cannot touch any brokerage account or order.
- Kill switch halts proposals and blocks execution at the pipeline level, not just the UI.
- Pre-wire the risk caps you will need for autonomy later even though autonomy is off: max position size, max daily trades, max total exposure, and a symbol allowlist. Enforce them in the pipeline from day one so paper runs exercise the same guardrails.
- All traffic over TLS. Secrets via environment, never committed. `.env.example` documents shape only.

---

## 9. Legal and Compliance

This is the largest non-technical risk and it gates monetization, not building.

- Paid, general trading signals rely on the **publisher's exclusion** in the Investment Advisers Act. Impersonal, general-circulation, non-personalized signals distributed to the public are protected. This is how Seeking Alpha defeated an adviser-registration claim (https://www.gtlaw.com/en/insights/2024/8/no-need-for-seeking-alpha-to-seek-registration), tracing to Lowe v. SEC (https://supreme.justia.com/cases/federal/us/472/181/).
- The danger zone: the SEC has treated an auto-trading service that pipes signals into a broker to trade for subscribers as personalized advice requiring registration (https://www.sec.gov/about/offices/oia/oia_investman/rplaze-042012.pdf). Ollie avoids this because each subscriber's own agent decides, but marketing decides which side of the line you land on. "Connect your agent to a generic technicals feed" is publisher side. "My bot auto-executes my picks in your account" is adviser side.

**Requirements:**
1. Keep signals generic, timestamped, and identical for all subscribers. No personalization.
2. Show a clear disclaimer before a subscriber completes onboarding and before any monetization: not financial advice, past performance is not indicative of future results, they act at their own risk through their own account.
3. Confirm Robinhood's Agentic Trading terms permit redistributing MCP-derived signals as a commercial product before charging. Market data often carries redistribution limits.
4. Talk to a securities lawyer before enabling real-money live signals or paid subscriptions. This document is not legal advice and its author is not a lawyer.

The build phase and the paper phase carry no monetization exposure, so development can start now.

---

## 10. Development Phases

**Phase 0 - Foundations.** Repo scaffold, Postgres, data model and migrations, Robinhood MCP connection to your Agentic account (paper intent), immutable signal logging. Exit: a signal can be written and read from the DB.

**Phase 1 - Orchestrator (headless).** One signal type (start with technicals or scheduled rebalance), deterministic engine, `review_equity_order` snapshot, thesis generation, pipeline with the execute seam stubbed to paper. Exit: signals generate on schedule and land in the DB with review snapshots. Verified via logs and DB, no app yet.

**Phase 2 - Owner app.** SwiftUI owner view, APNs, approve/reject flow, paper ledger, positions and PnL dashboard, kill switch, paper-vs-live indicator. Exit: you approve or reject real proposals on your phone; this replaces the web page and Discord.

**Phase 3 - Track record.** Accrue outcomes and PnL per signal, equity curve, win rate, average return. Run paper for a sustained period to build a record worth publishing.

**Phase 4 - Subscriber side.** Ollie Signal MCP server (read-only), subscriber onboarding, feed and track record view, disclaimer. Soft launch to a small group.

**Phase 5 - Gated flips (after lawyer and track record).** Real-money live mode for the owner, then autonomy within the pre-wired caps. Each flip is a config change against an already-built seam, not a rewrite.

---

## 11. Potential Challenges and Solutions

- **LLM nondeterminism:** solved by keeping decisions in pure functions and using the LLM only for the thesis. Log every input and output.
- **Paper simulation fidelity:** use the `review_equity_order` estimated price as the paper fill and apply a small conservative slippage assumption so paper results do not overstate live performance.
- **Robinhood MCP limits:** currently long equities and options only, trading only in the separate Agentic account. v1 is long equities, which fits.
- **APNs from Node:** use token-based auth with the APNs HTTP/2 endpoint; store the `.p8` key as a secret.
- **Swift and TS type drift:** the OpenAPI spec is the contract; generate the Swift client from it and validate Node handlers against it.
- **Track record credibility:** append-only records, timestamped, never edited. The credibility is the product.

---

## 12. Future Expansion

- Options signals (additive module once the strategy is proven).
- Autonomy within caps (seam already built).
- Android via React Native or a second native app.
- Additional signal types and a backtesting engine.
- Tiered subscriptions and payments.
- Prediction-market signals tied to your sports and prediction-market interests, if and when a compliant data path exists.

---

## 13. Open Decisions

1. First signal type: technicals (e.g. RSI or MACD crossovers) or scheduled rebalance. Pick one for v1.
2. Approval expiry window (default proposed: 15 minutes).
3. Conservative slippage assumption for paper fills.
4. Subscription pricing and tiers (defer until track record exists).
5. Exact read-only tool surface for the Signal MCP server.
