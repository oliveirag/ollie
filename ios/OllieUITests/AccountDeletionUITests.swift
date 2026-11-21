import XCTest

/// App Store guideline 5.1.1(v): an account created in the app can be deleted
/// in the app. Onboards a fresh subscriber, deletes the account from the Agent
/// tab, and expects the welcome screen back. The backend side (tombstone,
/// tokens revoked, Apple revocation) is covered by the signal service's tests.
///
/// The Debug test identity has no Apple tokens, so the app skips the Sign in
/// with Apple prompt that precedes deletion on a device.
final class AccountDeletionUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testDeletingTheAccountReturnsToWelcome() throws {
        guard let inviteCode = OnboardingDriver.inviteCode else {
            XCTFail("export TEST_RUNNER_SUBSCRIBER_INVITE_CODE before running")
            return
        }
        let app = OnboardingDriver.launch()
        OnboardingDriver.signIn(app, inviteCode: inviteCode)
        OnboardingDriver.acceptDisclaimer(app)
        OnboardingDriver.finishHandoff(app)

        app.tabBars.buttons["Agent"].tap()
        let delete = app.buttons["settings.deleteAccount"]
        var swipes = 0
        while !delete.isHittable && swipes < 6 {
            app.swipeUp()
            swipes += 1
        }
        XCTAssertTrue(delete.waitForExistence(timeout: 10), "Delete account is missing from Agent")
        XCTAssertTrue(app.buttons["settings.privacy"].exists, "privacy policy link is missing")
        delete.tap()

        // The dialog's button shares the row's label; find it without the id.
        let confirm = app.buttons
            .matching(NSPredicate(format: "label == 'Delete account' AND identifier != 'settings.deleteAccount'"))
            .firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "delete confirmation did not appear")
        confirm.tap()

        XCTAssertTrue(app.buttons["welcome.subscribe"].waitForExistence(timeout: 20), "deleting did not sign out")
    }
}
