import SwiftUI

/// Kill switch and mode toggle (PRD §4.3).
struct ControlsView: View {
    @Environment(SignalStore.self) private var store

    @State private var confirmingHalt = false
    @State private var isWorking = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(store.killSwitch ? "Halted" : "Running")
                                .font(.headline)
                                .foregroundStyle(store.killSwitch ? Theme.destructive : Theme.gain)
                            Text(store.killSwitch
                                 ? "No proposals, no execution."
                                 : "Proposing on schedule.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if isWorking { ProgressView() }
                    }

                    Button(role: store.killSwitch ? nil : .destructive) {
                        confirmingHalt = true
                    } label: {
                        Label(
                            store.killSwitch ? "Resume Ollie…" : "Halt Ollie…",
                            systemImage: store.killSwitch ? "play.fill" : "octagon.fill"
                        )
                        .frame(maxWidth: .infinity)
                        // The glyph would otherwise inherit the app's amber
                        // mode tint while the label text is red, which reads
                        // as two different controls.
                        .foregroundStyle(store.killSwitch ? Theme.gain : Theme.destructive)
                    }
                    .disabled(isWorking)
                } header: {
                    Text("Kill switch")
                } footer: {
                    Text("Halting stops new proposals and refuses execution immediately. "
                         + "It is enforced in the pipeline, not just here.")
                }

                Section {
                    HStack {
                        Label("Execution mode", systemImage: "lock.fill")
                        Spacer()
                        Text(store.mode.rawValue.capitalized)
                            .foregroundStyle(.secondary)
                    }
                    .foregroundStyle(store.liveTradingEnabled ? .primary : .secondary)
                } header: {
                    Text("Mode")
                } footer: {
                    // The toggle exists and is visibly locked, mirroring the
                    // executor's own double gate: one flips at runtime, the
                    // other needs a deploy.
                    Text(store.liveTradingEnabled
                         ? "Live trading is unlocked at the environment level."
                         : "Live trading is disabled at the environment level "
                           + "(LIVE_TRADING_ENABLED). Unlocking it needs a deploy, not a toggle.")
                }

                Section {
                    Toggle(isOn: Binding(
                        get: { store.autonomy },
                        set: { on in Task { await setAutonomy(on) } }
                    )) {
                        Label("Auto-approve after \(store.autonomyVetoMinutes) min", systemImage: store.autonomyEnabled ? "timer" : "lock.fill")
                    }
                    .disabled(!store.autonomyEnabled || isWorking)
                    .accessibilityIdentifier("controls.autonomy")
                } header: {
                    Text("Autonomy")
                } footer: {
                    // Same double gate as live mode: a deploy variable and this
                    // toggle. The kill switch halts it like everything else.
                    Text(store.autonomyEnabled
                         ? "When on, a new signal you neither approve nor reject within \(store.autonomyVetoMinutes) minutes is approved for you, under the same caps. Rejecting inside the window always wins. The kill switch stops it."
                         : "Autonomy is disabled at the environment level (AUTONOMY_ENABLED). Unlocking it needs a deploy, not a toggle.")
                }

                if let failure {
                    Section { ErrorRow(error: .server(failure)) }
                }
            }
            .navigationTitle("Controls")
            .refreshable { await store.refresh() }
            .confirmationDialog(
                store.killSwitch ? "Resume Ollie?" : "Halt Ollie?",
                isPresented: $confirmingHalt,
                titleVisibility: .visible
            ) {
                Button(
                    store.killSwitch ? "Resume" : "Halt everything",
                    role: store.killSwitch ? nil : .destructive
                ) {
                    Task { await toggle() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(store.killSwitch
                     ? "Proposals resume on the next scheduled run."
                     : "Stops new proposals and refuses execution until you turn it back on.")
            }
        }
    }

    private func setAutonomy(_ on: Bool) async {
        isWorking = true
        failure = nil
        defer { isWorking = false }
        do {
            try await store.setAutonomy(on)
        } catch let error as OllieError {
            failure = error.errorDescription
        } catch {
            failure = error.localizedDescription
        }
    }

    private func toggle() async {
        isWorking = true
        failure = nil
        defer { isWorking = false }

        do {
            try await store.setKillSwitch(!store.killSwitch)
        } catch let error as OllieError {
            failure = error.errorDescription
        } catch {
            failure = error.localizedDescription
        }
    }
}
