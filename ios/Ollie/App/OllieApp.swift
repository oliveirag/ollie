import SwiftUI

@main
struct OllieApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        #if DEBUG
        TokenStore.seedFromLaunchArgumentsIfNeeded()
        #endif
        DSAppearance.apply()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
