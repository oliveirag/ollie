import AuthenticationServices
import UIKit

/// Signs in with Apple once more, without any UI of Ollie's own, to get a fresh
/// authorization code just before the account is deleted. The signal service
/// exchanges that code for a token and revokes it with Apple, which is how the
/// app's Sign in with Apple link is cut when the account goes (TN3194).
///
/// Returns nil when the person cancels or Apple cannot complete the request:
/// the deletion goes ahead regardless, because Apple's own guidance is that a
/// missing code never blocks it.
@MainActor
final class AppleReauthorizer: NSObject, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding
{
    private var continuation: CheckedContinuation<String?, Never>?

    func authorizationCode() async -> String? {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = []
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    nonisolated func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        let code = (authorization.credential as? ASAuthorizationAppleIDCredential)?
            .authorizationCode
            .flatMap { String(data: $0, encoding: .utf8) }
        Task { @MainActor in self.finish(code) }
    }

    nonisolated func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: any Error
    ) {
        Task { @MainActor in self.finish(nil) }
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        }
    }

    private func finish(_ code: String?) {
        continuation?.resume(returning: code)
        continuation = nil
    }
}
