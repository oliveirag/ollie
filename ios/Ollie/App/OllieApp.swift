import SwiftUI

@main
struct OllieApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        #if DEBUG
        TokenStore.seedFromLaunchArgumentsIfNeeded()
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
