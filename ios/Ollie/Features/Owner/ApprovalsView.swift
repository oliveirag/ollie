import SwiftUI

struct ApprovalsView: View {
    @Environment(SignalStore.self) private var store

    var body: some View {
        NavigationStack {
            List {
                if let error = store.error, !error.isRace {
                    Section { ErrorRow(error: error) }
                }

                if store.pending.isEmpty {
                    Section { AllClearRow(store: store) }
                } else {
                    Section {
                        ForEach(store.pending, id: \.id) { signal in
                            NavigationLink(value: signal.id) {
                                PendingRow(signal: signal)
                            }
                            .accessibilityIdentifier("pending-signal-row")
                        }
                    } header: {
                        Text("^[\(store.pending.count) signal](inflect: true) awaiting you")
                    }
                }

                if !store.decided.isEmpty {
                    Section("History") {
                        ForEach(store.decided, id: \.id) { signal in
                            DecidedRow(signal: signal)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Approvals")
            .navigationDestination(for: String.self) { id in
                SignalDetailView(signalID: id)
            }
            .refreshable { await store.refresh() }
            .overlay {
                if store.isLoading && store.pending.isEmpty && store.lastRefreshed == nil {
                    ProgressView()
                }
            }
        }
    }
}

/// The state the owner sees most: nothing pending. Reports what the system is
/// doing rather than showing an empty box, so "no signals" reads as "working
/// and found nothing" instead of "possibly broken".
private struct AllClearRow: View {
    let store: SignalStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: store.killSwitch ? "octagon.fill" : "checkmark.circle.fill")
                    .foregroundStyle(store.killSwitch ? Theme.destructive : Theme.gain)
                Text(store.killSwitch ? "Halted" : "All clear")
                    .font(.headline)
            }

            Text(store.killSwitch
                 ? "The kill switch is on. No new signals will be proposed."
                 : "Nothing awaiting a decision.")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            if let refreshed = store.lastRefreshed {
                Label {
                    Text("Checked \(refreshed.formatted(date: .omitted, time: .shortened))")
                } icon: {
                    Image(systemName: "clock")
                }
                .font(.caption)
                .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 6)
    }
}

private struct PendingRow: View {
    let signal: SignalSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                OrderLine(signal: signal)
                Spacer(minLength: 8)
                if let expires = signal.expires_at {
                    Countdown(expiresAt: expires, compact: true)
                }
            }

            if let thesis = signal.thesis {
                Text(thesis)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            if signal.thesis_source?.value1 == .fallback_template {
                TemplateThesisMark()
            }
        }
        .padding(.vertical, 4)
    }
}

/// Symbol, side, quantity, price — the order itself, in one scannable line.
struct OrderLine: View {
    let signal: SignalSummary
    var size: CGFloat = 17

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: signal.side == .buy ? "arrowtriangle.up.fill" : "arrowtriangle.down.fill")
                .font(.system(size: size * 0.55))
                .foregroundStyle(signal.side == .buy ? Theme.gain : Theme.loss)

            Text(signal.symbol)
                .font(.system(size: size, weight: .bold))

            Text("\(signal.side == .buy ? "Buy" : "Sell") \(signal.quantity)")
                .font(.system(size: size * 0.88))
                .foregroundStyle(.secondary)

            if let price = signal.estimated_price {
                Text("@")
                    .font(.system(size: size * 0.8))
                    .foregroundStyle(.tertiary)
                MoneyText(value: price, size: size * 0.88, weight: .medium)
            }
        }
    }
}

/// The thesis came from the fallback template, meaning the LLM call failed.
/// Worth noticing — the signal itself is unaffected, since the decision is
/// deterministic and the model only ever writes prose.
struct TemplateThesisMark: View {
    var body: some View {
        Label("Template thesis — the model was unavailable", systemImage: "doc.plaintext")
            .font(.caption2)
            .foregroundStyle(.tertiary)
    }
}

private struct DecidedRow: View {
    let signal: SignalSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                OrderLine(signal: signal, size: 15)
                Spacer(minLength: 8)
                StatusChip(status: signal.status)
            }
            if let reason = signal.decide_reason {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let order = signal.order?.value1 {
                OrderStateLine(order: order)
            }
        }
        .padding(.vertical, 2)
    }
}

/// Where a live order stands (Phase 5). Approved-and-placed is not the same
/// as filled, and a cancelled order with no fill is an approved signal that
/// never became a position — both are said in words.
struct OrderStateLine: View {
    let order: Components.Schemas.Order

    var body: some View {
        Label {
            Text(text).font(.caption)
        } icon: {
            Image(systemName: symbol)
        }
        .foregroundStyle(order.terminal_at == nil ? Color.secondary : (filled ? Theme.gain : Theme.loss))
        .accessibilityIdentifier("order.state")
    }

    private var filled: Bool {
        (Decimal(string: order.cumulative_quantity) ?? 0) > 0
    }

    private var text: String {
        if order.terminal_at == nil {
            return order.state == "partially_filled"
                ? "Live order partially filled (\(order.cumulative_quantity)) — awaiting the rest"
                : "Live order \(order.state) — awaiting fill"
        }
        if filled, let price = order.average_price {
            return "Filled \(order.cumulative_quantity) @ \(price)"
        }
        return "Live order \(order.state) — no fill"
    }

    private var symbol: String {
        if order.terminal_at == nil { return "hourglass" }
        return filled ? "checkmark.seal" : "xmark.seal"
    }
}

/// Three outcomes, three temperatures. Rejected is grey because rejecting is a
/// valid decision, not an error; expired is amber because it is a missed
/// opportunity; red is reserved for halting and the final minute.
struct StatusChip: View {
    let status: Components.Schemas.SignalStatus

    var body: some View {
        Text(label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    private var label: String {
        switch status {
        case .approved: "Approved"
        case .rejected: "Rejected"
        case .expired: "Missed"
        case .pending: "Pending"
        }
    }

    private var color: Color {
        switch status {
        case .approved: Theme.gain
        case .rejected: .secondary
        case .expired: Theme.dynamic(dark: 0xE8A33D, light: 0xC07C16)
        case .pending: .secondary
        }
    }
}

struct ErrorRow: View {
    let error: OllieError

    var body: some View {
        Label {
            Text(error.errorDescription ?? "Something went wrong.")
                .font(.footnote)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .foregroundStyle(Theme.destructive)
    }
}
