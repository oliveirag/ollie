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

    var body: some View {
        NavigationStack {
            Form {
                if let detail {
                    Section {
                        OrderLine(signal: Self.summarize(detail))
                        if let expires = detail.expires_at, detail.status == .pending {
                            HStack {
                                Text("Time left").font(.subheadline).foregroundStyle(.secondary)
                                Spacer()
                                Countdown(expiresAt: expires, compact: true)
                            }
                        }
                    }

                    if let alerts = detail.review?.alerts, !alerts.isEmpty {
                        Section("Broker flagged") {
                            ForEach(Array(alerts.enumerated()), id: \.offset) { _, alert in
                                Text(alert._type.replacingOccurrences(of: "_", with: " ").capitalized)
                                    .font(.subheadline)
                            }
                        }
                    }
                }

                Section {
                    TextField("Reason (optional)", text: $reason, axis: .vertical)
                        .lineLimit(1...3)
                }

                Section {
                    Button {
                        Task { await onConfirm(reason.isEmpty ? nil : reason) }
                    } label: {
                        HStack {
                            Spacer()
                            if isWorking {
                                ProgressView().tint(.white)
                            } else {
                                // Names the verb *and* the mode, so the button
                                // itself says whether money is real.
                                Text(confirmLabel).fontWeight(.semibold)
                            }
                            Spacer()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(action == .approve ? mode.accent : Theme.destructive)
                    .disabled(isWorking)

                    Button("Cancel", role: .cancel) { dismiss() }
                        .frame(maxWidth: .infinity)
                        .disabled(isWorking)
                }
            }
            .navigationTitle(action == .approve ? "Approve signal" : "Reject signal")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var confirmLabel: String {
        guard let detail else { return action == .approve ? "Approve" : "Reject" }
        let side = detail.side == .buy ? "buy" : "sell"
        return action == .approve ? "Approve — \(mode.rawValue) \(side)" : "Reject"
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
            decide_reason: detail.decide_reason
        )
    }
}
