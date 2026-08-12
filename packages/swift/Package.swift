// swift-tools-version:5.9
//
//  Vidcall — Swift binding for the vidcall signaling protocol.
//  Wire contract: protocol/schema.json (single source of truth).
//
//  Layout
//  ------
//  - Vidcall        : pure Swift — Envelope + payloads (Codable), and the
//                     VidcallClient WebSocket signaling client. Zero
//                     dependencies; builds and tests fully offline.
//  - VidcallWebRTC  : optional WebRTC glue (peer connection + offer/answer/ICE
//                     wired to VidcallClient). The code is complete and
//                     compiles to a stub when the `WebRTC` module is absent;
//                     the real integration activates with `#if canImport(WebRTC)`.
//
//  WebRTC integration (two supported paths, see README.md "WebRTC integration")
//  ---------------------------------------------------------------------------
//  Path A — SwiftPM binary target (recommended):
//    Uncomment the .binaryTarget and add "WebRTC" to VidcallWebRTC's
//    dependencies below, then `swift build`. The artifact is the community
//    WebRTC 150.0.0 xcframework (stasel) — the same binary the community
//    CocoaPod `WebRTC` 150.0.0 ships (verified 2026-08-11:
//    https://github.com/stasel/WebRTC/releases/tag/150.0.0).
//    URL + checksum below were verified against the published SHA-256 of the
//    release asset (44 MB, iOS arm64 + simulator + macOS arm64/x86_64 slices;
//    module name `WebRTC`). Re-verify with `swift package compute-checksum`.
//
//  Path B — CocoaPods (manual):
//    pod 'WebRTC', '150.0.0'   (community pod, iOS only)
//    pod 'GoogleWebRTC', '1.1.32000'  (official Google pod, iOS only, 2023-era)
//    and add Sources/VidcallWebRTC to the app target. No Package.swift change
//    is needed because the glue is `#if canImport(WebRTC)`-guarded.
//
import PackageDescription

let package = Package(
    name: "Vidcall",
    platforms: [
        .iOS(.v13),
        .macOS(.v10_15),
    ],
    products: [
        .library(name: "Vidcall", targets: ["Vidcall"]),
        .library(name: "VidcallWebRTC", targets: ["VidcallWebRTC"]),
    ],
    targets: [
        .target(
            name: "Vidcall"
        ),
        .target(
            name: "VidcallWebRTC",
            dependencies: [
                "Vidcall",
                // Path A: uncomment together with the .binaryTarget below.
                // "WebRTC",
            ]
        ),
        // Path A: SwiftPM binary target for WebRTC 150.0.0 (community build,
        // stasel). Commented out by default so the package builds offline and
        // without the 44 MB binary; uncomment to link real WebRTC.
        // .binaryTarget(
        //     name: "WebRTC",
        //     url: "https://github.com/stasel/WebRTC/releases/download/150.0.0/WebRTC-M150.xcframework.zip",
        //     checksum: "f9890492b0016e4c88ab20f07867b8b420054caedc8a692b2ec6ac041f3cf6b2"
        // ),
        .testTarget(
            name: "VidcallTests",
            dependencies: ["Vidcall"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
