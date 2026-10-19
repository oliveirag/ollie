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

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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
            Text(plotted.isEmpty ? "No plottable days yet." : "One day recorded. A curve needs two.")
                .dsFont(.bodySmall)
                .foregroundStyle(DS.Text.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
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
                        .foregroundStyle(DS.Text.primary)
                        .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    }
                    // A lone surviving day between two gaps would otherwise be
                    // an invisible zero-length line.
                    ForEach(run.count == 1 ? run : [], id: \.date) { point in
                        PointMark(x: .value("Day", point.date), y: .value("PnL", point.value))
                            .foregroundStyle(DS.Text.primary)
                            .symbolSize(30)
                    }
                }
                // Zero is the baseline the whole curve is measured against.
                // This is cumulative PnL, not a portfolio value, so the line
                // crossing it is the only thing that means "up" or "down".
                RuleMark(y: .value("Break even", 0))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    .foregroundStyle(DS.Border.control)
            }
            .chartXAxis {
                AxisMarks { _ in
                    AxisGridLine().foregroundStyle(DS.Border.default)
                    AxisValueLabel(format: .dateTime.month(.abbreviated).day())
                        .font(DSType.font(.caption, weight: .regular, dynamicTypeSize: dynamicTypeSize))
                        .foregroundStyle(DS.Text.tertiary)
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading) { _ in
                    AxisGridLine().foregroundStyle(DS.Border.default)
                    AxisValueLabel()
                        .font(DSType.font(.caption, weight: .regular, dynamicTypeSize: dynamicTypeSize))
                        .foregroundStyle(DS.Text.tertiary)
                }
            }
            .frame(height: 180)
            .accessibilityIdentifier("curve.chart")
        }
    }

    /// One formatter for every point on every redraw. Building a DateFormatter
    /// per point is the classic way a chart starts to hitch on scroll.
    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    private static func parse(_ day: String) -> Date? {
        dayFormatter.date(from: day)
    }
}

struct StatRow: View {
    let label: String
    let value: String

    var body: some View {
        DSValueRow(label, text: value)
    }
}

/// Null is not zero, and the difference is the whole point.
struct WinRateRow: View {
    let winRate: Double?

    var body: some View {
        DSValueRow("Win rate") {
            if let rate = winRate {
                Text(rate.formatted(.percent.precision(.fractionLength(0))))
                    .dsFont(.body)
                    .foregroundStyle(DS.Text.secondary)
                    .accessibilityIdentifier("record.winRate")
            } else {
                // "0%" would be a claim about performance. There is no answer
                // until a trade closes, and open positions are deliberately
                // excluded from the denominator.
                Text("None yet")
                    .dsFont(.body)
                    .foregroundStyle(DS.Text.tertiary)
                    .accessibilityIdentifier("record.winRate.none")
            }
        }
    }
}

struct AverageReturnRow: View {
    let value: Double?

    var body: some View {
        DSValueRow("Average return") {
            if let value {
                // Signed like P&L: the sign carries direction, not a colour.
                Text(value.formatted(.percent.precision(.fractionLength(2)).sign(strategy: .always(includingZero: false))))
                    .dsFont(.body)
                    .foregroundStyle(DS.Text.secondary)
            } else {
                Text("None yet").dsFont(.body).foregroundStyle(DS.Text.tertiary)
            }
        }
    }
}

/// Which part of the record settled on paper (Phase 5, decision 5). Shown on
/// both sides of the wall, because a subscriber deserves to know it too.
struct LiveSinceRow: View {
    let liveSince: Date?

    var body: some View {
        DSValueRow("Money") {
            if let liveSince {
                DSBadge(
                    label: "Real since \(liveSince.formatted(date: .abbreviated, time: .omitted))",
                    icon: "record.circle",
                    variant: .solid
                )
            } else {
                DSBadge(label: "Paper, simulated", icon: "pencil.line", variant: .outline)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("record.liveSince")
    }
}

/// Gaps are surfaced, not hidden. A withheld day means a lot was open and had
/// no mark (a quote outage or a halt), and it can never be backfilled.
struct WithheldNote: View {
    let days: Int

    var body: some View {
        DSNotice(
            title: "\(days) day\(days == 1 ? "" : "s") withheld",
            message: "A position was open with no mark, so no honest total exists. These cannot be filled in later.",
            icon: "chart.dots.scatter"
        )
        .accessibilityIdentifier("record.withheldNote")
    }
}

/// The stats, the curve and the withheld note, as both record screens show
/// them. One view so the owner and the subscriber read the same rows in the
/// same order, drawn the same way.
struct RecordSummary: View {
    let liveSince: Date?
    let closedTrades: Int
    let openPositions: Int
    let winRate: Double?
    let averageReturn: Double?
    let realized: String
    let curve: [CurveDay]

    private enum Line: CaseIterable { case money, closed, open, winRate, average, realized }

    var body: some View {
        DSSection("Performance", padded: false) {
            DSRows(Line.allCases, id: \.self) { line in
                switch line {
                case .money: LiveSinceRow(liveSince: liveSince)
                case .closed: StatRow(label: "Closed trades", value: "\(closedTrades)")
                case .open: StatRow(label: "Open positions", value: "\(openPositions)")
                case .winRate: WinRateRow(winRate: winRate)
                case .average: AverageReturnRow(value: averageReturn)
                case .realized: DSValueRow("Realized") { PnLText(value: realized) }
                }
            }
        }

        DSSection("Equity curve", footer: "The dashed line is break-even.") {
            EquityCurve(points: curve)
        }

        let withheld = curve.filter(\.withheld).count
        if withheld > 0 {
            WithheldNote(days: withheld)
        }
    }
}
