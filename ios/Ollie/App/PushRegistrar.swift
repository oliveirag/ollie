import OpenAPIRuntime
import SwiftUI
import UIKit
import UserNotifications

/// Gets this device's APNs token to the backend, and tells the owner shell when
/// a push arrives so it can refetch.
///
/// Owner side only. The orchestrator pushes new signals to the owner's devices,
/// and one reminder before each expires;
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
            // Disconnect may have landed while the prompt was up.
            guard granted, self.ownerToken == ownerToken else { return }
            UIApplication.shared.registerForRemoteNotifications()
        } catch {
            print("[push] authorization failed: \(error)")
        }

        // A token that arrived before the owner token existed (first launch,
        // token pasted afterwards) is sent now instead of waiting a launch.
        if let deviceToken { await upload(deviceToken) }
    }

    /// Disconnect. Forgets the owner token this device registered with, so a
    /// later APNs token rotation is not uploaded under it, and stops this
    /// device getting the owner's signals.
    ///
    /// Two ways, because either can fail alone. The backend is asked to drop
    /// the row, authenticated with the token being dropped, which fails with
    /// a 401 when that token was rotated (the usual reason to disconnect). So
    /// the device also unregisters from APNs: the backend's next push to the
    /// old token comes back unregistered and `notify.ts` prunes the row.
    /// Connecting again registers afresh and gets a new token.
    func disable() {
        let ownerToken = self.ownerToken
        let deviceToken = self.deviceToken
        self.ownerToken = nil
        self.deviceToken = nil

        if UIApplication.shared.isRegisteredForRemoteNotifications {
            UIApplication.shared.unregisterForRemoteNotifications()
        }
        guard let ownerToken, let deviceToken else { return }
        Task { await unregister(deviceToken, ownerToken: ownerToken) }
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

    private func unregister(_ token: String, ownerToken: String) async {
        let body = Components.Schemas.DeviceUnregistrationInput(apns_token: token)
        do {
            let output = try await OllieAPI.client(token: ownerToken)
                .unregisterDevice(.init(body: .json(body)))
            if case .noContent = output { return }
            print("[push] device unregistration returned \(output)")
        } catch {
            print("[push] device unregistration failed: \(error)")
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
        // At every launch, before any notification can be delivered, so the
        // approve and decline buttons exist even on a launch an action caused.
        SignalNotificationActions.register()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await PushRegistrar.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        print("[push] APNs registration failed: \(error)")
    }

    /// Show the banner even with the app open: the owner may be looking at a
    /// different tab when a signal or its reminder lands.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        PushRegistrar.shared.didReceivePush()
        return [.banner, .list, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        switch response.actionIdentifier {
        case SignalNotificationActions.approve:
            await SignalNotificationActions.decide(userInfo: userInfo, approve: true)
        case SignalNotificationActions.decline:
            await SignalNotificationActions.decide(userInfo: userInfo, approve: false)
        default:
            break
        }
        PushRegistrar.shared.didReceivePush()
    }
}

/// Approve and decline straight from a signal's notification, without opening
/// the app. The categories match `PUSH_CATEGORY` in the backend's notify.ts.
///
/// Paper signals get both buttons. Live signals get decline only: approving
/// one places a real order and needs the decision sheet's second tap
/// (`confirm_live`), which a lock-screen button is not. Both actions require
/// an unlocked device, so a phone left on a desk cannot trade.
///
/// A failure is reported with a local notification, because the owner tapped
/// a button and left: a silently refused approval would read as a trade taken.
/// Success needs no message; the approvals list shows it on the next open.
enum SignalNotificationActions {
    static let approve = "SIGNAL_APPROVE"
    static let decline = "SIGNAL_DECLINE"
    static let paperCategory = "SIGNAL_DECISION"
    static let liveCategory = "SIGNAL_DECISION_LIVE"

    static func register() {
        let approveAction = UNNotificationAction(
            identifier: approve,
            title: "Approve",
            options: [.authenticationRequired],
            icon: UNNotificationActionIcon(systemImageName: "checkmark")
        )
        let declineAction = UNNotificationAction(
            identifier: decline,
            title: "Decline",
            options: [.authenticationRequired, .destructive],
            icon: UNNotificationActionIcon(systemImageName: "xmark")
        )
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: paperCategory, actions: [approveAction, declineAction], intentIdentifiers: []),
            UNNotificationCategory(identifier: liveCategory, actions: [declineAction], intentIdentifiers: []),
        ])
    }

    @MainActor
    static func decide(userInfo: [AnyHashable: Any], approve: Bool) async {
        guard let id = userInfo["signal_id"] as? String else { return }
        let label = Self.label(userInfo)

        // The live category has no approve button; this holds even if a stale
        // registration or a hand-built payload offers one.
        if approve, userInfo["execution_mode"] as? String == "live" {
            await report("Live signals are approved in the app.", title: "Open Ollie to approve \(label)", id: id)
            return
        }
        guard let token = TokenStore.read(), !token.isEmpty else {
            await report(OllieError.unauthorized.localizedDescription, title: failureTitle(approve, label), id: id)
            return
        }

        let body = Components.Schemas.DecisionRequestInput(
            action: approve ? .approve : .reject,
            reason: approve ? "approved from the notification" : "declined from the notification",
            confirm_live: nil
        )
        let message: String
        do {
            let output = try await OllieAPI.client(token: token)
                .decideSignal(.init(path: .init(id: id), body: .json(body)))
            switch output {
            case .ok:
                return
            case .conflict(let conflict):
                let payload = try? conflict.body.json
                if let status = payload?.status {
                    message = "Already \(status.rawValue)."
                } else {
                    message = payload?.detail ?? "Refused by the server."
                }
            case .internalServerError(let failure):
                message = (try? failure.body.json.detail) ?? "Approved, but not filled."
            case .notFound:
                message = OllieError.notFound.localizedDescription
            case .unauthorized:
                message = OllieError.unauthorized.localizedDescription
            case .badRequest:
                message = "The decision failed validation."
            case .undocumented(let status, _):
                message = "The server returned \(status)."
            }
        } catch {
            message = OllieError.fromTransport(error, host: OllieServer.baseURL).localizedDescription
        }
        await report(message, title: failureTitle(approve, label), id: id)
    }

    private static func label(_ userInfo: [AnyHashable: Any]) -> String {
        let side = (userInfo["side"] as? String) == "sell" ? "Sell" : "Buy"
        return "\(side) \(userInfo["symbol"] as? String ?? "signal")"
    }

    private static func failureTitle(_ approve: Bool, _ label: String) -> String {
        approve ? "Couldn't approve \(label)" : "Couldn't decline \(label)"
    }

    private static func report(_ message: String, title: String, id: String) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = message
        content.sound = .default
        // Same id as the signal's push, so it replaces that banner instead of
        // stacking next to it.
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
}
