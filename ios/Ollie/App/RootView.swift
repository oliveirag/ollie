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
        TabView {
            ApprovalsView()
                .tabItem { Label("Approvals", systemImage: "tray.full") }

            DashboardView()
                .tabItem { Label("Positions", systemImage: "chart.xyaxis.line") }

            TrackRecordView()
                .tabItem { Label("Record", systemImage: "chart.line.uptrend.xyaxis") }

            ControlsView()
                .tabItem { Label("Controls", systemImage: "slider.horizontal.3") }
        }
        // The rail is attached once, here, above navigation — not per screen.
        // PRD §4.3 wants the mode unmistakable everywhere, and a per-screen
        // badge is how one screen eventually ships without it.
        .safeAreaInset(edge: .top, spacing: 0) {
            ModeRail(mode: owner.mode)
        }
        .tint(owner.mode.accent)
        .task { await owner.refresh() }
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
        VStack(spacing: 28) {
            Spacer()

            VStack(spacing: 8) {
                Image(systemName: "waveform.path.ecg")
                    .font(.system(size: 44, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text("Ollie").font(.system(size: 34, weight: .bold))
                Text("A public record of one rule-based strategy's signals, published only after they were acted on. Your agent decides what to do with them.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
            }

            Spacer()

            VStack(spacing: 12) {
                Button(action: onSubscribe) {
                    Text("Subscribe")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("welcome.subscribe")

                Button("I run Ollie", action: onOwner)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("welcome.owner")
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
    }
}

/// The owner's first launch. The token is generated at deploy and pasted in
/// once; there is no account to create because the owner side has one user.
struct TokenEntryView: View {
    let onSave: (String) -> Void
    var onBack: (() -> Void)? = nil

    @State private var token = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Owner API token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Connect to Ollie")
                } footer: {
                    Text("The value of OWNER_API_TOKEN on your backend. It is stored in the "
                         + "Keychain on this device only and never leaves it except as a bearer "
                         + "header to \(OllieServer.baseURL.absoluteString).")
                }

                Section {
                    Button("Save") { onSave(token) }
                        .disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).count < 32)
                }
            }
            .navigationTitle("Ollie")
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
