// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TroublemakerMobileCore",
    platforms: [
        .iOS(.v17),
        .watchOS(.v10),
        .macOS(.v14),
    ],
    products: [
        .library(name: "TroublemakerMobileCore", targets: ["TroublemakerMobileCore"]),
    ],
    targets: [
        .target(name: "TroublemakerMobileCore"),
        .testTarget(
            name: "TroublemakerMobileCoreTests",
            dependencies: ["TroublemakerMobileCore"]
        ),
    ]
)
