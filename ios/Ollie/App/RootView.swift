import SwiftUI

struct RootView: View {
    @State private var store = SignalStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if store.token == nil {
                TokenEntryView { token in
                    TokenStore.save(token)
                    store.token = token
                    Task { await store.refresh() }
                }
            } else {
                shell
            }
        }
        .environment(store)
    }

    private var shell: some View {
        TabView {
            ApprovalsView()
                .tabItem { Label("Approvals", systemImage: "tray.full") }

            PlaceholderTab(
                title: "Positions",
                systemImage: "chart.xyaxis.line",
                note: "Open lots and PnL arrive with milestone 2.7."
            )
            .tabItem { Label("Positions", systemImage: "chart.xyaxis.line") }

            PlaceholderTab(
                title: "Controls",
                systemImage: "slider.horizontal.3",
                note: "Kill switch and mode toggle arrive with milestone 2.7."
            )
            .tabItem { Label("Controls", systemImage: "slider.horizontal.3") }
        }
        // The rail is attached once, here, above navigation — not per screen.
        // PRD §4.3 wants the mode unmistakable everywhere, and a per-screen
        // badge is how one screen eventually ships without it.
        .safeAreaInset(edge: .top, spacing: 0) {
            ModeRail(mode: store.mode)
        }
        .tint(store.mode.accent)
        .task { await store.refresh() }
        .onChange(of: scenePhase) { _, phase in
            // Push is best-effort and the app must not depend on it, so
            // returning to the foreground always refetches. A missed
            // notification then costs one expired signal, never a silent one.
            if phase == .active { Task { await store.refresh() } }
        }
    }
}

private struct PlaceholderTab: View {
    let title: String
    let systemImage: String
    let note: String

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label(title, systemImage: systemImage)
            } description: {
                Text(note)
            }
            .navigationTitle(title)
        }
    }
}

/// First launch. The owner token is generated at deploy and pasted in once;
/// there is no account to create because Phase 2 has exactly one user.
struct TokenEntryView: View {
    let onSave: (String) -> Void

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
        }
    }
}
