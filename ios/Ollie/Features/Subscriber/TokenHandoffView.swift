import SwiftUI

/// The agent token, shown once (Phase 4, decision 3 and milestone 4.5).
///
/// The service stores a hash and this screen is the only place the plaintext
/// ever exists. When it is dismissed the store drops it. Losing it costs a
/// revoke and a re-mint, which is the price of never storing it anywhere.
struct TokenHandoffView: View {
    @Environment(SubscriberStore.self) private var store

    @State private var copied = false
    @State private var isWorking = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            DSPage {
                if let minted = store.minted {
                    VStack(alignment: .leading, spacing: DS.Space.sm) {
                        DSSectionHeader("Your agent token")
                        DSCard {
                            VStack(alignment: .leading, spacing: DS.Space.md) {
                                Text(minted.token)
                                    .dsFont(.code)
                                    .foregroundStyle(DS.Text.primary)
                                    .textSelection(.enabled)
                                    .accessibilityIdentifier("handoff.token")

                                Button {
                                    UIPasteboard.general.string = minted.token
                                    copied = true
                                } label: {
                                    Label {
                                        Text(copied ? "Copied" : "Copy token")
                                    } icon: {
                                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                                            .contentTransition(.symbolEffect(.replace))
                                    }
                                }
                                .buttonStyle(.ds(.secondary))
                                .accessibilityIdentifier("handoff.copy")
                                .sensoryFeedback(.success, trigger: copied) { _, new in new }
                                // "Copied" is a confirmation, not a state. Left on
                                // screen it stops saying anything, and a second copy
                                // would get no answer at all.
                                .task(id: copied) {
                                    guard copied else { return }
                                    try? await Task.sleep(for: .seconds(2))
                                    copied = false
                                }
                            }
                        }
                        DSNotice(
                            title: "Shown once",
                            message: "Ollie keeps only a fingerprint of it. If you lose it, revoke it under Agent and create another.",
                            icon: "exclamationmark.triangle"
                        )
                    }

                    if let url = minted.mcpURL ?? store.mcpURL {
                        DSSection("MCP server") {
                            Text(url)
                                .dsFont(.code)
                                .foregroundStyle(DS.Text.primary)
                                .textSelection(.enabled)
                                .accessibilityIdentifier("handoff.url")
                        }
                    }

                    DSSection("Point an agent at it") {
                        SetupSteps(url: minted.mcpURL ?? store.mcpURL ?? "<the MCP URL above>")
                    }

                    Button("Done, I've saved it") { store.completeHandoff() }
                        .buttonStyle(.ds(.primary, size: .large))
                        .accessibilityIdentifier("handoff.done")
                } else {
                    // Signed in and consented, but no live agent token: after
                    // revoking the last one, or on a new device.
                    DSCard {
                        VStack(alignment: .leading, spacing: DS.Space.lg) {
                            DSEmptyState(
                                title: "No agent token",
                                message: "Create one to connect an agent to the feed. It is shown once.",
                                icon: "key"
                            )
                            Button {
                                Task { await mint() }
                            } label: {
                                ZStack {
                                    Text("Create agent token").opacity(isWorking ? 0 : 1)
                                    if isWorking { ProgressView().tint(DS.Text.onAction) }
                                }
                            }
                            .buttonStyle(.ds(.primary))
                            .disabled(isWorking)
                            .accessibilityIdentifier("handoff.mint")
                        }
                    }
                    if let failure {
                        ErrorRow(error: .server(failure))
                    }
                    Button("Sign out") { store.signOut() }
                        .buttonStyle(.ds(.ghost))
                }
            }
            .navigationTitle("Connect your agent")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func mint() async {
        isWorking = true
        failure = nil
        defer { isWorking = false }
        do {
            try await store.mintToken()
        } catch let error as OllieError {
            failure = error.errorDescription
        } catch {
            failure = error.localizedDescription
        }
    }
}

/// The setup steps, targeting the Claude-family clients first (Phase 4, risk
/// 4): they attach a custom header to a remote MCP server today.
struct SetupSteps: View {
    let url: String

    var body: some View {
        VStack(alignment: .leading, spacing: DS.Space.md) {
            Step(number: 1, text: "Add a remote MCP server in your agent and give it the URL above.")
            Step(number: 2, text: "Attach the header Authorization: Bearer <your token>.")
            Step(number: 3, text: "Ask your agent to call get_disclaimer, then list_signals. Nothing here can trade; what it does next is up to you and it.")

            Text("Claude Code")
                .dsFont(.caption)
                .foregroundStyle(DS.Text.secondary)
                .padding(.top, DS.Space.xs)
            DSCodeBlock(text: "claude mcp add --transport http ollie \(url) \\\n  --header \"Authorization: Bearer <token>\"")
        }
    }

    private struct Step: View {
        let number: Int
        let text: String

        var body: some View {
            HStack(alignment: .firstTextBaseline, spacing: DS.Space.sm) {
                Text("\(number).")
                    .dsFont(.bodySmall, weight: .bold)
                    .foregroundStyle(DS.Text.secondary)
                Text(text)
                    .dsFont(.bodySmall)
                    .foregroundStyle(DS.Text.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        }
    }
}
