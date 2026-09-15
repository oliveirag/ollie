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
            List {
                if let minted = store.minted {
                    Section {
                        Text(minted.token)
                            .font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled)
                            .accessibilityIdentifier("handoff.token")

                        Button {
                            UIPasteboard.general.string = minted.token
                            copied = true
                        } label: {
                            Label(copied ? "Copied" : "Copy token", systemImage: copied ? "checkmark" : "doc.on.doc")
                        }
                        .accessibilityIdentifier("handoff.copy")
                    } header: {
                        Text("Your agent token")
                    } footer: {
                        Text("Shown once. Ollie keeps only a fingerprint of it. If you lose it, revoke it under Agent and create another.")
                            .foregroundStyle(Theme.dynamic(dark: 0xE8A33D, light: 0xC07C16))
                    }

                    if let url = minted.mcpURL ?? store.mcpURL {
                        Section("MCP server") {
                            Text(url)
                                .font(.system(.footnote, design: .monospaced))
                                .textSelection(.enabled)
                                .accessibilityIdentifier("handoff.url")
                        }
                    }

                    Section("Point an agent at it") {
                        SetupSteps(url: minted.mcpURL ?? store.mcpURL ?? "<the MCP URL above>")
                    }

                    Section {
                        Button("Done — I've saved it") { store.completeHandoff() }
                            .frame(maxWidth: .infinity)
                            .accessibilityIdentifier("handoff.done")
                    }
                } else {
                    // Signed in and consented, but no live agent token — after
                    // revoking the last one, or on a new device.
                    Section {
                        ContentUnavailableView {
                            Label("No agent token", systemImage: "key")
                        } description: {
                            Text("Create one to connect an agent to the feed. It is shown once.")
                        } actions: {
                            Button {
                                Task { await mint() }
                            } label: {
                                if isWorking { ProgressView() } else { Text("Create agent token") }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(isWorking)
                            .accessibilityIdentifier("handoff.mint")
                        }
                    }
                    if let failure {
                        Section { ErrorRow(error: .server(failure)) }
                    }
                    Section {
                        Button("Sign out") { store.signOut() }
                            .foregroundStyle(.secondary)
                    }
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
        VStack(alignment: .leading, spacing: 10) {
            Step(number: 1, text: "Add a remote MCP server in your agent and give it the URL above.")
            Step(number: 2, text: "Attach the header  Authorization: Bearer <your token>.")
            Step(number: 3, text: "Ask your agent to call get_disclaimer, then list_signals. Nothing here can trade; what it does next is up to you and it.")

            Text("Claude Code:")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.top, 4)
            Text("claude mcp add --transport http ollie \(url) \\\n  --header \"Authorization: Bearer <token>\"")
                .font(.system(.caption2, design: .monospaced))
                .textSelection(.enabled)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.hairline, in: RoundedRectangle(cornerRadius: 6))
        }
        .padding(.vertical, 4)
    }

    private struct Step: View {
        let number: Int
        let text: String

        var body: some View {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(number).")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(text).font(.subheadline)
            }
        }
    }
}
