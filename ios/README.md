# Ollie — iOS app

SwiftUI, iOS 17+. One binary, two sides that share nothing but the design
system:

- **Owner** (PRD §4.2–4.3): approve or reject proposed trades — with a second,
  red confirmation when the signal is live money — watch positions, flip the
  kill switch, and turn autonomy on or off. Launches when the owner token is in
  the Keychain.
- **Subscriber** (PRD §4.6): Sign in with Apple, the disclaimer, the one-time
  agent token, the feed, and the track record. Talks only to the signal
  service, never to the owner API.

## Subscriber side without the Apple Developer membership

Sign in with Apple needs a paid team and App ID configuration. Until those
exist, Debug builds launched with `SUBSCRIBER_TEST_IDENTITY=1` show a
"Continue with a test identity" button that sends a `fake:` identity token. The
signal service accepts it only when started with `SIWA_STUB=true`, and refuses
to start that way in production.

```bash
# 1. the signal service on :3100, as the restricted role, with the stub on
cd backend
SIGNAL_DATABASE_URL=postgresql://ollie_signal:ollie_signal@localhost:5432/ollie \
SIWA_STUB=true SUBSCRIBER_INVITE_CODES=LOCAL-TEST \
SIGNAL_PUBLIC_URL=http://localhost:3100 npm run dev:signal

# 2. the onboarding UI tests
cd ../ios
export TEST_RUNNER_SUBSCRIBER_INVITE_CODE=LOCAL-TEST
xcodebuild test -project Ollie.xcodeproj -scheme Ollie \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -skipPackagePluginValidation \
  -only-testing:OllieUITests/SubscriberOnboardingUITests
```

The `ollie_signal` role's password is set by `npm test`'s database setup
(roles are cluster-wide, so it applies to the dev database too). The subscriber
client is generated from `docs/openapi-subscriber.yaml` by the local
`SignalAPI` package, through the same symlink arrangement as the owner client.

## Setup

```bash
brew install xcodegen
cd ios && xcodegen        # writes Ollie.xcodeproj
open Ollie.xcodeproj
```

`Ollie.xcodeproj` is **generated and gitignored**. Never edit it directly —
change `project.yml` and re-run `xcodegen`, or the change is lost on the next
generate.

The first build in Xcode prompts to trust the `OpenAPIGenerator` build tool
plugin. Approve it once. From the command line, pass
`-skipPackagePluginValidation` instead.

## The API client is generated, not written

`Ollie/Networking/openapi.yaml` is a **symlink** to `../../../docs/openapi.yaml`.
The Swift client is produced from it at build time by
[swift-openapi-generator](https://github.com/apple/swift-openapi-generator), so
there is no checked-in client to go stale.

The chain has one source of truth and a test at each hop:

```
backend zod route schemas
  └─ npm run openapi:write  ──▶  docs/openapi.yaml   (drift test fails if stale)
                                    └─ symlink ──▶ ios build ──▶ Swift client
```

A backend route change that does not reach `docs/openapi.yaml` fails the
backend's drift test. One that does reach it changes the Swift types on the
next iOS build, so the app fails to compile rather than failing at runtime
against an endpoint that no longer exists.

Do not copy `openapi.yaml` into this directory. A copy is a second source of
truth that nothing guards.

## Auth

Every `/v1` request needs the owner bearer token (`OWNER_API_TOKEN` on the
backend). The app stores it in the Keychain. Phase 2 has exactly one user, so
this stands in for Sign in with Apple; SIWA arrives in Phase 4 with the
subscriber side, where strangers make it earn its place.

## Running the UI tests

They drive the real app against a real backend, so both have to be up, and a
pending signal expires 15 minutes after it is written — seed it immediately
before the run, not before the build:

```bash
# 1. backend on :3000, with a database behind it
docker compose up -d
PORT=3000 npm --prefix ../backend run dev

# 2. compile first, so the expiry window is not spent building
cd ios
export TEST_RUNNER_OWNER_API_TOKEN=$(grep '^OWNER_API_TOKEN=' ../backend/.env | cut -d= -f2)
xcodebuild build-for-testing -project Ollie.xcodeproj -scheme Ollie \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -skipPackagePluginValidation

# 3. seed, then run
npm --prefix ../backend run signal:write-test
xcodebuild test-without-building -project Ollie.xcodeproj -scheme Ollie \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -skipPackagePluginValidation
```

`TEST_RUNNER_OWNER_API_TOKEN` must be **exported**, not passed as an argument —
`xcodebuild KEY=value` sets a build setting, not an environment variable, and
the token would never reach the test.

`ScreenshotUITests` captures each tab as an attachment for reviewing the app
against `docs/design/owner-app-design.html`:

```bash
xcodebuild test ... -only-testing:OllieUITests/ScreenshotUITests -resultBundlePath /tmp/shots.xcresult
xcrun xcresulttool export attachments --path /tmp/shots.xcresult --output-path /tmp/shots
```

## Requirements

Xcode 26+ with an **iOS simulator runtime matching the SDK**. An Xcode install
carrying only an older runtime (e.g. iOS 18.6 alongside the iOS 26.5 SDK) fails
with `iOS <version> is not installed` and a confusing "supported platforms is
empty" message. Fix:

```bash
xcodebuild -downloadPlatform iOS
```

or Xcode → Settings → Components.
