import XCTest

/// Milestones 4.5 and 4.6's exit criteria, automated.
///
/// Drives a complete onboarding through the real UI against the signal
/// service on localhost:3100: welcome → invite code → sign-in → the disclaimer
/// (scrolled to the end, because Accept is disabled until then) → the
/// one-time token handoff → the feed and the record. The rows it leaves in
/// Postgres (user, acceptance, hashed token) are checked afterwards; see the
/// README.
///
/// Sign in with Apple cannot run on the simulator without a paid team, so the
/// app under test is launched with `SUBSCRIBER_TEST_IDENTITY=1`, which enables
/// the Debug-only test identity button, and the service must run with
/// `SIWA_STUB=true`. That path exists for exactly this test.
///
/// Requires: signal service on :3100 with SIWA_STUB=true and
/// SUBSCRIBER_INVITE_CODES containing the value exported as
/// TEST_RUNNER_SUBSCRIBER_INVITE_CODE.
final class SubscriberOnboardingUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launchApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["OLLIE_DISABLE_PUSH"] = "1"
        app.launchEnvironment["RESET_SUBSCRIBER"] = "1"
        app.launchEnvironment["SUBSCRIBER_TEST_IDENTITY"] = "1"
        app.launch()
        return app
    }

    private var inviteCode: String? {
        ProcessInfo.processInfo.environment["SUBSCRIBER_INVITE_CODE"]
    }

    func testCompleteOnboardingLeavesTheSubscriberOnTheFeed() throws {
        guard let inviteCode else {
            XCTFail("export TEST_RUNNER_SUBSCRIBER_INVITE_CODE before running")
            return
        }
        let app = launchApp()

        // Welcome → Subscribe.
        let subscribe = app.buttons["welcome.subscribe"]
        XCTAssertTrue(subscribe.waitForExistence(timeout: 20), "welcome screen missing")
        subscribe.tap()

        // Invite code, then the Debug test identity in place of Apple.
        let field = app.textFields["signin.inviteCode"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(inviteCode)

        let testIdentity = app.buttons["signin.testIdentity"]
        XCTAssertTrue(testIdentity.waitForExistence(timeout: 5), "test identity button missing — is this a Debug build?")
        testIdentity.tap()

        // The disclaimer. Accept enables once the end of the text has been on
        // screen — immediately on a screen tall enough to show all of it, which
        // is this one at the default text size. The gate itself is pinned by
        // the test below, at a text size that forces the text to overflow.
        let accept = app.buttons["disclaimer.accept"]
        XCTAssertTrue(accept.waitForExistence(timeout: 20), "disclaimer did not appear")

        let scroll = app.scrollViews["disclaimer.scroll"]
        var swipes = 0
        while !accept.isEnabled && swipes < 25 {
            scroll.swipeUp()
            swipes += 1
        }
        XCTAssertTrue(accept.isEnabled, "Accept never enabled after scrolling")
        accept.tap()

        // The token, once.
        let token = app.staticTexts["handoff.token"]
        XCTAssertTrue(token.waitForExistence(timeout: 20), "token handoff did not appear")
        // Read now: the element is gone once the handoff screen is dismissed.
        let tokenText = token.label
        XCTAssertTrue(tokenText.hasPrefix("ollie_mcp_"), "token has the wrong shape: \(tokenText)")
        XCTAssertTrue(app.staticTexts["handoff.url"].exists, "MCP URL missing from the handoff")
        app.buttons["handoff.done"].tap()

        // The shell, with the reminder rail on both screens.
        let rail = app.descendants(matching: .any)["disclaimer-rail"]
        XCTAssertTrue(rail.waitForExistence(timeout: 20), "disclaimer rail missing on the feed")
        XCTAssertTrue(app.tabBars.buttons["Feed"].exists)

        app.tabBars.buttons["Record"].tap()
        XCTAssertTrue(rail.exists, "disclaimer rail missing on the record")
        XCTAssertTrue(app.navigationBars["Record"].waitForExistence(timeout: 10))

        // The record screen reports absence rather than zero, and the curve
        // either draws or says why not — the same pins as the owner's screen.
        let hasValue = app.descendants(matching: .any)["record.winRate"]
        let hasNone = app.descendants(matching: .any)["record.winRate.none"]
        let chart = app.descendants(matching: .any)["curve.chart"]
        let insufficient = app.descendants(matching: .any)["curve.insufficient"]
        let empty = app.staticTexts["No record yet"]
        let rendered = hasValue.waitForExistence(timeout: 10) || hasNone.exists || empty.exists
        XCTAssertTrue(rendered, "record screen rendered neither stats nor the empty state")
        XCTAssertFalse(hasValue.exists && hasNone.exists, "win rate rendered as both a value and an absence")
        XCTAssertFalse(chart.exists && insufficient.exists, "curve rendered two ways at once")

        // Agent tab: the token we were handed is listed, without its plaintext.
        app.tabBars.buttons["Agent"].tap()
        XCTAssertTrue(app.buttons["token.revoke"].waitForExistence(timeout: 10), "the minted token is not listed")
        XCTAssertFalse(app.staticTexts[tokenText].exists, "the plaintext token leaked into the list")
    }

    /// The gate, at the largest accessibility text size, where the disclaimer
    /// cannot fit on one screen: Accept stays disabled with no scrolling, and
    /// enables only once the reader has scrolled to the end.
    func testAcceptStaysDisabledUntilTheEndIsReached() throws {
        guard let inviteCode else {
            XCTFail("export TEST_RUNNER_SUBSCRIBER_INVITE_CODE before running")
            return
        }
        let app = XCUIApplication()
        app.launchEnvironment["OLLIE_DISABLE_PUSH"] = "1"
        app.launchEnvironment["RESET_SUBSCRIBER"] = "1"
        app.launchEnvironment["SUBSCRIBER_TEST_IDENTITY"] = "1"
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()

        let subscribe = app.buttons["welcome.subscribe"]
        XCTAssertTrue(subscribe.waitForExistence(timeout: 20))
        subscribe.tap()
        let field = app.textFields["signin.inviteCode"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(inviteCode)
        let testIdentity = app.buttons["signin.testIdentity"]
        if !testIdentity.isHittable { app.swipeUp() }
        testIdentity.tap()

        let accept = app.buttons["disclaimer.accept"]
        XCTAssertTrue(accept.waitForExistence(timeout: 20))
        // No scrolling. Still disabled two seconds later.
        Thread.sleep(forTimeInterval: 2)
        XCTAssertFalse(accept.isEnabled, "Accept enabled before the end of the text was on screen")

        let scroll = app.scrollViews["disclaimer.scroll"]
        var swipes = 0
        while !accept.isEnabled && swipes < 40 {
            scroll.swipeUp()
            swipes += 1
        }
        XCTAssertTrue(accept.isEnabled, "Accept never enabled after scrolling to the end")
        XCTAssertGreaterThan(swipes, 0)
    }
}
