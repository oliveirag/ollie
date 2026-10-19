import SwiftUI

struct DashboardView: View {
    @Environment(SignalStore.self) private var store

    var body: some View {
        NavigationStack {
            DSPage {
                if let dashboard = store.dashboard {
                    if !dashboard.quotes_available {
                        QuotesUnavailableNote()
                    }

                    DSSection("Totals", padded: false) {
                        DSRows(TotalLine.allCases, id: \.self) { line in
                            switch line {
                            case .costBasis:
                                TotalRow(label: "Cost basis", value: dashboard.totals.cost_basis)
                            case .marketValue:
                                TotalRow(label: "Market value", value: dashboard.totals.market_value)
                            case .unrealized:
                                DSValueRow("Unrealized") {
                                    if let unrealized = dashboard.totals.unrealized_pnl {
                                        PnLText(value: unrealized)
                                    } else {
                                        WithheldValue()
                                    }
                                }
                            case .realized:
                                DSValueRow("Realized") {
                                    PnLText(value: dashboard.totals.realized_pnl)
                                }
                            }
                        }
                    }

                    if dashboard.lots.isEmpty {
                        DSCard {
                            DSEmptyState(
                                title: "No open positions",
                                message: "Approved signals open a lot here.",
                                icon: "chart.bar.xaxis"
                            )
                        }
                    } else {
                        DSSection("Open lots", padded: false) {
                            DSRows(dashboard.lots, id: \.signal_id) { lot in
                                LotRow(lot: lot)
                            }
                        }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, DS.Space.xxxl)
                }
            }
            .navigationTitle("Positions")
            .refreshable { await store.refresh() }
        }
    }

    private enum TotalLine: CaseIterable { case costBasis, marketValue, unrealized, realized }
}

private struct LotRow: View {
    let lot: OpenLot

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.sm) {
            HStack(alignment: .firstTextBaseline, spacing: DS.Space.sm) {
                SideGlyph(isBuy: lot.side == .buy)
                Text(lot.symbol).dsFont(.body, weight: .bold).foregroundStyle(DS.Text.primary)
                Text(lot.quantity).dsFont(.bodySmall).foregroundStyle(DS.Text.secondary)
                Spacer()
                if let pnl = lot.unrealized_pnl {
                    PnLText(value: pnl)
                } else {
                    WithheldValue()
                }
            }

            HStack(spacing: DS.Space.lg) {
                LabelledValue("Entry", lot.entry_price)
                if let quote = lot.quote {
                    LabelledValue("Quote", quote)
                } else {
                    // Says which number is missing rather than showing a
                    // stale one; the row still carries its entry basis.
                    Text("No quote").dsFont(.caption).foregroundStyle(DS.Text.tertiary)
                }
                Spacer()
                if let age = lot.quote_age_seconds {
                    // Always on screen: a stale price read as current is the
                    // failure mode this endpoint was designed around.
                    Text("\(age)s ago").dsFont(.caption).foregroundStyle(DS.Text.tertiary)
                }
            }
        }
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
        HStack(alignment: .firstTextBaseline, spacing: DS.Space.xs) {
            Text(label).dsFont(.caption).foregroundStyle(DS.Text.secondary)
            MoneyText(value: value, style: .bodySmall, weight: .regular)
                .foregroundStyle(DS.Text.primary)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct TotalRow: View {
    let label: String
    let value: String?

    var body: some View {
        DSValueRow(label) {
            if let value {
                MoneyText(value: value, weight: .regular)
                    .foregroundStyle(DS.Text.primary)
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
        Label("Withheld", systemImage: "eye.slash")
            .dsFont(.bodySmall)
            .foregroundStyle(DS.Text.tertiary)
    }
}

private struct QuotesUnavailableNote: View {
    var body: some View {
        DSNotice(
            title: "Quotes unavailable",
            message: "Showing entry basis only. Positions are still accurate.",
            icon: "wifi.exclamationmark"
        )
    }
}
