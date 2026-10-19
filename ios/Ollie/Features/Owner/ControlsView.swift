import SwiftUI

/// Kill switch and mode toggle (PRD §4.3).
struct ControlsView: View {
    @Environment(SignalStore.self) private var store

    @State private var confirmingHalt = false
    @State private var isWorking = false
    @State private var failure: String?
    /// Bumped only when the owner's own halt or resume lands, so the haptic
    /// answers their tap and not a state change a refresh happened to bring in.
    @State private var switchConfirmed = 0

    var body: some View {
        NavigationStack {
            DSPage {
                DSSection(
                    "Kill switch",
                    footer: "Halting stops new proposals and refuses execution immediately. "
                        + "It is enforced in the pipeline, not just here."
                ) {
                    VStack(alignment: .leading, spacing: DS.Space.lg) {
                        HStack(alignment: .firstTextBaseline, spacing: DS.Space.sm) {
                            Image(systemName: store.killSwitch ? "octagon.fill" : "play.circle")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(store.killSwitch ? DS.Icon.error : DS.Icon.primary)
                            VStack(alignment: .leading, spacing: DS.Space.xs) {
                                Text(store.killSwitch ? "Halted" : "Running")
                                    .dsFont(.body, weight: .bold)
                                    .foregroundStyle(store.killSwitch ? DS.Text.error : DS.Text.primary)
                                Text(store.killSwitch
                                     ? "No proposals, no execution."
                                     : "Proposing on schedule.")
                                    .dsFont(.bodySmall)
                                    .foregroundStyle(DS.Text.secondary)
                            }
                            Spacer()
                            if isWorking { ProgressView() }
                        }
                        .accessibilityElement(children: .combine)

                        // Halting is the one destructive control here, so it
                        // is the red one. Resuming is ordinary.
                        Button {
                            confirmingHalt = true
                        } label: {
                            Label(
                                store.killSwitch ? "Resume Ollie…" : "Halt Ollie…",
                                systemImage: store.killSwitch ? "play.fill" : "octagon.fill"
                            )
                        }
                        .buttonStyle(.ds(store.killSwitch ? .secondary : .destructive))
                        .disabled(isWorking)
                    }
                }

                DSSection(
                    "Mode",
                    footer: store.liveTradingEnabled
                        ? "Live trading is unlocked at the environment level."
                        : "Live trading is disabled at the environment level "
                          + "(LIVE_TRADING_ENABLED). Unlocking it needs a deploy, not a toggle."
                ) {
                    // Read-only on purpose, mirroring the executor's double
                    // gate: one flips at runtime, the other needs a deploy.
                    DSValueRow("Execution mode") {
                        HStack(spacing: DS.Space.sm) {
                            Image(systemName: store.liveTradingEnabled ? "lock.open" : "lock.fill")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(DS.Icon.tertiary)
                                .accessibilityLabel(store.liveTradingEnabled ? "Unlocked" : "Locked")
                            Text(store.mode.rawValue.capitalized)
                                .dsFont(.body)
                                .foregroundStyle(DS.Text.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }

                DSSection(
                    "Autonomy",
                    // Same double gate as live mode: a deploy variable and this
                    // toggle. The kill switch halts it like everything else.
                    footer: store.autonomyEnabled
                        ? "When on, a new signal you neither approve nor reject within \(store.autonomyVetoMinutes) minutes is approved for you, under the same caps. Rejecting inside the window always wins. The kill switch stops it."
                        : "Autonomy is disabled at the environment level (AUTONOMY_ENABLED). Unlocking it needs a deploy, not a toggle."
                ) {
                    Toggle(isOn: Binding(
                        get: { store.autonomy },
                        set: { on in Task { await setAutonomy(on) } }
                    )) {
                        Label("Auto-approve after \(store.autonomyVetoMinutes) min", systemImage: store.autonomyEnabled ? "timer" : "lock.fill")
                    }
                    .toggleStyle(.ds)
                    .disabled(!store.autonomyEnabled || isWorking)
                    .accessibilityIdentifier("controls.autonomy")
                }

                if let failure {
                    ErrorRow(error: .server(failure))
                }
            }
            .navigationTitle("Controls")
            .refreshable { await store.refresh() }
            .sensoryFeedback(store.killSwitch ? .warning : .success, trigger: switchConfirmed)
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
            switchConfirmed += 1
        } catch let error as OllieError {
            failure = error.errorDescription
        } catch {
            failure = error.localizedDescription
        }
    }
}
