import SwiftUI

/// The disclaimer, full screen, before onboarding can complete (PRD §9;
/// Phase 4, decision 6).
///
/// Accept stays disabled until the end of the text has been on screen. That
/// is enforced by a sentinel at the bottom of a lazy stack — it only appears,
/// and so only flips the flag, once scrolled into view. The version accepted
/// is the hash of exactly this text; the service refuses any other.
struct DisclaimerView: View {
    @Environment(SubscriberStore.self) private var store

    @State private var reachedEnd = false
    @State private var isWorking = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, paragraph in
                            Text(paragraph)
                                .font(.body)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        // The sentinel. In a LazyVStack this view is created
                        // only when it is about to be visible, so reaching it
                        // means the reader scrolled to the end.
                        Color.clear
                            .frame(height: 1)
                            .onAppear { reachedEnd = true }
                            .accessibilityIdentifier("disclaimer.end")
                    }
                    .padding(20)
                }
                .accessibilityIdentifier("disclaimer.scroll")

                Divider()

                VStack(spacing: 10) {
                    if let failure {
                        ErrorRow(error: .server(failure))
                    }

                    Button {
                        Task { await accept() }
                    } label: {
                        Group {
                            if isWorking {
                                ProgressView()
                            } else {
                                Text(reachedEnd ? "I have read this and accept" : "Scroll to the end to accept")
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!reachedEnd || isWorking)
                    .accessibilityIdentifier("disclaimer.accept")

                    Button("Sign out") { store.signOut() }
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .padding(20)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var text: String { store.onboarding?.disclaimer.text ?? "" }

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
