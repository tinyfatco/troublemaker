import CryptoKit
import Foundation

/// OAuth 2.1 + PKCE client for api.example.com.
///
/// Server endpoints (mirrored from crawdad-cf/src/mcp-auth.ts):
///   POST   /oauth/register   — RFC 7591 dynamic client registration
///   GET    /oauth/authorize  — kicks user to tinyfat.com/login, then back via redirect_uri
///   POST   /oauth/token      — authorization_code → access_token (tfat_oauth_*)
///
/// `redirect_uri` must be the app's custom URL scheme registered in Info.plist
/// (e.g. `tfat://oauth-callback`).
public struct OAuthClient: Sendable {
    public struct Tokens: Sendable, Codable, Equatable {
        public let accessToken: String
        public let refreshToken: String?
        public let expiresAt: Date
        public let scope: String?
    }

    public enum Error: Swift.Error, Equatable {
        case registrationFailed(status: Int, body: String)
        case tokenExchangeFailed(status: Int, body: String)
        case missingAuthorizationCode
        case malformedCallback
    }

    public let issuer: URL
    public let redirectURI: String
    public let scope: String
    let session: URLSession

    public init(
        issuer: URL = URL(string: "https://api.example.com")!,
        redirectURI: String = "tfat://oauth-callback",
        scope: String = "mcp:tools",
        session: URLSession = .shared
    ) {
        self.issuer = issuer
        self.redirectURI = redirectURI
        self.scope = scope
        self.session = session
    }

    // MARK: - PKCE

    /// One authorization attempt's secrets: the verifier we'll later send to /token
    /// and the challenge we sent up front to /authorize.
    public struct PKCE: Sendable {
        public let verifier: String
        public let challenge: String

        public init() {
            self.verifier = Self.randomVerifier()
            self.challenge = Self.challenge(for: verifier)
        }

        static func randomVerifier() -> String {
            var bytes = [UInt8](repeating: 0, count: 64)
            _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
            return base64URL(Data(bytes))
        }

        static func challenge(for verifier: String) -> String {
            let digest = SHA256.hash(data: Data(verifier.utf8))
            return base64URL(Data(digest))
        }
    }

    // MARK: - Step 1: register

    /// One-shot dynamic client registration. Server stores client metadata for 1y
    /// and returns a `client_id` we use in subsequent /authorize requests.
    public func registerClient(name: String = "Troublemaker iOS") async throws -> String {
        var req = URLRequest(url: issuer.appendingPathComponent("oauth/register"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "client_name": name,
            "redirect_uris": [redirectURI],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none", // public client; PKCE substitutes
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, resp) = try await session.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw Error.registrationFailed(status: status, body: String(data: data, encoding: .utf8) ?? "")
        }
        let decoded = try JSONDecoder().decode(RegisterResponse.self, from: data)
        return decoded.client_id
    }

    // MARK: - Step 2: authorize URL

    /// Build the URL to hand to ASWebAuthenticationSession.
    public func authorizeURL(clientID: String, pkce: PKCE, state: String) -> URL {
        var components = URLComponents(url: issuer.appendingPathComponent("oauth/authorize"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            .init(name: "response_type", value: "code"),
            .init(name: "client_id", value: clientID),
            .init(name: "redirect_uri", value: redirectURI),
            .init(name: "scope", value: scope),
            .init(name: "state", value: state),
            .init(name: "code_challenge", value: pkce.challenge),
            .init(name: "code_challenge_method", value: "S256"),
        ]
        return components.url!
    }

    /// Pull the `code` query param out of the URL ASWebAuthenticationSession returned.
    /// Validates `state` matches what we sent.
    public func authorizationCode(from callback: URL, expectedState: String) throws -> String {
        guard let components = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              let items = components.queryItems else {
            throw Error.malformedCallback
        }
        let state = items.first { $0.name == "state" }?.value
        guard state == expectedState else { throw Error.malformedCallback }
        guard let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
            throw Error.missingAuthorizationCode
        }
        return code
    }

    // MARK: - Step 3: exchange code

    public func exchangeCode(_ code: String, pkce: PKCE, clientID: String) async throws -> Tokens {
        var req = URLRequest(url: issuer.appendingPathComponent("oauth/token"))
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var body = URLComponents()
        body.queryItems = [
            .init(name: "grant_type", value: "authorization_code"),
            .init(name: "code", value: code),
            .init(name: "code_verifier", value: pkce.verifier),
            .init(name: "redirect_uri", value: redirectURI),
            .init(name: "client_id", value: clientID),
        ]
        req.httpBody = body.percentEncodedQuery?.data(using: .utf8)

        let (data, resp) = try await session.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw Error.tokenExchangeFailed(status: status, body: String(data: data, encoding: .utf8) ?? "")
        }
        let decoded = try JSONDecoder().decode(TokenResponse.self, from: data)
        return Tokens(
            accessToken: decoded.access_token,
            refreshToken: decoded.refresh_token,
            expiresAt: Date().addingTimeInterval(TimeInterval(decoded.expires_in ?? 3600)),
            scope: decoded.scope
        )
    }

    public func refresh(_ refreshToken: String, clientID: String) async throws -> Tokens {
        var req = URLRequest(url: issuer.appendingPathComponent("oauth/token"))
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var body = URLComponents()
        body.queryItems = [
            .init(name: "grant_type", value: "refresh_token"),
            .init(name: "refresh_token", value: refreshToken),
            .init(name: "client_id", value: clientID),
        ]
        req.httpBody = body.percentEncodedQuery?.data(using: .utf8)

        let (data, resp) = try await session.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw Error.tokenExchangeFailed(status: status, body: String(data: data, encoding: .utf8) ?? "")
        }
        let decoded = try JSONDecoder().decode(TokenResponse.self, from: data)
        return Tokens(
            accessToken: decoded.access_token,
            refreshToken: decoded.refresh_token ?? refreshToken,
            expiresAt: Date().addingTimeInterval(TimeInterval(decoded.expires_in ?? 3600)),
            scope: decoded.scope
        )
    }
}

// MARK: - Wire types

private struct RegisterResponse: Decodable { let client_id: String }
private struct TokenResponse: Decodable {
    let access_token: String
    let refresh_token: String?
    let expires_in: Int?
    let scope: String?
    let token_type: String?
}

// MARK: - Base64URL helper

func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}
