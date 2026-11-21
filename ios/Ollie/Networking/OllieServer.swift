import Foundation
import OpenAPIRuntime

// Shared by both apps. The owner client (OllieAPI.swift) and the subscriber
// client (SignalClient.swift) each build on these; the App Store target
// compiles only the subscriber side, so nothing here may name an owner type.

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
            Self.unauthorizedMessage
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

    /// Each app's own wording: the App Store app has no owner token to talk about.
    private static var unauthorizedMessage: String {
        #if OWNER_CONSOLE
        return "The owner token was rejected. Disconnect in Controls and paste the current one."
        #else
        return "Your session ended. Sign in again."
        #endif
    }

    /// Maps a transport failure to what the UI shows. The generated client
    /// wraps every transport error in `ClientError`, so it is unwrapped first;
    /// otherwise every connection problem would surface as an opaque message.
    static func fromTransport(_ error: any Error, host: URL) -> OllieError {
        if let clientError = error as? ClientError {
            return fromTransport(clientError.underlyingError, host: host)
        }
        guard let urlError = underlyingURLError(of: error) else {
            return .server(error.localizedDescription)
        }
        return switch urlError.code {
        case .notConnectedToInternet, .networkConnectionLost:
            .offline("No network connection.")
        case .cannotConnectToHost, .cannotFindHost:
            .offline("Is the backend running at \(host.absoluteString)?")
        case .timedOut:
            .offline("The request timed out.")
        default:
            .offline(urlError.localizedDescription)
        }
    }

    private static func underlyingURLError(of error: any Error) -> URLError? {
        if let direct = error as? URLError { return direct }
        var current: NSError? = error as NSError
        while let nsError = current {
            if let urlError = nsError as? URLError { return urlError }
            current = nsError.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return nil
    }

    /// A lost race is not a failure to apologise for — the list just needs to
    /// catch up with what actually happened.
    var isRace: Bool {
        if case .notPending = self { return true }
        return false
    }
}

/// Where the backend lives: `OllieBaseURL` in Info.plist, set per build
/// configuration in project.yml.
enum OllieServer {
    static var baseURL: URL {
        configuredURL(infoKey: "OllieBaseURL", debugFallback: "http://localhost:3000")
    }

    /// Reads a base URL from Info.plist. Only a Debug build may fall back to
    /// localhost when the key is missing; a Release build that silently talked
    /// to localhost would just fail every call with a misleading offline
    /// message, so it stops on first use instead and the broken build never ships.
    static func configuredURL(infoKey: String, debugFallback: String) -> URL {
        if let value = Bundle.main.object(forInfoDictionaryKey: infoKey) as? String,
           !value.isEmpty,
           let url = URL(string: value) {
            return url
        }
        #if DEBUG
        return URL(string: debugFallback)!
        #else
        fatalError("\(infoKey) is missing or invalid in Info.plist; check the Release settings in project.yml")
        #endif
    }
}
