import OpenAPIRuntime
import SwiftUI
import UIKit
import UserNotifications

/// Gets this device's APNs token to the backend, and tells the owner shell when
/// a push arrives so it can refetch.
///
/// Owner side only. The orchestrator pushes new signals to the owner's devices;
/// subscribers read the feed through their agent and are never asked for
/// notification permission.
///
/// Push stays best-effort, as it is on the backend: every failure here is
/// logged and swallowed, and the foreground refetch in `RootView` covers
/// whatever push misses.
@MainActor
@Observable
final class PushRegistrar {
    static let shared = PushRegistrar()

    /// Bumped whenever a notification is shown in the foreground or tapped.
    /// `RootView` refetches on change.
    private(set) var lastPushAt: Date?

    private var ownerToken: String?
    private var deviceToken: String?

    private init() {}

    /// Ask for permission (the system shows the prompt once, ever) and register
    /// with APNs. Called on every launch of the owner shell: APNs can hand out
    /// a new token at any time, and `POST /v1/devices` is idempotent.
    func enable(ownerToken: String?) async {
        guard let ownerToken, !ownerToken.isEmpty else { return }
        #if DEBUG
        // UI tests set this so the permission alert cannot sit on top of the
        // screen they are driving.
        if ProcessInfo.processInfo.environment["OLLIE_DISABLE_PUSH"] == "1" { return }
        #endif
        self.ownerToken = ownerToken

        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            guard granted else { return }
            UIApplication.shared.registerForRemoteNotifications()
        } catch {
            print("[push] authorization failed: \(error)")
        }

        // A token that arrived before the owner token existed (first launch,
        // token pasted afterwards) is sent now instead of waiting a launch.
        if let deviceToken { await upload(deviceToken) }
    }

    func didRegister(deviceToken data: Data) async {
        let token = data.map { String(format: "%02x", $0) }.joined()
        deviceToken = token
        await upload(token)
    }

    func didReceivePush() {
        lastPushAt = Date()
    }

    private func upload(_ token: String) async {
        guard let ownerToken else { return }
        let body = Components.Schemas.DeviceRegistrationInput(
            apns_token: token,
            environment: ApnsEnvironment.current
        )
        do {
            let output = try await OllieAPI.client(token: ownerToken)
                .registerDevice(.init(body: .json(body)))
            if case .ok = output { return }
            print("[push] device registration returned \(output)")
        } catch {
            print("[push] device registration failed: \(error)")
        }
    }
}

/// Which APNs host this build's tokens belong to.
///
/// Decided by the provisioning profile, not the build configuration: a Release
/// build run from Xcode is still development-signed and gets a sandbox token,
/// while TestFlight and App Store builds get production tokens. Sending a token
/// to the wrong host fails with `BadDeviceToken`, and the backend prunes the
/// row, so guessing from `#if DEBUG` would silently drop a device.
enum ApnsEnvironment {
    typealias Value = Components.Schemas.DeviceRegistrationInput.environmentPayload

    static let current: Value = {
        #if targetEnvironment(simulator)
        return .sandbox
        #else
        // App Store builds carry no embedded profile at all.
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let raw = try? Data(contentsOf: url),
              let text = String(data: raw, encoding: .isoLatin1),
              let start = text.range(of: "<?xml"),
              let end = text.range(of: "</plist>"),
              let plistData = String(text[start.lowerBound..<end.upperBound]).data(using: .isoLatin1),
              let plist = try? PropertyListSerialization.propertyList(from: plistData, format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              let aps = entitlements["aps-environment"] as? String
        else { return .production }
        return aps == "development" ? .sandbox : .production
        #endif
    }()
}

/// UIKit entry points for APNs, which SwiftUI has no equivalent for.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await PushRegistrar.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        print("[push] APNs registration failed: \(error)")
    }

    /// Show the banner even with the app open: a signal has a short window, and
    /// the owner may be looking at a different tab when it lands.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        await PushRegistrar.shared.didReceivePush()
        return [.banner, .list, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        await PushRegistrar.shared.didReceivePush()
    }
}
