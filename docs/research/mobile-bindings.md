# Mobile Bindings Research: Kotlin / Swift / Dart(Flutter) for `vidcall`

**Status:** Research blueprint (implementation reference)
**Date:** 2026-08-11 (all publish dates verified on this date)
**Scope:** WebRTC packages per platform, one shared JSON signaling protocol, backend SDK matrix
(Convex/Supabase/Postgres/SQLite/Appwrite/Firebase), testing + CI matrix, FFI/architecture notes,
package publishing (Maven Central / CocoaPods / SwiftPM / pub.dev).
**Policy constraints applied:** supply-chain rule from `CONTRIBUTING.md` (every dependency published
≥ 14 days before adoption, exact pins, lockfiles), base/std utilities first, in-workspace
sub-libraries over micro-deps.

> 14-day cutoff used below: today = 2026-08-11 → a version is eligible if published **before 2026-07-28**.
> "too fresh" = published within the last 14 days → **do not adopt yet** (re-check the next stable).

---

## 0. Executive summary & recommendations

1. **WebRTC engine per platform** (all speak the same SDP/ICE wire format natively):
   - **Android:** `io.getstream:stream-webrtc-android` **1.3.10** (Maven Central, 2025-09-11). Google's own
     `org.webrtc:google-webrtc` died with JCenter (2021) and is **not** on Maven Central — Stream's
     prebuilt is the de-facto maintained distribution.
   - **iOS (and macOS via Flutter/desktop):** `GoogleWebRTC` CocoaPod **1.1.32000** is the official pod but
     **stale (2023-03-07)**. For a new binding prefer the actively maintained community pod
     `WebRTC` (stasel) pinned to **150.0.0** (2026-07-11; 151.0.0 is 4 days old — too fresh).
     macOS: official pods are iOS-only; macOS comes via `flutter_webrtc`/`dart_webrtc` or a source build.
   - **Flutter:** `flutter_webrtc` **1.5.2** (2026-06-19; 1.6.0 from 2026-08-03 is too fresh). It wraps the
     same native GoogleWebRTC underneath, so behavior matches the native bindings.
2. **Shared wire protocol:** a **versioned JSON envelope over WebSocket**, defined once as **JSON Schema**
   (single source of truth), with **quicktype** codegen to TS/Kotlin/Swift/Dart. JSON wins over protobuf
   here: zero per-language runtime deps beyond what every platform already ships (stdlib JSON),
   trivial debugging, and our message volume (signaling) is tiny. Protobuf is the right call at
   SFU-scale (LiveKit) — not for us. (Details in §2.)
3. **Backends:** Supabase, Firebase, Appwrite ship **official SDKs on all three platforms**. **Convex now
   has official Kotlin (Android) and Swift clients** (built on a Rust client) but **no official Dart client**
   → Dart falls back to raw WebSocket or the community `convex_dart` package. Postgres/SQLite are not
   signaling backends; the realistic path is a TS-side signaling relay + WebSocket. (Matrix in §3.)
4. **Testing:** one macOS GitHub Actions runner runs BOTH the iOS simulator (Xcode 16.4–26.3) and the
   Android emulator (SDK + emulator preinstalled). Add `flutter test`/`dart test` jobs. Shared protocol
   conformance suite = the same JSON fixtures + scenario scripts executed by every binding. (§4)
5. **Architecture:** mirror the JS core 1:1; each binding is a thin adapter over the platform's native
   WebRTC + a platform WebSocket client. No FFI needed for WebRTC (each platform has native WebRTC);
   FFI (UniFFI/cdylib) applies to `provider-connect`'s Rust core, which can expose JSON-RPC signaling
   helpers to all four languages. (§5)
6. **Publishing:** Maven Central via the Central Portal (verified namespace + GPG), SwiftPM first
   (CocoaPods trunk is being deprecated → read-only), pub.dev with a verified publisher. (§6)

---

## 1. WebRTC per platform

### 1.1 What is shared across platforms

All four targets implement the **same WebRTC API surface and the same wire artifacts**:

| Concept | JS (browser) | Android (`org.webrtc`) | iOS/macOS (`WebRTC.framework`) | Flutter (`flutter_webrtc`) |
|---|---|---|---|---|
| Peer connection | `RTCPeerConnection` | `PeerConnectionFactory` → `PeerConnection` | `RTCPeerConnection` | `RTCPeerConnection` (mirrors JS) |
| Media | `getUserMedia` | `Camera1/2Enumerator`, `VideoSource` | `RTCCameraVideoCapturer` | `navigator.mediaDevices.getUserMedia` |
| SDP | `createOffer/Answer`, `setLocal/RemoteDescription` | same, `SessionDescription` | same, `RTCSessionDescription` | same |
| ICE | `addIceCandidate`, `onicecandidate` | same, `IceCandidate` | same, `RTCIceCandidate` | same |
| Data channel | `RTCDataChannel` | `DataChannel` | `RTCDataChannel` | `RTCDataChannel` |

Because SDP (`RFC 3264`) and ICE (`RFC 8445`, trickle ICE) are standardized, a signaling server only
needs to **relay opaque SDP/ICE payloads without transformation** — this is the interoperability
guarantee the shared protocol (§2) builds on. JS and all native bindings produce/consume the same
SDP bodies and ICE candidate formats; the only adaptation is the JSON envelope.

Sources:
- WebRTC native Android API: <https://webrtc.github.io/webrtc-org/native-code/android/>
- WebRTC API (W3C): <https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API>
- SDP: <https://www.rfc-editor.org/rfc/rfc3264>, ICE: <https://www.rfc-editor.org/rfc/rfc8445>

### 1.2 Android

**Status: no official Google artifact since JCenter shutdown.** Google's WebRTC Android docs
(<https://webrtc.github.io/webrtc-org/native-code/android/>) still point at
`implementation 'org.webrtc:google-webrtc:1.0.+'` on **JCenter**, which was sunset in 2021
(<https://jfrog.com/blog/into-the-sunset-bintray-jcenter-gocenter-and-chartmuseum/>).
`org.webrtc:google-webrtc` is **not on Maven Central** (verified via search.maven.org, 2026-08-11:
0 results). It survives only via JitPack mirrors (e.g. mvnrepository lists a "BT WebRTC" JitPack repo)
— do **not** use JitPack for a published library.

The de-facto maintained prebuilt is **Stream's fork**, which explicitly exists because Google stopped
publishing ("even JCenter has been shut down, so the library is not available now" — repo README):

| Artifact | Version | Published | Maturity | Notes |
|---|---|---|---|---|
| `io.getstream:stream-webrtc-android` | **1.3.10** | 2025-09-11 | ✅ recommended | Apache-2.0, min API 21, prebuilt AAR on Maven Central, tracks recent WebRTC commits, used by stream-video-android |
| `org.jitsi:webrtc` | 124.0.0 | 2024-05-13 | ✅ usable | Jitsi-maintained prebuilt (M124) |
| `com.dafruits:webrtc` | 123.0.0 | 2024-03-23 | ⚠️ smaller community | |
| `org.webrtc:google-webrtc` | 1.0.32006+ | (JCenter, dead) | ❌ | JitPack-only; avoid |

Sources:
- Stream prebuilt: <https://github.com/getstream/stream-webrtc-android> · Maven Central:
  <https://central.sonatype.com/artifact/io.getstream/stream-webrtc-android>
- Jitsi prebuilt: <https://github.com/jitsi/webrtc> · <https://central.sonatype.com/artifact/org.jitsi/webrtc>
- Publish-date evidence: repo1 metadata
  <https://repo1.maven.org/maven2/io/getstream/stream-webrtc-android/maven-metadata.xml> (`lastUpdated` 2025-09-11)

**Recommendation:** pin `io.getstream:stream-webrtc-android:1.3.10`. Rationale: actively maintained
(pre-14-day rule satisfied), Apache-2.0, single AAR with no transitive deps, and it is the same
WebRTC build family used by production video SDKs.

### 1.3 iOS / macOS

| Package | Version | Published | Maturity | Notes |
|---|---|---|---|---|
| `GoogleWebRTC` (CocoaPod, official) | 1.1.32000 | 2023-03-07 | ⚠️ stale | official Google binary pod, iOS 11.0+, **no macOS**; not updated in 3.5 years |
| `WebRTC` (CocoaPod, community stasel) | 151.0.0 | 2026-08-07 | 🔥 too fresh | monthly M-version releases; 150.0.0 (2026-07-11) is the newest eligible |
| `WebRTC` pod (Anakros) | 63.x | 2017 | ❌ | ancient, do not use |

Verified via CocoaPods trunk API: GoogleWebRTC last version 1.1.32000 created 2023-03-07
(<https://trunk.cocoapods.org/api/v1/pods/GoogleWebRTC>); podspec shows `platforms: ios 11.0`,
source is a Google-hosted tarball (<https://trunk.cocoapods.org/api/v1/pods/GoogleWebRTC/specs/1.1.32000>).
Community pod releases: <https://github.com/stasel/WebRTC/releases> (151.0.0 on 2026-08-07, 150.0.0 on
2026-07-11).

**macOS note:** both pods above are iOS-only. macOS support exists through:
- `flutter_webrtc` (plugin declares `macos` platform, §1.4) — the pragmatic path for a macOS client;
- a WebRTC source build for macOS (webrtc.org supports macOS desktop; heavy);
- LiveKit/Daily SDKs as precedent (they ship iOS+macOS binaries).

**Recommendation for the Swift binding:**
- **iOS:** `WebRTC` pod by stasel **pinned to 150.0.0** (151.0.0 published 2026-08-07 violates the
  14-day rule; re-evaluate ≥ 2026-08-21), or the official `GoogleWebRTC` pod if a 2023-era binary is
  acceptable for a first release (it is stable and widely deployed).
- **macOS:** first release can be iOS-only; add macOS via `dart_webrtc`/`flutter_webrtc` (Flutter) or a
  later binary from a source build. Document this as a known platform gap in the Swift binding README.

### 1.4 Flutter (Dart)

| Package | Version | Published | Maturity | Notes |
|---|---|---|---|---|
| `flutter_webrtc` | **1.5.2** (pin) | 2026-06-19 | ✅ recommended | 1.6.0 published 2026-08-03 — **too fresh** (8 days) |
| `flutter_webrtc` | 1.6.0 | 2026-08-03 | 🔥 too fresh | re-check ≥ 2026-08-17 |
| `dart_webrtc` | 1.8.1 | 2026-03-26 | ✅ | pure-Dart WebRTC for web/desktop via JS interop |
| `webrtc_interface` | 1.5.1 | 2026-03-16 | ✅ | interface package that decouples `flutter_webrtc` from `dart_webrtc` |

Source: <https://pub.dev/api/packages/flutter_webrtc> (versions list with `published` timestamps).
`flutter_webrtc` supports **Android, iOS, macOS, Windows, Linux, web, embedded Linux**
(plugin platforms in pubspec; verified from the pub.dev API). It is "based on GoogleWebRTC"
(cloudwebrtc/flutter-webrtc, <https://github.com/cloudwebrtc/flutter-webrtc>): the Android side wraps a
WebRTC AAR, the iOS side wraps GoogleWebRTC, desktop uses its own native builds.

> **Naming correction:** the package is `flutter_webrtc` — `webrtc_flutter` does not exist on pub.dev
> (verified 2026-08-11, 404).

**Cross-platform "what works" summary (§1.2–1.4):** the same WebRTC feature set (peer connection,
getUserMedia, SDP/ICE, data channels, simulcast on recent builds) works on all four targets. The
Android/iOS/Flutter bindings can all join the same room through the shared signaling protocol in §2;
differences are packaging (Maven/CocoaPods/pub.dev), version cadence (stasel monthly vs Stream
quarterly vs flutter_webrtc monthly), and macOS support (Flutter yes, native pods no).

---

## 2. Shared wire protocol (JS / Kotlin / Swift / Dart)

### 2.1 Protocol definition options

| Option | Single source of truth | Codegen targets | Per-platform runtime deps | Versioning / back-compat | Verdict |
|---|---|---|---|---|---|
| **JSON Schema + codegen (recommended)** | JSON Schema file | TS, Kotlin, Swift, Dart (quicktype) | none beyond stdlib JSON (JS `JSON`, Kotlin `kotlinx.serialization`/`org.json`, Swift `Codable`, Dart `dart:convert`) | schema version in envelope; additive-only rules; `additionalProperties: false` optional | ✅ **chosen** |
| TS types + codegen | `.ts` types → JSON Schema (`typescript-json-schema`) → same pipeline as above | same | same | same | ✅ viable; adds a TS→schema step |
| Protobuf | `.proto` | TS (`protobufjs`), Kotlin (`protobuf-kotlin` 4.35.0), Swift (`SwiftProtobuf` 1.38.1), Dart (`protobuf` 6.0.0) | runtime lib per language (all ≥14 days old, mature) | field numbers, `reserved`, wire compat | ❌ overkill for signaling; wins only at high message volume (SFU) or when payloads are binary |

Verified tooling versions (all eligible):
- quicktype: <https://quicktype.io/> · <https://github.com/glideapps/quicktype> — generates types +
  serializers for TypeScript, Kotlin, Swift, Dart, C#, Go, Rust, … from JSON, JSON Schema, or TS types.
  Recommended workflow per quicktype docs: generate schema → review → commit schema → generate code.
- `typescript-json-schema`: <https://github.com/YousefED/typescript-json-schema> (TS types → JSON Schema).
- Protobuf runtime per platform (eligibility verified 2026-08-11): protoc v35.1 (2026-06-11),
  `protobuf-kotlin` 4.35.0 (2026-05-19), `SwiftProtobuf` 1.38.1 (2026-06-23), Dart `protobuf` 6.0.0
  (2025-11-26), JS `protobufjs` (npm).
- LiveKit precedent (protobuf signaling over WebSocket):
  <https://docs.livekit.io/reference/internals/client-protocol/> — "LiveKit clients use a WebSocket to
  communicate with the server over Protocol Buffers." They chose protobuf for a server-client SFU
  protocol with high message rates; we don't need that.
- PeerJS precedent (JSON signaling): messages are JSON over WebSocket with a mandatory `type` field
  (<https://github.com/peers/peerjs>); simple-peer relays opaque SDP/ICE objects
  (<https://github.com/feross/simple-peer>). MDN's signaling walkthrough is JSON over WebSocket
  (<https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling>).

**Recommendation: JSON Schema as the single source of truth + quicktype codegen.**
- Zero new runtime dependencies in any binding (all platforms have stdlib JSON + a WebSocket client).
- Signaling traffic is tiny (a few messages per call) — protobuf's size/speed win is irrelevant.
- Debuggability: `curl` a signaling server and read the traffic.
- Codegen keeps the four languages' models in lockstep and is testable by comparing generated
  serializers against the same fixtures.

### 2.2 Protocol design (concrete)

**Transport:** one WebSocket connection per client to the signaling server (the backend adapter layer,
§3). All messages are JSON objects with a `v` (protocol version) and `type` field; server and clients
ignore unknown fields (forward-compat) and must tolerate unknown `type` values (ignore + log).

**Envelope**

```json
{
  "v": 1,
  "type": "signal.offer",
  "id": "msg-uuid",
  "room": "room-abc",
  "from": "user-42",
  "to": "user-7",
  "ts": 1780000000000,
  "payload": { }
}
```

**Message taxonomy** (payloads are minimal; SDP/ICE payloads are relayed verbatim):

| Category | type | payload | direction |
|---|---|---|---|
| Room | `room.join` / `room.join_ack` | `{token?, displayName, capabilities?}` / `{participants:[…]}` | C→S / S→C |
| Room | `room.leave` | `{reason?}` | C→S |
| Presence | `presence.update` | `{state: {muted, speaking, raisedHand, …}}` | C→S (broadcast) |
| Presence | `presence.snapshot` | `{participants:[{id, state, joinedAt}]}` | S→C (on join + on change) |
| SDP | `signal.offer` / `signal.answer` | `{sdp: "<SDP string>", sessionId}` | C→C via S |
| ICE | `signal.ice` | `{candidate: {candidate, sdpMid, sdpMLineIndex, usernameFragment?}}` (trickle) | C→C via S |
| Reactions | `reaction.emoji` | `{emoji, target?}` | C→S broadcast |
| Quality | `quality.report` | `{bitrate, fps, resolution, rtt, loss, codec, direction}` | C→S (metrics) |
| Quality | `quality.adapt` | `{action: "up"|"down"|"simulcast", layer?}` | S→C (server or JS-core-driven adaptation) |
| Error | `error` | `{code, message}` | S→C |

**Rules that keep the four bindings interoperable:**
1. SDP and ICE payloads are **opaque strings/objects** — never parsed or transformed by the signaling
   layer; only validated as JSON.
2. `to` may be null → broadcast to the room (presence, reactions).
3. Server assigns session/sessionId; clients never invent them.
4. Every binding must implement the full taxonomy with the same semantics; the conformance suite (§4)
   is the enforcement mechanism.
5. Versioning: bump `v` only on breaking changes; servers must support the current and previous `v`.
   Additive changes (new `type`, new optional fields) are non-breaking.

**Fixtures:** the protocol repo keeps `protocol/fixtures/*.json` (one file per message type, plus
scripted scenarios such as "join → offer → answer → ICE → leave") consumed by every binding's
conformance test.

---

## 3. Backend connectivity per platform

Principle: the JS core's backend adapters (Convex, Supabase, PostgreSQL, SQLite, Appwrite, Firebase)
are replaced per-platform by the SDKs below, or by the shared fallback — a **raw WebSocket + REST
adapter** that talks to a TS-side signaling relay. The wire protocol in §2 is transport-agnostic.

### 3.1 SDK matrix (verified 2026-08-11)

| Backend | Kotlin (JVM/Android) | Swift (iOS/macOS) | Dart (Flutter) | Signaling fit |
|---|---|---|---|---|
| **Convex** | ✅ official **convex-android** (Kotlin client on Convex's Rust client; docs: `docs.convex.dev/client/android/overview`) | ✅ official **convex-swift** 0.8.1 (2026-02-20; github.com/get-convex/convex-swift; docs: `docs.convex.dev/client/swift/overview`) | ❌ **no official Dart client** (open issue get-convex/convex-backend#54); community `convex_dart` 0.5.0 (2025-10-22) or **raw WebSocket fallback** | ✅ Convex is WebSocket-native (mutations + realtime queries + presence component github.com/get-convex/presence) — build signaling on mutations + presence |
| **Supabase** | ✅ **supabase-kt** 3.7.0 (2026-07-20; supabase-community/supabase-kt) | ✅ **supabase-swift** v2.54.0 (2026-07-27) — v2.54.1 (07-29) is 13 days old → too fresh (supabase/supabase-swift) | ✅ **supabase-dart** 2.14.0 (2026-07-07) — 2.16.0 (08-05) too fresh (supabase/supabase-dart) | ✅ Realtime (broadcast + presence + Postgres changes) is exactly a signaling primitive |
| **Firebase** | ✅ Firebase Android SDK on **Google Maven** (`maven.google.com`, NOT Maven Central): `firebase-database` 22.0.1 (2025-09-18), `firebase-firestore` 26.4.1 (pom Last-Modified 2026-07-09; 26.5.0 published 2026-07-30 → too fresh) | ✅ **firebase-ios-sdk** 12.16.0 (2026-07-08; 12.17.0 on 2026-07-28 is borderline 14d → re-check before pinning; SPM + CocoaPods) | ✅ Firebase Flutter plugins: `firebase_core` 4.12.1 (2026-07-14), `firebase_database`, `firebase_firestore` (same monorepo) | ✅ Realtime Database / Firestore can serve as signaling transport (all platforms) |
| **Appwrite** | ✅ `io.appwrite:sdk-for-android` **26.0.0** (2026-07-13; repo appwrite/sdk-for-android) | ✅ **appwrite/sdk-for-apple** 18.3.0 (2026-07-13) — note: `sdk-for-swift` is the *server-side* Swift SDK; mobile is `sdk-for-apple` | ✅ **appwrite** 25.3.0 (2026-07-13; 25.4.0 on 08-05 too fresh) | ✅ Appwrite Realtime (channels) |
| **PostgreSQL** | ✅ JDBC `org.postgresql:postgresql` 42.7.7 (2025-06-11) | ✅ PostgresNIO (vapor/postgres-nio) | ✅ `postgres` 3.5.12 (2026-06-11) | ⚠️ no pub/sub push → **use a TS relay**: Postgres stores rooms/participants; signaling flows over WebSocket from the relay (same adapter as JS) |
| **SQLite** | Room (androidx) | GRDB.swift / SQLite.swift | `sqflite` 2.4.3 (2026-06-02) | ❌ local storage only — never a signaling backend; optional offline/cache layer in bindings |

### 3.2 Notes and gaps

- **Convex × Dart is the only real gap.** Options for the Dart binding, in order of preference:
  1. raw WebSocket client against Convex's JSON sync protocol (same fallback the protocol allows),
  2. community `convex_dart` (0.5.0, 2025-10-22 — eligible) with a maintainer-audit note,
  3. wait for official support (track <https://github.com/get-convex/convex-backend/issues/54>).
- **Firebase Android is on Google Maven, not Maven Central** — the Gradle setup differs
  (`google()` repo). Supply-chain check for Google Maven uses the `maven-metadata.xml`/`lastUpdated`
  fields (<https://dl.google.com/dl/android/maven2/com/google/firebase/firebase-firestore/maven-metadata.xml>).
- **Appwrite naming trap:** `appwrite/sdk-for-swift` = server-side Swift; Apple clients must use
  `appwrite/sdk-for-apple`.
- All official SDKs listed satisfy the 14-day rule **at the pinned versions** above; several "latest"
  versions (supabase-dart 2.16.0, appwrite 25.4.0, firebase_core 4.13.0, firestore 26.5.0,
  flutter_webrtc 1.6.0, WebRTC 151.0.0, supabase-swift 2.54.1) are **too fresh** and must not be adopted
  until ≥ 14 days old.
- Every adapter interface in the JS core must have ≥ 2 implementations (CONTRIBUTING.md) — the
  per-platform SDKs above give each platform ≥ 2 signaling transports (e.g. Supabase Realtime +
  raw WebSocket).

Sources:
- Convex mobile: <https://docs.convex.dev/client/android/overview>, <https://docs.convex.dev/client/swift/overview>,
  <https://github.com/get-convex/convex-swift>, <https://github.com/get-convex/convex-backend/issues/54>,
  <https://pub.dev/packages/convex_dart>
- Supabase: <https://supabase.com/docs/reference/kotlin>, <https://supabase.com/docs/reference/swift>,
  <https://supabase.com/docs/reference/dart>; repos supabase-community/supabase-kt,
  supabase/supabase-swift, supabase/supabase-dart
- Firebase: <https://firebase.google.com/docs/android/setup>, <https://firebase.google.com/docs/ios/setup>,
  <https://firebase.google.com/docs/flutter/setup>; releases firebase/firebase-ios-sdk,
  firebase/firebase-android-sdk
- Appwrite: <https://appwrite.io/docs>; repos appwrite/sdk-for-android, appwrite/sdk-for-apple,
  appwrite/sdk-for-swift (server-side), pub.dev `appwrite`
- Postgres: <https://jdbc.postgresql.org/>, <https://github.com/vapor/postgres-nio>, <https://pub.dev/packages/postgres>
- SQLite: <https://developer.android.com/training/data-storage/room>, <https://github.com/groue/GRDB.swift>,
  <https://pub.dev/packages/sqflite>

---

## 4. Testing strategy (shared matrix)

### 4.1 The shared matrix

Every binding (JS core, Kotlin, Swift, Dart) runs the **same test suites**, defined in three layers:

| Layer | What it covers | Runs where |
|---|---|---|
| **L0 protocol conformance** | The §2 protocol: encode/decode every fixture, scenario scripts (join→offer→answer→ICE→leave→presence→reactions→quality), unknown-field tolerance, version guard | CI on every platform (fast, no devices) |
| **L1 unit tests** | Per-binding: room manager state machine, backend adapter mocks, quality estimator logic, error mapping | CI on every platform |
| **L2 integration** | Two real peers (e.g. Kotlin↔JS, Swift↔Dart, Kotlin↔Swift) through a local signaling server + native WebRTC loopback; verify media/data-channel up, ICE over a real network | CI (simulators/emulators) + nightly real-device |

L0 is the interoperability contract: **a binding cannot merge unless it passes L0 with the shared
fixtures** (CONTRIBUTING.md: "Every binding … must run the shared test matrix before merge").

### 4.2 Per-platform tooling

| Platform | Unit tests | Integration tests |
|---|---|---|
| JS core | `vitest`/`jest` + TS | two Node/headless-Chrome peers over local WebSocket server |
| Kotlin | Gradle + `kotlin.test`/JUnit 5 | Android instrumented tests (`connectedAndroidTest`) on emulator; JVM loopback tests (no device) |
| Swift | SwiftPM + XCTest | `xcodebuild test -destination 'platform=iOS Simulator,…'` |
| Dart/Flutter | `flutter test` / `dart test` | `flutter test integration_test` on iOS sim + Android emulator |

### 4.3 CI (GitHub Actions) — one macOS runner covers iOS + Android

Verified from the official runner image docs (github.com/actions/runner-images,
`images/macos/macos-15-Readme.md`, fetched 2026-08-11):
- **Xcode:** 16.4 (default) plus 16.x–26.3 installed → iOS simulator tests.
- **Android:** Android SDK + Emulator 36.6.11, Build-tools 37.0.0, platforms android-35/36/37.x,
  NDK 27.3 (latest 29) preinstalled → Android emulator tests on the same runner.
- Hosted macOS runners are free for public open-source repos → fits our OSS model.

**Suggested workflow layout** (single `test-matrix.yml`, job matrix `[js, kotlin, swift, dart]` on
`macos-15`; a `linux` job for pure-Dart/TS speed):
1. `protocol-conformance` — runs L0 fixtures for all four languages (fast; can be a parallel matrix).
2. `kotlin-android` — `./gradlew test` + `connectedAndroidTest` on an API 35 emulator
   (use the ReactiveCircus/android-emulator-runner action: github.com/ReactiveCircus/android-emulator-runner).
3. `swift-ios` — `xcodebuild test` on iOS Simulator (e.g. iPhone 16, Xcode 16.4 default).
4. `flutter` — `flutter analyze`, `flutter test`, then `integration_test` on iOS sim + Android emulator.
5. `nightly-devices` — Firebase Test Lab (physical Android) / Xcode Cloud or BrowserStack for real
   iOS devices (optional, on schedule).

Notes:
- Pin runner images (`macos-15` not `macos-latest`) — GitHub relabels `macos-latest` periodically.
- Cache Gradle/Flutter/SPM dependency caches to keep the matrix fast.
- The signaling server for L2 is the in-workspace TS package; start it as a service container.

---

## 5. FFI / architecture note

### 5.1 How a cross-language library family is structured

The standard pattern (used by LiveKit, Stream, and Mozilla's own components):

```
core (one language, the source of truth)
  └── thin bindings (per platform: Kotlin / Swift / Dart / JS)
        └── each binding = adapter over platform-native APIs + shared wire protocol
```

Two variants:
1. **Core = Rust/C++ with FFI.** The core exposes a C ABI (`cdylib`) or UniFFI-generated bindings;
   each language gets a thin wrapper. This is what **provider-connect** does: Rust (tokio) core, with
   JSON-RPC over stdio/WebSocket/HTTP, direct Rust calls, and FFI
   (`README.md`: "FFI" listed as an interface; `cdylib + C ABI / UniFFI` per the mission brief).
2. **Core = TS/JS with per-platform native reimplementations.** The "core" is a *spec + shared
   protocol*; each binding reimplements the room/signaling logic against native WebRTC. This is what
   **vidcall** does (README: "TypeScript, Kotlin, Swift, Dart" packages in one npm-workspace repo).

**UniFFI facts (verified):** Mozilla UniFFI generates Kotlin, Swift, and Python bindings from a Rust
core (<https://github.com/mozilla/uniffi-rs>, <https://mozilla.github.io/uniffi-rs/>). Latest
`uniffi` crate 0.32.0 (updated 2026-06-30, crates.io — eligible). UniFFI is proven in production
(Firefox components, Glean).

### 5.2 How vidcall bindings should mirror the JS core

- **Don't use FFI for WebRTC.** Every target already has a native WebRTC library (§1); bridging a
  Rust core for media would add a hop with no benefit. The JS core's *engine* (peer management,
  quality adaptation) is re-implemented per binding, or the JS core's logic is ported and shared as
  fixtures/scenarios for parity testing (§4 L0/L1).
- **Do use FFI for shared non-media logic.** provider-connect's Rust core (JSON-RPC signaling helpers,
  backend adapters) can be exposed to Kotlin/Swift via UniFFI (Kotlin + Swift generated bindings) or
  a C ABI, and to Dart via FFI (`dart:ffi`) or, simpler, by speaking JSON-RPC over stdio/WebSocket —
  the same JSON-RPC surface it already exposes to Node. This gives all four bindings one implementation
  of "connect to provider, authenticate, relay signaling JSON" without re-implementing it four times.
- **Kotlin Multiplatform (KMP) is optional glue, not a requirement.** KMP is stable and production-ready
  (kotlinlang.org/multiplatform; developer.android.com/kotlin/multiplatform) and can share the Kotlin
  room/state machine between Android and iOS. Recommendation: start with a pure JVM/Android Kotlin
  package (simplest publishing, §6); evaluate KMP for iOS sharing later — Swift binding stays native.
- **Suggested package layout** (mirrors the JS workspace):

```
vidcall/
  packages/
    core/            (TS — source of truth for protocol + fixtures)
    engine/          (TS — peer + quality engine)
    backends/        (TS — convex/supabase/postgres/appwrite/firebase adapters)
    bindings/
      kotlin/        (Gradle, Maven Central)
      swift/         (SwiftPM + optional CocoaPods)
      dart/          (pub.dev)
  docs/research/     (this doc)
```

---

## 6. Package publishing (open-source distribution)

### 6.1 Maven Central (Kotlin/Android)

Requirements (Central Portal, central.sonatype.com — the modern path; legacy OSSRH still works but is
being superseded):
1. **Account + verified namespace:** register at <https://central.sonatype.com/>, add a namespace
   (e.g. `io.vidcall`), verify it — DNS TXT record for a domain you own, or GitHub-org verification
   (docs: <https://central.sonatype.org/register/namespace/>).
2. **GPG signing:** every artifact must be signed; generate a keypair, upload the public key to a keyserver,
   configure `signing` in Gradle (docs: <https://central.sonatype.org/publish/requirements/gpg/>).
3. **POM metadata:** license, SCM URL, developers, description — mandatory for OSS.
4. **Publishing:** Gradle `maven-publish` + `io.github.gradle-nexus.publish-plugin`
   (docs: <https://central.sonatype.org/publish/publish-gradle/>). Android library → publish the **AAR**.
5. Propagation: publish to Central → `repo1.maven.org` typically within minutes; search index can lag
   hours (central.sonatype.org FAQ).

### 6.2 Swift: SwiftPM primary, CocoaPods optional

- **SwiftPM:** no account/registry needed — a `Package.swift` + a **git tag** is the release
  (`https://developer.apple.com/documentation/swiftpackagemanager`). Add discoverability via the
  Swift Package Index (<https://swiftpackageindex.com/>). Versioning: semver tags; consumers pin
  `exact:`/`from:`.
- **CocoaPods:** trunk workflow — `pod trunk register` (email verification), `pod lib lint`,
  `pod trunk push` (docs: <https://guides.cocoapods.org/making/getting-setup-with-trunk.html>,
  <https://guides.cocoapods.org/terminal/commands.html>).
- **⚠️ CocoaPods trunk is going read-only:** announced 2024-11-30, "in two years we plan to turn
  CocoaPods trunk to be read-only" (updated May 2025: ~10 months to go at that point)
  (<https://blog.cocoapods.org/CocoaPods-Specs-Repo/>). **Recommendation: ship SwiftPM-only for the
  Swift binding**; add a podspec only if consumer demand justifies it, and keep the podspec in-repo so
  a future migration is trivial.

### 6.3 pub.dev (Dart/Flutter)

- Publish: `dart pub publish` from the package dir (<https://dart.dev/tools/pub/publishing>,
  <https://pub.dev/help/publishing>).
- **Verified publisher:** register a publisher domain and verify via DNS TXT or HTML file
  (<https://pub.dev/create-publisher>, docs at <https://dart.dev/tools/pub/publishing#verify-a-publisher>).
  Verified publishers can transfer uploader-only packages.
- **Package score:** pub.dev computes analysis/formatting/documentation/tests scores — keep the
  package green (0 analyzer issues, doc comments, example/) for a good score.
- First publish requires a Google account; package names are first-come-first-served — claim
  `vidcall`/`vidcall_*` names early.

### 6.4 Cross-cutting publishing policy (mirrors CONTRIBUTING.md)

- Pin exact versions in `Package.resolved`/`gradle.lockfile`/`pubspec.lock`; commit them.
- Record in each binding's README **why each dependency exists** and its publish date (audit trail).
- CI publishes only from tags (conventional commits → tag → release).

---

## 7. Dependency summary (supply-chain table, verified 2026-08-11)

All versions below satisfy the ≥ 14-day rule (published before 2026-07-28). "Too fresh" versions
listed are **not** adopted until they age past 14 days.

| Dep | Target | Pin | Published | Why |
|---|---|---|---|---|
| `io.getstream:stream-webrtc-android` | Android | 1.3.10 | 2025-09-11 | maintained prebuilt WebRTC (Google's JCenter artifact is dead) |
| `WebRTC` pod (stasel) | iOS | 150.0.0 | 2026-07-11 | current WebRTC binary; 151.0.0 (08-07) too fresh |
| `GoogleWebRTC` pod (official) | iOS | 1.1.32000 | 2023-03-07 | fallback if a Google-blessed binary is preferred; stale |
| `flutter_webrtc` | Flutter | 1.5.2 | 2026-06-19 | cross-platform plugin (1.6.0 from 08-03 too fresh) |
| `dart_webrtc` | Flutter (web/desktop) | 1.8.1 | 2026-03-26 | pure-Dart WebRTC for web/desktop parity |
| `webrtc_interface` | Flutter | 1.5.1 | 2026-03-16 | decouples plugin from dart_webrtc |
| `convex-swift` | Swift | 0.8.1 | 2026-02-20 | official Convex Swift client |
| `supabase-kt` | Kotlin | 3.7.0 | 2026-07-20 | official Supabase Kotlin + Realtime |
| `supabase-swift` | Swift | 2.54.0 | 2026-07-27 | official; 2.54.1 (07-29) too fresh |
| `supabase-dart` | Dart | 2.14.0 | 2026-07-07 | official; 2.16.0 (08-05) too fresh |
| `firebase-database` | Android | 22.0.1 | 2025-09-18 | Google Maven (not Central) |
| `firebase-firestore` | Android | 26.4.1 | 2026-07-09 | pin; 26.5.0 (07-30) too fresh |
| `firebase-ios-sdk` | iOS/macOS | 12.16.0 | 2026-07-08 | 12.17.0 (07-28) borderline — re-check before pinning |
| `firebase_core` | Flutter | 4.12.1 | 2026-07-14 | official Flutter plugin root |
| `io.appwrite:sdk-for-android` | Kotlin | 26.0.0 | 2026-07-13 | official |
| `appwrite/sdk-for-apple` | Swift | 18.3.0 | 2026-07-13 | official Apple SDK |
| `appwrite` (dart) | Dart | 25.3.0 | 2026-07-13 | official; 25.4.0 (08-05) too fresh |
| `convex_dart` (community) | Dart | 0.5.0 | 2025-10-22 | only Dart option until official; or raw WS |
| `org.postgresql:postgresql` | Kotlin/JVM | 42.7.7 | 2025-06-11 | server-side relay support |
| `postgres` (dart) | Dart | 3.5.12 | 2026-06-11 | server-side relay support |
| `sqflite` | Flutter | 2.4.3 | 2026-06-02 | local cache only (not signaling) |
| `uniffi` (crate) | Rust core | 0.32.0 | 2026-06-30 | FFI bindings for provider-connect → Kotlin/Swift |
| protoc / protobuf-kotlin / SwiftProtobuf / dart protobuf | (if protobuf chosen) | 35.1 / 4.35.0 / 1.38.1 / 6.0.0 | 2026-06-11 / 05-19 / 06-23 / 2025-11-26 | not needed for recommended JSON path |

---

## 8. Open questions / follow-ups for implementation day

1. **macOS Swift binding:** confirm whether the Swift package targets macOS in v1 or defers to
   Flutter/dart_webrtc (recommended: defer).
2. **Convex Dart:** decide raw-WebSocket adapter vs `convex_dart` — track
   get-convex/convex-backend#54.
3. **Signaling server transport:** WebSocket directly, or JSON-RPC (provider-connect) over WebSocket?
   Protocol §2 is transport-agnostic; provider-connect's JSON-RPC surface can carry the envelope
   without change.
4. **Re-check "too fresh" versions** (flutter_webrtc 1.6.0, WebRTC 151.0.0, supabase-dart 2.16.0,
   appwrite 25.4.0, firebase_core 4.13.0, firestore 26.5.0, supabase-swift 2.54.1) once they age
   past 14 days and bump pins in the same PR that adopts them.
5. **KMP:** decide in the Kotlin binding milestone 2 whether to add iOS targets.

---

## 9. Source URLs (all accessed 2026-08-11)

**WebRTC packages**
- <https://webrtc.github.io/webrtc-org/native-code/android/> (Google WebRTC Android — JCenter, dead)
- <https://github.com/getstream/stream-webrtc-android> · <https://central.sonatype.com/artifact/io.getstream/stream-webrtc-android>
- <https://repo1.maven.org/maven2/io/getstream/stream-webrtc-android/maven-metadata.xml>
- <https://github.com/jitsi/webrtc> · <https://central.sonatype.com/artifact/org.jitsi/webrtc>
- <https://trunk.cocoapods.org/api/v1/pods/GoogleWebRTC> (versions + dates)
- <https://trunk.cocoapods.org/api/v1/pods/GoogleWebRTC/specs/1.1.32000> (podspec)
- <https://github.com/stasel/WebRTC/releases>
- <https://pub.dev/api/packages/flutter_webrtc> · <https://github.com/cloudwebrtc/flutter-webrtc>
- <https://pub.dev/api/packages/dart_webrtc> · <https://pub.dev/api/packages/webrtc_interface>

**Protocol**
- <https://quicktype.io/> · <https://github.com/glideapps/quicktype>
- <https://github.com/YousefED/typescript-json-schema>
- <https://docs.livekit.io/reference/internals/client-protocol/> (protobuf signaling precedent)
- <https://github.com/peers/peerjs> · <https://github.com/feross/simple-peer>
- <https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling>
- <https://github.com/protocolbuffers/protobuf> · <https://github.com/apple/swift-protobuf>
- RFC 3264 (SDP) <https://www.rfc-editor.org/rfc/rfc3264> · RFC 8445 (ICE) <https://www.rfc-editor.org/rfc/rfc8445>

**Backends**
- Convex: <https://docs.convex.dev/client/android/overview> · <https://docs.convex.dev/client/swift/overview> ·
  <https://github.com/get-convex/convex-swift> · <https://github.com/get-convex/convex-backend/issues/54> ·
  <https://pub.dev/packages/convex_dart>
- Supabase: <https://supabase.com/docs/reference/kotlin> · <https://supabase.com/docs/reference/swift> ·
  <https://supabase.com/docs/reference/dart> · <https://github.com/supabase-community/supabase-kt> ·
  <https://github.com/supabase/supabase-swift> · <https://github.com/supabase/supabase-dart>
- Firebase: <https://firebase.google.com/docs/android/setup> · <https://firebase.google.com/docs/ios/setup> ·
  <https://firebase.google.com/docs/flutter/setup> · <https://github.com/firebase/firebase-ios-sdk/releases> ·
  <https://dl.google.com/dl/android/maven2/com/google/firebase/firebase-firestore/maven-metadata.xml>
- Appwrite: <https://appwrite.io/docs> · <https://github.com/appwrite/sdk-for-android> ·
  <https://github.com/appwrite/sdk-for-apple> · <https://github.com/appwrite/sdk-for-swift>
- Postgres: <https://jdbc.postgresql.org/> · <https://github.com/vapor/postgres-nio> ·
  <https://pub.dev/packages/postgres>
- SQLite: <https://developer.android.com/training/data-storage/room> · <https://github.com/groue/GRDB.swift> ·
  <https://pub.dev/packages/sqflite>

**Testing / CI**
- <https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md> (Xcode + Android SDK preinstalled)
- <https://github.com/ReactiveCircus/android-emulator-runner>
- <https://docs.github.com/en/actions/using-github-hosted-runners/using-github-hosted-runners/about-github-hosted-runners>

**FFI / architecture**
- <https://github.com/mozilla/uniffi-rs> · <https://mozilla.github.io/uniffi-rs/> · <https://crates.io/api/v1/crates/uniffi>
- <https://kotlinlang.org/multiplatform/> · <https://developer.android.com/kotlin/multiplatform>

**Publishing**
- Maven Central: <https://central.sonatype.com/> · <https://central.sonatype.org/register/namespace/> ·
  <https://central.sonatype.org/publish/publish-gradle/> · <https://central.sonatype.org/publish/requirements/gpg/>
- CocoaPods: <https://guides.cocoapods.org/making/getting-setup-with-trunk.html> ·
  <https://guides.cocoapods.org/terminal/commands.html> · <https://blog.cocoapods.org/CocoaPods-Specs-Repo/> (trunk read-only plan)
- SwiftPM: <https://developer.apple.com/documentation/swiftpackagemanager> · <https://swiftpackageindex.com/>
- pub.dev: <https://dart.dev/tools/pub/publishing> · <https://pub.dev/help/publishing> · <https://pub.dev/create-publisher>

---

*Blueprint notes: this document is the implementation reference for tomorrow's work. Pins in §7 are
the exact versions to put into Gradle/Package.swift/pubspec.yaml, re-verified against the 14-day rule
at add time.*
