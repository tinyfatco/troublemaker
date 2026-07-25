import Foundation
import Security

/// Keychain-backed storage for the OAuth tokens. Keys are scoped by issuer host
/// so a self-hosted edge would get its own slot.
public struct TokenStore: Sendable {
    public let service: String
    public let account: String

    public init(issuer: URL, accountSuffix: String = "tokens") {
        self.service = "com.tinyfatco.troublemaker.ios"
        self.account = "\(issuer.host ?? "default").\(accountSuffix)"
    }

    public func save(_ tokens: OAuthClient.Tokens) throws {
        let data = try JSONEncoder().encode(tokens)
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func load() -> OAuthClient.Tokens? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(OAuthClient.Tokens.self, from: data)
    }

    public func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

public struct KeychainError: Swift.Error, CustomStringConvertible {
    public let status: OSStatus
    public var description: String { "Keychain error \(status)" }
}
