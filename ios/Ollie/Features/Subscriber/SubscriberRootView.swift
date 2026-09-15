import SwiftUI

/// The subscriber flow, driven by `SubscriberStore.phase` — which is derived
/// from what the service says exists in rows, not from anything remembered on
/// the device. Sign in, read and accept the disclaimer, receive the agent
/// token once, then the feed and the record.
struct SubscriberRootView: View {
    let onLeave: () -> Void

    @Environment(SubscriberStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch store.phase {
            case .signedOut:
                SubscriberSignInView(onBack: onLeave)
            case .loading:
                ProgressView()
                    .task { await store.refresh() }
            case .disclaimer:
                DisclaimerView()
            case .handoff:
                TokenHandoffView()
            case .ready:
                shell
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, store.token != nil { Task { await store.refresh() } }
        }
    }

    private var shell: some View {
        TabView {
            FeedView()
                .tabItem { Label("Feed", systemImage: "list.bullet.rectangle") }

            SubscriberRecordView()
                .tabItem { Label("Record", systemImage: "chart.line.uptrend.xyaxis") }

            SubscriberSettingsView()
                .tabItem { Label("Agent", systemImage: "key") }
        }
        // The disclaimer's one-line reminder, attached once above navigation
        // for the same reason the owner's mode rail is: a per-screen line is
        // how one screen eventually ships without it.
        .safeAreaInset(edge: .top, spacing: 0) {
            DisclaimerRail()
        }
        // Onboarding only loads what onboarding needs. Arriving at the shell —
        // after the handoff, or on a relaunch — is when the feed and record load.
        .task { await store.refresh() }
    }
}

/// The persistent reminder (Phase 4, milestone 4.6). Never scrolls, never
/// animates, says one thing.
struct DisclaimerRail: View {
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "info.circle")
                .font(.system(size: 10, weight: .bold))
            Text("NOT ADVICE · SAME SIGNALS FOR EVERYONE · YOUR AGENT DECIDES")
                .font(.system(size: 10, weight: .bold))
                .kerning(0.6)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
        .frame(height: 22)
        .background(Theme.hairline)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Not financial advice. The same signals for everyone. Your agent decides.")
        .accessibilityIdentifier("disclaimer-rail")
    }
}
