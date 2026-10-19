import SwiftUI

/// The rail pinned under the status bar on every owner screen.
///
/// PRD §4.3 asks for the paper/live state to be unmistakable everywhere. This
/// is attached once, above the root TabView, rather than per screen, because
/// a per-screen badge is how one screen eventually ships without it. It never
/// scrolls, never animates, and shows nothing else.
struct ModeRail: View {
    let mode: TradingMode

    var body: some View {
        HStack(spacing: DS.Space.sm) {
            Image(systemName: mode.railSymbol)
                .font(.system(size: 11, weight: .semibold))
            Text(mode.railText)
                .dsFont(.caption, weight: .bold)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .foregroundStyle(mode.railForeground)
        .padding(.horizontal, DS.pageMargin)
        .frame(maxWidth: .infinity, minHeight: 24)
        .background {
            ZStack(alignment: .bottom) {
                if mode.isStriped {
                    Stripes(base: mode.railBackground)
                } else {
                    mode.railBackground
                }
                Rectangle().fill(DS.Border.default).frame(height: 1)
            }
            .ignoresSafeArea(edges: .top)
        }
        // One label for the pair: VoiceOver should say the state, not read a
        // glyph name and a string separately.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            mode == .paper
                ? "Paper mode. Fills are simulated."
                : "Live mode. Orders are real."
        )
        // Stable handle for the UI test that asserts the rail is present on
        // every tab. The requirement it guards is the one most likely to be
        // broken silently by a refactor of the shell.
        .accessibilityIdentifier("mode-rail")
    }
}

/// Diagonal stripes in `border.strong` over the rail's surface. The texture
/// is what tells paper from live in grayscale and in peripheral vision, so
/// it is not decoration.
private struct Stripes: View {
    let base: Color

    var body: some View {
        Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(base))

            let stripe: CGFloat = 4
            let gap: CGFloat = 8
            var x = -size.height
            while x < size.width + size.height {
                var path = Path()
                path.move(to: CGPoint(x: x, y: size.height))
                path.addLine(to: CGPoint(x: x + size.height, y: 0))
                path.addLine(to: CGPoint(x: x + size.height + stripe, y: 0))
                path.addLine(to: CGPoint(x: x + stripe, y: size.height))
                path.closeSubpath()
                context.fill(path, with: .color(DS.Border.strong))
                x += stripe + gap
            }
        }
        .drawingGroup()
    }
}

#Preview {
    VStack(spacing: 0) {
        ModeRail(mode: .paper)
        ModeRail(mode: .live)
    }
}
