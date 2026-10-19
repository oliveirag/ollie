import AuthenticationServices
import SwiftUI

/// Sign in with Apple plus the soft-launch invite code (Phase 4, decisions 3
/// and 8). The identity token Apple hands back goes to the signal service,
/// which verifies it against Apple's keys; the app never learns anything from
/// it but a session token.
///
/// The Debug-only "test identity" button exists because Sign in with Apple
/// needs a paid Apple Developer team and per-app configuration the simulator
/// does not have. It sends a `fake:` token the service accepts only with
/// `SIWA_STUB=true`, which it refuses in production.
struct SubscriberSignInView: View {
    let onBack: () -> Void

    @Environment(SubscriberStore.self) private var store
    @Environment(\.colorScheme) private var colorScheme

    @State private var inviteCode = ""
    @State private var isWorking = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            DSPage {
                Text("Ollie is invite-only for now. Returning subscribers can leave the code blank.")
                    .dsFont(.body)
                    .foregroundStyle(DS.Text.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                DSTextField(label: "Invite code", placeholder: "Invite code", text: $inviteCode)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("signin.inviteCode")

                VStack(alignment: .leading, spacing: DS.Space.sm) {
                    // Apple's own button, as the HIG requires, with the
                    // design system's corner radius and control height.
                    SignInWithAppleButton(.signIn) { request in
                        request.requestedScopes = [.email]
                    } onCompletion: { result in
                        Task { await complete(result) }
                    }
                    .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                    .frame(height: DS.ControlHeight.lg)
                    .clipShape(RoundedRectangle(cornerRadius: DS.Radius.md, style: .continuous))
                    .disabled(isWorking)

                    #if DEBUG
                    if TokenStore.testIdentityEnabled {
                        Button("Continue with a test identity") {
                            Task { await signIn(identityToken: Self.testIdentityToken()) }
                        }
                        .buttonStyle(.ds(.secondary, size: .large))
                        .accessibilityIdentifier("signin.testIdentity")
                        .disabled(isWorking)
                    }
                    #endif

                    Text("Apple shares only a stable identifier and, if you choose, a relay email. "
                         + "Ollie never sees a password and never asks for brokerage credentials.")
                        .dsFont(.caption)
                        .foregroundStyle(DS.Text.secondary)
                        .padding(.horizontal, DS.Space.xs)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if isWorking {
                    ProgressView().frame(maxWidth: .infinity)
                }

                if let failure {
                    ErrorRow(error: .server(failure))
                }
            }
            .navigationTitle("Subscribe")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Back", action: onBack)
                }
            }
        }
    }

    private func complete(_ result: Result<ASAuthorization, any Error>) async {
        switch result {
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let data = credential.identityToken,
                  let token = String(data: data, encoding: .utf8)
            else {
                failure = "Apple returned no identity token."
                return
            }
            await signIn(identityToken: token)
        case .failure(let error):
            // The user cancelling is not an error worth a red row.
            if (error as? ASAuthorizationError)?.code == .canceled { return }
            failure = error.localizedDescription
        }
    }

    private func signIn(identityToken: String) async {
        isWorking = true
        failure = nil
        defer { isWorking = false }

        do {
            try await store.signIn(identityToken: identityToken, inviteCode: inviteCode)
        } catch let error as OllieError {
            failure = error.errorDescription
        } catch {
            failure = error.localizedDescription
        }
    }

    #if DEBUG
    /// A fresh subject every time, so a repeated UI test run onboards a new
    /// subscriber rather than finding the last run's rows.
    private static func testIdentityToken() -> String {
        let sub = "test." + UUID().uuidString.lowercased()
        return #"fake:{"sub":"\#(sub)","email":"\#(sub)@example.test"}"#
    }
    #endif
}
