import OpenAPIRuntime
import SignalAPI
import SwiftUI

/// The feed (Phase 4, milestone 4.6): published signals, newest first, exactly
/// as the service projects them. There is no status, no fill, no decision
/// reason — the fact of publication already says the signal was approved and
/// filled, and the owner's side of the record stays on the owner's side.
struct FeedView: View {
    @Environment(SubscriberStore.self) private var store

    var body: some View {
        NavigationStack {
            List {
                if let error = store.error {
                    Section { ErrorRow(error: error) }
                }

                if store.feed.isEmpty {
                    Section {
                        ContentUnavailableView(
                            "No signals yet",
                            systemImage: "waveform.path.ecg",
                            description: Text("A signal appears here only after the owner approved it and the fill was recorded.")
                        )
                        .accessibilityIdentifier("feed.empty")
                    }
                } else {
                    Section {
                        ForEach(store.feed, id: \.id) { signal in
                            NavigationLink(value: signal.id) {
                                PublishedSignalRow(signal: signal)
                            }
                            .accessibilityIdentifier("feed.row")
                        }
                    } header: {
                        Text("Published signals")
                    } footer: {
                        Text("Same list for every subscriber. Sizes are the owner's, not a suggestion.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Feed")
            .navigationDestination(for: String.self) { id in
                PublishedSignalDetailView(signalID: id)
            }
            .refreshable { await store.refresh() }
            .overlay {
                if store.isLoading && store.feed.isEmpty && store.lastRefreshed == nil {
                    ProgressView()
                }
            }
        }
    }
}

struct PublishedSignalRow: View {
    let signal: PublishedSignal

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                PublishedOrderLine(signal: signal)
                Spacer(minLength: 8)
                Text(signal.published_at.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
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
/// A twin of the owner's `OrderLine` over the subscriber's generated type.
struct PublishedOrderLine: View {
    let signal: PublishedSignal
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

/// One published signal and its record rows — the recompute path, rendered.
struct PublishedSignalDetailView: View {
    let signalID: String

    @Environment(SubscriberStore.self) private var store

    @State private var detail: PublishedSignalDetail?
    @State private var loadError: OllieError?

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
        .navigationTitle(detail?.signal.symbol ?? "Signal")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                detail = try await store.detail(id: signalID)
            } catch let error as OllieError {
                loadError = error
            } catch {
                loadError = .server(error.localizedDescription)
            }
        }
    }

    @ViewBuilder
    private func content(_ detail: PublishedSignalDetail) -> some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    PublishedOrderLine(signal: detail.signal, size: 22)
                    HStack(spacing: 18) {
                        Field("Fired", detail.signal.created_at.formatted(date: .abbreviated, time: .shortened))
                        Field("Published", detail.signal.published_at.formatted(date: .abbreviated, time: .shortened))
                    }
                    Field("Type", detail.signal.signal_type.rawValue.replacingOccurrences(of: "_", with: " "))
                }
                .padding(.vertical, 4)
            }

            if let thesis = detail.signal.thesis {
                Section("Thesis") {
                    Text(thesis).font(.callout)
                    if detail.signal.thesis_source?.value1 == .fallback_template {
                        TemplateThesisMark()
                    }
                }
            }

            if let indicators = Self.readIndicators(detail.signal.indicators) {
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

            Section {
                if detail.record.isEmpty {
                    Text("No record rows for this signal. An exit's rows live on the lot it closed.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(Array(detail.record.enumerated()), id: \.offset) { _, row in
                        RecordRowView(row: row)
                    }
                }
            } header: {
                Text("Record")
            } footer: {
                Text("Every row, verbatim and append-only. A later row supersedes an earlier one; nothing is edited. Recompute the published numbers from these and you get the same answer.")
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
                Text(value).font(.subheadline)
            }
        }
    }

    /// Indicators are an untyped blob by design — the strategy owns their
    /// shape. Render whatever arrived, in a stable order.
    private static func readIndicators(_ container: OpenAPIRuntime.OpenAPIValueContainer?) -> [(String, String)]? {
        guard let value = container?.value as? [String: Any], !value.isEmpty else { return nil }
        return value.keys.sorted().compactMap { key in
            guard let raw = value[key] else { return nil }
            if let number = raw as? Double {
                let rounded = (number * 10_000).rounded() / 10_000
                return (key, String(rounded))
            }
            if let text = raw as? String { return (key, text) }
            if let flag = raw as? Bool { return (key, flag ? "true" : "false") }
            return (key, String(describing: raw))
        }
    }
}

struct RecordRowView: View {
    let row: RecordRow

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(kind).font(.subheadline.weight(.semibold))
                Spacer()
                Text(row.recorded_at.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            HStack(spacing: 14) {
                Labeled("Entry", row.entry_price)
                if let mark = row.mark_price { Labeled("Mark", mark) }
                if let exit = row.exit_price { Labeled("Exit", exit) }
                Spacer()
                if let pnl = row.realized_pnl ?? row.unrealized_pnl {
                    PnLText(value: pnl, size: 15)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var kind: String {
        if row.status == .closed { return "Closed" }
        return row.mark_price == nil ? "Opened" : "Mark"
    }

    private struct Labeled: View {
        let label: String
        let value: String
        init(_ label: String, _ value: String) {
            self.label = label
            self.value = value
        }
        var body: some View {
            HStack(spacing: 4) {
                Text(label).font(.caption).foregroundStyle(.secondary)
                MoneyText(value: value, size: 14, weight: .medium)
            }
        }
    }
}
