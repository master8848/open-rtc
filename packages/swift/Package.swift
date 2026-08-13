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
//  - VidcallWebRTC  : WebRTC glue (peer connection + offer/answer/ICE + data
//                     channel bus wired to VidcallClient). The negotiation
//                     state machine and bus are WebRTC-agnostic and compile +
//                     test offline with injected fakes; the GoogleWebRTC
//                     adapter activates with `#if canImport(WebRTC)`.
//  - VidcallWebRTCTests : state-machine + L2 loopback tests (fakes, offline)
//                     plus an env-gated real-WebRTC smoke test that runs when
//                     the binary target below is enabled.
//
//  WebRTC integration (see README.md "WebRTC integration")
//  ------------------------------------------------------
//  Path A — SwiftPM binary target (commented below by default so the package
//    builds and tests fully offline): the community WebRTC 150.0.0 xcframework
//    (stasel) — the same binary the community CocoaPod `WebRTC` 150.0.0 ships
//    (verified 2026-08-12: https://github.com/stasel/WebRTC/releases/tag/150.0.0).
//    The SHA-256 was recomputed from the downloaded release asset
//    (`swift package compute-checksum WebRTC-M150.xcframework.zip`) and
//    matches the checksum in scripts/enable-webrtc.sh. Enable with
//    scripts/enable-webrtc.sh (fetches the 44 MB artifact once, verifies the
//    checksum, and uncomments the dependency + binary target); disable again
//    with scripts/disable-webrtc.sh. With the target commented, the state-
//    machine + bus tests run against injected fakes.
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
                // __VIDCALL_WEBRTC_DEP__
                "WebRTC", // WebRTC 150.0.0 binary target (Path A, enabled)
            ]
        ),
        // __VIDCALL_WEBRTC_BINARY_BEGIN__
        // Path A: SwiftPM binary target for WebRTC 150.0.0 (community build,
        // stasel). SHA-256 verified from the published release asset via
        // scripts/enable-webrtc.sh (44 MB; iOS arm64 + simulator +
        // maccatalyst + macOS arm64/x86_64 slices; module name `WebRTC`).
        // Disable for fully-offline builds with scripts/disable-webrtc.sh.
        .binaryTarget(
            name: "WebRTC",
            url: "https://github.com/stasel/WebRTC/releases/download/150.0.0/WebRTC-M150.xcframework.zip",
            checksum: "f9890492b0016e4c88ab20f07867b8b420054caedc8a692b2ec6ac041f3cf6b2"
        ),
        // __VIDCALL_WEBRTC_BINARY_END__
        .testTarget(
            name: "VidcallTests",
            dependencies: ["Vidcall"],
            resources: [.copy("Fixtures")]
        ),
        .testTarget(
            name: "VidcallWebRTCTests",
            dependencies: ["VidcallWebRTC"]
        ),
    ]
)
