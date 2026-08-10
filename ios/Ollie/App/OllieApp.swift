import SwiftUI

@main
struct OllieApp: App {
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
