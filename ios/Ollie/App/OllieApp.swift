import SwiftUI

@main
struct OllieApp: App {
    #if OWNER_CONSOLE
    // Push is the owner's: a signal's approval window is 15 minutes. The App
    // Store app registers for nothing.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif

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
