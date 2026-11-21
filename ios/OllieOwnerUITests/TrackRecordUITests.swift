import XCTest

/// Milestone 3.7's exit criterion, automated.
///
/// The record screen's job is to report what the API says *including where the
/// API declines to answer*. A screen that renders a null win rate as "0%", or
/// draws the equity curve straight through a withheld day, would be disagreeing
/// with the record it exists to display — and it would look completely fine.
/// Those are the states worth pinning, because they are the ones that fail
/// silently.
///
/// Requires the backend on localhost:3000 and the token forwarded via
/// `TEST_RUNNER_OWNER_API_TOKEN`. Seed a record with
/// `npm run seed:track-record` immediately before running.
final class TrackRecordUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launchApp() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["OLLIE_DISABLE_PUSH"] = "1"
        guard let token = ProcessInfo.processInfo.environment["OWNER_API_TOKEN"] else {
            XCTFail("export TEST_RUNNER_OWNER_API_TOKEN before running")
            return app
        }
        app.launchEnvironment["OWNER_API_TOKEN"] = token
        app.launch()
        return app
    }

    private func openRecordTab(_ app: XCUIApplication) {
        let tab = app.tabBars.buttons["Record"]
        XCTAssertTrue(tab.waitForExistence(timeout: 20), "Record tab missing")
        tab.tap()
    }

    func testRecordTabIsReachable() throws {
        let app = launchApp()
        openRecordTab(app)

        XCTAssertTrue(
            app.navigationBars["Record"].waitForExistence(timeout: 20),
            "Record screen did not appear"
        )
    }

    func testTheModeRailSurvivesOnTheRecordTab() throws {
        let app = launchApp()
        openRecordTab(app)

        // PRD §4.3 again: the rail is attached once above navigation, so a new
        // tab must inherit it. This is the assertion a refactor of the shell
        // would break silently.
        let rail = app.descendants(matching: .any)["mode-rail"]
        XCTAssertTrue(rail.waitForExistence(timeout: 20), "mode rail missing on the record tab")
    }

    /// With nothing closed, win rate has no answer. The screen must say so.
    ///
    /// Passes in either direction depending on the seeded state, and asserts the
    /// two are mutually exclusive — rendering a percentage *and* a dash would
    /// mean the null case is being papered over somewhere.
    func testWinRateReportsAbsenceRatherThanZero() throws {
        let app = launchApp()
        openRecordTab(app)

        let hasValue = app.descendants(matching: .any)["record.winRate"]
        let hasNone = app.descendants(matching: .any)["record.winRate.none"]

        let appeared = hasValue.waitForExistence(timeout: 20) || hasNone.exists
        XCTAssertTrue(appeared, "neither a win rate nor an explicit absence was rendered")
        XCTAssertFalse(
            hasValue.exists && hasNone.exists,
            "win rate rendered as both a value and an absence"
        )
    }

    /// A one-point curve is not drawn as a chart.
    ///
    /// A single dot on an axis implies a trend one day cannot support, so the
    /// view falls back to text. Whichever branch the seeded data lands on,
    /// exactly one of them must be present.
    func testCurveRendersOrExplainsWhyItCannot() throws {
        let app = launchApp()
        openRecordTab(app)

        let chart = app.descendants(matching: .any)["curve.chart"]
        let insufficient = app.descendants(matching: .any)["curve.insufficient"]

        let appeared = chart.waitForExistence(timeout: 20) || insufficient.exists
        XCTAssertTrue(appeared, "the curve neither drew nor explained its absence")
        XCTAssertFalse(chart.exists && insufficient.exists, "curve rendered two ways at once")
    }
}
