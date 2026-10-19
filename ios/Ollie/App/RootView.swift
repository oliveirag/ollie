import SwiftUI

/// Which side of the wall this launch is on.
///
/// The owner's pre-shared token in the Keychain means the owner shell,
/// unchanged from Phase 2. Otherwise the subscriber flow: signed in already, or
/// the welcome screen that leads there. The two sides share a binary and
/// nothing else — different servers, different tokens, different stores.
struct RootView: View {
    @State private var owner = SignalStore()
    @State private var subscriber = SubscriberStore()
    @State private var route: Route = .undecided
    @Environment(\.scenePhase) private var scenePhase
    private let push = PushRegistrar.shared

    private enum Route { case undecided, owner, subscriber }

    var body: some View {
        Group {
            if owner.token != nil {
                ownerShell
            } else if subscriber.token != nil || route == .subscriber {
                SubscriberRootView(onLeave: { route = .undecided })
                    .environment(subscriber)
            } else if route == .owner {
                TokenEntryView(
                    onSave: { token in
                        TokenStore.save(token)
                        owner.token = token
                        Task { await owner.refresh() }
                    },
                    onBack: { route = .undecided }
                )
            } else {
                WelcomeView(
                    onSubscribe: { route = .subscriber },
                    onOwner: { route = .owner }
                )
            }
        }
        .environment(owner)
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

/// First launch, before either side is chosen. Subscribing is the primary
/// action; running Ollie is the one person who already has a token.
struct WelcomeView: View {
    let onSubscribe: () -> Void
    let onOwner: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer()

            VStack(alignment: .leading, spacing: DS.Space.lg) {
                Image(systemName: "waveform.path.ecg")
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(DS.Icon.primary)
                    .frame(width: 56, height: 56)
                    .background(DS.Surface.default, in: RoundedRectangle(cornerRadius: DS.Radius.lg, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: DS.Radius.lg, style: .continuous)
                            .strokeBorder(DS.Border.strong, lineWidth: DS.BorderWidth.sm)
                    }
                    .accessibilityHidden(true)

                Text("Ollie")
                    .dsFont(.display)
                    .foregroundStyle(DS.Text.primary)

                Text("A public record of one rule-based strategy's signals, published only after they were acted on. Your agent decides what to do with them.")
                    .dsFont(.body)
                    .foregroundStyle(DS.Text.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer()

            VStack(spacing: DS.Space.sm) {
                Button("Subscribe", action: onSubscribe)
                    .buttonStyle(.ds(.primary, size: .large))
                    .accessibilityIdentifier("welcome.subscribe")

                Button("I run Ollie", action: onOwner)
                    .buttonStyle(.ds(.ghost))
                    .accessibilityIdentifier("welcome.owner")
            }
        }
        .padding(.horizontal, DS.Space.xxl)
        .padding(.bottom, DS.Space.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DS.Surface.page)
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
