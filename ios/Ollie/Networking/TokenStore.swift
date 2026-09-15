import Foundation
import Security

/// Bearer tokens, kept in the Keychain.
///
/// Two accounts since Phase 4: the owner's pre-shared API token (Phase 2;
/// stands in for Sign in with Apple for the one known user) and the
/// subscriber's app session token, minted by the signal service after Sign in
/// with Apple. Which one is present decides which side of the app launches.
///
/// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` is deliberate for both: the
/// owner token approves trades and the subscriber token can mint agent
/// credentials, so neither should ride an iCloud backup to another device.
enum TokenStore {
    enum Account: String {
        case owner = "owner-api-token"
        case subscriber = "subscriber-app-token"
    }

    private static let service = "com.guilhermeoliveira.Ollie"

    static func read(_ account: Account = .owner) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account.rawValue,
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
    static func save(_ token: String, account: Account = .owner) -> Bool {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { return false }

        // Delete-then-add rather than update: it is one code path for both the
        // first save and a rotation.
        delete(account)

        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account.rawValue,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
    }

    static func delete(_ account: Account = .owner) {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account.rawValue,
        ] as CFDictionary)
    }
}
