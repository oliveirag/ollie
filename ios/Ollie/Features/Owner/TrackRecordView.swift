import SwiftUI

/// The published record, as the owner sees it before anyone else does.
///
/// Everything here is rendered exactly as the API reports it. Where the server
/// says "no answer" — a null win rate, a withheld curve day — this screen says
/// so too rather than substituting a zero. That is not defensive UI: a chart
/// that draws through a gap, or a 0% that means "nothing has closed", is the
/// screen quietly disagreeing with the record it exists to display.
///
/// The chart and the stat rows are shared with the subscriber's record screen
/// (Features/Shared/EquityCurve.swift), so the two sides of the wall render
/// the same rows the same way.
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
                            LiveSinceRow(liveSince: record.live_since)
                            StatRow(label: "Closed trades", value: "\(record.closed_trades)")
                            StatRow(label: "Open positions", value: "\(record.open_positions)")
                            WinRateRow(winRate: record.win_rate)
                            AverageReturnRow(value: record.average_return)

                            HStack {
                                Text("Realized")
                                Spacer()
                                PnLText(value: record.total_realized_pnl)
                            }
                        }

                        Section("Equity curve") {
                            EquityCurve(points: curve(record))
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

    private func curve(_ record: TrackRecord) -> [CurveDay] {
        record.curve.map { CurveDay(date: $0.date, value: $0.value, withheld: $0.withheld) }
    }

    private func withheldCount(_ points: [CurvePoint]) -> Int {
        points.filter(\.withheld).count
    }
}
