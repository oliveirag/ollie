import SwiftUI

/// One confirmation step between a thumb and a fill.
///
/// The countdown keeps running here on purpose: this sheet can sit open long
/// enough for the signal to expire underneath it, and the owner should see
/// that rather than tap Approve into a 409.
struct DecisionSheet: View {
    let action: DecisionAction
    let detail: SignalDetail?
    let mode: TradingMode
    let isWorking: Bool
    let onConfirm: (String?) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""
    /// The live path's second tap (Phase 5, decision 4). The backend refuses a
    /// live approval without `confirm_live`, and this is the only thing that
    /// sends it.
    @State private var acknowledgedLive = false

    /// A live-mode signal being approved: a real order, and the sheet says so.
    private var isLiveApproval: Bool {
        action == .approve && detail?.execution_mode == .live
    }

    var body: some View {
        NavigationStack {
            DSPage(spacing: DS.Space.xl) {
                if let detail {
                    DSCard {
                        VStack(alignment: .leading, spacing: DS.Space.md) {
                            OrderLine(signal: Self.summarize(detail))
                            if let expires = detail.expires_at, detail.status == .pending {
                                DSDivider()
                                HStack {
                                    Text("Time left").dsFont(.bodySmall).foregroundStyle(DS.Text.secondary)
                                    Spacer()
                                    Countdown(expiresAt: expires)
                                }
                            }
                        }
                    }

                    if let alerts = detail.review?.alerts, !alerts.isEmpty {
                        VStack(alignment: .leading, spacing: DS.Space.sm) {
                            DSSectionHeader("Broker flagged")
                            ForEach(Array(alerts.enumerated()), id: \.offset) { _, alert in
                                DSNotice(
                                    title: alert._type.replacingOccurrences(of: "_", with: " ").capitalized,
                                    icon: "exclamationmark.triangle"
                                )
                            }
                        }
                    }
                }

                if isLiveApproval, let detail {
                    VStack(alignment: .leading, spacing: DS.Space.sm) {
                        DSCard {
                            VStack(alignment: .leading, spacing: DS.Space.md) {
                                Label("This places a real order", systemImage: "exclamationmark.octagon.fill")
                                    .dsFont(.body, weight: .bold)
                                    .foregroundStyle(DS.Text.error)
                                if let notional = Self.notional(detail) {
                                    HStack(spacing: DS.Space.xs) {
                                        Text("About").foregroundStyle(DS.Text.secondary)
                                        MoneyText(value: notional, style: .bodySmall, prefix: "$")
                                            .foregroundStyle(DS.Text.primary)
                                        Text("at the proposal's estimate").foregroundStyle(DS.Text.secondary)
                                    }
                                    .dsFont(.bodySmall)
                                }
                                DSDivider()
                                Toggle("I understand this uses real money", isOn: $acknowledgedLive)
                                    .toggleStyle(.ds)
                                    .accessibilityIdentifier("decision.acknowledgeLive")
                            }
                        }
                        .overlay {
                            RoundedRectangle(cornerRadius: DS.Radius.lg, style: .continuous)
                                .strokeBorder(DS.Border.error, lineWidth: DS.BorderWidth.sm)
                        }
                        Text("Ollie reviews the order again, places it, and records the fill when Robinhood reports it. The signal is published only after that fill.")
                            .dsFont(.caption)
                            .foregroundStyle(DS.Text.secondary)
                            .padding(.horizontal, DS.Space.xs)
                    }
                }

                DSTextField(label: "Reason", placeholder: "Optional", text: $reason)

                VStack(spacing: DS.Space.sm) {
                    Button {
                        Task { await onConfirm(reason.isEmpty ? nil : reason) }
                    } label: {
                        ZStack {
                            // Names the verb *and* the mode, so the button
                            // itself says whether money is real. The label
                            // keeps its width while working, so nothing jumps.
                            Text(confirmLabel).opacity(isWorking ? 0 : 1)
                            if isWorking { ProgressView().tint(confirmVariant == .secondary ? DS.Text.primary : DS.Text.onAction) }
                        }
                    }
                    .buttonStyle(.ds(confirmVariant, size: .large))
                    .disabled(isWorking || (isLiveApproval && !acknowledgedLive))
                    .accessibilityLabel(confirmLabel)
                    .accessibilityIdentifier("decision.confirm")

                    Button("Cancel") { dismiss() }
                        .buttonStyle(.ds(.ghost))
                        .disabled(isWorking)
                }
            }
            .navigationTitle(action == .approve ? "Approve signal" : "Reject signal")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationBackground(DS.Surface.page)
    }

    /// A live approval is the only red button in the app: it spends real
    /// money and cannot be taken back. A paper approval and a rejection are
    /// the sheet's one primary action, in the mono accent.
    private var confirmVariant: DSButtonVariant {
        isLiveApproval ? .destructive : .primary
    }

    private var confirmLabel: String {
        guard let detail else { return action == .approve ? "Approve" : "Reject" }
        let side = detail.side == .buy ? "buy" : "sell"
        guard action == .approve else { return "Reject" }
        // The signal's own mode, not the account's: a paper signal approved
        // after the flip still settles on paper, and the button must not say
        // otherwise.
        return isLiveApproval ? "Place real \(side) order" : "Approve paper \(side)"
    }

    /// Quantity × the review estimate, as a string, without going through a
    /// float for the money itself. Decimal parses and multiplies exactly.
    private static func notional(_ detail: SignalDetail) -> String? {
        guard let price = detail.review?.estimated_price ?? detail.estimated_price,
              let p = Decimal(string: price),
              let q = Decimal(string: detail.quantity)
        else { return nil }
        var product = p * q
        var rounded = Decimal()
        NSDecimalRound(&rounded, &product, 2, .plain)
        return NSDecimalNumber(decimal: rounded).stringValue
    }

    /// The sheet reuses the list's order line, which is typed against the
    /// summary shape; detail extends summary, so this is a projection rather
    /// than a second rendering of the same facts.
    private static func summarize(_ detail: SignalDetail) -> SignalSummary {
        SignalSummary(
            id: detail.id,
            created_at: detail.created_at,
            symbol: detail.symbol,
            side: detail.side,
            signal_type: detail.signal_type,
            quantity: detail.quantity,
            status: detail.status,
            execution_mode: detail.execution_mode,
            estimated_price: detail.estimated_price,
            thesis: detail.thesis,
            thesis_source: detail.thesis_source.map { .init(value1: $0.value1) },
            expires_at: detail.expires_at,
            decided_at: detail.decided_at,
            decide_reason: detail.decide_reason,
            published: detail.published,
            published_at: detail.published_at,
            auto_decide_at: detail.auto_decide_at,
            order: detail.order.map { .init(value1: $0.value1) }
        )
    }
}
