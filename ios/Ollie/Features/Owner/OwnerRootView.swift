import SwiftUI

/// The owner app (the OllieOwner target, distributed through TestFlight only).
///
/// The owner's pre-shared token in the Keychain means the owner shell;
/// otherwise the token entry screen, since the owner side has one user and no
/// account to create. Kept out of the App Store build entirely: approving
/// trades on a brokerage account is not something that app does.
struct OwnerRootView: View {
    @State private var owner = SignalStore()
    @Environment(\.scenePhase) private var scenePhase
    private let push = PushRegistrar.shared

    var body: some View {
        Group {
            if owner.token != nil {
                ownerShell
            } else {
                TokenEntryView(onSave: { token in
                    TokenStore.save(token)
                    owner.token = token
                    Task { await owner.refresh() }
                })
            }
        }
        .environment(owner)
        // Disconnect in Controls clears the token, which lands back on token
        // entry, and stops this device getting the owner's pushes until a
        // token is pasted again.
        .onChange(of: owner.token) { _, token in
            if token == nil { push.disable() }
        }
    }

    private var ownerShell: some View {
        // The rail sits above the TabView in a stack rather than in a safe
        // area inset on it: an inset on the TabView let pushed screens lay
        // their navigation bar underneath the rail, hiding the back button.
        // Still attached once, here, above navigation. PRD §4.3 wants the mode
        // unmistakable everywhere, and a per-screen badge is how one screen
        // eventually ships without it.
        VStack(spacing: 0) {
            ModeRail(mode: owner.mode)

            TabView {
                ApprovalsView()
                    .tabItem { Label("Approvals", systemImage: "tray.full") }

                DashboardView()
                    .tabItem { Label("Positions", systemImage: "chart.bar.xaxis") }

                TrackRecordView()
                    .tabItem { Label("Record", systemImage: "chart.line.uptrend.xyaxis") }

                ControlsView()
                    .tabItem { Label("Controls", systemImage: "slider.horizontal.3") }
            }
        }
        .tint(DS.Text.action)
        .task { await owner.refresh() }
        // Keyed on the token so pasting it on first launch registers the
        // device then, not on the next launch.
        .task(id: owner.token) { await push.enable(ownerToken: owner.token) }
        .onChange(of: push.lastPushAt) { Task { await owner.refresh() } }
        .onChange(of: scenePhase) { _, phase in
            // Push is best-effort and the app must not depend on it, so
            // returning to the foreground always refetches. A missed
            // notification then costs one expired signal, never a silent one.
            if phase == .active { Task { await owner.refresh() } }
        }
    }
}

/// The owner's first launch. The token is generated at deploy and pasted in
/// once; there is no account to create because the owner side has one user.
struct TokenEntryView: View {
    let onSave: (String) -> Void
    var onBack: (() -> Void)? = nil

    @State private var token = ""

    private var isPlausible: Bool {
        token.trimmingCharacters(in: .whitespacesAndNewlines).count >= 32
    }

    var body: some View {
        NavigationStack {
            DSPage {
                DSTextField(
                    label: "Owner API token",
                    placeholder: "Paste the token",
                    text: $token,
                    secure: true,
                    helper: "The value of OWNER_API_TOKEN on your backend. It is stored in the "
                        + "Keychain on this device only and never leaves it except as a bearer "
                        + "header to \(OllieServer.baseURL.absoluteString)."
                )
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

                Button("Save") { onSave(token) }
                    .buttonStyle(.ds(.primary))
                    .disabled(!isPlausible)
            }
            .navigationTitle("Connect to Ollie")
            .toolbar {
                if let onBack {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Back", action: onBack)
                    }
                }
            }
        }
    }
}
