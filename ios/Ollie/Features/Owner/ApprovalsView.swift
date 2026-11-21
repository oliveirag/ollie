import SwiftUI

struct ApprovalsView: View {
    @Environment(SignalStore.self) private var store

    var body: some View {
        NavigationStack {
            DSPage {
                if let error = store.error, !error.isRace {
                    ErrorRow(error: error)
                }

                if store.pending.isEmpty {
                    if store.isLoading && store.lastRefreshed == nil {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, DS.Space.xxxl)
                    } else {
                        AllClearCard(store: store)
                    }
                } else {
                    DSSection(pendingTitle, padded: false) {
                        DSRows(store.pending, id: \.id) { signal in
                            NavigationLink(value: signal.id) {
                                PendingRow(signal: signal)
                            }
                            .buttonStyle(DSRowButtonStyle())
                            .accessibilityIdentifier("pending-signal-row")
                        }
                    }
                }

                if !store.decided.isEmpty {
                    DSSection("History", padded: false) {
                        DSRows(store.decided, id: \.id) { signal in
                            DecidedRow(signal: signal)
                        }
                    }
                }
            }
            .navigationTitle("Approvals")
            .navigationDestination(for: String.self) { id in
                SignalDetailView(signalID: id)
            }
            .refreshable { await store.refresh() }
        }
    }

    private var pendingTitle: String {
        let count = store.pending.count
        return "\(count) signal\(count == 1 ? "" : "s") awaiting you"
    }
}

/// The state the owner sees most: nothing pending. Reports what the system is
/// doing rather than showing an empty box, so "no signals" reads as "working
/// and found nothing" instead of "possibly broken".
private struct AllClearCard: View {
    let store: SignalStore

    var body: some View {
        DSCard {
            VStack(alignment: .leading, spacing: DS.Space.sm) {
                HStack(spacing: DS.Space.sm) {
                    Image(systemName: store.killSwitch ? "octagon.fill" : "checkmark.circle")
                        .dsIcon(size: 17, relativeTo: .body)
                        .foregroundStyle(store.killSwitch ? DS.Icon.error : DS.Icon.primary)
                    Text(store.killSwitch ? "Halted" : "All clear")
                        .dsFont(.body, weight: .bold)
                        .foregroundStyle(DS.Text.primary)
                }

                Text(store.killSwitch
                     ? "The kill switch is on. No new signals will be proposed."
                     : "Nothing awaiting a decision.")
                    .dsFont(.bodySmall)
                    .foregroundStyle(DS.Text.secondary)

                if let refreshed = store.lastRefreshed {
                    Label {
                        Text("Checked \(refreshed.formatted(date: .omitted, time: .shortened))")
                    } icon: {
                        Image(systemName: "clock")
                    }
                    .dsFont(.caption)
                    .foregroundStyle(DS.Text.tertiary)
                    .padding(.top, DS.Space.xs)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct PendingRow: View {
    let signal: SignalSummary

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.sm) {
            HStack(alignment: .center, spacing: DS.Space.sm) {
                OrderLine(signal: signal)
                Spacer(minLength: DS.Space.sm)
                if let expires = signal.expires_at {
                    Countdown(expiresAt: expires)
                }
            }

            if let thesis = signal.thesis {
                Text(thesis)
                    .dsFont(.bodySmall)
                    .foregroundStyle(DS.Text.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }

            if signal.thesis_source?.value1 == .fallback_template {
                TemplateThesisMark()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Symbol, side, quantity, price: the order itself, in one scannable line.
/// Side is a glyph and a word, never a colour.
struct OrderLine: View {
    let signal: SignalSummary
    var style: DSTextStyle = .body

    var body: some View {
        OrderLineContent(
            symbol: signal.symbol,
            isBuy: signal.side == .buy,
            quantity: signal.quantity,
            price: signal.estimated_price,
            style: style
        )
    }
}

private struct DecidedRow: View {
    let signal: SignalSummary

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.xs) {
            HStack(alignment: .center) {
                OrderLine(signal: signal, style: .bodySmall)
                Spacer(minLength: DS.Space.sm)
                StatusChip(status: signal.status)
            }
            if let reason = signal.decide_reason {
                Text(reason)
                    .dsFont(.caption)
                    .foregroundStyle(DS.Text.secondary)
                    .lineLimit(1)
            }
            if let order = signal.order?.value1 {
                OrderStateLine(order: order)
            }
        }
    }
}

/// Where a live order stands (Phase 5). Approved-and-placed is not the same
/// as filled, and a cancelled order with no fill is an approved signal that
/// never became a position. Both are said in words, with a glyph each.
struct OrderStateLine: View {
    let order: Components.Schemas.Order

    var body: some View {
        Label {
            Text(text).dsFont(.caption)
        } icon: {
            Image(systemName: symbol)
        }
        .foregroundStyle(order.terminal_at == nil ? DS.Text.secondary : DS.Text.primary)
        .accessibilityIdentifier("order.state")
    }

    private var filled: Bool {
        (Decimal(string: order.cumulative_quantity) ?? 0) > 0
    }

    private var text: String {
        if order.terminal_at == nil {
            return order.state == "partially_filled"
                ? "Live order partially filled (\(order.cumulative_quantity)), awaiting the rest"
                : "Live order \(order.state), awaiting fill"
        }
        if filled, let price = order.average_price {
            return "Filled \(order.cumulative_quantity) @ \(price)"
        }
        return "Live order \(order.state), no fill"
    }

    private var symbol: String {
        if order.terminal_at == nil { return "hourglass" }
        return filled ? "checkmark.seal" : "xmark.seal"
    }
}

/// Three outcomes, three glyphs, one colour. Approved is the solid badge
/// because it is the one that moved money; rejected and missed are outlines.
/// Rejecting is a valid decision, not an error, so nothing here is red.
struct StatusChip: View {
    let status: Components.Schemas.SignalStatus

    var body: some View {
        switch status {
        case .approved: DSBadge(label: "Approved", icon: "checkmark", variant: .solid)
        case .rejected: DSBadge(label: "Rejected", icon: "xmark", variant: .outline)
        case .expired: DSBadge(label: "Missed", icon: "clock.badge.xmark", variant: .outline)
        case .pending: DSBadge(label: "Pending", icon: "hourglass", variant: .neutral)
        }
    }
}
