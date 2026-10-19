import OpenAPIRuntime
import SwiftUI

struct SignalDetailView: View {
    let signalID: String

    @Environment(SignalStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var detail: SignalDetail?
    @State private var loadError: OllieError?
    @State private var pendingAction: DecisionAction?
    @State private var isDeciding = false
    @State private var outcome: Outcome?

    /// What the decision came to. A refused approval must not arrive under a
    /// "Done" title, and the haptic has to match the words.
    private struct Outcome: Equatable {
        let succeeded: Bool
        let message: String
    }

    var body: some View {
        Group {
            if let detail {
                content(detail)
            } else if let loadError {
                ContentUnavailableView {
                    Label("Can't load this signal", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(loadError.errorDescription ?? "")
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(DS.Surface.page)
            }
        }
        .navigationTitle(detail?.symbol ?? "Signal")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .sheet(item: $pendingAction) { action in
            DecisionSheet(
                action: action,
                detail: detail,
                mode: store.mode,
                isWorking: isDeciding,
                onConfirm: { reason in await confirm(action, reason: reason) }
            )
            // Full height for a live approval: the real-money warning, the
            // acknowledgement, and the confirm button must all be on screen at
            // once, not below the fold of a half sheet.
            .presentationDetents(
                action == .approve && detail?.execution_mode == .live ? [.large] : [.medium]
            )
        }
        .alert(
            outcome?.succeeded == false ? "Not done" : "Done",
            isPresented: .init(get: { outcome != nil }, set: { if !$0 { outcome = nil } })
        ) {
            Button("OK") {
                // A failed decision leaves the signal where it was, so the
                // owner stays on it rather than being sent back to the list.
                if outcome?.succeeded == true { dismiss() }
                outcome = nil
            }
        } message: {
            Text(outcome?.message ?? "")
        }
        // Fires on the same change that shows the alert, so the tap, the
        // words and the buzz land together.
        .sensoryFeedback(trigger: outcome) { _, new in
            guard let new else { return nil }
            return new.succeeded ? .success : .error
        }
    }

    @ViewBuilder
    private func content(_ detail: SignalDetail) -> some View {
        DSPage {
            DSCard {
                VStack(alignment: .leading, spacing: DS.Space.lg) {
                    HStack(alignment: .center) {
                        Text(detail.symbol)
                            .dsFont(.h2)
                            .foregroundStyle(DS.Text.primary)
                        Spacer()
                        if detail.status == .pending, let expires = detail.expires_at {
                            Countdown(expiresAt: expires)
                        } else {
                            StatusChip(status: detail.status)
                        }
                    }

                    HStack(alignment: .top, spacing: DS.Space.xxl) {
                        DSFact("Side", detail.side == .buy ? "Buy" : "Sell")
                        DSFact("Quantity", detail.quantity)
                        if let price = detail.review?.estimated_price ?? detail.estimated_price {
                            VStack(alignment: .leading, spacing: DS.Space.xs) {
                                Text("Est. price").dsFont(.caption).foregroundStyle(DS.Text.secondary)
                                MoneyText(value: price)
                                    .foregroundStyle(DS.Text.primary)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            }

            // Broker warnings get their own block rather than a footnote:
            // "not enough buying power" is the kind of thing that should stop
            // a thumb, not reward a careful reader.
            if let alerts = detail.review?.alerts, !alerts.isEmpty {
                VStack(alignment: .leading, spacing: DS.Space.sm) {
                    DSSectionHeader("Broker review")
                    ForEach(Array(alerts.enumerated()), id: \.offset) { _, alert in
                        DSNotice(title: Self.humanize(alert._type), icon: "exclamationmark.triangle")
                    }
                }
            }

            if let thesis = detail.thesis {
                DSSection("Thesis") {
                    VStack(alignment: .leading, spacing: DS.Space.md) {
                        Text(thesis)
                            .dsFont(.body)
                            .foregroundStyle(DS.Text.primary)
                            .fixedSize(horizontal: false, vertical: true)
                        if detail.thesis_source?.value1 == .fallback_template {
                            TemplateThesisMark()
                        }
                    }
                }
            }

            if let indicators = IndicatorReader.read(detail.indicators) {
                DSSection("Evidence", padded: false) {
                    DSRows(indicators, id: \.name) { item in
                        DSValueRow(item.name) {
                            Text(item.value)
                                .dsFont(.code)
                                .foregroundStyle(DS.Text.secondary)
                        }
                    }
                }
            }

            if !detail.events.isEmpty {
                DSSection("History", padded: false) {
                    DSRows(detail.events, id: \.self) { event in
                        VStack(alignment: .leading, spacing: DS.Space.xs) {
                            Text("\(event.from_status.rawValue) → \(event.to_status.rawValue)")
                                .dsFont(.bodySmall)
                                .foregroundStyle(DS.Text.primary)
                            if let reason = event.reason {
                                Text(reason).dsFont(.caption).foregroundStyle(DS.Text.secondary)
                            }
                        }
                    }
                }
            }

            if detail.status == .pending {
                VStack(alignment: .leading, spacing: DS.Space.sm) {
                    // One primary per view. Reject is secondary, not red:
                    // rejecting is a valid decision, and red is kept for
                    // what cannot be undone.
                    Button("Approve…") { pendingAction = .approve }
                        .buttonStyle(.ds(.primary, size: .large))
                    Button("Reject…") { pendingAction = .reject }
                        .buttonStyle(.ds(.secondary, size: .large))
                    Text(store.killSwitch
                         ? "The kill switch is on. Approving is refused until it is off."
                         : "You'll confirm on the next screen.")
                        .dsFont(.caption)
                        .foregroundStyle(DS.Text.secondary)
                        .padding(.horizontal, DS.Space.xs)
                }
            }
        }
    }

    private func load() async {
        do {
            detail = try await store.detail(id: signalID)
        } catch let error as OllieError {
            loadError = error
        } catch {
            loadError = .server(error.localizedDescription)
        }
    }

    private func confirm(_ action: DecisionAction, reason: String?) async {
        isDeciding = true
        defer { isDeciding = false }

        do {
            let result = try await store.decide(
                id: signalID,
                approve: action == .approve,
                reason: reason,
                // Only reachable after the live sheet's acknowledgement, which
                // gates its confirm button.
                confirmLive: action == .approve && detail?.execution_mode == .live
            )
            pendingAction = nil
            if let fill = result.fillPrice {
                outcome = Outcome(succeeded: true, message: "Approved and filled at \(fill).")
            } else if let state = result.orderState {
                outcome = Outcome(succeeded: true, message: "Real order placed (\(state)). The fill is recorded when Robinhood reports it.")
            } else {
                outcome = Outcome(succeeded: true, message: "Signal \(result.status).")
            }
        } catch let error as OllieError {
            pendingAction = nil
            // A race is the system working, so the detail is refreshed rather
            // than presented as a failure the owner has to interpret.
            loadError = error
            detail = try? await store.detail(id: signalID)
            if !error.isRace {
                outcome = Outcome(succeeded: false, message: error.errorDescription ?? "The decision was not recorded.")
            }
        } catch {
            pendingAction = nil
            outcome = Outcome(succeeded: false, message: error.localizedDescription)
        }
    }

    private static func humanize(_ code: String) -> String {
        code.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

enum DecisionAction: String, Identifiable {
    case approve, reject
    var id: String { rawValue }
}
