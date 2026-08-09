# Deploying the orchestrator to Railway

The orchestrator is a single always-on service plus a managed Postgres. It is
headless in Phases 0–1: the only HTTP route is `/healthz`, and everything else
is observed through logs and the database.

## One-time setup

1. **Create the project and add Postgres.** In Railway, create a project, then
   `+ New` → `Database` → `PostgreSQL`.

2. **Add the service from this repo** and set its **Root Directory to
   `backend`**. This matters: `railway.json` and `package.json` both live there,
   and Nixpacks will not find them from the repo root.

3. **Set the service variables.** `DATABASE_URL` should reference the database
   service rather than being pasted in, so it survives a credential rotation:

   ```
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   ```

   Then everything from [`backend/.env.example`](../backend/.env.example) that
   is not a local default. At minimum:

   ```
   ANTHROPIC_API_KEY=…
   OWNER_API_TOKEN=…
   RH_OAUTH_CLIENT_ID=…
   RH_OAUTH_REFRESH_TOKEN=…
   SYMBOL_ALLOWLIST=AAPL,MSFT,SPY
   PIPELINE_CRON=35 9 * * 1-5
   KILL_SWITCH=false
   LIVE_TRADING_ENABLED=false
   NODE_ENV=production
   ```

   `OWNER_API_TOKEN` is the owner API's only credential (Phase 2). Generate it
   with `openssl rand -hex 32` and paste the same value into the iOS app, which
   keeps it in the Keychain. **The service refuses to boot without it** — it
   would otherwise serve the approval and kill-switch endpoints unauthenticated,
   so a crash-loop is the intended failure. If a deploy is restarting with no
   obvious cause, check this variable first.

   The Robinhood credential is **not** a token you can paste from anywhere. The
   MCP speaks OAuth 2.1 + PKCE, and the first token requires a human at
   `robinhood.com/oauth` — which Railway has no way to do. Get the pair locally:

   ```bash
   cd backend && npm run rh:authorize
   ```

   That prints a `client_id` and a refresh token; those two are what the deploy
   carries. The service exchanges the refresh token for an access token on boot
   and whenever one expires. `RH_MCP_AUTH_TOKEN` still works for a one-off manual
   run with a pasted access token, but it expires and cannot renew itself, so it
   is not a deploy credential.

   > **Unresolved:** whether Robinhood rotates refresh tokens on use. If it does,
   > the value in this variable goes stale after the first refresh and the
   > credential has to move to Postgres — an environment variable cannot hold
   > something that changes at runtime. `OAuthStateStore` exists to make that
   > swap a new implementation rather than a rewrite. Watch the first redeploy
   > after a token refresh for an unexpected `401`.

   `PORT` is injected by Railway; do not set it. Leave `LIVE_TRADING_ENABLED`
   false — it is the second of the two gates in front of real money and has no
   use before Phase 5.

4. **Deploy.** The start command runs `prisma migrate deploy` before the
   process boots, so a deploy that includes a migration applies it exactly once
   and fails the release if it cannot.

## Verifying a deploy

```bash
curl https://<service>.up.railway.app/healthz
```

A healthy response reports the database as up and echoes the current safety
flags, which is the fastest way to confirm which mode production is actually in:

```json
{
  "status": "ok",
  "database": "up",
  "killSwitch": false,
  "executionMode": "paper",
  "uptimeSeconds": 42,
  "checkedAt": "2026-08-04T16:55:00.000Z"
}
```

`/healthz` returns 503 when the database is unreachable, which is what the
platform health check keys on.

## Running scripts against the deployed database

`railway run` injects the service's environment into a local shell, which is how
the Phase 0 exit check gets repeated against managed Postgres for parity:

```bash
cd backend
railway run npm run signal:write-test
```

That writes a real, permanent row to production. It is fabricated data that
cannot be deleted — the immutability triggers see to that — so do it once
during setup and mark it in the `thesis` field, which the script already does.

## Operational notes

- **The kill switch has two independent halves.** `app_settings.kill_switch` in
  the database is the runtime one (flip it with SQL now, from the iOS app in
  Phase 2, no redeploy needed). `KILL_SWITCH=true` in the environment is an
  override that requires a redeploy. Either being on stops the pipeline.

  ```sql
  UPDATE app_settings SET kill_switch = true WHERE id = 1;
  ```

- **Cron is interpreted in `America/New_York`** so the schedule tracks market
  hours through daylight saving. Everything persisted is UTC.

- **One replica only.** `croner`'s overlap protection is per-process, so a
  second replica would run the pipeline twice on the same bar. The unique
  `dedupe_key` would keep the duplicate out of the database, but the second
  replica would still burn broker calls doing it.
