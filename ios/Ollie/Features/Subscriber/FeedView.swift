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
            DSPage {
                if let error = store.error {
                    ErrorRow(error: error)
                }

                if store.feed.isEmpty {
                    if store.isLoading && store.lastRefreshed == nil {
                        ProgressView().frame(maxWidth: .infinity).padding(.top, DS.Space.xxxl)
                    } else {
                        DSCard {
                            DSEmptyState(
                                title: "No signals yet",
                                message: "A signal appears here only after the owner approved it and the fill was recorded.",
                                icon: "waveform.path.ecg"
                            )
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("feed.empty")
                    }
                } else {
                    DSSection(
                        "Published signals",
                        footer: "Same list for every subscriber. Sizes are the owner's, not a suggestion.",
                        padded: false
                    ) {
                        DSRows(store.feed, id: \.id) { signal in
                            NavigationLink(value: signal.id) {
                                PublishedSignalRow(signal: signal)
                            }
                            .buttonStyle(DSRowButtonStyle())
                            .accessibilityIdentifier("feed.row")
                        }
                    }
                }
            }
            .navigationTitle("Feed")
            .navigationDestination(for: String.self) { id in
                PublishedSignalDetailView(signalID: id)
            }
            .refreshable { await store.refresh() }
        }
    }
}

struct PublishedSignalRow: View {
    let signal: PublishedSignal

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.sm) {
            PublishedOrderLine(signal: signal)
            if let thesis = signal.thesis {
                Text(thesis)
                    .dsFont(.bodySmall)
                    .foregroundStyle(DS.Text.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            Text("Published \(signal.published_at.formatted(date: .abbreviated, time: .shortened))")
                .dsFont(.caption)
                .foregroundStyle(DS.Text.tertiary)
            if signal.thesis_source?.value1 == .fallback_template {
                TemplateThesisMark()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Symbol, side, quantity, price: the order itself, in one scannable line.
/// A twin of the owner's `OrderLine` over the subscriber's generated type,
/// drawn by the same `OrderLineContent`.
struct PublishedOrderLine: View {
    let signal: PublishedSignal
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
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(DS.Surface.page)
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
        DSPage {
            DSCard {
                VStack(alignment: .leading, spacing: DS.Space.lg) {
                    PublishedOrderLine(signal: detail.signal, style: .h4)
                    HStack(alignment: .top, spacing: DS.Space.xxl) {
                        DSFact("Fired", detail.signal.created_at.formatted(date: .abbreviated, time: .shortened))
                        DSFact("Published", detail.signal.published_at.formatted(date: .abbreviated, time: .shortened))
                    }
                    DSFact("Type", detail.signal.signal_type.rawValue.replacingOccurrences(of: "_", with: " "))
                }
            }

            if let thesis = detail.signal.thesis {
                DSSection("Thesis") {
                    VStack(alignment: .leading, spacing: DS.Space.md) {
                        Text(thesis)
                            .dsFont(.body)
                            .foregroundStyle(DS.Text.primary)
                            .fixedSize(horizontal: false, vertical: true)
                        if detail.signal.thesis_source?.value1 == .fallback_template {
                            TemplateThesisMark()
                        }
                    }
                }
            }

            if let indicators = IndicatorReader.read(detail.signal.indicators) {
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

            DSSection(
                "Record",
                footer: "Every row, verbatim and append-only. A later row supersedes an earlier one; nothing is edited. Recompute the published numbers from these and you get the same answer.",
                padded: detail.record.isEmpty
            ) {
                if detail.record.isEmpty {
                    Text("No record rows for this signal. An exit's rows live on the lot it closed.")
                        .dsFont(.bodySmall)
                        .foregroundStyle(DS.Text.secondary)
                } else {
                    DSRows(Array(detail.record.enumerated()), id: \.offset) { item in
                        RecordRowView(row: item.element)
                    }
                }
            }
        }
    }
}

struct RecordRowView: View {
    let row: RecordRow

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.xs) {
            HStack(alignment: .firstTextBaseline) {
                Text(kind).dsFont(.bodySmall, weight: .bold).foregroundStyle(DS.Text.primary)
                Spacer()
                Text(row.recorded_at.formatted(date: .abbreviated, time: .shortened))
                    .dsFont(.caption)
                    .foregroundStyle(DS.Text.tertiary)
            }
            HStack(alignment: .firstTextBaseline, spacing: DS.Space.md) {
                Labeled("Entry", row.entry_price)
                if let mark = row.mark_price { Labeled("Mark", mark) }
                if let exit = row.exit_price { Labeled("Exit", exit) }
                Spacer()
                if let pnl = row.realized_pnl ?? row.unrealized_pnl {
                    PnLText(value: pnl, style: .bodySmall)
                }
            }
        }
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
            HStack(alignment: .firstTextBaseline, spacing: DS.Space.xs) {
                Text(label).dsFont(.caption).foregroundStyle(DS.Text.secondary)
                MoneyText(value: value, style: .bodySmall, weight: .regular)
                    .foregroundStyle(DS.Text.primary)
            }
        }
    }
}
