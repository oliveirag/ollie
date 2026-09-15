import Foundation
import OpenAPIRuntime
import SignalAPI
import SwiftUI

typealias PublishedSignal = SignalAPI.Components.Schemas.PublishedSignal
typealias PublishedSignalDetail = SignalAPI.Components.Schemas.PublishedSignalDetail
typealias RecordRow = SignalAPI.Components.Schemas.RecordRow
typealias Onboarding = SignalAPI.Components.Schemas.Onboarding
typealias McpToken = SignalAPI.Components.Schemas.McpToken
typealias SubscriberTrackRecord = SignalAPI.Components.Schemas.SubscriberTrackRecord
typealias OpenPosition = SignalAPI.Components.Schemas.OpenPosition

/// The subscriber side's state (Phase 4, milestones 4.5–4.6).
///
/// Where the subscriber is in onboarding is read from rows, never from a local
/// flag: the service reports whether the current disclaimer was accepted and
/// whether an unrevoked MCP token exists, and `phase` is derived from that on
/// every refresh. The one piece of state that lives only here is the
/// just-minted token plaintext, because it exists nowhere else — the server
/// keeps a hash, and this object drops it the moment the handoff is dismissed.
@MainActor
@Observable
final class SubscriberStore {
    enum Phase: Equatable {
        case signedOut
        case loading
        case disclaimer
        case handoff
        case ready
    }

    /// The plaintext MCP token, shown exactly once.
    struct MintedToken: Equatable {
        let token: String
        let mcpURL: String?
    }

    private(set) var onboarding: Onboarding?
    private(set) var feed: [PublishedSignal] = []
    private(set) var record: SubscriberTrackRecord?
    private(set) var tokens: [McpToken] = []
    private(set) var minted: MintedToken?
    private(set) var isLoading = false
    private(set) var lastRefreshed: Date?
    var error: OllieError?

    var token: String? {
        didSet { if token != oldValue { reset() } }
    }

    init(token: String? = TokenStore.read(.subscriber)) {
        self.token = token
    }

    var phase: Phase {
        guard token != nil else { return .signedOut }
        guard let onboarding else { return .loading }
        if !onboarding.accepted_current_version { return .disclaimer }
        if minted != nil || !onboarding.has_mcp_token { return .handoff }
        return .ready
    }

    var mcpURL: String? { onboarding?.mcp_url }

    private func reset() {
        onboarding = nil
        feed = []
        record = nil
        tokens = []
        minted = nil
        lastRefreshed = nil
        error = nil
    }

    private func client() throws -> SignalAPI.Client {
        guard let token, !token.isEmpty else { throw OllieError.unauthorized }
        return SignalClientFactory.client(token: token)
    }

    // MARK: Onboarding

    /// Sign in with Apple's identity token → an app session token. The invite
    /// code is only consulted on a first sign-in, but it is sent whenever the
    /// user typed one; the service decides.
    func signIn(identityToken: String, inviteCode: String?) async throws {
        let client = SignalClientFactory.client(token: nil)
        let body = SignalAPI.Components.Schemas.SessionRequestInput(
            identity_token: identityToken,
            invite_code: inviteCode?.isEmpty == false ? inviteCode : nil
        )
        switch try await client.createSession(.init(body: .json(body))) {
        case .ok(let ok):
            let session = try ok.body.json
            TokenStore.save(session.token, account: .subscriber)
            token = session.token
            await refresh()
        case .forbidden:
            throw OllieError.server("That invite code was not accepted.")
        case .unauthorized:
            throw OllieError.server("Apple did not verify this sign-in. Try again.")
        case .badRequest:
            throw OllieError.server("The sign-in request failed validation.")
        case .undocumented(let status, _):
            throw OllieError.server("Sign-in returned \(status).")
        }
    }

    func signOut() {
        TokenStore.delete(.subscriber)
        token = nil
    }

    func acceptDisclaimer() async throws {
        guard let version = onboarding?.disclaimer.version else { return }
        let body = SignalAPI.Components.Schemas.AcceptDisclaimerRequestInput(version: version)
        switch try await client().acceptDisclaimer(.init(body: .json(body))) {
        case .ok:
            // Mint straight away: the handoff screen is the next thing the
            // subscriber sees, and the acceptance row now predates the token.
            try await mintToken()
        case .conflict:
            // The text changed under us. Re-fetch and re-display.
            await loadOnboarding()
            throw OllieError.server("The disclaimer was updated. Please read the new version.")
        case .unauthorized:
            throw OllieError.unauthorized
        case .badRequest:
            throw OllieError.server("The acceptance failed validation.")
        case .undocumented(let status, _):
            throw OllieError.server("Accept returned \(status).")
        }
    }

    func mintToken() async throws {
        switch try await client().mintMcpToken(.init()) {
        case .ok(let ok):
            let payload = try ok.body.json
            minted = MintedToken(token: payload.token, mcpURL: payload.mcp_url)
            await loadOnboarding()
            await loadTokens()
        case .conflict:
            await loadOnboarding()
            throw OllieError.server("Accept the disclaimer before creating an agent token.")
        case .unauthorized:
            throw OllieError.unauthorized
        case .undocumented(let status, _):
            throw OllieError.server("Token mint returned \(status).")
        }
    }

    /// The handoff is over; the plaintext is gone from memory. The shell that
    /// replaces the handoff screen loads the feed and record on appear.
    func completeHandoff() {
        minted = nil
    }

    func revoke(id: String) async throws {
        switch try await client().revokeMcpToken(.init(path: .init(id: id))) {
        case .noContent:
            await loadTokens()
            await loadOnboarding()
        case .notFound:
            await loadTokens()
        case .unauthorized:
            throw OllieError.unauthorized
        case .badRequest:
            throw OllieError.server("The revoke request failed validation.")
        case .undocumented(let status, _):
            throw OllieError.server("Revoke returned \(status).")
        }
    }

    // MARK: Reads

    func refresh() async {
        isLoading = true
        defer { isLoading = false }

        await loadOnboarding()
        guard phase == .ready || phase == .handoff else { return }
        await loadFeed()
        await loadRecord()
        await loadTokens()
        lastRefreshed = Date()
    }

    private func loadOnboarding() async {
        do {
            switch try await client().getOnboarding(.init()) {
            case .ok(let ok):
                onboarding = try ok.body.json
                error = nil
            case .unauthorized:
                // The session token was revoked or never existed server-side.
                signOut()
            case .undocumented(let status, _):
                error = .server("Onboarding returned \(status).")
            }
        } catch let ollie as OllieError {
            error = ollie
        } catch {
            self.error = Self.translate(error)
        }
    }

    private func loadFeed() async {
        do {
            if case .ok(let ok) = try await client().getFeed(.init(query: .init(limit: 50))) {
                feed = try ok.body.json.signals
            }
        } catch {
            // Left as it was; the view reports staleness.
        }
    }

    private func loadRecord() async {
        do {
            if case .ok(let ok) = try await client().getSubscriberTrackRecord(.init()) {
                record = try ok.body.json
            }
        } catch {
            // Left as it was.
        }
    }

    private func loadTokens() async {
        do {
            if case .ok(let ok) = try await client().listMcpTokens(.init()) {
                tokens = try ok.body.json.tokens
            }
        } catch {
            // Left as it was.
        }
    }

    func detail(id: String) async throws -> PublishedSignalDetail {
        switch try await client().getPublishedSignal(.init(path: .init(id: id))) {
        case .ok(let ok):
            return try ok.body.json
        case .notFound, .badRequest:
            throw OllieError.notFound
        case .unauthorized:
            throw OllieError.unauthorized
        case .undocumented(let status, _):
            throw OllieError.server("Signal returned \(status).")
        }
    }

    private static func translate(_ error: any Error) -> OllieError {
        guard let urlError = (error as? URLError) ?? (error as NSError).userInfo[NSUnderlyingErrorKey] as? URLError else {
            return .server(error.localizedDescription)
        }
        return switch urlError.code {
        case .notConnectedToInternet, .networkConnectionLost:
            .offline("No network connection.")
        case .cannotConnectToHost, .cannotFindHost:
            .offline("Is the signal service running at \(SignalServer.baseURL.absoluteString)?")
        case .timedOut:
            .offline("The request timed out.")
        default:
            .offline(urlError.localizedDescription)
        }
    }
}
