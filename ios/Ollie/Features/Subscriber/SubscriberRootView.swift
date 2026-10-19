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
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(DS.Surface.page)
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
        // The disclaimer's one-line reminder, attached once above navigation
        // for the same reason the owner's mode rail is: a per-screen line is
        // how one screen eventually ships without it. Stacked above the
        // TabView, not inset into it, so no navigation bar slides under it.
        VStack(spacing: 0) {
            DisclaimerRail()

            TabView {
                FeedView()
                    .tabItem { Label("Feed", systemImage: "list.bullet.rectangle") }

                SubscriberRecordView()
                    .tabItem { Label("Record", systemImage: "chart.line.uptrend.xyaxis") }

                SubscriberSettingsView()
                    .tabItem { Label("Agent", systemImage: "key") }
            }
        }
        .tint(DS.Text.action)
        // Onboarding only loads what onboarding needs. Arriving at the shell,
        // after the handoff or on a relaunch, is when the feed and record load.
        .task { await store.refresh() }
    }
}

/// The persistent reminder (Phase 4, milestone 4.6). Never scrolls, never
/// animates, says one thing. Wraps rather than shrinking past legibility at
/// large text sizes.
struct DisclaimerRail: View {
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: DS.Space.sm) {
            Image(systemName: "info.circle")
                .font(.system(size: 11, weight: .semibold))
            Text("Not advice. Same signals for everyone. Your agent decides.")
                .dsFont(.caption)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(DS.Text.secondary)
        .padding(.horizontal, DS.pageMargin)
        .padding(.vertical, DS.Space.xs)
        .frame(maxWidth: .infinity, minHeight: 24)
        .background {
            ZStack(alignment: .bottom) {
                DS.Surface.default
                Rectangle().fill(DS.Border.default).frame(height: 1)
            }
            .ignoresSafeArea(edges: .top)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Not financial advice. The same signals for everyone. Your agent decides.")
        .accessibilityIdentifier("disclaimer-rail")
    }
}
