import XCTest

/// Milestone 2.6's exit criterion, automated: approve a real signal from the
/// simulator and let the backend record the paper fill.
///
/// This drives the actual UI rather than calling the API, because the thing
/// under test is the decision surface — that the row is reachable, the
/// confirmation step exists, and the result is reported. The fill itself is
/// verified in the database afterwards.
///
/// Requires the backend on localhost:3000, a pending signal, and the token
/// forwarded via `TEST_RUNNER_OWNER_API_TOKEN`. A signal expires 15 minutes
/// after it is written, so seed one immediately before running.
final class ApprovalFlowUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launchApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["OLLIE_DISABLE_PUSH"] = "1"

        // `TEST_RUNNER_OWNER_API_TOKEN=…` reaches this runner process, but the
        // app under test is launched separately and inherits nothing, so the
        // token has to be handed across explicitly.
        guard let token = ProcessInfo.processInfo.environment["OWNER_API_TOKEN"] else {
            XCTFail("export TEST_RUNNER_OWNER_API_TOKEN before running")
            return app
        }
        app.launchEnvironment["OWNER_API_TOKEN"] = token
        app.launch()
        return app
    }

    func testModeRailIsVisibleOnEveryTab() throws {
        let app = launchApp()

        let rail = app.descendants(matching: .any)["mode-rail"]
        XCTAssertTrue(rail.waitForExistence(timeout: 20), "mode rail missing on first tab")

        // PRD §4.3: unmistakable on *every* screen. Attaching it to the root
        // shell is what makes that hold; this test is what catches a refactor
        // that quietly moves it into one screen.
        for tab in ["Positions", "Controls", "Approvals"] {
            app.tabBars.buttons[tab].tap()
            XCTAssertTrue(rail.exists, "mode rail missing on \(tab)")
        }
    }

    func testApprovingAPendingSignalReportsAFill() throws {
        let app = launchApp()

        let row = app.descendants(matching: .any)["pending-signal-row"].firstMatch
        XCTAssertTrue(
            row.waitForExistence(timeout: 25),
            "no pending signal — run `npm run signal:write-test` immediately before this test"
        )
        row.tap()

        let approve = app.buttons["Approve…"]
        XCTAssertTrue(approve.waitForExistence(timeout: 15), "detail did not load")
        approve.tap()

        // The confirmation names the verb and the mode together, so this also
        // asserts the sheet cannot be mistaken for a live approval.
        let confirm = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH 'Approve — paper'")
        ).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10), "confirmation step missing")
        confirm.tap()

        let done = app.alerts.firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 30), "no result reported")

        let reported = done.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: " ")
        XCTAssertTrue(
            reported.contains("filled at"),
            "expected a fill price in the result, got: \(reported)"
        )
        done.buttons["OK"].tap()
    }
}
