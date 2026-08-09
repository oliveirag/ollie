import SwiftUI

@main
struct OllieApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

/// Placeholder shell. The tab structure, the persistent paper/live banner, and
/// the approvals surface land in 2.5–2.7 against the design in docs/design/.
struct RootView: View {
    var body: some View {
        VStack(spacing: 12) {
            Text("Ollie")
                .font(.largeTitle.weight(.semibold))
            Text("Owner app scaffold")
                .foregroundStyle(.secondary)
        }
    }
}

#Preview {
    RootView()
}
