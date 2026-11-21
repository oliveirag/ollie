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
