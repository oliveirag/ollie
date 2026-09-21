// swift-tools-version: 5.10
import PackageDescription

// The subscriber API client, generated at build time from
// docs/openapi-subscriber.yaml (symlinked into Sources/SignalAPI).
//
// A separate package rather than a second document in the app target because
// the generator plugin handles one document per target. Keeping it a package
// also keeps the two contracts' types apart by module: the owner's `Client`
// and the subscriber's `SignalAPI.Client` cannot be confused for one another.
let package = Package(
    name: "SignalAPI",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "SignalAPI", targets: ["SignalAPI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.13.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.12.0"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.3.1"),
    ],
    targets: [
        .target(
            name: "SignalAPI",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
            ],
            plugins: [
                .plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator"),
            ]
        ),
    ]
)
