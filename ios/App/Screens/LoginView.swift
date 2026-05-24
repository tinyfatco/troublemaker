import SwiftUI
#if canImport(AuthenticationServices)
import AuthenticationServices
#endif

public struct LoginView: View {
    let viewModel: AppViewModel
    @State private var error: String?
    @State private var inFlight = false

    public init(viewModel: AppViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Text("Troublemaker")
                .font(.largeTitle.weight(.bold))
            Text("Mom, liberated.")
                .foregroundStyle(.secondary)
            Spacer()
            Button(action: signIn) {
                Text(inFlight ? "Signing in…" : "Sign in to tinyfat.com")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(inFlight)
            if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            Spacer()
        }
        .padding(24)
    }

    private func signIn() {
        #if canImport(AuthenticationServices) && os(iOS)
        inFlight = true
        error = nil
        Task {
            do {
                let pkce = OAuthClient.PKCE()
                let state = UUID().uuidString
                let clientID = try await viewModel.oauth.registerClient()
                let authURL = viewModel.oauth.authorizeURL(clientID: clientID, pkce: pkce, state: state)
                let scheme = URL(string: viewModel.oauth.redirectURI)!.scheme!
                let callback = try await ASWebAuthenticationSession.start(url: authURL, callbackURLScheme: scheme)
                let code = try viewModel.oauth.authorizationCode(from: callback, expectedState: state)
                let tokens = try await viewModel.oauth.exchangeCode(code, pkce: pkce, clientID: clientID)
                await MainActor.run {
                    viewModel.didCompleteSignIn(clientID: clientID, tokens: tokens)
                    inFlight = false
                }
            } catch {
                await MainActor.run {
                    self.error = String(describing: error)
                    self.inFlight = false
                }
            }
        }
        #else
        error = "Sign-in only available on iOS."
        #endif
    }
}

#if canImport(AuthenticationServices) && os(iOS)
extension ASWebAuthenticationSession {
    /// Async wrapper that hides the delegate boilerplate.
    static func start(url: URL, callbackURLScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { cont in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackURLScheme) { callback, error in
                if let error { cont.resume(throwing: error); return }
                guard let callback else { cont.resume(throwing: URLError(.badServerResponse)); return }
                cont.resume(returning: callback)
            }
            session.presentationContextProvider = PresentationProvider.shared
            session.prefersEphemeralWebBrowserSession = false
            session.start()
        }
    }
}

private final class PresentationProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = PresentationProvider()
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // First foreground key window of the active scene.
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        return scene?.keyWindow ?? ASPresentationAnchor()
    }
}
#endif
