import SwiftUI

/// The disclaimer, full screen, before onboarding can complete (PRD §9;
/// Phase 4, decision 6).
///
/// Accept stays disabled until the end of the text has been on screen. That
/// is enforced by a sentinel at the bottom of a lazy stack — it only appears,
/// and so only flips the flag, once scrolled into view. The version accepted
/// is the hash of exactly this text; the service refuses any other.
///
/// Reaching the end is remembered per version. When an accept gets a 409
/// because the text changed, the store swaps in the new version, which
/// rebuilds the scroll view from the top (`.id(version)`) and leaves the new
/// text unread until its own sentinel appears.
struct DisclaimerView: View {
    @Environment(SubscriberStore.self) private var store

    /// The version whose end has been on screen, if any.
    @State private var reachedEndVersion: String?
    @State private var isWorking = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: DS.Space.lg) {
                        ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, paragraph in
                            Text(paragraph)
                                .dsFont(.body)
                                .foregroundStyle(DS.Text.primary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        // The sentinel. In a LazyVStack this view is created
                        // only when it is about to be visible, so reaching it
                        // means the reader scrolled to the end.
                        Color.clear
                            .frame(height: 1)
                            .onAppear { reachedEndVersion = version }
                            .accessibilityIdentifier("disclaimer.end")
                    }
                    .padding(.horizontal, DS.pageMargin)
                    .padding(.vertical, DS.Space.xl)
                }
                // A new version is a new scroll view: back to the top, and a
                // fresh sentinel that has not appeared yet.
                .id(version)
                .accessibilityIdentifier("disclaimer.scroll")

                VStack(spacing: DS.Space.sm) {
                    if let failure {
                        ErrorRow(error: .server(failure))
                    }

                    Button {
                        Task { await accept() }
                    } label: {
                        ZStack {
                            Text(reachedEnd ? "I have read this and accept" : "Scroll to the end to accept")
                                .opacity(isWorking ? 0 : 1)
                            if isWorking { ProgressView().tint(DS.Text.onAction) }
                        }
                    }
                    .buttonStyle(.ds(.primary, size: .large))
                    .disabled(!reachedEnd || isWorking)
                    .accessibilityIdentifier("disclaimer.accept")

                    Button("Sign out") { store.signOut() }
                        .buttonStyle(.ds(.ghost))
                }
                .padding(.horizontal, DS.pageMargin)
                .padding(.vertical, DS.Space.md)
                .background {
                    VStack(spacing: 0) {
                        Rectangle().fill(DS.Border.default).frame(height: 1)
                        DS.Surface.page
                    }
                    .ignoresSafeArea(edges: .bottom)
                }
            }
            .background(DS.Surface.page)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var text: String { store.onboarding?.disclaimer.text ?? "" }

    private var version: String? { store.onboarding?.disclaimer.version }

    private var reachedEnd: Bool { version != nil && reachedEndVersion == version }

    /// The first `# ` line is the title; the rest are paragraphs with inline
    /// markdown (bold), which `AttributedString` renders and SwiftUI shows.
    private var title: String {
        text.split(separator: "\n", maxSplits: 1).first.map {
            String($0).replacingOccurrences(of: "# ", with: "")
        } ?? "Before you connect"
    }

    private var paragraphs: [AttributedString] {
        let body = text.split(separator: "\n", maxSplits: 1).dropFirst().first.map(String.init) ?? ""
        return body
            .components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .map { paragraph in
                // Markdown soft wraps are single newlines; join them so a
                // paragraph reflows to the screen width.
                let joined = paragraph.replacingOccurrences(of: "\n", with: " ")
                return (try? AttributedString(markdown: joined)) ?? AttributedString(joined)
            }
    }

    private func accept() async {
        isWorking = true
        failure = nil
        defer { isWorking = false }
        do {
            try await store.acceptDisclaimer()
        } catch let error as OllieError {
            failure = error.errorDescription
        } catch {
            failure = error.localizedDescription
        }
    }
}
