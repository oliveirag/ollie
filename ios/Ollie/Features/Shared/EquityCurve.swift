import Charts
import SwiftUI

/// One day of the published curve, in a shape both API clients map into.
///
/// The owner's `CurvePoint` and the subscriber's `SignalAPI` `CurvePoint` are
/// generated from the same zod schema but live in different modules, so the
/// chart takes this neutral value rather than either of them.
struct CurveDay: Hashable {
    let date: String
    let value: Double?
    let withheld: Bool
}

/// The curve, drawn only through days that have an honest total.
///
/// The line breaks at every withheld day rather than spanning it — see
/// `segments`. The gap is also stated in words below the chart.
struct EquityCurve: View {
    let points: [CurveDay]

    /// Contiguous runs of plottable days, split at every withheld one.
    ///
    /// The split is the point. `LineMark` joins consecutive data points, so a
    /// single series would draw a straight line *through* a withheld day —
    /// stating a value for a day the record explicitly declines to state, in
    /// the one view whose whole job is to not do that. One series per run
    /// leaves a visible break instead.
    private var segments: [[(date: Date, value: Double)]] {
        var runs: [[(date: Date, value: Double)]] = []
        var current: [(date: Date, value: Double)] = []

        for point in points {
            guard !point.withheld, let value = point.value, let date = Self.parse(point.date) else {
                if !current.isEmpty { runs.append(current); current = [] }
                continue
            }
            current.append((date, value))
        }
        if !current.isEmpty { runs.append(current) }
        return runs
    }

    private var plotted: [(date: Date, value: Double)] { segments.flatMap { $0 } }

    var body: some View {
        if plotted.count < 2 {
            // One point is not a curve. Drawing a single dot on an axis implies
            // a trend that a single day cannot support.
            Text(plotted.isEmpty ? "No plottable days yet." : "One day recorded — a curve needs two.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 8)
                .accessibilityIdentifier("curve.insufficient")
        } else {
            Chart {
                ForEach(Array(segments.enumerated()), id: \.offset) { index, run in
                    ForEach(run, id: \.date) { point in
                        LineMark(
                            x: .value("Day", point.date),
                            y: .value("PnL", point.value),
                            // Distinct series per run, so Charts does not join
                            // them across the break.
                            series: .value("Run", index)
                        )
                        .interpolationMethod(.monotone)
                    }
                    // A lone surviving day between two gaps would otherwise be
                    // an invisible zero-length line.
                    ForEach(run.count == 1 ? run : [], id: \.date) { point in
                        PointMark(x: .value("Day", point.date), y: .value("PnL", point.value))
                    }
                }
                // Zero is the baseline the whole curve is measured against —
                // this is cumulative PnL, not a portfolio value, so the line
                // crossing it is the only thing that means "up" or "down".
                RuleMark(y: .value("Break even", 0))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .foregroundStyle(.secondary.opacity(0.4))
            }
            .chartYAxis { AxisMarks(position: .leading) }
            .frame(height: 180)
            .padding(.vertical, 4)
            .accessibilityIdentifier("curve.chart")
        }
    }

    private static func parse(_ day: String) -> Date? {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.date(from: day)
    }
}

struct StatRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
            Spacer()
            Text(value).foregroundStyle(.secondary).monospacedDigit()
        }
    }
}

/// Null is not zero, and the difference is the whole point.
struct WinRateRow: View {
    let winRate: Double?

    var body: some View {
        HStack {
            Text("Win rate")
            Spacer()
            if let rate = winRate {
                Text(rate.formatted(.percent.precision(.fractionLength(0))))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .accessibilityIdentifier("record.winRate")
            } else {
                // "0%" would be a claim about performance. There is no answer
                // until a trade closes, and open positions are deliberately
                // excluded from the denominator.
                Text("—")
                    .foregroundStyle(.tertiary)
                    .accessibilityIdentifier("record.winRate.none")
            }
        }
    }
}

struct AverageReturnRow: View {
    let value: Double?

    var body: some View {
        HStack {
            Text("Average return")
            Spacer()
            if let value {
                Text(value.formatted(.percent.precision(.fractionLength(2))))
                    .foregroundStyle(value < 0 ? Theme.loss : .secondary)
                    .monospacedDigit()
            } else {
                Text("—").foregroundStyle(.tertiary)
            }
        }
    }
}

/// Which part of the record settled on paper (Phase 5, decision 5). Shown on
/// both sides of the wall, because a subscriber deserves to know it too.
struct LiveSinceRow: View {
    let liveSince: Date?

    var body: some View {
        HStack {
            Text("Money")
            Spacer()
            if let liveSince {
                Text("Real since \(liveSince.formatted(date: .abbreviated, time: .omitted))")
                    .foregroundStyle(TradingMode.live.accent)
            } else {
                Text("Paper — simulated fills")
                    .foregroundStyle(TradingMode.paper.accent)
            }
        }
        .accessibilityIdentifier("record.liveSince")
    }
}

/// Gaps are surfaced, not hidden. A withheld day means a lot was open and had
/// no mark — a quote outage or a halt — and it can never be backfilled.
struct WithheldNote: View {
    let days: Int

    var body: some View {
        Label {
            Text("\(days) day\(days == 1 ? "" : "s") withheld — a position was open with no mark, so no honest total exists. These cannot be filled in later.")
                .font(.caption)
                .foregroundStyle(.secondary)
        } icon: {
            Image(systemName: "chart.dots.scatter").foregroundStyle(.tertiary)
        }
        .accessibilityIdentifier("record.withheldNote")
    }
}
