import SwiftUI

struct DashboardView: View {
    @Environment(SignalStore.self) private var store

    var body: some View {
        NavigationStack {
            List {
                if let dashboard = store.dashboard {
                    if !dashboard.quotes_available {
                        Section { QuotesUnavailableNote() }
                    }

                    Section("Totals") {
                        TotalRow(label: "Cost basis", value: dashboard.totals.cost_basis)
                        TotalRow(label: "Market value", value: dashboard.totals.market_value)

                        HStack {
                            Text("Unrealized")
                            Spacer()
                            if let unrealized = dashboard.totals.unrealized_pnl {
                                PnLText(value: unrealized)
                            } else {
                                WithheldValue()
                            }
                        }

                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text("Realized")
                                Spacer()
                                MoneyText(value: dashboard.totals.realized_pnl, weight: .regular)
                                    .foregroundStyle(.secondary)
                            }
                            // Permanent caption, not a temporary note: zero is
                            // the true value until exits exist, and without
                            // this line a correct number reads as a bug.
                            Text("No closed lots yet — exits arrive in a later phase.")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }

                    if dashboard.lots.isEmpty {
                        Section {
                            ContentUnavailableView(
                                "No open positions",
                                systemImage: "chart.xyaxis.line",
                                description: Text("Approved signals open a lot here.")
                            )
                        }
                    } else {
                        Section("Open lots") {
                            ForEach(dashboard.lots, id: \.signal_id) { lot in
                                LotRow(lot: lot)
                            }
                        }
                    }
                } else {
                    Section { ProgressView() }
                }
            }
            .navigationTitle("Positions")
            .refreshable { await store.refresh() }
        }
    }
}

private struct LotRow: View {
    let lot: OpenLot

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: lot.side == .buy ? "arrowtriangle.up.fill" : "arrowtriangle.down.fill")
                    .font(.caption2)
                    .foregroundStyle(lot.side == .buy ? Theme.gain : Theme.loss)
                Text(lot.symbol).font(.headline)
                Text(lot.quantity).font(.subheadline).foregroundStyle(.secondary)
                Spacer()
                if let pnl = lot.unrealized_pnl {
                    PnLText(value: pnl, size: 15)
                } else {
                    WithheldValue()
                }
            }

            HStack(spacing: 14) {
                LabelledValue("Entry", lot.entry_price)
                if let quote = lot.quote {
                    LabelledValue("Quote", quote)
                } else {
                    // Says which number is missing rather than showing a
                    // stale one; the row still carries its entry basis.
                    Text("No quote").font(.caption).foregroundStyle(.tertiary)
                }
                Spacer()
                if let age = lot.quote_age_seconds {
                    // Always on screen: a stale price read as current is the
                    // failure mode this endpoint was designed around.
                    Text("\(age)s ago").font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

private struct LabelledValue: View {
    let label: String
    let value: String

    init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
    }

    var body: some View {
        HStack(spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            MoneyText(value: value, size: 13, weight: .medium)
        }
    }
}

private struct TotalRow: View {
    let label: String
    let value: String?

    var body: some View {
        HStack {
            Text(label)
            Spacer()
            if let value {
                MoneyText(value: value, weight: .regular)
            } else {
                WithheldValue()
            }
        }
    }
}

/// A total the server declined to compute because not every lot was quoted.
/// Rendered as an explicit withholding rather than a zero or a dash, because
/// a partial sum understates the portfolio.
private struct WithheldValue: View {
    var body: some View {
        Text("—  withheld")
            .font(.subheadline)
            .foregroundStyle(.tertiary)
    }
}

private struct QuotesUnavailableNote: View {
    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text("Quotes unavailable").font(.subheadline.weight(.semibold))
                Text("Showing entry basis only. Positions are still accurate.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: "wifi.exclamationmark")
        }
        .foregroundStyle(Theme.dynamic(dark: 0xE8A33D, light: 0xC07C16))
    }
}
