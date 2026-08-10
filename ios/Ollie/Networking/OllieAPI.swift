import Foundation
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession

/// Attaches the owner bearer token to every request.
///
/// A middleware rather than a per-call parameter so a new endpoint cannot ship
/// unauthenticated by omission — the same reason the backend registers its auth
/// hook on the /v1 scope instead of route by route.
struct OwnerTokenMiddleware: ClientMiddleware {
    let token: String

    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        request.headerFields[.authorization] = "Bearer \(token)"
        return try await next(request, body, baseURL)
    }
}

/// What the UI shows when a call fails. The API's own failure modes are
/// meaningful — a 409 means the sweep or another surface won a race, which is
/// the system working — so they are modelled rather than flattened into
/// "something went wrong".
enum OllieError: LocalizedError, Equatable {
    case unauthorized
    case notPending(status: String)
    case notFound
    case executionFailed(detail: String)
    case server(String)
    case offline(String)

    var errorDescription: String? {
        switch self {
        case .unauthorized:
            "The owner token was rejected. Check it in Settings."
        case .notPending(let status):
            "Already \(status)."
        case .notFound:
            "That signal no longer exists."
        case .executionFailed(let detail):
            detail
        case .server(let message):
            message
        case .offline(let message):
            "Can't reach Ollie. \(message)"
        }
    }

    /// A lost race is not a failure to apologise for — the list just needs to
    /// catch up with what actually happened.
    var isRace: Bool {
        if case .notPending = self { return true }
        return false
    }
}

/// Where the backend lives. Defaults to the simulator's view of the host
/// machine; overridable so a device build can point at Railway.
enum OllieServer {
    static var baseURL: URL {
        if let override = Bundle.main.object(forInfoDictionaryKey: "OllieBaseURL") as? String,
           !override.isEmpty,
           let url = URL(string: override) {
            return url
        }
        return URL(string: "http://localhost:3000")!
    }
}

@MainActor
enum OllieAPI {
    static func client(token: String) -> Client {
        Client(
            serverURL: OllieServer.baseURL,
            // The backend serializes every timestamp with `toISOString()`, so
            // they all carry milliseconds — "2026-08-09T03:41:14.780Z". The
            // default transcoder is strict ISO8601 without fractional seconds
            // and rejects every one of them, which fails the whole response
            // rather than one field.
            configuration: Configuration(dateTranscoder: .iso8601WithFractionalSeconds),
            transport: URLSessionTransport(),
            middlewares: [OwnerTokenMiddleware(token: token)]
        )
    }
}
