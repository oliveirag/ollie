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
   RH_MCP_AUTH_TOKEN=…
   SYMBOL_ALLOWLIST=AAPL,MSFT,SPY
   PIPELINE_CRON=35 9 * * 1-5
   KILL_SWITCH=false
   LIVE_TRADING_ENABLED=false
   NODE_ENV=production
   ```

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
