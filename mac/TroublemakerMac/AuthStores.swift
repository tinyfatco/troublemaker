import Foundation
import Security

struct TokenStore: Sendable {
	let service: String
	let account: String
	let defaultsKey: String

	private enum StorageMode {
		case keychain
		case userDefaults
	}

	init(issuer: URL, accountSuffix: String = "tokens") {
		service = "com.tinyfatco.troublemaker.mac"
		account = "\(issuer.host ?? "default").\(accountSuffix)"
		defaultsKey = "tfat.mac.tokenCache.\(account)"
	}

	func save(_ tokens: OAuthClient.Tokens) throws {
		let data = try JSONEncoder().encode(tokens)
		switch storageMode {
		case .keychain:
			UserDefaults.standard.removeObject(forKey: defaultsKey)
			try saveKeychainData(data)
		case .userDefaults:
			UserDefaults.standard.set(data, forKey: defaultsKey)
		}
	}

	func load() -> OAuthClient.Tokens? {
		switch storageMode {
		case .keychain:
			if let data = loadKeychainData(),
			   let tokens = try? JSONDecoder().decode(OAuthClient.Tokens.self, from: data) {
				return tokens
			}

			if let legacyData = UserDefaults.standard.data(forKey: defaultsKey),
			   let tokens = try? JSONDecoder().decode(OAuthClient.Tokens.self, from: legacyData) {
				try? save(tokens)
				UserDefaults.standard.removeObject(forKey: defaultsKey)
				return tokens
			}
			return nil
		case .userDefaults:
			guard let data = UserDefaults.standard.data(forKey: defaultsKey) else { return nil }
			return try? JSONDecoder().decode(OAuthClient.Tokens.self, from: data)
		}
	}

	func clear() {
		UserDefaults.standard.removeObject(forKey: defaultsKey)
		guard storageMode == .keychain else { return }
		SecItemDelete(keychainQuery() as CFDictionary)
	}

	private var storageMode: StorageMode {
		switch ProcessInfo.processInfo.environment["TROUBLEMAKER_TOKEN_STORE"]?.lowercased() {
		case "defaults", "userdefaults", "insecure-defaults":
			return .userDefaults
		default:
			return .keychain
		}
	}

	private func keychainQuery() -> [String: Any] {
		[
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
		]
	}

	private func saveKeychainData(_ data: Data) throws {
		var query = keychainQuery()
		SecItemDelete(query as CFDictionary)
		query[kSecValueData as String] = data
		query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
		let status = SecItemAdd(query as CFDictionary, nil)
		guard status == errSecSuccess else { throw KeychainError(status: status) }
	}

	private func loadKeychainData() -> Data? {
		var query = keychainQuery()
		query[kSecReturnData as String] = true
		query[kSecMatchLimit as String] = kSecMatchLimitOne
		var item: CFTypeRef?
		guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else {
			return nil
		}
		return item as? Data
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
