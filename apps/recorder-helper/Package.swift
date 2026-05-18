// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "marec",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "marec",
            path: "Sources/marec"
        )
    ]
)
