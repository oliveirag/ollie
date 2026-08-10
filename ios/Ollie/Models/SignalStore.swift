import Foundation
import OpenAPIRuntime
import SwiftUI

typealias SignalSummary = Components.Schemas.SignalSummary
typealias SignalDetail = Components.Schemas.SignalDetail

@MainActor
@Observable
final class SignalStore {
    private(set) var pending: [SignalSummary] = []
    private(set) var decided: [SignalSummary] = []
    private(set) var mode: TradingMode = .paper
    private(set) var killSwitch = false
    private(set) var liveTradingEnabled = false

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
            let settings = try ok.body.json
            mode = settings.execution_mode == .live ? .live : .paper
            killSwitch = settings.kill_switch
            liveTradingEnabled = settings.live_trading_enabled
        case .unauthorized:
            throw OllieError.unauthorized
        case .undocumented(let status, _):
            throw OllieError.server("Settings returned \(status).")
        }
    }

    private func loadSignals(_ client: Client) async throws {
        switch try await client.listSignals(.init(query: .init(status: .pending))) {
        case .ok(let ok):
            pending = try ok.body.json.signals
        case .unauthorized:
            throw OllieError.unauthorized
        case .undocumented(let status, _):
            throw OllieError.server("Signals returned \(status).")
        }

        switch try await client.listSignals(.init(query: .init(status: .decided, limit: 30))) {
        case .ok(let ok):
            decided = try ok.body.json.signals
        case .unauthorized:
            throw OllieError.unauthorized
        case .undocumented:
            break  // History is secondary; a failure here must not blank the queue.
        }
    }

    func detail(id: String) async throws -> SignalDetail {
        switch try await client().getSignal(.init(path: .init(id: id))) {
        case .ok(let ok):
            return try ok.body.json
        case .notFound:
            throw OllieError.notFound
        case .unauthorized:
            throw OllieError.unauthorized
        case .undocumented(let status, _):
            throw OllieError.server("Signal detail returned \(status).")
        }
    }

    struct DecisionResult {
        let status: String
        let fillPrice: String?
    }

    func decide(id: String, approve: Bool, reason: String?) async throws -> DecisionResult {
        let body = Components.Schemas.DecisionRequestInput(
            action: approve ? .approve : .reject,
            reason: reason?.isEmpty == false ? reason : nil
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
                fillPrice: decision.execution?.value1.fill_price
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
