import SwiftUI

@main
struct ComputerWatchApp: App {
    @State private var bridge = WatchConversationBridge()

    var body: some Scene {
        WindowGroup {
            WatchRootView(bridge: bridge)
                .task { bridge.start() }
        }
    }
}
