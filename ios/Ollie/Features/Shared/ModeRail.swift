import SwiftUI

/// The 22pt rail pinned under the status bar on every screen.
///
/// PRD §4.3 asks for the paper/live state to be unmistakable everywhere. This
/// is attached once via `safeAreaInset` on the root TabView rather than per
/// screen, because a per-screen badge is how one screen eventually ships
/// without it. It never scrolls, never animates, and shows nothing else.
struct ModeRail: View {
    let mode: TradingMode

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: mode.railSymbol)
                .font(.system(size: 10, weight: .bold))
            Text(mode.railText)
                .font(.system(size: 10, weight: .bold))
                .kerning(0.8)
        }
        .foregroundStyle(Color.black.opacity(0.82))
        .frame(maxWidth: .infinity)
        .frame(height: 22)
        .background {
            if mode.isStriped {
                CautionStripes(base: mode.accent)
            } else {
                mode.accent
            }
        }
        // One label for the pair: VoiceOver should say the state, not read a
        // glyph name and a shouty string separately.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            mode == .paper
                ? "Paper mode. Fills are simulated."
                : "Live mode. Orders are real."
        )
        // Stable handle for the UI test that asserts the rail is present on
        // every tab — the requirement it guards is the one most likely to be
        // broken silently by a refactor of the shell.
        .accessibilityIdentifier("mode-rail")
    }
}

/// Diagonal caution stripes. The texture is what makes paper distinguishable
/// from live in grayscale and in peripheral vision, so it is not decoration.
private struct CautionStripes: View {
    let base: Color

    var body: some View {
        Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(base))

            let stripe: CGFloat = 6
            let gap: CGFloat = 10
            var x = -size.height
            while x < size.width + size.height {
                var path = Path()
                path.move(to: CGPoint(x: x, y: size.height))
                path.addLine(to: CGPoint(x: x + size.height, y: 0))
                path.addLine(to: CGPoint(x: x + size.height + stripe, y: 0))
                path.addLine(to: CGPoint(x: x + stripe, y: size.height))
                path.closeSubpath()
                context.fill(path, with: .color(.black.opacity(0.13)))
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
