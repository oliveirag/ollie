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
            DSPage {
                if let record = store.trackRecord {
                    if record.closed_trades == 0 && record.open_positions == 0 {
                        DSCard {
                            DSEmptyState(
                                title: "No record yet",
                                message: "Approved signals open lots, and the record starts accruing once one closes.",
                                icon: "chart.line.uptrend.xyaxis"
                            )
                        }
                    } else {
                        RecordSummary(
                            liveSince: record.live_since,
                            closedTrades: record.closed_trades,
                            openPositions: record.open_positions,
                            winRate: record.win_rate,
                            averageReturn: record.average_return,
                            realized: record.total_realized_pnl,
                            curve: curve(record)
                        )
                    }
                } else if store.isLoading {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, DS.Space.xxxl)
                } else {
                    DSCard {
                        DSEmptyState(
                            title: "Record unavailable",
                            message: "Pull to refresh.",
                            icon: "exclamationmark.triangle"
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
}
