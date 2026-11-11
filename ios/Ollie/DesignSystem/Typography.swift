import CoreText
import SwiftUI
import UIKit

/// One typeface, JetBrains Mono, at the sizes the design system defines for
/// mobile. Every size scales with Dynamic Type from its default, through the
/// text style named in `relativeTo`, so a larger text setting grows the whole
/// layout rather than clipping it.
///
/// Regular, Medium and Bold ship in the bundle (Resources/Fonts), all from the
/// same JetBrains Mono release so their metrics match. Those are the only
/// three weights the system allows.
///
/// Tracking stays at zero below 32. Apple adds a little positive tracking at
/// small sizes because SF is proportional and tightens as it grows; a
/// monospace already sets every glyph in a full-width cell, and JetBrains Mono
/// is drawn for 12 to 14pt, so extra space would only make it look gappy.
enum DSTextStyle: CaseIterable {
    case display, h1, h2, h3, h4, bodyLarge, body, bodySmall, code, caption

    var size: CGFloat {
        switch self {
        case .display: 40
        case .h1: 32
        case .h2: 28
        case .h3: 24
        case .h4: 20
        case .bodyLarge: 18
        case .body: 16
        case .bodySmall, .code: 14
        case .caption: 12
        }
    }

    var lineHeight: CGFloat {
        switch self {
        case .display: 48
        case .h1: 40
        case .h2: 36
        case .h3: 32
        case .h4, .bodyLarge: 28
        case .body: 24
        case .bodySmall, .code: 20
        case .caption: 16
        }
    }

    var weight: DSWeight {
        switch self {
        case .display, .h1, .h2, .h3, .h4: .bold
        case .caption: .medium
        default: .regular
        }
    }

    /// Tracking in em. Negative only at 32 and up; body stays at zero.
    var tracking: CGFloat {
        switch self {
        case .display, .h1: -0.02
        case .h2: -0.01
        default: 0
        }
    }

    var relativeTo: UIFont.TextStyle {
        switch self {
        case .display: .largeTitle
        case .h1: .title1
        case .h2: .title2
        case .h3: .title3
        case .h4: .headline
        case .bodyLarge, .body: .body
        case .bodySmall: .subheadline
        case .code: .callout
        case .caption: .caption1
        }
    }

    /// Programming ligatures belong in code, not in UI text, where `->` or
    /// `!=` turning into one glyph reads as a typo.
    var ligatures: Bool { self == .code }
}

enum DSWeight {
    case regular, medium, bold

    var postScriptName: String {
        switch self {
        case .regular: "JetBrainsMono-Regular"
        case .medium: "JetBrainsMono-Medium"
        case .bold: "JetBrainsMono-Bold"
        }
    }

    /// Only for the fallback, if a bundled font ever fails to load.
    var systemWeight: UIFont.Weight {
        switch self {
        case .regular: .regular
        case .medium: .medium
        case .bold: .bold
        }
    }
}

enum DSType {
    static func uiFont(
        _ style: DSTextStyle,
        weight: DSWeight? = nil,
        size: CGFloat? = nil,
        dynamicTypeSize: DynamicTypeSize? = nil
    ) -> UIFont {
        let resolved = weight ?? style.weight
        let pointSize = size ?? style.size
        var base = UIFont(name: resolved.postScriptName, size: pointSize)
            ?? .monospacedSystemFont(ofSize: pointSize, weight: resolved.systemWeight)

        if !style.ligatures {
            let descriptor = base.fontDescriptor.addingAttributes([
                .featureSettings: [[
                    UIFontDescriptor.FeatureKey.type: kLigaturesType,
                    UIFontDescriptor.FeatureKey.selector: kCommonLigaturesOffSelector,
                ], [
                    UIFontDescriptor.FeatureKey.type: kContextualAlternatesType,
                    UIFontDescriptor.FeatureKey.selector: kContextualAlternatesOffSelector,
                ]],
            ])
            base = UIFont(descriptor: descriptor, size: pointSize)
        }

        let metrics = UIFontMetrics(forTextStyle: style.relativeTo)
        guard let dynamicTypeSize else { return metrics.scaledFont(for: base) }
        let traits = UITraitCollection(preferredContentSizeCategory: dynamicTypeSize.contentSizeCategory)
        return metrics.scaledFont(for: base, compatibleWith: traits)
    }

    static func font(
        _ style: DSTextStyle,
        weight: DSWeight? = nil,
        size: CGFloat? = nil,
        dynamicTypeSize: DynamicTypeSize
    ) -> Font {
        Font(uiFont(style, weight: weight, size: size, dynamicTypeSize: dynamicTypeSize))
    }

    static func scale(_ style: DSTextStyle, _ dynamicTypeSize: DynamicTypeSize) -> CGFloat {
        let traits = UITraitCollection(preferredContentSizeCategory: dynamicTypeSize.contentSizeCategory)
        return UIFontMetrics(forTextStyle: style.relativeTo).scaledValue(for: 1, compatibleWith: traits)
    }
}

private struct DSFontModifier: ViewModifier {
    let style: DSTextStyle
    let weight: DSWeight?

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func body(content: Content) -> some View {
        let font = DSType.uiFont(style, weight: weight, dynamicTypeSize: dynamicTypeSize)
        let scale = DSType.scale(style, dynamicTypeSize)
        // The token's line height, scaled with the text, minus what the font
        // already brings. SwiftUI only adds spacing, it cannot take any away.
        let extra = max(0, style.lineHeight * scale - font.lineHeight)

        content
            .font(Font(font))
            .lineSpacing(extra)
            .tracking(style.tracking * font.pointSize)
    }
}

extension View {
    /// The design system's type, scaled with Dynamic Type.
    func dsFont(_ style: DSTextStyle, weight: DSWeight? = nil) -> some View {
        modifier(DSFontModifier(style: style, weight: weight))
    }
}

extension DynamicTypeSize {
    var contentSizeCategory: UIContentSizeCategory {
        switch self {
        case .xSmall: .extraSmall
        case .small: .small
        case .medium: .medium
        case .large: .large
        case .xLarge: .extraLarge
        case .xxLarge: .extraExtraLarge
        case .xxxLarge: .extraExtraExtraLarge
        case .accessibility1: .accessibilityMedium
        case .accessibility2: .accessibilityLarge
        case .accessibility3: .accessibilityExtraLarge
        case .accessibility4: .accessibilityExtraExtraLarge
        case .accessibility5: .accessibilityExtraExtraExtraLarge
        @unknown default: .large
        }
    }
}

/// Navigation and tab bar titles are UIKit's, so they take the typeface
/// through appearance proxies, once, at launch.
enum DSAppearance {
    static func apply() {
        let large = DSType.uiFont(.h1)
        let inline = DSType.uiFont(.body, weight: .bold)
        let titleColor = UIColor(DS.Text.primary)

        let nav = UINavigationBar.appearance()
        nav.largeTitleTextAttributes = [
            .font: large,
            .foregroundColor: titleColor,
            .kern: DSTextStyle.h1.tracking * large.pointSize,
        ]
        nav.titleTextAttributes = [.font: inline, .foregroundColor: titleColor]

        let item = UITabBarItem.appearance()
        let caption = DSType.uiFont(.caption)
        item.setTitleTextAttributes([.font: caption], for: .normal)
        item.setTitleTextAttributes([.font: caption], for: .selected)

        UIBarButtonItem.appearance().setTitleTextAttributes([.font: DSType.uiFont(.body)], for: .normal)
    }
}
