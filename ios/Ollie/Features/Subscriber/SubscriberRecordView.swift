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
            List {
                if let record = store.record {
                    if record.closed_trades == 0 && record.open_positions == 0 {
                        Section {
                            ContentUnavailableView(
                                "No record yet",
                                systemImage: "chart.line.uptrend.xyaxis",
                                description: Text("The record starts accruing once a published signal opens a lot.")
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
                            EquityCurve(points: record.curve.map {
                                CurveDay(date: $0.date, value: $0.value, withheld: $0.withheld)
                            })
                        }

                        if withheld(record) > 0 {
                            Section { WithheldNote(days: withheld(record)) }
                        }

                        if !record.positions.isEmpty {
                            Section {
                                ForEach(record.positions, id: \.signal_id) { position in
                                    OpenPositionRow(position: position)
                                }
                            } header: {
                                Text("Open positions")
                            } footer: {
                                Text("Valued at the latest daily mark, never a live quote. Your own agent has your own market data.")
                            }
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
    }

    private func withheld(_ record: SubscriberTrackRecord) -> Int {
        record.curve.filter(\.withheld).count
    }
}

private struct OpenPositionRow: View {
    let position: OpenPosition

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: position.side == .buy ? "arrowtriangle.up.fill" : "arrowtriangle.down.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(position.side == .buy ? Theme.gain : Theme.loss)
                Text(position.symbol).font(.headline)
                Text("\(position.quantity) @").foregroundStyle(.secondary)
                MoneyText(value: position.entry_price, size: 15, weight: .medium)
                Spacer()
                if let mark = position.latest_mark {
                    PnLText(value: mark.unrealized_pnl, size: 15)
                }
            }

            if let mark = position.latest_mark {
                HStack(spacing: 4) {
                    Text("Mark")
                    MoneyText(value: mark.price, size: 12, weight: .regular)
                    Text("as of \(mark.as_of.formatted(date: .abbreviated, time: .omitted)) · held \(mark.days_held) day\(mark.days_held == 1 ? "" : "s")")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("position.mark")
            } else {
                Text("Not yet marked — opened \(position.opened_at.formatted(date: .abbreviated, time: .omitted)). No value is claimed until a daily mark exists.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .accessibilityIdentifier("position.unmarked")
            }
        }
        .padding(.vertical, 2)
    }
}
