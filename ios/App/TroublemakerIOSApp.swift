import SwiftUI

@main
struct TroublemakerIOSApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
                .onOpenURL { url in
                    // OAuth callback URLs (tfat://oauth-callback?code=...) are consumed
                    // inside ASWebAuthenticationSession's completion handler — this
                    // hook exists so deep-links from other sources (e.g. push
                    // notifications opening a specific agent) have a place to land.
                    NotificationCenter.default.post(name: .tfatDeepLink, object: url)
                }
        }
    }
}

extension Notification.Name {
    static let tfatDeepLink = Notification.Name("com.tinyfatco.troublemaker.deepLink")
}
