import Charts
import SwiftUI

/// The published record, as the owner sees it before anyone else does.
///
/// Everything here is rendered exactly as the API reports it. Where the server
/// says "no answer" — a null win rate, a withheld curve day — this screen says
/// so too rather than substituting a zero. That is not defensive UI: a chart
/// that draws through a gap, or a 0% that means "nothing has closed", is the
/// screen quietly disagreeing with the record it exists to display.
struct TrackRecordView: View {
    @Environment(SignalStore.self) private var store

    var body: some View {
        NavigationStack {
            List {
                if let record = store.trackRecord {
                    if record.closed_trades == 0 && record.open_positions == 0 {
                        Section {
                            ContentUnavailableView(
                                "No record yet",
                                systemImage: "chart.line.uptrend.xyaxis",
                                description: Text(
                                    "Approved signals open lots, and the record starts accruing once one closes."
                                )
                            )
                        }
                    } else {
                        Section("Performance") {
                            StatRow(label: "Closed trades", value: "\(record.closed_trades)")
                            StatRow(label: "Open positions", value: "\(record.open_positions)")
                            WinRateRow(record: record)
                            AverageReturnRow(value: record.average_return)

                            HStack {
                                Text("Realized")
                                Spacer()
                                PnLText(value: record.total_realized_pnl)
                            }
                        }

                        Section("Equity curve") {
                            EquityCurve(points: record.curve)
                        }

                        if withheldCount(record.curve) > 0 {
                            Section { WithheldNote(days: withheldCount(record.curve)) }
                        }
                    }
                } else if store.isLoading {
                    Section { ProgressView() }
                } else {
                    Section {
                        ContentUnavailableView(
                            "Record unavailable",
                            systemImage: "exclamationmark.triangle",
                            description: Text("Pull to refresh.")
                        )
                    }
                }
            }
            .navigationTitle("Record")
            .refreshable { await store.refresh() }
        }
        .task { if store.trackRecord == nil { await store.refresh() } }
    }

    private func withheldCount(_ points: [CurvePoint]) -> Int {
        points.filter(\.withheld).count
    }
}

/// The curve, drawn only through days that have an honest total.
///
/// The line breaks at every withheld day rather than spanning it — see
/// `segments`. The gap is also stated in words below the chart.
private struct EquityCurve: View {
    let points: [CurvePoint]

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

private struct StatRow: View {
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
private struct WinRateRow: View {
    let record: TrackRecord

    var body: some View {
        HStack {
            Text("Win rate")
            Spacer()
            if let rate = record.win_rate {
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

private struct AverageReturnRow: View {
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

/// Gaps are surfaced, not hidden. A withheld day means a lot was open and had
/// no mark — a quote outage or a halt — and it can never be backfilled.
private struct WithheldNote: View {
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
