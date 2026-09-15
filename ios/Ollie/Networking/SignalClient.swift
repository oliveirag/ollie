import Foundation
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession
import SignalAPI

/// Where the signal service lives. A different host from the owner API on
/// purpose (Phase 4, decision 4): the subscriber surface is its own process
/// with its own database role, and the app never points a subscriber at the
/// owner's endpoint.
enum SignalServer {
    static var baseURL: URL {
        if let override = Bundle.main.object(forInfoDictionaryKey: "OllieSignalBaseURL") as? String,
           !override.isEmpty,
           let url = URL(string: override) {
            return url
        }
        return URL(string: "http://localhost:3100")!
    }
}

/// Attaches the subscriber's app session token. Absent for the one public
/// call, `createSession`, which is how the token is obtained.
struct SubscriberTokenMiddleware: ClientMiddleware {
    let token: String?

    func intercept(
        _ request: HTTPRequest,
        body: HTTPBody?,
        baseURL: URL,
        operationID: String,
        next: (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
    ) async throws -> (HTTPResponse, HTTPBody?) {
        var request = request
        if let token { request.headerFields[.authorization] = "Bearer \(token)" }
        return try await next(request, body, baseURL)
    }
}

@MainActor
enum SignalClientFactory {
    static func client(token: String?) -> SignalAPI.Client {
        SignalAPI.Client(
            serverURL: SignalServer.baseURL,
            // Same reason as the owner client: every timestamp carries
            // milliseconds and the default transcoder rejects them.
            configuration: Configuration(dateTranscoder: .iso8601WithFractionalSeconds),
            transport: URLSessionTransport(),
            middlewares: [SubscriberTokenMiddleware(token: token)]
        )
    }
}
