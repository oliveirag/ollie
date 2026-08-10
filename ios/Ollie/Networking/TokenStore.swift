import Foundation
import Security

/// The owner API bearer token, kept in the Keychain.
///
/// Phase 2 has exactly one user, so this pre-shared token stands in for Sign
/// in with Apple (PRD §5); SIWA arrives in Phase 4 with the subscriber side.
/// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` is deliberate: the token
/// approves trades, so it should not ride an iCloud backup to another device.
enum TokenStore {
    private static let service = "com.guilhermeoliveira.Ollie"
    private static let account = "owner-api-token"

    static func read() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8),
              !token.isEmpty
        else { return nil }

        return token
    }

    @discardableResult
    static func save(_ token: String) -> Bool {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { return false }

        // Delete-then-add rather than update: it is one code path for both the
        // first save and a rotation.
        delete()

        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
    }

    static func delete() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
    }
}
