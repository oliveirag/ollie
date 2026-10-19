import SwiftUI

/// The time left to decide, derived from `expires_at`.
///
/// The backend's expiry sweep remains the authority on what is actually
/// expired. This is a countdown hint, so it is allowed to reach zero without
/// anything happening for up to a minute. Hitting zero therefore reads as
/// "expiring", not "expired": claiming the latter would be asserting something
/// only the server can know.
///
/// Drawn as a badge. Urgency steps up through weight and edge, and only the
/// final minute turns red, because a signal about to lapse unanswered is the
/// one state here that is about to become a failure.
struct Countdown: View {
    let expiresAt: Date

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // Half-second cadence so the seconds digit never visibly stalls on a
        // one-second timer that drifts.
        TimelineView(.periodic(from: .now, by: 0.5)) { context in
            let remaining = max(0, expiresAt.timeIntervalSince(context.date))
            let urgency = Urgency(remaining: remaining)
            let ring = 12 * DSType.scale(.caption, dynamicTypeSize)

            HStack(spacing: DS.Space.xs + 2) {
                Ring(fraction: fraction(remaining: remaining), color: urgency.foreground)
                    .frame(width: ring, height: ring)
                Text(Self.format(remaining))
                    .dsFont(.caption, weight: urgency == .calm ? .regular : .bold)
                    .foregroundStyle(urgency.foreground)
            }
            .padding(.horizontal, DS.Space.sm)
            .frame(minHeight: 24)
            .background(DS.Surface.raised, in: RoundedRectangle(cornerRadius: DS.Radius.sm, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: DS.Radius.sm, style: .continuous)
                    .strokeBorder(urgency.edge, lineWidth: DS.BorderWidth.sm)
            }
            // The last minute pulses in opacity only. Under Reduce Motion it
            // holds still; the red and the bold already say it.
            .opacity(shouldPulse(urgency) && Int(context.date.timeIntervalSince1970 * 2) % 2 == 0 ? 0.6 : 1)
            .animation(DS.Motion.out(0.4), value: Int(context.date.timeIntervalSince1970 * 2))
            .fixedSize()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Self.spoken(remaining))
        }
    }

    private func shouldPulse(_ urgency: Urgency) -> Bool {
        urgency == .critical && !reduceMotion
    }

    /// Fraction of the *configured* window still left. The window is not on the
    /// wire, so this assumes the backend default; a wrong assumption changes
    /// only how full the ring looks, never the digits.
    private func fraction(remaining: TimeInterval) -> Double {
        min(1, max(0, remaining / (15 * 60)))
    }

    static func format(_ remaining: TimeInterval) -> String {
        let total = Int(remaining.rounded(.down))
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    static func spoken(_ remaining: TimeInterval) -> String {
        let total = Int(remaining.rounded(.down))
        if total <= 0 { return "Expiring now" }
        let minutes = total / 60
        let seconds = total % 60
        if minutes == 0 { return "\(seconds) seconds remaining" }
        return "\(minutes) minute\(minutes == 1 ? "" : "s") \(seconds) second\(seconds == 1 ? "" : "s") remaining"
    }

    enum Urgency {
        case calm, warning, critical

        init(remaining: TimeInterval) {
            self = remaining <= 60 ? .critical : (remaining <= 300 ? .warning : .calm)
        }

        var foreground: Color {
            switch self {
            case .calm: DS.Text.secondary
            case .warning: DS.Text.primary
            case .critical: DS.Text.error
            }
        }

        var edge: Color {
            switch self {
            case .calm: DS.Border.default
            case .warning: DS.Border.control
            case .critical: DS.Border.error
            }
        }
    }

    private struct Ring: View {
        let fraction: Double
        let color: Color

        var body: some View {
            ZStack {
                Circle().stroke(DS.Border.strong, lineWidth: 2)
                Circle()
                    .trim(from: 0, to: fraction)
                    .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
        }
    }
}
