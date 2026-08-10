import SwiftUI

/// The time left to decide, derived from `expires_at`.
///
/// The backend's expiry sweep remains the authority on what is actually
/// expired — this is a countdown hint, so it is allowed to reach zero without
/// anything happening for up to a minute. Hitting zero therefore reads as
/// "expiring", not "expired": claiming the latter would be asserting something
/// only the server can know.
struct Countdown: View {
    let expiresAt: Date
    var compact: Bool = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // Half-second cadence so the seconds digit never visibly stalls on a
        // one-second timer that drifts.
        TimelineView(.periodic(from: .now, by: 0.5)) { context in
            let remaining = max(0, expiresAt.timeIntervalSince(context.date))
            let urgency = Urgency(remaining: remaining)

            HStack(spacing: 6) {
                ring(fraction: fraction(remaining: remaining), color: urgency.color)
                Text(Self.format(remaining))
                    .font(.system(size: compact ? 13 : 15, weight: .semibold, design: .monospaced))
                    .monospacedDigit()
                    .foregroundStyle(urgency.color)
            }
            .padding(.horizontal, compact ? 7 : 9)
            .padding(.vertical, compact ? 3 : 5)
            .background(urgency.color.opacity(0.13), in: Capsule())
            .opacity(shouldPulse(urgency) && Int(context.date.timeIntervalSince1970 * 2) % 2 == 0 ? 0.62 : 1)
            .animation(.easeInOut(duration: 0.5), value: Int(context.date.timeIntervalSince1970 * 2))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Self.spoken(remaining))
        }
    }

    private func shouldPulse(_ urgency: Urgency) -> Bool {
        urgency == .critical && !reduceMotion
    }

    private func ring(fraction: Double, color: Color) -> some View {
        ZStack {
            Circle().stroke(color.opacity(0.25), lineWidth: 2)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: compact ? 11 : 13, height: compact ? 11 : 13)
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

        var color: Color {
            switch self {
            case .calm: .secondary
            case .warning: Theme.dynamic(dark: 0xE8A33D, light: 0xC07C16)
            case .critical: Theme.critical
            }
        }
    }
}
