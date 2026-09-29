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
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text(detail.symbol).font(.title.bold())
                        Spacer()
                        if detail.status == .pending, let expires = detail.expires_at {
                            Countdown(expiresAt: expires)
                        } else {
                            StatusChip(status: detail.status)
                        }
                    }

                    HStack(spacing: 18) {
                        Field("Side", detail.side == .buy ? "Buy" : "Sell")
                        Field("Quantity", detail.quantity)
                        if let price = detail.review?.estimated_price ?? detail.estimated_price {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Est. price").font(.caption).foregroundStyle(.secondary)
                                MoneyText(value: price, size: 17)
                            }
                        }
                    }
                }
                .padding(.vertical, 4)
            }

            // Broker warnings get their own section rather than a footnote:
            // "not enough buying power" is the kind of thing that should stop
            // a thumb, not reward a careful reader.
            if let alerts = detail.review?.alerts, !alerts.isEmpty {
                Section("Broker review") {
                    ForEach(Array(alerts.enumerated()), id: \.offset) { _, alert in
                        Label(Self.humanize(alert._type), systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .foregroundStyle(Theme.caution)
                    }
                }
            }

            if let thesis = detail.thesis {
                Section("Thesis") {
                    Text(thesis).font(.callout)
                    if detail.thesis_source?.value1 == .fallback_template {
                        TemplateThesisMark()
                    }
                }
            }

            if let indicators = Self.readIndicators(detail.indicators) {
                Section("Evidence") {
                    ForEach(indicators, id: \.0) { name, value in
                        HStack {
                            Text(name).font(.subheadline)
                            Spacer()
                            Text(value)
                                .font(.system(.subheadline, design: .monospaced))
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if !detail.events.isEmpty {
                Section("History") {
                    ForEach(Array(detail.events.enumerated()), id: \.offset) { _, event in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(event.from_status.rawValue) → \(event.to_status.rawValue)")
                                .font(.subheadline)
                            if let reason = event.reason {
                                Text(reason).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }

            if detail.status == .pending {
                Section {
                    Button { pendingAction = .approve } label: {
                        Text("Approve…")
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    // Grey, not red: rejecting is a valid decision, and red is
                    // reserved for halting and the final minute (Theme).
                    Button { pendingAction = .reject } label: {
                        Text("Reject…").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(.secondary)
                } footer: {
                    Text(store.killSwitch
                         ? "The kill switch is on — approving is refused until it is off."
                         : "You'll confirm on the next screen.")
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
                outcome = Outcome(succeeded: true, message: "Approved — filled at \(fill).")
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

    /// Indicators are an untyped jsonb blob by design — the strategy owns their
    /// shape and it changes with the rules. Render whatever arrived, in a
    /// stable order, rather than pinning a schema the backend never promised.
    private static func readIndicators(_ container: OpenAPIRuntime.OpenAPIValueContainer?) -> [(String, String)]? {
        guard let value = container?.value as? [String: Any], !value.isEmpty else { return nil }

        return value.keys.sorted().compactMap { key in
            guard let raw = value[key] else { return nil }
            if let number = raw as? Double {
                let rounded = (number * 10_000).rounded() / 10_000
                return (key, String(rounded))
            }
            return (key, String(describing: raw))
        }
    }
}

private struct Field: View {
    let label: String
    let value: String

    init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.headline)
        }
    }
}

enum DecisionAction: String, Identifiable {
    case approve, reject
    var id: String { rawValue }
}
