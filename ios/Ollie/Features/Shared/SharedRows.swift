import SwiftUI

// Drawn by both apps: the owner console and the App Store subscriber feed.
// Nothing here may name an owner type.

/// The shared drawing behind `OrderLine` and the subscriber's
/// `PublishedOrderLine`, which wrap two generated types with the same facts.
struct OrderLineContent: View {
    let symbol: String
    let isBuy: Bool
    let quantity: String
    let price: String?
    var style: DSTextStyle = .body

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: DS.Space.sm) {
            SideGlyph(isBuy: isBuy, size: style.size * 0.75)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + style.size * 0.3 }

            Text(symbol)
                .dsFont(style, weight: .bold)
                .foregroundStyle(DS.Text.primary)

            Text("\(isBuy ? "Buy" : "Sell") \(quantity)")
                .dsFont(style == .body ? .bodySmall : .body)
                .foregroundStyle(DS.Text.secondary)

            if let price {
                Text("@")
                    .dsFont(style == .body ? .bodySmall : .body)
                    .foregroundStyle(DS.Text.tertiary)
                MoneyText(value: price, style: style == .body ? .bodySmall : .body, weight: .regular)
                    .foregroundStyle(DS.Text.secondary)
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.85)
        .accessibilityElement(children: .combine)
    }
}

/// The thesis came from the fallback template, meaning the LLM call failed.
/// Worth noticing. The signal itself is unaffected, since the decision is
/// deterministic and the model only ever writes prose.
struct TemplateThesisMark: View {
    var body: some View {
        Label("Template thesis: the model was unavailable", systemImage: "doc.plaintext")
            .dsFont(.caption)
            .foregroundStyle(DS.Text.tertiary)
    }
}

struct ErrorRow: View {
    let error: OllieError

    var body: some View {
        DSNotice(
            title: error.errorDescription ?? "Something went wrong.",
            icon: "exclamationmark.triangle.fill",
            isError: true
        )
    }
}
