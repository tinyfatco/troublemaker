import SwiftUI
#if canImport(WebKit)
import WebKit
#endif

/// Live preview of the agent's generated UI. Loads `/agents/{id}/` on the
/// crawdad host with the OAuth bearer attached on the initial request.
/// The web UI bundle and any agent-served files render inside WKWebView.
public struct PreviewView: View {
    let viewModel: AppViewModel
    let agent: Agent
    @State private var token: String?
    @State private var error: String?

    public init(viewModel: AppViewModel, agent: Agent) {
        self.viewModel = viewModel
        self.agent = agent
    }

    public var body: some View {
        Group {
            #if canImport(WebKit) && os(iOS)
            if let token, let url = URL(string: viewModel.oauth.issuer.absoluteString + "/agents/\(agent.id)/") {
                AgentWebView(url: url, bearerToken: token)
                    .ignoresSafeArea(edges: .bottom)
            } else if let error {
                ContentUnavailableView("Preview unavailable", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView().task { await loadToken() }
            }
            #else
            ContentUnavailableView("Preview is iOS-only", systemImage: "rectangle.dashed")
            #endif
        }
    }

    private func loadToken() async {
        guard let api = viewModel.api else { return }
        do {
            token = try await api.currentBearerToken()
        } catch {
            self.error = String(describing: error)
        }
    }
}

#if canImport(WebKit) && os(iOS)
struct AgentWebView: UIViewRepresentable {
    let url: URL
    let bearerToken: String

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView()
        webView.allowsBackForwardNavigationGestures = true
        var req = URLRequest(url: url)
        req.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        webView.load(req)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
#endif
