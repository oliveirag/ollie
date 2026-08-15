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

   > **Two Robinhood quirks are load-bearing here, and both fail silently.**
   > Established by experiment on 2026-08-12, after the flow appeared to do
   > nothing twice. In each case `robinhood.com/oauth` redirects the browser to a
   > Robinhood page with no consent screen and no error, so it reads as a dead
   > link rather than a rejected request.
   >
   > 1. **The redirect host must be the literal `localhost`, not `127.0.0.1`.**
   >    Robinhood's allowlist matches the string. RFC 8252 §8.3 and OAuth 2.1
   >    both *prefer* the loopback IP, so the spec-correct value is the broken
   >    one. Reported elsewhere as a 403 `Mismatching Redirect URI`.
   > 2. **The `state` parameter is required**, whatever the RFC says about it
   >    being RECOMMENDED. The MCP SDK omits it unless asked.
   >
   > Registration cannot help with either: three POSTs with different client
   > metadata all return the same pre-provisioned `client_id` named "Robinhood
   > Trading", with the submitted `redirect_uris` echoed back but ignored. The
   > allowlist is fixed and shared, so matching it is the only option.

   > **Resolved 2026-08-14: Robinhood does rotate refresh tokens on use, and the
   > credential now lives in Postgres.** The first unattended run died with
   > `InvalidGrantError` — the token in this variable had already been
   > invalidated by an earlier refresh elsewhere, and nothing in the running
   > service could write the replacement back.
   >
   > `RH_OAUTH_REFRESH_TOKEN` is now only a **seed**. On first boot
   > `bootstrapOAuthState` copies it into the `oauth_state` table if that table
   > is empty, and every refresh after that reads and writes the database. The
   > environment value goes stale immediately and that is fine — bootstrap
   > refuses to overwrite a stored token, because the environment holds whatever
   > was pasted at deploy time while the database holds what the server last
   > issued.
   >
   > Consequence worth knowing: re-running `npm run rh:authorize` and pasting a
   > new value into Railway does nothing on its own once the table is populated.
   > A genuinely dead credential has to be cleared from `oauth_state` first.

   `PORT` is injected by Railway; do not set it. Leave `LIVE_TRADING_ENABLED`
   false — it is the second of the two gates in front of real money and has no
   use before Phase 5.

   The four `APNS_*` variables are optional. With any of them missing the
   notifier is a no-op and signals are simply not pushed — push is best-effort
   and the app refetches on foreground, so a partial configuration degrades
   instead of failing. They need a paid Apple Developer Program membership.

4. **Deploy.** The start command runs `prisma migrate deploy` before the
   process boots, so a deploy that includes a migration applies it exactly once
   and fails the release if it cannot.


## Clearing the record before it starts

The record tables refuse `TRUNCATE` as of the `reject_truncate` migration, which
closes the last way to erase history: the Phase 0 triggers are row-level and
fire on UPDATE and DELETE, so before this a `TRUNCATE` wiped the whole record in
one statement while every "immutable" guarantee looked intact.

**Order matters.** The migration ships with the deploy, so a clean slate is far
easier before that deploy than after:

```bash
# Before deploying the trigger — an ordinary truncate still works.
railway run psql $DATABASE_URL \
  -c 'TRUNCATE track_record, executions, signal_events, signals RESTART IDENTITY CASCADE'
```

Afterwards it takes a deliberate bypass, which is the intended friction rather
than an obstacle to work around casually:

```bash
railway run psql $DATABASE_URL \
  -c "SET session_replication_role = 'replica';
      TRUNCATE track_record, executions, signal_events, signals RESTART IDENTITY CASCADE;
      SET session_replication_role = 'origin';"
```

Once the sustained run begins, neither should ever be used again — at that point
they are not a clean slate, they are editing the published record.

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
  "killSwitchEnv": false,
  "killSwitchDb": false,
  "executionMode": "paper",
  "uptimeSeconds": 42,
  "checkedAt": "2026-08-04T16:55:00.000Z"
}
```

`killSwitch` is the effective answer — true when *either* half is on, so it
matches what the pipeline actually does. The two halves are reported separately
because clearing them differs: `killSwitchEnv` needs a redeploy, `killSwitchDb`
is one API call from the iOS app. `killSwitchEnv` is read from config rather
than the database, so it stays truthful in the degraded response too.

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
