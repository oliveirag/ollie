import SwiftUI

/// Paper or live. Drives the rail at the top of every owner screen and the
/// one red button a live approval ends on.
///
/// The design system has no amber and keeps red for destructive actions, so
/// the two modes differ by texture and words first: paper is a striped
/// neutral rail, live is a solid red one. Red is earned here. In live mode
/// every approval places a real order that cannot be taken back, which is
/// exactly what the system reserves red for.
enum TradingMode: String, Sendable {
    case paper
    case live

    var railText: String {
        switch self {
        case .paper: "Paper · simulated fills"
        case .live: "Live · real orders"
        }
    }

    var railSymbol: String {
        switch self {
        case .paper: "pencil.line"
        case .live: "record.circle"
        }
    }

    var railBackground: Color {
        switch self {
        case .paper: DS.Surface.raised
        case .live: DS.Surface.error
        }
    }

    var railForeground: Color {
        switch self {
        case .paper: DS.Text.primary
        case .live: DS.Text.onError
        }
    }

    /// Paper is striped, live is solid. Texture, not just hue: the shell has
    /// to look different with colour stripped entirely.
    var isStriped: Bool { self == .paper }
}
