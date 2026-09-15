import Foundation
import OpenAPIRuntime
import SwiftUI

typealias SignalSummary = Components.Schemas.SignalSummary
typealias SignalDetail = Components.Schemas.SignalDetail
typealias Dashboard = Components.Schemas.Dashboard
typealias OpenLot = Components.Schemas.OpenLot
typealias TrackRecord = Components.Schemas.TrackRecord
typealias CurvePoint = Components.Schemas.CurvePoint

@MainActor
@Observable
final class SignalStore {
    private(set) var pending: [SignalSummary] = []
    private(set) var decided: [SignalSummary] = []
    private(set) var mode: TradingMode = .paper
    private(set) var killSwitch = false
    private(set) var liveTradingEnabled = false
    private(set) var autonomy = false
    private(set) var autonomyEnabled = false
    private(set) var autonomyVetoMinutes = 0

    private(set) var dashboard: Dashboard?
    private(set) var trackRecord: TrackRecord?

    private(set) var isLoading = false
    private(set) var lastRefreshed: Date?
    var error: OllieError?

    var token: String? {
        didSet { if token != oldValue { reset() } }
    }

    init(token: String? = TokenStore.read()) {
        self.token = token
    }

    private func reset() {
        pending = []
        decided = []
        dashboard = nil
        trackRecord = nil
        lastRefreshed = nil
        error = nil
    }

    private func client() throws -> Client {
        guard let token, !token.isEmpty else { throw OllieError.unauthorized }
        return OllieAPI.client(token: token)
    }

    /// Settings first: the mode drives the rail and the app tint, so a refresh
    /// that loaded signals but not the mode would render the whole shell in the
    /// wrong colour.
    func refresh() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let client = try client()
            try await loadSettings(client)
            try await loadSignals(client)
            await loadDashboard(client)
            await loadTrackRecord(client)
            lastRefreshed = Date()
            error = nil
        } catch let ollie as OllieError {
            error = ollie
        } catch {
            self.error = Self.translate(error)
        }
    }

    private func loadSettings(_ client: Client) async throws {
        switch try await client.getSettings(.init()) {
        case .ok(let ok):
            apply(try ok.body.json)
        case .unauthorized:
            throw OllieError.unauthorized
        case .undocumented(let status, _):
            throw OllieError.server("Settings returned \(status).")
        }
    }

    private func apply(_ settings: Components.Schemas.Settings) {
        mode = settings.execution_mode == .live ? .live : .paper
        killSwitch = settings.kill_switch
        liveTradingEnabled = settings.live_trading_enabled
        autonomy = settings.autonomy
        autonomyEnabled = settings.autonomy_enabled
        autonomyVetoMinutes = settings.autonomy_veto_minutes
    }

    /// The runtime half of the autonomy gate (Phase 5). Not optimistic, for the
    /// kill switch's reason: the displayed state is what the server confirmed.
    func setAutonomy(_ on: Bool) async throws {
        try await updateSettings(Components.Schemas.SettingsUpdateInput(autonomy: on))
    }

    private func updateSettings(_ body: Components.Schemas.SettingsUpdateInput) async throws {
        switch try await client().updateSettings(.init(body: .json(body))) {
        case .ok(let ok):
            apply(try ok.body.json)
        case .conflict(let conflict):
            throw OllieError.server(try conflict.body.json.detail ?? "Refused.")
        case .unauthorized:
            throw OllieError.unauthorized
        case .badRequest:
            throw OllieError.server("The settings update failed validation.")
        case .undocumented(let status, _):
            throw OllieError.server("Settings update returned \(status).")
        }
    }

    private func loadSignals(_ client: Client) async throws {
        switch try await client.listSignals(.init(query: .init(status: .pending))) {
        case .ok(let ok):
            pending = try ok.body.json.signals
        case .unauthorized:
            throw OllieError.unauthorized
        case .badRequest:
            throw OllieError.server("The signals request failed validation.")
        case .undocumented(let status, _):
            throw OllieError.server("Signals returned \(status).")
        }

        switch try await client.listSignals(.init(query: .init(status: .decided, limit: 30))) {
        case .ok(let ok):
            decided = try ok.body.json.signals
        case .unauthorized:
            throw OllieError.unauthorized
        // History is secondary; a failure here must not blank the queue.
        case .badRequest, .undocumented:
            break
        }
    }

    /// Never throws. The dashboard is instrumentation; a failure here must not
    /// take down the approvals queue, which is the screen that matters when a
    /// signal is ticking.
    private func loadDashboard(_ client: Client) async {
        do {
            if case .ok(let ok) = try await client.getDashboard(.init()) {
                dashboard = try ok.body.json
            }
        } catch {
            // Left as whatever it was; the view shows its own staleness.
        }
    }

    /// Never throws, for the same reason the dashboard loader does not: the
    /// record is instrumentation. A failure here must not blank the approvals
    /// queue, which is the screen that matters when a signal is ticking.
    private func loadTrackRecord(_ client: Client) async {
        do {
            if case .ok(let ok) = try await client.getTrackRecord(.init()) {
                trackRecord = try ok.body.json
            }
        } catch {
            // Left as whatever it was; the view shows its own empty state.
        }
    }

    /// Flip the kill switch. Deliberately not optimistic: the switch's whole
    /// purpose is that its displayed state is true, so the UI shows what the
    /// server confirmed rather than what was requested.
    func setKillSwitch(_ on: Bool) async throws {
        try await updateSettings(Components.Schemas.SettingsUpdateInput(kill_switch: on))
    }

    func detail(id: String) async throws -> SignalDetail {
        switch try await client().getSignal(.init(path: .init(id: id))) {
        case .ok(let ok):
            return try ok.body.json
        case .notFound:
            throw OllieError.notFound
        case .unauthorized:
            throw OllieError.unauthorized
        case .badRequest:
            throw OllieError.notFound  // A malformed id names nothing that exists.
        case .undocumented(let status, _):
            throw OllieError.server("Signal detail returned \(status).")
        }
    }

    struct DecisionResult {
        let status: String
        let fillPrice: String?
        /// Set when a live approval placed an order; the fill comes later.
        let orderState: String?
    }

    /// `confirmLive` is the per-approval confirmation (Phase 5, decision 4).
    /// Only the live decision sheet passes true, after its second tap.
    func decide(id: String, approve: Bool, reason: String?, confirmLive: Bool = false) async throws -> DecisionResult {
        let body = Components.Schemas.DecisionRequestInput(
            action: approve ? .approve : .reject,
            reason: reason?.isEmpty == false ? reason : nil,
            confirm_live: confirmLive ? true : nil
        )

        let output = try await client().decideSignal(
            .init(path: .init(id: id), body: .json(body))
        )

        switch output {
        case .ok(let ok):
            let decision = try ok.body.json
            // Refresh rather than mutate locally: the sweep may have changed
            // other rows while this request was in flight.
            await refresh()
            return DecisionResult(
                status: decision.signal.status.rawValue,
                fillPrice: decision.execution?.value1.fill_price,
                orderState: decision.order?.value1.state
            )

        case .conflict(let conflict):
            let payload = try conflict.body.json
            await refresh()
            throw OllieError.notPending(status: payload.status?.rawValue ?? "decided")

        case .notFound:
            await refresh()
            throw OllieError.notFound

        case .unauthorized:
            throw OllieError.unauthorized

        case .badRequest:
            throw OllieError.server("The decision failed validation.")

        case .internalServerError(let failure):
            let payload = try failure.body.json
            await refresh()
            throw OllieError.executionFailed(
                detail: payload.detail ?? "The signal was approved but not filled."
            )

        case .undocumented(let status, _):
            throw OllieError.server("Decision returned \(status).")
        }
    }

    private static func translate(_ error: any Error) -> OllieError {
        let urlError = (error as? URLError) ?? (error as NSError).underlyingURLError
        guard let urlError else { return .server(error.localizedDescription) }

        return switch urlError.code {
        case .notConnectedToInternet, .networkConnectionLost:
            .offline("No network connection.")
        case .cannotConnectToHost, .cannotFindHost:
            .offline("Is the backend running at \(OllieServer.baseURL.absoluteString)?")
        case .timedOut:
            .offline("The request timed out.")
        default:
            .offline(urlError.localizedDescription)
        }
    }
}

private extension NSError {
    /// The transport wraps the real URLError, so the surface error alone would
    /// render every connection problem as an opaque failure.
    var underlyingURLError: URLError? {
        if let direct = self as? URLError { return direct }
        var current: NSError? = self
        while let error = current {
            if let urlError = error as? URLError { return urlError }
            if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
                current = underlying
            } else {
                return nil
            }
        }
        return nil
    }
}
