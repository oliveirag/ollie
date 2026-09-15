import XCTest

/// Milestone 5.5's exit criterion, automated: approving a live signal shows
/// the red sheet, refuses to confirm until real money is acknowledged, and
/// lands on "real order placed".
///
/// No brokerage account is involved. The orchestrator runs with `BROKER=mock`
/// (refused in production), whose orders fill on the first poll.
///
/// Requires, on localhost:3000:
///
///     BROKER=mock LIVE_TRADING_ENABLED=true npm --prefix ../backend run dev
///     curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
///       -d '{"execution_mode":"live"}' localhost:3000/v1/settings
///     npm --prefix ../backend run signal:write-test     # now writes a live signal
///
/// and `TEST_RUNNER_OWNER_API_TOKEN` exported. Seed immediately before the run:
/// the signal expires in 15 minutes.
final class LiveApprovalUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testLiveApprovalNeedsTheRealMoneyAcknowledgement() throws {
        let app = XCUIApplication()
        guard let token = ProcessInfo.processInfo.environment["OWNER_API_TOKEN"] else {
            XCTFail("export TEST_RUNNER_OWNER_API_TOKEN before running")
            return
        }
        app.launchEnvironment["OWNER_API_TOKEN"] = token
        app.launch()

        // The rail says live before anything else does.
        let rail = app.descendants(matching: .any)["mode-rail"]
        XCTAssertTrue(rail.waitForExistence(timeout: 20))
        XCTAssertEqual(rail.label, "Live mode. Orders are real.", "the app is not in live mode — flip it before running")

        let row = app.descendants(matching: .any)["pending-signal-row"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 25), "no pending signal — run `npm run signal:write-test` first")
        row.tap()

        // The decision buttons sit at the bottom of a lazy List, below the
        // evidence, so they do not exist in the hierarchy until scrolled to.
        XCTAssertTrue(app.navigationBars.staticTexts["AAPL"].waitForExistence(timeout: 15), "detail did not load")
        let approve = app.buttons["Approve…"]
        var swipes = 0
        while !approve.exists && swipes < 8 {
            app.swipeUp()
            swipes += 1
        }
        XCTAssertTrue(approve.waitForExistence(timeout: 5), "no Approve button on the live signal")
        approve.tap()

        // The live sheet: confirm is disabled until the acknowledgement.
        let confirm = app.buttons["decision.confirm"]
        XCTAssertTrue(app.staticTexts["This places a real order"].waitForExistence(timeout: 10), "the live warning is missing")
        var sheetSwipes = 0
        while !confirm.exists && sheetSwipes < 4 {
            app.staticTexts["This places a real order"].swipeUp()
            sheetSwipes += 1
        }
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "no confirm button on the live sheet")
        XCTAssertTrue(confirm.label.contains("Place real"), "confirm does not say it places a real order: \(confirm.label)")
        XCTAssertFalse(confirm.isEnabled, "confirm enabled before real money was acknowledged")

        let acknowledge = app.switches["decision.acknowledgeLive"]
        XCTAssertTrue(acknowledge.exists, "no real-money acknowledgement on a live approval")
        // A SwiftUI Toggle's hit area is the switch at its trailing edge.
        acknowledge.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertTrue(confirm.isEnabled, "confirm still disabled after the acknowledgement")
        confirm.tap()

        let placed = app.alerts.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Real order placed'")).firstMatch
        XCTAssertTrue(placed.waitForExistence(timeout: 20), "the approval did not report a placed order")
    }
}
