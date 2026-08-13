import XCTest

/// Captures each tab as a test attachment.
///
/// Not an assertion suite — it exists so the rendered app can be reviewed
/// against docs/design/owner-app-design.html without a human driving the
/// simulator. Extract with:
///
///     xcrun xcresulttool export attachments --path <result>.xcresult --output-path <dir>
final class ScreenshotUITests: XCTestCase {
    func testCaptureEveryTab() throws {
        let app = XCUIApplication()
        if let token = ProcessInfo.processInfo.environment["OWNER_API_TOKEN"] {
            app.launchEnvironment["OWNER_API_TOKEN"] = token
        }
        app.launch()

        XCTAssertTrue(
            app.descendants(matching: .any)["mode-rail"].waitForExistence(timeout: 20),
            "app did not reach the shell"
        )

        for tab in ["Approvals", "Positions", "Controls"] {
            app.tabBars.buttons[tab].tap()
            // Let the tab settle; the dashboard fetches quotes on appear.
            Thread.sleep(forTimeInterval: 2.5)

            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = "tab-\(tab)"
            shot.lifetime = .keepAlways
            add(shot)
        }
    }
}
