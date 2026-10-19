import Foundation
import OpenAPIRuntime

/// Indicators are an untyped jsonb blob by design: the strategy owns their
/// shape and it changes with the rules. Render whatever arrived, in a stable
/// order, rather than pinning a schema the backend never promised.
///
/// Shared by the owner's signal detail and the subscriber's published one, so
/// the two sides of the wall print the same evidence the same way.
enum IndicatorReader {
    struct Item: Hashable {
        let name: String
        let value: String
    }

    static func read(_ container: OpenAPIValueContainer?) -> [Item]? {
        guard let value = container?.value as? [String: Any], !value.isEmpty else { return nil }

        return value.keys.sorted().compactMap { key in
            guard let raw = unwrap(value[key] as Any) else { return nil }
            return Item(name: key, value: format(raw))
        }
    }

    /// The container's values arrive as optionals boxed in `Any`, which
    /// `String(describing:)` prints as "Optional(14)". Peel them first.
    private static func unwrap(_ any: Any) -> Any? {
        let mirror = Mirror(reflecting: any)
        guard mirror.displayStyle == .optional else { return any }
        guard let child = mirror.children.first else { return nil }
        return unwrap(child.value)
    }

    private static func format(_ raw: Any) -> String {
        switch raw {
        case let flag as Bool:
            return flag ? "true" : "false"
        case let integer as Int:
            return String(integer)
        case let number as Double:
            if number == number.rounded(), abs(number) < 1e15 { return String(Int(number)) }
            let rounded = (number * 10_000).rounded() / 10_000
            return String(rounded)
        case let text as String:
            return text
        default:
            return String(describing: raw)
        }
    }
}
