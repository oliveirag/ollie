import XCTest

/// The onboarding steps several suites need before they can test anything
/// else: welcome, invite code, the Debug test identity, the disclaimer, and
/// the token handoff. Each returns once the next screen is up.
enum OnboardingDriver {
    static var inviteCode: String? {
        ProcessInfo.processInfo.environment["SUBSCRIBER_INVITE_CODE"]
    }

    /// A fresh, signed-out subscriber app with the test identity enabled.
    static func launch(_ configure: (XCUIApplication) -> Void = { _ in }) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["OLLIE_DISABLE_PUSH"] = "1"
        app.launchEnvironment["RESET_SUBSCRIBER"] = "1"
        app.launchEnvironment["SUBSCRIBER_TEST_IDENTITY"] = "1"
        configure(app)
        app.launch()
        return app
    }

    static func signIn(_ app: XCUIApplication, inviteCode: String) {
        let subscribe = app.buttons["welcome.subscribe"]
        XCTAssertTrue(subscribe.waitForExistence(timeout: 20), "welcome screen missing")
        subscribe.tap()
        let field = app.textFields["signin.inviteCode"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText(inviteCode)
        let testIdentity = app.buttons["signin.testIdentity"]
        XCTAssertTrue(testIdentity.waitForExistence(timeout: 5), "test identity button missing; is this a Debug build?")
        if !testIdentity.isHittable { app.swipeUp() }
        testIdentity.tap()
    }

    static func acceptDisclaimer(_ app: XCUIApplication) {
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
    }

    static func finishHandoff(_ app: XCUIApplication) {
        let done = app.buttons["handoff.done"]
        XCTAssertTrue(done.waitForExistence(timeout: 20), "token handoff did not appear")
        done.tap()
        XCTAssertTrue(app.tabBars.buttons["Feed"].waitForExistence(timeout: 20), "never reached the feed")
    }
}
