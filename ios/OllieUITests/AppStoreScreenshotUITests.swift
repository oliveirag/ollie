import XCTest

/// The App Store screenshots, captured from the real app against a seeded
/// local stack (`backend/scripts/seed-published-feed.ts`). Not an assertion
/// suite beyond reaching each screen. Run it on the 6.9-inch simulator; App
/// Store Connect scales those down for every smaller iPhone. Extract with:
///
///     xcrun xcresulttool export attachments --path <result>.xcresult --output-path <dir>
final class AppStoreScreenshotUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func capture(_ name: String, settle: TimeInterval = 1.5) {
        Thread.sleep(forTimeInterval: settle)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testCaptureStoreScreens() throws {
        guard let inviteCode = OnboardingDriver.inviteCode else {
            XCTFail("export TEST_RUNNER_SUBSCRIBER_INVITE_CODE before running")
            return
        }
        let app = OnboardingDriver.launch()
        XCTAssertTrue(app.buttons["welcome.subscribe"].waitForExistence(timeout: 20))
        capture("01-welcome")

        OnboardingDriver.signIn(app, inviteCode: inviteCode)
        XCTAssertTrue(app.buttons["disclaimer.accept"].waitForExistence(timeout: 20))
        capture("05-disclaimer")
        OnboardingDriver.acceptDisclaimer(app)

        // No capture of the handoff: it shows a token's plaintext, which reads
        // as a leaked secret in a store screenshot even when it is a local one.
        OnboardingDriver.finishHandoff(app)

        let row = app.buttons["feed.row"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "feed is empty; seed the published feed first")
        capture("02-feed", settle: 2.5)

        row.tap()
        capture("03-signal", settle: 2.5)
        app.navigationBars.buttons.element(boundBy: 0).tap()

        app.tabBars.buttons["Record"].tap()
        XCTAssertTrue(app.navigationBars["Record"].waitForExistence(timeout: 10))
        capture("04-record", settle: 2.5)

        app.tabBars.buttons["Agent"].tap()
        capture("06-agent")
    }
}
