#!/usr/bin/env bash
# Runs every iOS UI test on the simulator against a throwaway local stack.
#
#   ios/scripts/e2e.sh                # all suites but screenshots
#   ios/scripts/e2e.sh owner          # owner app: paper approval, record, screenshots
#   ios/scripts/e2e.sh live           # owner app: the real-money acknowledgement, on a mock broker
#   ios/scripts/e2e.sh subscriber     # App Store app: onboarding, account deletion
#   SIMULATOR="iPhone 17 Pro Max" ios/scripts/e2e.sh screenshots
#                                     # App Store app: the store screenshots, on a seeded feed
#
# Two apps, two schemes: OllieOwner (owner, TestFlight only) runs the owner and
# live suites; Ollie (the App Store app, subscriber only) runs the rest.
#
# No device, no Developer Mode, nobody at the keyboard. What makes it safe to
# run unattended:
#
# - Its own Postgres cluster, created from scratch in ios/build/e2e/pgdata on
#   port 5433 and deleted afterwards. The immutability triggers make seeded
#   rows permanent, so they never go near the dev database, let alone the
#   real record. Needs only Homebrew's postgresql@16, not Docker.
# - DOTENV_CONFIG_PATH=/dev/null, so backend/.env (Robinhood, Anthropic, APNs)
#   is never loaded. BROKER=mock places nothing anywhere; the backend refuses
#   it in production.
# - Debug builds point at localhost (project.yml), so the app under test
#   cannot reach Railway.
#
# Result bundles, with the screenshot attachments, land in ios/build/e2e/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BACKEND="$ROOT/backend"
IOS="$ROOT/ios"
OUT="$IOS/build/e2e"
SUITE="${1:-all}"

PG_PORT=5433
PG_BIN="$(brew --prefix postgresql@16 2>/dev/null)/bin"
PGDATA="$OUT/pgdata"
# The socket goes in a short temp dir, not PGDATA: a Unix socket path is
# capped at 103 bytes on macOS, and a worktree under ~/Developer blows past it.
# Created in the postgres step, once the cleanup trap is set.
PGSOCK=""
# initdb and postgres refuse to start when the locale is unset, which it is
# under a non-interactive shell.
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
DB_URL="postgresql://ollie:ollie@localhost:$PG_PORT/ollie_e2e"
SIGNAL_DB_URL="postgresql://ollie_signal:ollie_signal@localhost:$PG_PORT/ollie_e2e"
OWNER_TOKEN="$(openssl rand -hex 32)"
INVITE_CODE="E2E-$(openssl rand -hex 4 | tr a-f A-F)"
SIMULATOR="${SIMULATOR:-iPhone 17 Pro}"
# What the service advertises as the MCP URL. The store screenshots show it, so
# that suite advertises the production host instead of localhost.
SIGNAL_PUBLIC_URL=http://localhost:3100
[ "$SUITE" = screenshots ] && SIGNAL_PUBLIC_URL=https://ollie-signal.up.railway.app

log() { printf '\n== %s\n' "$*"; }

case "$SUITE" in
  all|owner|live|subscriber|screenshots) ;;
  *) echo "unknown suite: $SUITE (all, owner, live, subscriber, screenshots)" >&2; exit 2 ;;
esac

[ -x "$PG_BIN/initdb" ] || { echo "needs Homebrew postgresql@16: brew install postgresql@16" >&2; exit 1; }

for port in 3000 3100 "$PG_PORT"; do
  if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is in use; stop whatever is on it first" >&2
    exit 1
  fi
done

mkdir -p "$OUT"
rm -rf "$OUT"/*.xcresult "$OUT"/*.log

cleanup() {
  # npx and tsx each fork, so the listener is a grandchild of the job;
  # killing by port is what actually stops it.
  for port in 3000 3100; do
    lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  done
  if [ -f "$PGDATA/postmaster.pid" ]; then
    "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  fi
  rm -rf "$PGDATA" ${PGSOCK:+"$PGSOCK"}
}
trap cleanup EXIT

# The whole backend environment, stated here instead of inherited from .env.
backend_env() {
  env -i PATH="$PATH" HOME="$HOME" \
    DOTENV_CONFIG_PATH=/dev/null \
    NODE_ENV=development \
    DATABASE_URL="$DB_URL" \
    SIGNAL_DATABASE_URL="$SIGNAL_DB_URL" \
    OWNER_API_TOKEN="$OWNER_TOKEN" \
    BROKER=mock \
    LIVE_TRADING_ENABLED=true \
    SIWA_STUB=true \
    SUBSCRIBER_INVITE_CODES="$INVITE_CODE" \
    SIGNAL_PUBLIC_URL="$SIGNAL_PUBLIC_URL" \
    PIPELINE_CRON='0 0 1 1 *' \
    MARK_CRON='0 0 1 1 *' \
    LOG_LEVEL=warn \
    "$@"
}

wait_for() {
  local url="$1" name="$2"
  for _ in $(seq 1 60); do
    curl -sf "$url" >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "$name did not come up; see $OUT/$name.log" >&2
  tail -20 "$OUT/$name.log" >&2
  exit 1
}

log "postgres"
rm -rf "$PGDATA"
PGSOCK="$(mktemp -d /tmp/ollie-pg.XXXXXX)"
"$PG_BIN/initdb" -D "$PGDATA" -U ollie --pwfile=<(echo ollie) -A scram-sha-256 >"$OUT/initdb.log" 2>&1
"$PG_BIN/pg_ctl" -D "$PGDATA" -o "-p $PG_PORT -k $PGSOCK" -l "$OUT/postgres.log" -w start >/dev/null
(cd "$BACKEND" && backend_env TEST_DATABASE_URL="$DB_URL" SIGNAL_TEST_DATABASE_URL="$SIGNAL_DB_URL" \
  npx tsx scripts/setup-test-db.ts >"$OUT/db-setup.log" 2>&1) \
  || { tail -20 "$OUT/db-setup.log"; exit 1; }

log "servers"
(cd "$BACKEND" && backend_env npx tsx src/index.ts >"$OUT/orchestrator.log" 2>&1) &
(cd "$BACKEND" && backend_env npx tsx src/signal-server/index.ts >"$OUT/signal.log" 2>&1) &
wait_for http://localhost:3000/healthz orchestrator
wait_for http://localhost:3100/healthz signal

log "app build"
cd "$IOS"
# Always regenerate: project.yml is the source of truth, and an existing
# project from an older checkout would build without newly added files.
xcodegen >/dev/null
DEVICE="$(xcrun simctl list devices available | grep -m1 "    $SIMULATOR (" | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"
[ -n "$DEVICE" ] || { echo "no '$SIMULATOR' simulator installed" >&2; exit 1; }
# Booted up front, so the first suite does not pay for the boot inside the
# runner's own startup timeout.
xcrun simctl boot "$DEVICE" 2>/dev/null || true
xcrun simctl bootstatus "$DEVICE" -b >/dev/null

XCODEBUILD=(xcodebuild -project Ollie.xcodeproj
  -destination "id=$DEVICE" -skipPackagePluginValidation)

SCHEMES=()
case "$SUITE" in
  all) SCHEMES=(OllieOwner Ollie) ;;
  owner|live) SCHEMES=(OllieOwner) ;;
  subscriber|screenshots) SCHEMES=(Ollie) ;;
esac
for scheme in "${SCHEMES[@]}"; do
  "${XCODEBUILD[@]}" -scheme "$scheme" build-for-testing -quiet >"$OUT/build-$scheme.log" 2>&1 \
    || { tail -40 "$OUT/build-$scheme.log"; exit 1; }
done

# Each scheme's UI test target.
test_target() { [ "$1" = OllieOwner ] && echo OllieOwnerUITests || echo OllieUITests; }

FAILED=()
run_tests() {
  local name="$1" scheme="$2"; shift 2
  local target
  target="$(test_target "$scheme")"
  local only=()
  for t in "$@"; do only+=("-only-testing:$target/$t"); done
  log "tests: $name"
  local attempt
  for attempt in 1 2; do
    rm -rf "$OUT/$name.xcresult"
    if TEST_RUNNER_OWNER_API_TOKEN="$OWNER_TOKEN" \
       TEST_RUNNER_SUBSCRIBER_INVITE_CODE="$INVITE_CODE" \
       "${XCODEBUILD[@]}" -scheme "$scheme" test-without-building "${only[@]}" \
         -resultBundlePath "$OUT/$name.xcresult" >"$OUT/$name.log" 2>&1; then
      grep -E "Executed [0-9]+ tests?" "$OUT/$name.log" | tail -1 || true
      return 0
    fi
    # A runner that never started says nothing about the app. The simulator
    # sometimes times out loading Accessibility; that earns one retry, a real
    # assertion failure does not.
    grep -q "failed to initialize for UI testing" "$OUT/$name.log" || break
    echo "runner did not start (attempt $attempt)"
  done
  grep -E "error: |failed \(|encountered an error" "$OUT/$name.log" | head -20 || true
  FAILED+=("$name")
}

seed() { (cd "$BACKEND" && backend_env npx tsx "scripts/$1" >>"$OUT/seed.log" 2>&1); }

set_mode() {
  curl -sf -X PUT http://localhost:3000/v1/settings \
    -H "Authorization: Bearer $OWNER_TOKEN" -H 'content-type: application/json' \
    -d "{\"execution_mode\":\"$1\"}" >/dev/null
}

# Live runs first, on an empty database. The record seed leaves a pending
# paper signal behind, and the live test taps the first pending row, so after
# the seed it would open the wrong sheet.
if [ "$SUITE" = all ] || [ "$SUITE" = live ]; then
  set_mode live
  seed write-test-signal.ts
  run_tests live OllieOwner LiveApprovalUITests
  set_mode paper
fi

if [ "$SUITE" = all ] || [ "$SUITE" = owner ]; then
  # Signals expire 15 minutes after they are written, so seed right before.
  seed seed-track-record.ts
  seed write-test-signal.ts
  run_tests owner OllieOwner ApprovalFlowUITests TrackRecordUITests ScreenshotUITests
fi

if [ "$SUITE" = all ] || [ "$SUITE" = subscriber ]; then
  run_tests subscriber Ollie SubscriberOnboardingUITests AccountDeletionUITests
fi

if [ "$SUITE" = screenshots ]; then
  seed seed-published-feed.ts
  # Apple's marketing status bar: 9:41, full signal and battery, no carrier.
  xcrun simctl status_bar "$DEVICE" override --time "9:41" --dataNetwork wifi \
    --wifiMode active --wifiBars 3 --cellularMode active --cellularBars 4 \
    --batteryState discharged --batteryLevel 100 --operatorName "" 2>/dev/null || true
  run_tests screenshots Ollie AppStoreScreenshotUITests
  xcrun simctl status_bar "$DEVICE" clear 2>/dev/null || true
  rm -rf "$OUT/screenshots"
  xcrun xcresulttool export attachments --path "$OUT/screenshots.xcresult" \
    --output-path "$OUT/screenshots" >/dev/null 2>&1 \
    && echo "screenshots in $OUT/screenshots" || echo "attachment export failed; open $OUT/screenshots.xcresult"
fi

log "results in $OUT"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "FAILED: ${FAILED[*]}"
  exit 1
fi
echo "ALL PASSED"
