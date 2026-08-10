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
    @State private var outcome: String?

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
            .presentationDetents([.medium])
        }
        .alert("Done", isPresented: .constant(outcome != nil)) {
            Button("OK") {
                outcome = nil
                dismiss()
            }
        } message: {
            Text(outcome ?? "")
        }
    }

    @ViewBuilder
    private func content(_ detail: SignalDetail) -> some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text(detail.symbol).font(.system(size: 30, weight: .bold))
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
                            .foregroundStyle(Theme.dynamic(dark: 0xE8A33D, light: 0xC07C16))
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
                    Button("Approve…") { pendingAction = .approve }
                        .buttonStyle(.borderedProminent)
                        .frame(maxWidth: .infinity)
                    Button("Reject…", role: .destructive) { pendingAction = .reject }
                        .frame(maxWidth: .infinity)
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
                reason: reason
            )
            pendingAction = nil
            outcome = result.fillPrice.map { "Approved — filled at \($0)." }
                ?? "Signal \(result.status)."
        } catch let error as OllieError {
            pendingAction = nil
            // A race is the system working, so the detail is refreshed rather
            // than presented as a failure the owner has to interpret.
            loadError = error
            detail = try? await store.detail(id: signalID)
            if !error.isRace { outcome = error.errorDescription }
        } catch {
            pendingAction = nil
            outcome = error.localizedDescription
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
            Text(value).font(.system(size: 17, weight: .semibold))
        }
    }
}

enum DecisionAction: String, Identifiable {
    case approve, reject
    var id: String { rawValue }
}
