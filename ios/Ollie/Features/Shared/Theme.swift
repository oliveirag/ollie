import SwiftUI

/// Design tokens from docs/design/owner-app-design.html.
///
/// Two rules the palette encodes and the code must not quietly break:
///
/// 1. Paper-amber sits deliberately outside the gain/loss axis, so "simulated"
///    never reads as "profit" or "danger".
/// 2. Gain leans teal and loss leans red-orange — the pair most separable under
///    deutan and protan vision — and neither is ever the only carrier of
///    meaning. Every use is paired with a glyph or a sign.
enum Theme {
    static func dynamic(dark: UInt32, light: UInt32) -> Color {
        Color(UIColor { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }

    static let background = dynamic(dark: 0x10141B, light: 0xF2F3F5)
    static let card = dynamic(dark: 0x171D26, light: 0xFFFFFF)
    static let hairline = dynamic(dark: 0x212936, light: 0xE7E9ED)

    static let gain = dynamic(dark: 0x3EC08D, light: 0x12855E)
    static let loss = dynamic(dark: 0xE5605B, light: 0xC2413C)
    static let destructive = dynamic(dark: 0xE5484D, light: 0xC93A40)

    /// Reserved for the countdown's final minute and for halting. Never used
    /// for a rejection — rejecting is a valid decision, not an error.
    static let critical = destructive
}

/// Paper or live. Drives the rail *and* the app-wide tint, so the mode is
/// carried by every interactive surface rather than one badge that gets tuned
/// out. Flipping to live repaints the Approve button, the selected tab, and
/// the back chevron in one move.
enum TradingMode: String, Sendable {
    case paper
    case live

    var accent: Color {
        switch self {
        case .paper: Theme.dynamic(dark: 0xE8A33D, light: 0xC07C16)
        case .live: Theme.dynamic(dark: 0xC9364C, light: 0xC9364C)
        }
    }

    var railText: String {
        switch self {
        case .paper: "PAPER · SIMULATED FILLS"
        case .live: "LIVE · REAL ORDERS"
        }
    }

    var railSymbol: String {
        switch self {
        case .paper: "pencil.line"
        case .live: "record.circle"
        }
    }

    /// Paper is striped, live is solid. Texture, not just hue — the shell has
    /// to look different with color stripped entirely.
    var isStriped: Bool { self == .paper }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}
