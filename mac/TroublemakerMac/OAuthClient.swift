import CryptoKit
import Foundation
import Security

struct OAuthClient: Sendable {
	struct Tokens: Sendable, Codable, Equatable {
		let accessToken: String
		let refreshToken: String?
		let expiresAt: Date
		let scope: String?
	}

	enum ClientError: Error, Equatable, CustomStringConvertible {
		case registrationFailed(status: Int, body: String)
		case tokenExchangeFailed(status: Int, body: String)
		case missingAuthorizationCode
		case malformedCallback

		var description: String {
			switch self {
			case let .registrationFailed(status, body):
				return "OAuth registration failed with HTTP \(status): \(body)"
			case let .tokenExchangeFailed(status, body):
				return "OAuth token exchange failed with HTTP \(status): \(body)"
			case .missingAuthorizationCode:
				return "OAuth callback did not include an authorization code."
			case .malformedCallback:
				return "OAuth callback was malformed."
			}
		}
	}

	let issuer: URL
	let redirectURI: String
	let scope: String
	let session: URLSession

	init(
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

	struct PKCE: Sendable {
		let verifier: String
		let challenge: String

		init() {
			verifier = Self.randomVerifier()
			challenge = Self.challenge(for: verifier)
		}

		private static func randomVerifier() -> String {
			var bytes = [UInt8](repeating: 0, count: 64)
			_ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
			return base64URL(Data(bytes))
		}

		private static func challenge(for verifier: String) -> String {
			let digest = SHA256.hash(data: Data(verifier.utf8))
			return base64URL(Data(digest))
		}
	}

	func registerClient(name: String = "Troublemaker Mac") async throws -> String {
		var req = URLRequest(url: issuer.appendingPathComponent("oauth/register"))
		req.httpMethod = "POST"
		req.setValue("application/json", forHTTPHeaderField: "Content-Type")
		req.httpBody = try JSONSerialization.data(withJSONObject: [
			"client_name": name,
			"redirect_uris": [redirectURI],
			"grant_types": ["authorization_code", "refresh_token"],
			"response_types": ["code"],
			"token_endpoint_auth_method": "none",
		])

		let (data, response) = try await session.data(for: req)
		let status = (response as? HTTPURLResponse)?.statusCode ?? 0
		guard (200..<300).contains(status) else {
			throw ClientError.registrationFailed(status: status, body: String(data: data, encoding: .utf8) ?? "")
		}
		return try JSONDecoder().decode(RegisterResponse.self, from: data).client_id
	}

	func authorizeURL(clientID: String, pkce: PKCE, state: String) -> URL {
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

	func authorizationCode(from callback: URL, expectedState: String) throws -> String {
		guard let components = URLComponents(url: callback, resolvingAgainstBaseURL: false),
			  let items = components.queryItems else {
			throw ClientError.malformedCallback
		}
		guard items.first(where: { $0.name == "state" })?.value == expectedState else {
			throw ClientError.malformedCallback
		}
		guard let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
			throw ClientError.missingAuthorizationCode
		}
		return code
	}

	func exchangeCode(_ code: String, pkce: PKCE, clientID: String) async throws -> Tokens {
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

		let (data, response) = try await session.data(for: req)
		let status = (response as? HTTPURLResponse)?.statusCode ?? 0
		guard (200..<300).contains(status) else {
			throw ClientError.tokenExchangeFailed(status: status, body: String(data: data, encoding: .utf8) ?? "")
		}
		let decoded = try JSONDecoder().decode(TokenResponse.self, from: data)
		return Tokens(
			accessToken: decoded.access_token,
			refreshToken: decoded.refresh_token,
			expiresAt: Date().addingTimeInterval(TimeInterval(decoded.expires_in ?? 3600)),
			scope: decoded.scope
		)
	}

	func refresh(_ refreshToken: String, clientID: String) async throws -> Tokens {
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

		let (data, response) = try await session.data(for: req)
		let status = (response as? HTTPURLResponse)?.statusCode ?? 0
		guard (200..<300).contains(status) else {
			throw ClientError.tokenExchangeFailed(status: status, body: String(data: data, encoding: .utf8) ?? "")
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

private struct RegisterResponse: Decodable {
	let client_id: String
}

private struct TokenResponse: Decodable {
	let access_token: String
	let refresh_token: String?
	let expires_in: Int?
	let scope: String?
}

private func base64URL(_ data: Data) -> String {
	data.base64EncodedString()
		.replacingOccurrences(of: "+", with: "-")
		.replacingOccurrences(of: "/", with: "_")
		.replacingOccurrences(of: "=", with: "")
}
