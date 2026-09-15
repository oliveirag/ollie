import SwiftUI

/// Agent tokens (list, revoke, mint another), the MCP URL, and sign-out.
/// The plaintext of an existing token is never here — the service holds only
/// a hash — so "I lost it" is answered by revoke-and-mint, not by lookup.
struct SubscriberSettingsView: View {
    @Environment(SubscriberStore.self) private var store

    @State private var revoking: String?
    @State private var failure: String?
    @State private var isMinting = false

    var body: some View {
        NavigationStack {
            List {
                if let url = store.mcpURL {
                    Section("MCP server") {
                        Text(url)
                            .font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled)
                        SetupSteps(url: url)
                    }
                }

                Section {
                    if store.tokens.isEmpty {
                        Text("No agent tokens.").foregroundStyle(.secondary)
                    }
                    ForEach(store.tokens, id: \.id) { token in
                        TokenRow(token: token) {
                            revoking = token.id
                        }
                    }
                    Button {
                        Task { await mint() }
                    } label: {
                        if isMinting { ProgressView() } else { Label("Create a new agent token", systemImage: "plus") }
                    }
                    .disabled(isMinting)
                    .accessibilityIdentifier("settings.mint")
                } header: {
                    Text("Agent tokens")
                } footer: {
                    Text("Each token is shown once at creation. Revoking cuts the agent off immediately; the row stays as history.")
                }

                if let failure {
                    Section { ErrorRow(error: .server(failure)) }
                }

                Section {
                    Button("Sign out", role: .destructive) { store.signOut() }
                        .accessibilityIdentifier("settings.signOut")
                } footer: {
                    Text("Signing out forgets the session on this device. Agent tokens keep working until revoked.")
                }

                if let version = store.onboarding?.disclaimer.version {
                    Section("Disclaimer") {
                        Text("Accepted version \(version.prefix(12))…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Agent")
            .refreshable { await store.refresh() }
            .confirmationDialog(
                "Revoke this token?",
                isPresented: .init(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
                titleVisibility: .visible
            ) {
                Button("Revoke", role: .destructive) {
                    if let id = revoking { Task { await revoke(id) } }
                }
                Button("Cancel", role: .cancel) { revoking = nil }
            } message: {
                Text("Any agent using it stops working on its next call.")
            }
        }
    }

    private func revoke(_ id: String) async {
        failure = nil
        defer { revoking = nil }
        do {
            try await store.revoke(id: id)
        } catch let error as OllieError {
            failure = error.errorDescription
        } catch {
            failure = error.localizedDescription
        }
    }

    private func mint() async {
        isMinting = true
        failure = nil
        defer { isMinting = false }
        do {
            // The store flips to the handoff phase so the new plaintext is
            // shown on the dedicated screen, once.
            try await store.mintToken()
        } catch let error as OllieError {
            failure = error.errorDescription
        } catch {
            failure = error.localizedDescription
        }
    }
}

private struct TokenRow: View {
    let token: McpToken
    let onRevoke: () -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Created \(token.created_at.formatted(date: .abbreviated, time: .shortened))")
                    .font(.subheadline)
                Text(status)
                    .font(.caption)
                    .foregroundStyle(token.revoked_at == nil ? .secondary : .tertiary)
            }
            Spacer()
            if token.revoked_at == nil {
                Button("Revoke", role: .destructive, action: onRevoke)
                    .font(.footnote)
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("token.revoke")
            }
        }
        .foregroundStyle(token.revoked_at == nil ? .primary : .secondary)
    }

    private var status: String {
        if let revoked = token.revoked_at {
            return "Revoked \(revoked.formatted(date: .abbreviated, time: .shortened))"
        }
        if let used = token.last_used_at {
            return "Last used \(used.formatted(date: .abbreviated, time: .shortened))"
        }
        return "Never used"
    }
}
