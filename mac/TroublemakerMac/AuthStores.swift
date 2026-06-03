import Foundation
import Security

struct TokenStore: Sendable {
	let service: String
	let account: String
	let defaultsKey: String

	init(issuer: URL, accountSuffix: String = "tokens") {
		service = "com.tinyfatco.troublemaker.mac"
		account = "\(issuer.host ?? "default").\(accountSuffix)"
		defaultsKey = "tfat.mac.tokenCache.\(account)"
	}

	func save(_ tokens: OAuthClient.Tokens) throws {
		let data = try JSONEncoder().encode(tokens)
		UserDefaults.standard.set(data, forKey: defaultsKey)
		guard usesKeychain else { return }

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

	func load() -> OAuthClient.Tokens? {
		if let data = UserDefaults.standard.data(forKey: defaultsKey),
		   let tokens = try? JSONDecoder().decode(OAuthClient.Tokens.self, from: data) {
			return tokens
		}
		guard usesKeychain else { return nil }

		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
			kSecReturnData as String: true,
			kSecMatchLimit as String: kSecMatchLimitOne,
		]
		var item: CFTypeRef?
		guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
			  let data = item as? Data else {
			return nil
		}
		let tokens = try? JSONDecoder().decode(OAuthClient.Tokens.self, from: data)
		if let tokens, let cached = try? JSONEncoder().encode(tokens) {
			UserDefaults.standard.set(cached, forKey: defaultsKey)
		}
		return tokens
	}

	func clear() {
		UserDefaults.standard.removeObject(forKey: defaultsKey)
		guard usesKeychain else { return }

		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
		]
		SecItemDelete(query as CFDictionary)
	}

	private var usesKeychain: Bool {
		ProcessInfo.processInfo.environment["TROUBLEMAKER_TOKEN_STORE"] == "keychain"
	}
}

struct ClientIDStore {
	let key: String

	init(issuer: URL) {
		key = "tfat.mac.clientID.\(issuer.host ?? "default")"
	}

	func load() -> String? {
		UserDefaults.standard.string(forKey: key)
	}

	func save(_ id: String) {
		UserDefaults.standard.set(id, forKey: key)
	}

	func clear() {
		UserDefaults.standard.removeObject(forKey: key)
	}
}

struct AgentBindingStore {
	private let key = "tfat.mac.selectedCloudAgent"

	func load() -> CloudAgentBinding? {
		guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
		return try? JSONDecoder().decode(CloudAgentBinding.self, from: data)
	}

	func save(_ binding: CloudAgentBinding) {
		if let data = try? JSONEncoder().encode(binding) {
			UserDefaults.standard.set(data, forKey: key)
		}
	}

	func clear() {
		UserDefaults.standard.removeObject(forKey: key)
	}
}

struct KeychainError: Error, CustomStringConvertible {
	let status: OSStatus
	var description: String { "Keychain error \(status)" }
}
