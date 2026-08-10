import SwiftUI

/// Money exactly as the backend sent it.
///
/// The API serializes stored prices verbatim — `"100"`, `"182.6825"`,
/// `"308.94864"` — because padding them on the server would mean rounding a
/// four-decimal fill price. So formatting happens here, and the rule is:
/// pad to two places, show everything beyond two at 70% size in secondary
/// colour, and never round and never go through Double. A fill price that is
/// almost right is wrong in a record that can never be edited.
struct MoneyText: View {
    let value: String
    var size: CGFloat = 17
    var weight: Font.Weight = .semibold
    var prefix: String = ""

    var body: some View {
        let parts = Self.split(value)

        return (
            Text(prefix + parts.main)
                .font(.system(size: size, weight: weight))
                .monospacedDigit()
            + Text(parts.subCent)
                .font(.system(size: size * 0.7, weight: weight))
                .monospacedDigit()
                .foregroundColor(.secondary)
        )
        .accessibilityLabel(prefix + value)
    }

    /// Splits "308.94864" into ("308.94", "864"). Pure string work — parsing to
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

/// A signed P&L value. Colour is never the only carrier — the sign and an
/// arrow glyph both survive grayscale and colour blindness.
struct PnLText: View {
    let value: String
    var size: CGFloat = 17

    var body: some View {
        let negative = value.hasPrefix("-")
        let magnitude = negative ? String(value.dropFirst()) : value
        let zero = Double(value).map { $0 == 0 } ?? false

        HStack(spacing: 3) {
            if !zero {
                Image(systemName: negative ? "arrowtriangle.down.fill" : "arrowtriangle.up.fill")
                    .font(.system(size: size * 0.5))
            }
            MoneyText(
                value: magnitude,
                size: size,
                weight: .semibold,
                prefix: zero ? "" : (negative ? "−" : "+")
            )
        }
        .foregroundStyle(zero ? Color.secondary : (negative ? Theme.loss : Theme.gain))
    }
}
