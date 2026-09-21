#if DEBUG
import Foundation

extension TokenStore {
    /// Seed the Keychain from a launch argument, for development only.
    ///
    ///     xcrun simctl launch <device> com.guilhermeoliveira.Ollie \
    ///         -OwnerAPIToken "$(grep ^OWNER_API_TOKEN backend/.env | cut -d= -f2)"
    ///
    /// The alternative is hand-typing a 64-character secret into a simulator
    /// every time its data is reset, which is enough friction that the
    /// approval flow stops being exercised. `UserDefaults` picks up
    /// `-key value` launch arguments automatically.
    ///
    /// Compiled out of release builds entirely: this reads a trade-approving
    /// credential from an unauthenticated local channel, which is fine on a
    /// simulator you already control and unacceptable anywhere else.
    /// Also reads `OWNER_API_TOKEN` from the environment, which is how a UI
    /// test supplies it: `xcodebuild test TEST_RUNNER_OWNER_API_TOKEN=…`
    /// forwards the variable to the app under test with the prefix stripped.
    static func seedFromLaunchArgumentsIfNeeded() {
        // `RESET_SUBSCRIBER=1` starts the subscriber side signed out, so the
        // onboarding UI test begins from the welcome screen on every run
        // rather than wherever the last run left the Keychain.
        if ProcessInfo.processInfo.environment["RESET_SUBSCRIBER"] == "1" {
            delete(.subscriber)
            delete(.owner)
        }

        let candidate = UserDefaults.standard.string(forKey: "OwnerAPIToken")
            ?? ProcessInfo.processInfo.environment["OWNER_API_TOKEN"]

        guard let token = candidate,
              !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return }

        save(token)
    }

    /// Whether the Debug-only "test identity" sign-in is offered. Sign in with
    /// Apple needs a paid Apple Developer team and per-app configuration the
    /// simulator does not have (Phase 4, risk 3); the backend accepts the
    /// stand-in only with `SIWA_STUB=true`, which it refuses in production.
    static var testIdentityEnabled: Bool {
        ProcessInfo.processInfo.environment["SUBSCRIBER_TEST_IDENTITY"] == "1"
    }
}
#endif
