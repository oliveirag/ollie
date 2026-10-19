import SwiftUI

/// Money exactly as the backend sent it.
///
/// The API serializes stored prices verbatim (`"100"`, `"182.6825"`,
/// `"308.94864"`) because padding them on the server would mean rounding a
/// four-decimal fill price. So formatting happens here, and the rule is:
/// pad to two places, show everything beyond two smaller in a quieter text
/// token, and never round and never go through Double. A fill price that is
/// almost right is wrong in a record that can never be edited.
///
/// JetBrains Mono is monospaced, so every digit is already tabular and a
/// column of prices lines up without asking.
struct MoneyText: View {
    let value: String
    var style: DSTextStyle = .body
    var weight: DSWeight = .bold
    var prefix: String = ""

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let parts = Self.split(value)
        let main = DSType.font(style, weight: weight, dynamicTypeSize: dynamicTypeSize)
        // The sub-cent digits stay at the caption floor, never below 12.
        let tail = DSType.font(.caption, weight: .regular, size: max(12, style.size * 0.75), dynamicTypeSize: dynamicTypeSize)

        return (
            Text(prefix + parts.main).font(main)
            + Text(parts.subCent).font(tail).foregroundColor(DS.Text.tertiary)
        )
        .accessibilityLabel(prefix + value)
    }

    /// Splits "308.94864" into ("308.94", "864"). Pure string work: parsing to
    /// a number to reformat is exactly the bug this type exists to prevent.
    static func split(_ raw: String) -> (main: String, subCent: String) {
        guard let dot = raw.firstIndex(of: ".") else {
            return (raw + ".00", "")
        }
        let decimals = raw[raw.index(after: dot)...]
        if decimals.count <= 2 {
            return (raw + String(repeating: "0", count: 2 - decimals.count), "")
        }
        let cutoff = raw.index(dot, offsetBy: 3)
        return (String(raw[..<cutoff]), String(raw[cutoff...]))
    }
}

/// A signed P&L value. The sign and the arrow carry the direction, in the
/// primary text colour: the design system keeps red for errors, and a loss is
/// a result, not an error. Zero gets neither.
struct PnLText: View {
    let value: String
    var style: DSTextStyle = .body

    var body: some View {
        let negative = value.hasPrefix("-")
        let magnitude = negative ? String(value.dropFirst()) : value
        let zero = Decimal(string: value).map { $0 == 0 } ?? false

        HStack(spacing: DS.Space.xs) {
            if !zero {
                Image(systemName: negative ? "arrowtriangle.down.fill" : "arrowtriangle.up.fill")
                    .font(.system(size: style.size * 0.55, weight: .bold))
                    .accessibilityHidden(true)
            }
            MoneyText(
                value: magnitude,
                style: style,
                weight: .bold,
                prefix: zero ? "" : (negative ? "−" : "+")
            )
        }
        .foregroundStyle(zero ? DS.Text.secondary : DS.Text.primary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(zero ? "Zero" : (negative ? "Down \(magnitude)" : "Up \(magnitude)"))
    }
}

/// Buy or sell, as a glyph and a word: plus adds to the position, minus takes
/// from it. Deliberately not an arrow, which belongs to P&L direction; a buy
/// that is losing should not show two arrows pointing opposite ways.
struct SideGlyph: View {
    let isBuy: Bool
    var size: CGFloat = 12

    var body: some View {
        Image(systemName: isBuy ? "plus.circle" : "minus.circle")
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(DS.Icon.primary)
            .accessibilityHidden(true)
    }
}
