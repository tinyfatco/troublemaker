import Foundation
import Security

enum SecureCredentialStore {
    private static let service = "com.tinyfatco.computer.mobile"

    static func load(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else { return nil }
        return value
    }

    static func save(_ value: String, account: String) throws {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            SecItemDelete(base as CFDictionary)
            return
        }
        let attributes: [String: Any] = [
            kSecValueData as String: Data(trimmed.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let update = SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw SecureStoreError.status(update) }
        var add = base
        attributes.forEach { add[$0.key] = $0.value }
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw SecureStoreError.status(status) }
    }

    static func remove(account: String) {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
    }
}

enum SecureStoreError: Error, LocalizedError {
    case status(OSStatus)
    var errorDescription: String? { "Secure storage failed (\(statusCode))." }
    private var statusCode: OSStatus {
        if case .status(let value) = self { return value }
        return errSecInternalError
    }
}

struct AgentCatalogStore {
    private let defaults: UserDefaults
    private let catalogKey = "computer.mobile.agent-bindings.v1"
    private let selectionKey = "computer.mobile.selected-binding.v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func loadBindings() -> [AgentBinding] {
        guard let data = defaults.data(forKey: catalogKey) else { return [] }
        return (try? JSONDecoder().decode([AgentBinding].self, from: data)) ?? []
    }

    func saveBindings(_ bindings: [AgentBinding]) throws {
        defaults.set(try JSONEncoder().encode(bindings), forKey: catalogKey)
    }

    func selectedBindingID() -> String? { defaults.string(forKey: selectionKey) }

    func select(_ bindingID: String?) {
        if let bindingID { defaults.set(bindingID, forKey: selectionKey) }
        else { defaults.removeObject(forKey: selectionKey) }
    }
}

enum MobileCredentialAccount {
    static let deepgram = "transcription.deepgram"
}
