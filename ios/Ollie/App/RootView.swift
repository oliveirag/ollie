import SwiftUI

/// One codebase, two apps. The App Store target (Ollie) is the subscriber
/// feed and nothing else. The owner target (OllieOwner, TestFlight only) is
/// compiled with OWNER_CONSOLE and is the owner console and nothing else. The
/// two share design system and networking plumbing, never a server, a token,
/// or a store.
struct RootView: View {
    var body: some View {
        #if OWNER_CONSOLE
        OwnerRootView()
        #else
        SubscriberEntryView()
        #endif
    }
}

#if !OWNER_CONSOLE
/// Signed in already, or the welcome screen that leads there.
struct SubscriberEntryView: View {
    @State private var subscriber = SubscriberStore()
    @State private var started = false

    var body: some View {
        Group {
            if subscriber.token != nil || started {
                SubscriberRootView(onLeave: { started = false })
            } else {
                WelcomeView(onSubscribe: { started = true })
            }
        }
        .environment(subscriber)
        // Signing out or deleting the account clears the token; land on the
        // welcome screen, not on a sign-in form nobody asked for.
        .onChange(of: subscriber.token) { _, token in
            if token == nil { started = false }
        }
    }
}
#endif

/// First launch, before signing in.
struct WelcomeView: View {
    let onSubscribe: () -> Void

    /// Grows with Dynamic Type like the display title it replaced.
    @ScaledMetric(relativeTo: .largeTitle) private var lockupHeight: CGFloat = 48

    var body: some View {
        // Scrolls once the largest text sizes push the buttons past the
        // screen; until then the spacers hold the hero centred and the
        // buttons at the bottom, exactly as a fixed layout would.
        GeometryReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: DS.Space.xxxl) {
                    Spacer(minLength: 0)

                    VStack(alignment: .leading, spacing: DS.Space.lg) {
                        // The horizontal lockup, vector, with the reversed
                        // colours in dark mode (asset catalog appearance).
                        Image("OllieLockup")
                            .resizable()
                            .scaledToFit()
                            .frame(height: lockupHeight)
                            .accessibilityLabel("Ollie")
                            .accessibilityAddTraits(.isHeader)

                        Text("A public record of one rule-based strategy's signals, published only after they were acted on. Your agent decides what to do with them.")
                            .dsFont(.body)
                            .foregroundStyle(DS.Text.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Spacer(minLength: 0)

                    Button("Subscribe", action: onSubscribe)
                        .buttonStyle(.ds(.primary, size: .large))
                        .accessibilityIdentifier("welcome.subscribe")
                }
                .padding(.horizontal, DS.Space.xxl)
                .padding(.bottom, DS.Space.lg)
                .frame(maxWidth: .infinity, minHeight: proxy.size.height, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(DS.Surface.page)
    }
}
