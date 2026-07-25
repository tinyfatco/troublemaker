import Foundation
import Observation

/// Single source of truth for the app shell. Holds the auth state and the
/// resolved ApiClient. Views observe this and react.
@Observable
@MainActor
public final class AppViewModel {
    public enum Phase: Equatable {
        case loading
        case signedOut
        case signedIn(userTokenSummary: String)
    }

    public private(set) var phase: Phase = .loading
    public private(set) var api: ApiClient?
    public private(set) var clientID: String?

    let oauth: OAuthClient
    let tokenStore: TokenStore
    let clientIDStore: ClientIDStore

    public init(
        oauth: OAuthClient = OAuthClient(),
        tokenStore: TokenStore? = nil,
        clientIDStore: ClientIDStore? = nil
    ) {
        self.oauth = oauth
        self.tokenStore = tokenStore ?? TokenStore(issuer: oauth.issuer)
        self.clientIDStore = clientIDStore ?? ClientIDStore(issuer: oauth.issuer)
    }

    public func bootstrap() async {
        guard let tokens = tokenStore.load(), let cid = clientIDStore.load() else {
            phase = .signedOut
            return
        }
        clientID = cid
        api = ApiClient(baseURL: oauth.issuer, clientID: cid, oauth: oauth, tokenStore: tokenStore)
        phase = .signedIn(userTokenSummary: String(tokens.accessToken.prefix(16)) + "…")
    }

    public func didCompleteSignIn(clientID: String, tokens: OAuthClient.Tokens) {
        self.clientID = clientID
        try? tokenStore.save(tokens)
        clientIDStore.save(clientID)
        api = ApiClient(baseURL: oauth.issuer, clientID: clientID, oauth: oauth, tokenStore: tokenStore)
        phase = .signedIn(userTokenSummary: String(tokens.accessToken.prefix(16)) + "…")
    }

    public func signOut() {
        tokenStore.clear()
        clientIDStore.clear()
        api = nil
        clientID = nil
        phase = .signedOut
    }
}

/// Tiny UserDefaults-backed slot for the dynamic-client-registration ID.
/// Not secret — server-side it's just an opaque handle that points at the
/// client metadata we registered on first launch. Keychain would be overkill.
public struct ClientIDStore {
    let key: String
    public init(issuer: URL) {
        self.key = "tfat.clientID.\(issuer.host ?? "default")"
    }
    public func load() -> String? { UserDefaults.standard.string(forKey: key) }
    public func save(_ id: String) { UserDefaults.standard.set(id, forKey: key) }
    public func clear() { UserDefaults.standard.removeObject(forKey: key) }
}
