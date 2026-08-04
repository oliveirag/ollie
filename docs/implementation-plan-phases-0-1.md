# Ollie — Phases 0 & 1 Implementation Plan (backend/orchestrator, headless)

## Context

Ollie is a multi-user trading-signal product built on Robinhood Agentic Trading, fully specified in the PRD at `/Users/goliveira/Developer/ollie/Ollie.md`. The repo is greenfield: it contains only the PRD (untracked, no first commit). This plan covers **PRD Phases 0–1 only** — the backend orchestrator, headless, verified via logs and DB. iOS (Phase 2), track record accrual (Phase 3), and the subscriber Signal MCP server (Phase 4) come in later plans.

Decisions confirmed with the owner:
- **Scope:** Phases 0–1 (backend only).
- **First signal type:** technical indicators — RSI / MACD crossings, deterministic pure functions (PRD Open Decision #1).
- **Robinhood MCP:** real headless connection to `https://agent.robinhood.com/mcp/trading` (owner has/can get credentials), but built behind a `BrokerAdapter` interface with a mock implementation for tests/local dev.
- **Hosting:** Railway from the start (service + managed Postgres); everything must also run locally (Docker Postgres).
- Defaults adopted from PRD open decisions (all config-driven): 15-minute signal expiry, 10 bps paper slippage.

Core PRD principles that gate every implementation choice: deterministic decisions (LLM writes the thesis only, never decides); every signal is an immutable record whether approved or not; `review_equity_order` snapshot required before any signal exists; `place_equity_order` is unreachable in Phases 0–1; risk caps and kill switch enforced at the pipeline level from day one.

## Key de-risk: real Robinhood MCP input schemas (captured 2026-08-04)

The actual tool input schemas were inspected via the live connector. Bake these into the adapter types:

- **All prices/quantities are decimal strings on the wire** (`quantity: "10"`, `limit_price: "182.50"`). Never `parseFloat` money.
- `get_accounts`: `{}` → find `account_number`; account must be `agentic_allowed=true` (the separate Agentic account). Buying power comes from `get_portfolio`, not here.
- `get_portfolio`: `{account_number}` required. `get_equity_positions`: `{account_number, cursor?}` (paginated).
- `get_equity_quotes`: `{symbols: string[]}`.
- `get_equity_historicals`: `{symbols (≤10), start_time: RFC3339 (required), end_time?, interval? ('day','hour','minute'), bounds? ('regular'), adjustment_type? ('split')}`. Bars may carry `interpolated: true` → **filter before indicator computation**.
- `get_equity_technical_indicators`: `{symbol, type ('rsi'|'macd'|…), interval, start_time, period?…, output?}` — use only as a one-time cross-check of our own indicator math.
- `review_equity_order`: `{account_number, symbol, side, type, quantity XOR dollar_amount (market only), time_in_force? ('gfd'), market_hours? ('regular_hours')}`. Market orders regular-hours-only; fractional shares market+regular-hours only.
- `place_equity_order`: same plus `ref_id` (UUID idempotency key). **Never called in Phases 0–1**, but pre-allocate and persist a `ref_id` per signal now so live mode is idempotent later.

Caveat: only **input** schemas are known; output shapes are unverified until first connection. Tool names on the direct server may lack the connector prefix — verify via `tools/list` in milestone 1.1.

## Repo scaffold

```
ollie/
  README.md
  Ollie.md
  .gitignore                      # node_modules, .env, dist, coverage
  docker-compose.yml              # local Postgres 16
  docs/
    openapi.yaml                  # stub (/healthz only) — becomes source of truth in Phase 2
    signal-schema.md              # stub
  backend/
    package.json                  # "type": "module"
    tsconfig.json                 # strict, NodeNext, ES2022
    vitest.config.ts
    .env.example
    prisma/
      schema.prisma
      migrations/                 # generated SQL + hand-written trigger migration
    src/
      index.ts                    # config -> db -> scheduler -> /healthz server (node:http)
      logger.ts                   # pino; run_id child logger per pipeline run
      config/index.ts             # zod-validated env + strategy/risk config
      db/
        client.ts                 # Prisma singleton
        signals.ts                # insertSignal, transitionSignal (tx w/ signal_events), queries
        executions.ts             # recordExecution
        trackRecord.ts            # appendTrackRecord
        settings.ts               # kill switch / execution_mode flags
      orchestrator/
        strategy/
          types.ts                # Candle, CandidateSignal, StrategyConfig
          indicators.ts           # rsi(), ema(), macd() — pure, ~100 LOC, own implementation
          technical.ts            # evaluateTechnical() — pure, deterministic
          index.ts
        robinhood/
          types.ts                # zod schemas for tool inputs/outputs (frozen after 1.1 spike)
          client.ts               # BrokerAdapter interface
          mcpClient.ts            # real impl: @modelcontextprotocol/sdk, StreamableHTTPClientTransport
          mockClient.ts           # fixture-driven impl
        anthropic/thesis.ts       # generateThesis() with deterministic template fallback
        risk.ts                   # applyRiskCaps() — pure
        executor.ts               # Executor interface, PaperExecutor, throwing LiveExecutor stub
        pipeline.ts               # generate -> decide -> execute seam
        scheduler.ts              # croner: pipeline run + expiry sweep
    scripts/
      introspect-mcp.ts           # milestone 1.1 spike: tools/list + sample calls, dump raw JSON
      write-test-signal.ts        # Phase 0 exit check
      run-pipeline-once.ts        # --broker=mock|real
      decide-signal.ts            # CLI approve/reject (iOS stand-in for Phase 1)
    test/
      fixtures/ohlcv/  fixtures/mcp/
      indicators.test.ts  technical.test.ts  risk.test.ts
      pipeline.integration.test.ts  db.signals.test.ts
```

Do not scaffold `api/`, `mcp-server/` (Phases 2/4).

## Library choices

| Concern | Choice | Why |
|---|---|---|
| MCP client | `@modelcontextprotocol/sdk` | Official TS SDK; `StreamableHTTPClientTransport` + `authProvider` hook for token injection/refresh |
| DB + migrations | **Prisma** | Owner knows it (Nudge project). Append-only enforcement lives in raw SQL triggers via `prisma migrate dev --create-only` + hand-written DDL. Money = `Decimal @db.Decimal(18,6)`, never float. Fallback if trigger/migration friction: node-pg-migrate (not Drizzle) |
| Scheduler | **croner** | TS-native, IANA timezones (`America/New_York`), `protect: true` prevents overlapping runs |
| LLM | `@anthropic-ai/sdk` | Default model `claude-opus-5` via `ANTHROPIC_MODEL` env (thesis volume = cents/day; flip to `claude-haiku-4-5` is config). **Do not set `temperature`** (400 on this family); handle `stop_reason === 'refusal'` |
| Tests | vitest | Integration tests hit local Docker Postgres |
| Config | zod | `EnvSchema.parse(process.env)` at boot; also validates MCP responses at adapter boundary |
| Logging | pino | Structured; log every strategy input/output (PRD §11) |
| Decimal math | `Prisma.Decimal` | Only arithmetic on money: slippage + notional caps. Wire values stay strings otherwise |

## Database schema (Phase 0)

`users`/`subscriptions` deferred — nothing in Phases 0–1 reads them.

**Migration 1 — enums + tables:**

```sql
-- enums: signal_side('buy','sell'), signal_type('technical','rebalance'),
--        signal_status('pending','approved','rejected','expired'),
--        exec_mode('paper','live'), position_status('open','closed')

CREATE TABLE signals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  symbol          text NOT NULL,
  side            signal_side NOT NULL,
  signal_type     signal_type NOT NULL,
  quantity        numeric(18,6) NOT NULL,
  thesis          text,                          -- nullable: LLM may fail
  thesis_source   text NOT NULL DEFAULT 'llm',   -- 'llm' | 'fallback_template'
  indicators      jsonb NOT NULL,
  review_snapshot jsonb NOT NULL,                -- NOT NULL enforces snapshot-before-pending
  status          signal_status NOT NULL DEFAULT 'pending',
  execution_mode  exec_mode NOT NULL,
  decided_at      timestamptz,
  decide_reason   text,
  published       boolean NOT NULL DEFAULT false,
  published_at    timestamptz,
  dedupe_key      text NOT NULL UNIQUE,          -- '{rule}:{symbol}:{side}:{barTime}'
  ref_id          uuid NOT NULL DEFAULT gen_random_uuid()  -- broker idempotency key for later
);

CREATE TABLE signal_events (  -- append-only audit of status transitions
  id uuid PK, signal_id uuid FK, from_status, to_status, reason text, created_at timestamptz
);

CREATE TABLE executions (
  id uuid PK, signal_id uuid FK, mode exec_mode, fill_price numeric(18,6),
  quantity numeric(18,6), filled_at timestamptz, broker_order_id text
);

CREATE TABLE track_record (
  id uuid PK, signal_id uuid FK, entry_price numeric(18,6), exit_price numeric(18,6),
  realized_pnl numeric(18,6), unrealized_pnl numeric(18,6),
  status position_status, recorded_at timestamptz DEFAULT now()
);

CREATE TABLE app_settings (   -- single row; kill switch survives restarts, iOS-flippable later
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  kill_switch boolean NOT NULL DEFAULT false,
  execution_mode exec_mode NOT NULL DEFAULT 'paper',
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

**Migration 2 — immutability triggers (hand-written plpgsql).** Resolves "immutable record" vs. status transitions:
- `signals` BEFORE UPDATE: raise if any column other than `status, decided_at, decide_reason, published, published_at` changes. State machine: status only `pending → approved|rejected|expired`; `decided_at` only NULL→non-NULL and required when leaving pending; `published` only false→true.
- `signals` BEFORE DELETE: always raise.
- `signal_events`, `executions`, `track_record`: raise on any UPDATE or DELETE (pure append-only; "corrections are new rows").
- Repo layer exposes only `insertSignal` / `transitionSignal(id, to, reason)` (one tx writing both tables) / `recordExecution` / `appendTrackRecord` — no generic update surface.

## Strategy engine (pure, deterministic)

```ts
interface Candle { t: string; o: string; h: string; l: string; c: string; v: number; interpolated?: boolean }
interface CandidateSignal {
  symbol: string; side: 'buy'|'sell'; signalType: 'technical';
  quantity: string;                    // decimal string, whole shares in v1
  rule: string;                        // 'rsi_oversold' | 'macd_bullish_cross' | ...
  indicators: Record<string, number>;  // rsi14, macdLine, macdSignal, macdHist + prev values
  barTime: string;                     // decision bar close time -> dedupe_key
}
function evaluateTechnical(symbol: string, candles: Candle[], cfg: StrategyConfig): CandidateSignal | null
```

- No I/O, no clock reads, no randomness. Pipeline fetches candles and stamps timestamps.
- **Implement RSI (Wilder), EMA, MACD(12,26,9) ourselves** (~100 LOC) — the `technicalindicators` npm package is unmaintained and its warm-up conventions would undermine the determinism proof. Indicator math in doubles is fine (not money; deterministic for identical inputs).
- Rules on daily bars, **crossing semantics** (prev bar vs current, so conditions don't re-fire): buy = RSI crosses below `rsiOversold` (30) or MACD bullish cross; sell = RSI crosses above `rsiOverbought` (70) or MACD bearish cross. Long-only sell gating (needs open position) lives in the risk gate, not the pure function.
- Sizing: `ORDER_NOTIONAL_CENTS` ÷ last close, floored to whole shares (avoids fractional-share constraints).
- Dedupe backstop: unique `dedupe_key` in DB.
- Validate our indicator math against published reference values + one-time tolerance-based cross-check against RH's `get_equity_technical_indicators` in the introspect script.

## Pipeline: generate → decide → execute

`runPipeline(deps)` with `deps = { broker: BrokerAdapter, thesis, db, config, clock }` — constructor-injected for testability.

```ts
interface BrokerAdapter {
  getAccountNumber(): Promise<string>;            // cached; asserts agentic_allowed
  getHistoricals(symbols, startTime, interval): Promise<Record<string, Candle[]>>;
  getQuotes(symbols): Promise<Record<string, Quote>>;
  getPortfolio(): Promise<Portfolio>;
  getPositions(): Promise<Position[]>;
  reviewEquityOrder(req): Promise<ReviewResult>;  // raw JSON preserved
  placeEquityOrder(req): Promise<PlaceResult>;    // implemented, unreachable in Phase 1
}
```

Run sequence (each stage logged with `run_id`):
1. **Kill switch gate** — read `app_settings.kill_switch` (DB, so future app can flip it; `KILL_SWITCH=true` env is an extra override). If on: log and return. Executor re-checks independently.
2. **Fetch** — historicals for allowlist symbols; drop `interpolated` bars.
3. **Generate** — `evaluateTechnical` per symbol.
4. **Dedupe** — skip existing `dedupe_key`s (unique constraint is the race-proof backstop).
5. **Risk gate** — pure `applyRiskCaps(candidates, accountState, todayStats, cfg)`: symbol allowlist; long-only (sell needs open position ≥ qty); max position size; max daily trades (UTC day — document the choice); max total exposure (open positions + pending signals + candidate). Rejected candidates logged with reasons, not persisted.
6. **Review snapshot** — `reviewEquityOrder` per accepted candidate; on failure/timeout skip the candidate entirely (**no snapshot → no signal**, also enforced by NOT NULL). Persist raw response.
7. **Thesis** — never blocks (see below).
8. **Persist** — `insertSignal(status='pending', execution_mode from app_settings)`. Notification = structured log line (APNs is Phase 2).

**Decide (Phase 1 stand-in):** `scripts/decide-signal.ts <id> approve|reject` → `transitionSignal`; approve calls `executor.execute(signal)`.

**Execute seam:**
- `PaperExecutor`: fill = review estimated price × (1 ± `SLIPPAGE_BPS`/10000) (+ for buys, − for sells; default 10 bps). Writes `executions` (mode paper, broker_order_id null) + opens `track_record` row (entry = fill, status open). Never touches the broker.
- `LiveExecutor`: throws `LiveModeNotEnabledError` unless `execution_mode==='live'` AND `LIVE_TRADING_ENABLED=true` env — double gate. Body deferred to Phase 5 (fresh review re-check, then `placeEquityOrder` with the signal's persisted `ref_id`).
- Both re-check kill switch immediately before acting.

**Expiry sweep:** croner job every minute; `pending` older than `SIGNAL_EXPIRY_MINUTES` (15) → `expired` with reason.

**Scheduler:** croner, `America/New_York`, `protect: true`. `PIPELINE_CRON` default `35 9 * * 1-5` ET + expiry sweep. Weekend runs harmless (no new bar + dedupe).

## Thesis generation

- `client.messages.create({ model: env.ANTHROPIC_MODEL /* claude-opus-5 */, max_tokens: 500, system, messages })`; ~15s timeout, SDK default retries. No `temperature`.
- System prompt: 2–3 sentence plain-English rationale, only from provided data, no invented numbers/predictions/price targets, no advice language.
- User content: compact JSON `{symbol, side, rule, indicators, quantity, estimated_price, review_warnings}`.
- **Any failure/timeout/refusal → deterministic template fallback** (e.g. `"AAPL RSI(14) at 27.3 crossed below the oversold threshold of 30; MACD histogram −0.42."`) with `thesis_source='fallback_template'`. Log prompt + completion always.

## Milestones

**Phase 0 — exit: a signal can be written and read from the DB**

- [x] 0.1 First commit of `Ollie.md`; scaffold tree, package.json, strict tsconfig, vitest, pino, zod config, `.env.example`, `docker-compose.yml` (postgres:16).
- [x] 0.2 Prisma schema + migration 1; migration 2 (`--create-only`, hand-written triggers); `npm run db:migrate`.
- [x] 0.3 Repo layer + `db.signals.test.ts`: round-trip; pending→approved writes `signal_events`; **immutability asserted** (UPDATE symbol throws, DELETE throws, double-decide throws, executions/track_record UPDATE throws).
- [x] 0.4 `scripts/write-test-signal.ts` — fabricated signal in, read back, printed. **← Phase 0 exit, met.**
- [~] 0.5 Railway: service (build from `backend/`) + managed Postgres; `prisma migrate deploy` on release; `/healthz` via `node:http`; run write-test-signal against Railway PG (`railway run`) for parity. — *`/healthz`, `railway.json` and the runbook are written and the built service boots; the Railway project itself has not been created. See Open items.*

**Phase 1 — exit: signals generate on schedule, land in DB with review snapshots**

- [x] 1.1 **MCP connectivity spike FIRST** — `scripts/introspect-mcp.ts`: connect with headless credentials, `tools/list`, dump input schemas, call `get_accounts` / `get_portfolio` / `get_equity_quotes(['AAPL'])` / `get_equity_historicals` / one 1-share `review_equity_order`; freeze observed **output** shapes into `robinhood/types.ts` zod schemas; then `mcpClient.ts` + `mockClient.ts` (fixtures from dumped responses). — *Output shapes were captured through the claude.ai connector rather than a headless token; see Open items.*
- [x] 1.2 `indicators.ts` + `technical.ts` + fixtures + determinism/reference-value tests.
- [x] 1.3 `risk.ts` + per-cap boundary tests.
- [x] 1.4 `anthropic/thesis.ts` + fallback tests (mock SDK throw).
- [x] 1.5 `pipeline.ts` + `executor.ts` + expiry; integration test (mock broker + local PG): pending signals w/ snapshots; kill-switch run → nothing; duplicate run → nothing new; cap violations rejected; approve → execution + open track_record with slippage fill.
- [x] 1.6 `scheduler.ts` + wire into `index.ts`; `run-pipeline-once.ts --broker=mock|real`.
- [ ] 1.7 Manual E2E vs real RH MCP (paper intent), then Railway deploy with `PIPELINE_CRON` live; watch first scheduled run. **← Phase 1 exit.**

## Where this left off (2026-08-04)

Milestones 0.1–1.6 are complete and pushed. 161 tests pass; typecheck and build
are clean. The pipeline was verified end to end against the mock broker: three
candidates, one rejected by the exposure cap, two persisted as pending signals
with review snapshots, one approved into a paper fill at 308.94864 (the 308.64
review estimate plus 10 bps against the trader) with a track-record position
opened, one rejected and left on the record with its reason. Flipping
`app_settings.kill_switch` in psql halted the next run before its first broker
call. `grep` confirms `placeEquityOrder` has no call site — only the interface
declaration and two implementations that both throw.

### Four findings that changed the plan

1. **`review_equity_order` returns no estimated price.** It returns a
   `quote_data` block. The fill estimate is derived — ask for a buy, bid for a
   sell, last trade when a side of the book is missing — and that derivation
   lives in `robinhood/client.ts` so the mock and real adapters cannot drift on
   the number that becomes the paper fill. Both the derived value and the raw
   response are persisted; see `docs/signal-schema.md`.
2. **`order_checks` is an object keyed by `alertType`**, `{}` when clean — not
   the array its name suggests.
3. **`max_tokens` covers thinking plus response text on `claude-opus-5`**, so
   the planned 500-token thesis budget would have truncated every answer. It is
   4096, with length bounded by the prompt. `temperature` is rejected with a
   400 on this model family, not merely discouraged.
4. **The trading MCP speaks OAuth 2.1 + PKCE, not static bearer tokens.** An
   anonymous `initialize` returns `401` with
   `www-authenticate: Bearer resource_metadata=…`, and the discovery documents
   give: authorize `https://robinhood.com/oauth`, token
   `https://api.robinhood.com/oauth2/token/`, register
   `https://agent.robinhood.com/oauth/trading/register` (Dynamic Client
   Registration supported), `grant_types: authorization_code, refresh_token`,
   `code_challenge_methods: S256`, `token_endpoint_auth_methods: none` (public
   client, no secret), `scopes: internal`.

   Consequences: the `Authorization: Bearer` header in `mcpClient.ts` was
   already the right seam — an access token *is* a bearer token — but nothing
   acquires or refreshes one. Authorization requires a human in a browser, so
   **Railway can never perform the initial leg**; the refresh token is what
   ships to the deploy. Whether refresh tokens rotate on use is still unknown,
   and if they do, the credential cannot live in an env var at all — it has to
   move to Postgres, since an env var cannot store something that changes at
   runtime. Design for rotation.

Indicator math was cross-checked against Robinhood's own
`get_equity_technical_indicators` on the same AAPL bars: RSI agrees to 0.10 and
MACD to 0.09, both differences shrinking toward the present — the signature of a
warm-up seeding difference, not a formula error. RSI also matches Wilder's
published worked example to 0.07.

### Open items

- **Robinhood MCP auth is OAuth 2.1 + PKCE — resolved 2026-08-04, see below.**
  No longer an unknown, but now a known piece of unbuilt work: there is an
  interactive browser leg, and nothing headless can perform it. Blocks the
  real-broker half of 1.7 until the authorize script exists.
- **Railway: project created by the owner 2026-08-04**, service hostname
  `ollie.railway.internal`. Managed Postgres, service variables, and the first
  scheduled run are still outstanding (0.5 and 1.7). `DATABASE_URL` is set as the
  reference `${{Postgres.DATABASE_URL}}`, never pasted, so no database
  credential needs to leave the platform.
- **`ANTHROPIC_API_KEY` is deliberately deferred** until the strategy is shown to
  work (owner decision, 2026-08-04). This is safe and needs no code change:
  `thesis.ts` checks for the missing key before constructing the client and takes
  the deterministic template path, so every signal generated in the meantime is
  recorded with `thesis_source='fallback_template'`. Signals are unaffected —
  the LLM never decides anything — but the real LLM path stays unexercised, so
  1.7 should be repeated once against a funded key before Phase 2 relies on it.
- **The Agentic account (`••••3844`, the only `agentic_allowed=true` account) is
  unfunded** — zero buying power, no positions. Every real `review_equity_order`
  will therefore carry an `EQUITY_NOT_ENOUGH_BP` alert. That is harmless in
  paper mode (alerts are recorded, not treated as a reason to drop a candidate),
  but a live run would have nothing to trade with.
- **Cap values reviewed and kept as-is by the owner (2026-08-04).** $500 per
  order, $1,000 max position, 3 trades/day, $5,000 total exposure, 15-minute
  expiry, 10 bps slippage, allowlist `AAPL,MSFT,SPY`. These are *paper* caps and
  deliberately exceed the account's funded balance, which is correct: paper fills
  are simulated from the review snapshot and never spend money, so sizing the
  caps to the balance would only stop the strategy from being exercised on liquid
  names.

  **The owner has funded the Agentic account with $10 and wants that to be the
  live ceiling.** That is a Phase 5 constraint, not a Phase 1 one, and it does
  not translate into these caps — at today's prices $10 cannot buy a single whole
  share of any allowlist symbol, so applying it here would make
  `evaluateTechnical` return `quantity_rounds_to_zero` for every symbol on every
  bar and the pipeline would go permanently, silently quiet. Phase 5 must
  therefore either size to sub-$10 symbols, adopt fractional shares, or raise the
  funded balance — and must not simply inherit these numbers.
- The dev database holds a handful of smoke-test signals from these runs. They
  cannot be deleted — that is the point of the triggers — so `TRUNCATE` the
  tables or use a fresh database before the first real run if you want a clean
  track record.

**`.env.example`:**

```bash
DATABASE_URL=postgresql://ollie:ollie@localhost:5432/ollie
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-opus-5
RH_MCP_URL=https://agent.robinhood.com/mcp/trading
RH_MCP_AUTH_TOKEN=            # exact mechanism TBD after 1.1 spike
RH_ACCOUNT_NUMBER=            # optional pin; else discovered via get_accounts
SYMBOL_ALLOWLIST=AAPL,MSFT,SPY
RSI_PERIOD=14
RSI_OVERSOLD=30
RSI_OVERBOUGHT=70
MACD_FAST=12
MACD_SLOW=26
MACD_SIGNAL=9
ORDER_NOTIONAL_CENTS=50000
MAX_POSITION_CENTS=100000
MAX_DAILY_TRADES=3
MAX_TOTAL_EXPOSURE_CENTS=500000
SLIPPAGE_BPS=10
SIGNAL_EXPIRY_MINUTES=15
PIPELINE_CRON=35 9 * * 1-5    # America/New_York
KILL_SWITCH=false             # env override; runtime flag lives in app_settings
LIVE_TRADING_ENABLED=false    # second gate; unused until Phase 5
LOG_LEVEL=info
```

## Verification

1. **Unit (no network/DB):** indicator reference values; strategy determinism (same fixtures → identical output, snapshot-asserted); crossings don't re-fire; risk caps per rule + boundaries; thesis fallback.
2. **DB tests (Docker PG):** repo round-trips; every immutability trigger provably raises; illegal transitions rejected.
3. **Integration (mock broker + local PG):** full pipeline scenarios incl. kill switch, dedupe, expiry (fake clock), approve→paper fill→track_record.
4. **Manual E2E (real RH MCP, paper intent):** temporarily widen a threshold (e.g. `RSI_OVERSOLD=70`) to force a candidate; verify `agentic_allowed` account discovered; signal lands `pending` with real review snapshot; **grep confirms zero `place_equity_order` calls** (structurally guaranteed: only the throwing LiveExecutor references it); approve via CLI → paper fill + track_record; reject/expire leave records; flip kill switch in psql → next run produces nothing.
5. **Post-deploy:** Railway logs for first scheduled run; query `signals` for rows with populated `review_snapshot`.

## Risks / open questions for the implementer

1. ~~**RH MCP headless auth is the #1 unknown**~~ — **resolved 2026-08-04: OAuth 2.1 + PKCE with refresh tokens** (finding 4 above). The remaining work is a `scripts/authorize-rh.ts` doing DCR + PKCE + a loopback callback, plus refresh-on-401 in the adapter. There is no fully headless path: someone authorizes in a browser once.
2. **Output shapes unknown** until first call (esp. where `review_equity_order` puts estimated price + alerts). Mitigation: zod `.passthrough()`, persist raw JSON, freeze schemas from introspect output.
3. Tool names on the direct server may differ from connector-prefixed names — verify via `tools/list`.
4. `review_equity_order` needs the **Agentic** account (`agentic_allowed=true`); market reviews are regular-hours-only — inspect alerts if scheduler runs near open.
5. Rate limits unknown; ≤10 symbols/call, daily bars ~90d lookback is light, but add 429/backoff in the adapter.
6. **Decimal discipline:** every price/qty crossing the adapter is a string; arithmetic only in `risk.ts` and `PaperExecutor` via `Prisma.Decimal`. A `parseFloat` on money is a review-blocking defect.
7. Split adjustments can shift historical closes and re-trigger crossings — `dedupe_key` absorbs this.
8. Scheduler thinks in `America/New_York`; all persistence UTC; "max daily trades" boundary = UTC day (documented).
9. `claude-opus-5` current as of Aug 2026; env-configurable; no sampling params, handle refusal stop reason.
10. Defaults this plan sets from PRD open decisions (all config): expiry 15 min, slippage 10 bps, allowlist `AAPL,MSFT,SPY`, $500 notional/trade, caps in `.env.example` — owner should review the cap values before the first real paper run.
