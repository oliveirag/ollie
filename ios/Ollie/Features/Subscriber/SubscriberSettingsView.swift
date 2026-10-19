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
            DSPage {
                if let url = store.mcpURL {
                    DSSection("MCP server") {
                        VStack(alignment: .leading, spacing: DS.Space.lg) {
                            Text(url)
                                .dsFont(.code)
                                .foregroundStyle(DS.Text.primary)
                                .textSelection(.enabled)
                            DSDivider()
                            SetupSteps(url: url)
                        }
                    }
                }

                DSSection(
                    "Agent tokens",
                    footer: "Each token is shown once at creation. Revoking cuts the agent off immediately; the row stays as history.",
                    padded: false
                ) {
                    if store.tokens.isEmpty {
                        Text("No agent tokens.")
                            .dsFont(.body)
                            .foregroundStyle(DS.Text.secondary)
                            .padding(DS.Space.lg)
                    } else {
                        DSRows(store.tokens, id: \.id) { token in
                            TokenRow(token: token) {
                                revoking = token.id
                            }
                        }
                    }
                    DSDivider()
                    Button {
                        Task { await mint() }
                    } label: {
                        HStack {
                            if isMinting {
                                ProgressView()
                            } else {
                                Label("Create a new agent token", systemImage: "plus")
                            }
                            Spacer()
                        }
                        .dsFont(.body, weight: .bold)
                        .foregroundStyle(DS.Text.primary)
                        .padding(.horizontal, DS.Space.lg)
                        .frame(minHeight: DS.hitTarget + DS.Space.sm)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(isMinting)
                    .accessibilityIdentifier("settings.mint")
                }

                if let failure {
                    ErrorRow(error: .server(failure))
                }

                VStack(alignment: .leading, spacing: DS.Space.sm) {
                    // Signing out is reversible, so it is not red. Revoking a
                    // token is the irreversible one.
                    Button("Sign out") { store.signOut() }
                        .buttonStyle(.ds(.secondary))
                        .accessibilityIdentifier("settings.signOut")
                    Text("Signing out forgets the session on this device. Agent tokens keep working until revoked.")
                        .dsFont(.caption)
                        .foregroundStyle(DS.Text.secondary)
                        .padding(.horizontal, DS.Space.xs)
                }

                if let version = store.onboarding?.disclaimer.version {
                    DSSection("Disclaimer") {
                        Text("Accepted version \(version.prefix(12))…")
                            .dsFont(.code)
                            .foregroundStyle(DS.Text.secondary)
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
        HStack(alignment: .center, spacing: DS.Space.md) {
            VStack(alignment: .leading, spacing: DS.Space.xs) {
                Text("Created \(token.created_at.formatted(date: .abbreviated, time: .shortened))")
                    .dsFont(.bodySmall)
                    .foregroundStyle(token.revoked_at == nil ? DS.Text.primary : DS.Text.secondary)
                Text(status)
                    .dsFont(.caption)
                    .foregroundStyle(token.revoked_at == nil ? DS.Text.secondary : DS.Text.tertiary)
            }
            Spacer()
            if token.revoked_at == nil {
                Button("Revoke", action: onRevoke)
                    .buttonStyle(.ds(.destructive, size: .small, fullWidth: false))
                    .accessibilityIdentifier("token.revoke")
            } else {
                DSBadge(label: "Revoked", icon: "xmark", variant: .outline)
            }
        }
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
