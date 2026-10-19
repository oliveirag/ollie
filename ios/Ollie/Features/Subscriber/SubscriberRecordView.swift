import SwiftUI

/// The subscriber's track record (Phase 4, milestone 4.6). The same stats and
/// curve as the owner's screen — same rows, same function, same rendering
/// conventions — plus open positions at daily-mark granularity (decision 7):
/// entry, quantity, days held, and the latest mark labelled with its date.
/// No live number exists on this side of the wall, and none is implied.
struct SubscriberRecordView: View {
    @Environment(SubscriberStore.self) private var store

    var body: some View {
        NavigationStack {
            DSPage {
                if let record = store.record {
                    if record.closed_trades == 0 && record.open_positions == 0 {
                        DSCard {
                            DSEmptyState(
                                title: "No record yet",
                                message: "The record starts accruing once a published signal opens a lot.",
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
                            curve: record.curve.map {
                                CurveDay(date: $0.date, value: $0.value, withheld: $0.withheld)
                            }
                        )

                        if !record.positions.isEmpty {
                            DSSection(
                                "Open positions",
                                footer: "Valued at the latest daily mark, never a live quote. Your own agent has your own market data.",
                                padded: false
                            ) {
                                DSRows(record.positions, id: \.signal_id) { position in
                                    OpenPositionRow(position: position)
                                }
                            }
                        }
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
    }
}

private struct OpenPositionRow: View {
    let position: OpenPosition

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.sm) {
            HStack(alignment: .firstTextBaseline, spacing: DS.Space.sm) {
                SideGlyph(isBuy: position.side == .buy)
                Text(position.symbol).dsFont(.body, weight: .bold).foregroundStyle(DS.Text.primary)
                Text("\(position.quantity) @").dsFont(.bodySmall).foregroundStyle(DS.Text.secondary)
                MoneyText(value: position.entry_price, style: .bodySmall, weight: .regular)
                    .foregroundStyle(DS.Text.secondary)
                Spacer()
                if let mark = position.latest_mark {
                    PnLText(value: mark.unrealized_pnl, style: .bodySmall)
                }
            }

            if let mark = position.latest_mark {
                HStack(alignment: .firstTextBaseline, spacing: DS.Space.xs) {
                    Text("Mark")
                    MoneyText(value: mark.price, style: .caption, weight: .regular)
                    Text("as of \(mark.as_of.formatted(date: .abbreviated, time: .omitted)) · held \(mark.days_held) day\(mark.days_held == 1 ? "" : "s")")
                }
                .dsFont(.caption)
                .foregroundStyle(DS.Text.secondary)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("position.mark")
            } else {
                Text("Not yet marked. Opened \(position.opened_at.formatted(date: .abbreviated, time: .omitted)). No value is claimed until a daily mark exists.")
                    .dsFont(.caption)
                    .foregroundStyle(DS.Text.tertiary)
                    .accessibilityIdentifier("position.unmarked")
            }
        }
    }
}
