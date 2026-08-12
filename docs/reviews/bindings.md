# vidcall Mobile Bindings — Architecture Review

**Status:** Review (read-only) · **Date:** 2026-08-12 · **Scope:** `packages/kotlin`, `packages/swift`, `packages/dart`
**Reviewed against:** `protocol/schema.json` (single source of truth), `packages/core` (TS engine public API), `docs/architecture.md`, `docs/research/mobile-bindings.md` (implementation blueprint), `CONTRIBUTING.md`.
**Verification performed (read-only):** `swift test` (19/19 green), `dart test` (29/29 green, `dart analyze` clean), `./gradlew test` on JDK 21 (protocol 10 + client 12 + android 4+4 green, BUILD SUCCESSFUL). Kotlin runs locally via the pinned Temurin 21 toolchain — no longer a "skip" item.

---

## 1. Executive summary

All three bindings implement the same architecture: a **protocol layer** (typed mirror of `schema.json`), a **signaling client** (backend-agnostic, envelope in/out), and a **WebRTC glue layer** over the platform engine (`org.webrtc` / GoogleWebRTC / `flutter_webrtc`). Protocol models are hand-written mirrors of the schema (not quicktype codegen, as the blueprint's D8 envisioned), which is acceptable at this surface size but is the root cause of fixture drift (§5) and of several small wire divergences.

Strengths:

- **Supply chain is clean.** Every pinned artifact was verified against Maven Central / pub.dev / Google Maven on 2026-08-12 and satisfies the ≥14-day rule at the 2026-08-11 adoption cutoff (§8). Exact pins, committed lockfiles (`gradle.lockfile` ×3 + `settings-gradle.lockfile`, `pubspec.lock`), Swift is zero-dependency.
- **Kotlin is the most complete binding**: full mesh (one `PeerConnection` per peer), perfect negotiation, trickle-ICE queueing, per-sender dedupe, auto-pong, unicast routing, pure mapping functions unit-tested on the JVM. Its `org.webrtc` choice (Stream prebuilt) is the right one.
- **Dart** is clean and idiomatic; `flutter_webrtc 1.5.2` is the correct package (`webrtc_flutter` does not exist on pub.dev — 404, per blueprint D9).
- **Swift protocol layer is exemplary**: `LenientStringEnum` preserves unknown wire values (forward-compat), `JSONValue` keeps arbitrary objects lossless, zero deps, fully offline-testable.

Critical gaps:

1. **Cross-binding polarity rule conflict (P0).** The TS core derives perfect-negotiation polarity as `polite = selfId < remoteId`; Kotlin derives `impolite = myClientId < theirClientId` (i.e. `polite = largerId`). For a TS↔Kotlin room the same pair can be **both polite or both impolite**, deadlocking glare. The tie-break must be a single documented rule in the protocol, identical in every binding.
2. **L0 fixtures are not identical across bindings (P0).** Kotlin/Swift/Dart each ship their own copies of join/offer/ice with different `roomId`/`senderId`/`sessionId`/`ts`/`seq`/platform values (§5). The "shared conformance suite" (CONTRIBUTING.md, blueprint §4) does not exist as shared artifacts; each test only round-trips its own fixture.
3. **Swift's WebRTC glue is uncompiled, unverified dead code (P0).** The `.binaryTarget` is commented out in `Package.swift`; `VidcallWebRTC` compiles to a stub in CI. The real `#if canImport(WebRTC)` code has never been built or run (and has at least one semantic bug in its glare path, §4.2).
4. **Unknown message `type` is rejected by Kotlin (P0/P1).** `MessageType` decode throws `SerializationException` on an unknown `type`, violating the schema rule "tolerate unknown `type` values (ignore + log)". Swift (`case .unknown`) and Dart (`rawType`) both tolerate.
5. **No data channels, no recording, no quality controller, no participant roster (P1).** These TS-core capabilities are absent in all three mobile bindings (§6). Swift/Dart additionally have no unicast (`targetSenderId`) and no ordering/idempotency layer, so they cannot interop with the JS mesh engine's addressing model.

---

## 2. Kotlin binding (`packages/kotlin`)

### 2.1 Architecture

Three Gradle modules, all published under `io.vidcall`:

```
vidcall-protocol  (JVM jar)   Envelope/MessageType/Payloads data classes + shared JSON codec
vidcall-client    (JVM jar)   VidcallClient (signaling state machine), WebSocketTransport, RestTransport
vidcall-android   (AAR)       WebRtcFactory, PeerConnectionManager (mesh), VidcallRtcClient (facade)
```

- `Envelope` mirrors the schema's 7 required fields; `payload` is a `JsonObject` so the envelope codec is stable while payload types evolve. Typed payloads (`JoinPayload`, …) are separate `@Serializable` classes, converted via `encodeAsPayload()`/`decodeAsPayload()`.
- `Protocol.json` codec config matches the schema's forward-compat intent: `encodeDefaults = true` (stable wire form), `explicitNulls = false` (omit null optionals), `ignoreUnknownKeys = true` (tolerate additive fields).
- `VidcallClient` owns `seq` (1-based), version guard (reports `protocol-version` error envelope), (senderId, seq) dedupe, auto-pong, and typed dispatch to `VidcallEventListener`.
- Transports: `WebSocketTransport` (room socket + lazy per-target `to=` sockets for unicast) and `RestTransport` (HTTP POST + 1s poll loop on a daemon thread).
- `PeerConnectionManager` implements perfect negotiation (polite/impolite), trickle-ICE queueing until the remote description lands, renegotiation on `onRenegotiationNeeded`, track/ICE-state events. `VidcallRtcClient` wires signaling → peers and exposes local media creation, screen-share announce, chat/reactions/presence.

### 2.2 Library alternatives

| Dep (pinned) | Published | Verdict vs alternatives |
|---|---|---|
| `org.jetbrains.kotlinx:kotlinx-serialization-json 1.11.0` | 2026-04-09 | **Correct choice.** Compile-time codegen, no reflection, KMP-ready, first-class Kotlin default/null semantics. Alternatives: **Moshi** (needs reflection or codegen + okio dep; stronger for legacy JSON), **Gson** (reflection-based; no Kotlin defaults; worse perf), `org.json` (platform, untyped). kotlinx wins on type-safety + zero extra runtime deps beyond the serializer. |
| `io.getstream:stream-webrtc-android 1.3.10` | 2025-09-11 | **Correct choice.** Maintained prebuilt `org.webrtc` AAR on Maven Central. Alternatives: `org.jitsi:webrtc 124.0.0` (older M124 build), `com.dafruits:webrtc` (smaller community), Google's `org.webrtc:google-webrtc` (JCenter, dead since 2021). |
| `com.squareup.okhttp3:okhttp 5.4.0` | 2026-06-08 | Reasonable. WebSocket + HTTP in one client; standard on Android. Alternatives: Ktor client (heavier, coroutine-first), `java.net.http` (no first-class WS). |
| `junit 4.13.2` (test) | 2021-02-13 | Fine for JVM unit tests. |

### 2.3 API parity vs TS core

| TS core (`Room`) | Kotlin (`VidcallRtcClient` + `VidcallClient`) |
|---|---|
| `join()` / `leave(reason)` | `connect()` + `join(...)` / `leave(reason)` ✓ |
| `publish(track)` / `unpublish(pub)` | `setLocalMedia(...)` + `addLocalTrack` ✓ / **unpublish ✗** |
| `subscribe(id,{kind})` + `setEnabled` | ✗ |
| `track` / `track-unpublished` events | `onRemoteTrack/onRemoteAudio/VideoTrack` ✓ / **unpublished ✗** |
| `participant-joined/left/updated` | `onPeerJoined/onPeerLeft` ✓ / **updated ✗** (join metadata not merged) |
| `presence` (backend-native) | `onPresence` envelope callback ✓ (no backend-native presence layer) |
| `reaction` / `chat` / `screen-share` | ✓ send+receive |
| `quality-warning` | ✓ send (`sendQualityWarning`) + `onQualityWarning` (no adaptation engine) |
| `restartIce(participantId?)` | ✗ |
| `connection-state` / `ice-connection-state` | ice-connection-state ✓ / aggregate connection-state ✗ |
| DataChannelBus (SCTP reactions/chat/control) | ✗ (`onDataChannel` is an empty stub, "future work") |
| `recording` facade (MediaRecorder + upload) | ✗ |
| Ordering buffer (per-sessionId) | dedupe only, keyed **(senderId, seq)** — different key semantics than TS (`sessionId`); no reorder |
| Auto-pong on ping | ✓ |
| Unicast (`targetSenderId`) | ✓ transport-level `targetSessionId` (not envelope field) |
| Polarity tie-break | **`impolite = myId < theirId` — opposite of TS `polite = selfId < remoteId` → P0** |

### 2.4 L0 fixture conformance & platform caveats

- Fixtures: 3 files (`sample-join/offer/ice.json`) under `vidcall-protocol/src/test/resources/envelopes/`. Round-trip and typed-decode tests pass (10 tests). **Unknown `type` is asserted to *throw*** — schema violation (§1.4).
- Caveats: camera capture needs runtime CAMERA permission (documented); screen share needs app-owned MediaProjection capturer; `RestTransport.send` blocks the caller thread; no reconnect/backoff in `WebSocketTransport`; `PeerConnectionManager` has no SDP idempotency guard (`o=` line) unlike the TS core.

### 2.5 Code quality

Highest quality of the three: clean layering, pure mapping functions isolated for JVM testing, thread-safety notes, KDoc on public API, lockfile-pinned catalog with audit dates in `libs.versions.toml`. 26 test executions green (protocol 10, client 12, android 4 debug + 4 release). `PeerConnectionManager` itself is untested (only the pure mappings are) — no fake `PeerConnectionFactory` exists.

---

## 3. Swift binding (`packages/swift`)

### 3.1 Architecture

Two SwiftPM products:

```
Vidcall        (pure Swift, zero deps)  Envelope + Payloads (Codable), JSONValue, VidcallClient (URLSessionWebSocketTask)
VidcallWebRTC  (optional glue)          PeerConnectionManaging protocol + WebRTCPeerConnectionManager (#if canImport(WebRTC))
```

- Protocol layer: `Envelope` decodes `type` into `MessageType` and routes `payload` to the typed `Payload` enum via `Payload.decode(type:raw:)`. Unknown types and enum values are preserved (`LenientStringEnum` → `.unknown(String)`), unknown payload JSON preserved as `JSONValue` — best-in-class forward compatibility of the three bindings.
- `VidcallClient`: `async` `connect()`, typed senders, `Event` enum dispatch (weak listeners + `onEvent` closure), heartbeat timer, session-id override. No dedupe/ordering, no auto-pong.
- `VidcallWebRTC`: a **single** peer connection per manager instance wired to one client (single-peer, not a room mesh). `makePeerConnectionManager` returns `nil` unless the `WebRTC` module is linked.

### 3.2 The WebRTC gap

- `Package.swift` keeps the `WebRTC 150.0.0` binary target **commented out** (checksum present). `VidcallWebRTC.swift` compiles to a stub; CI (`swift build`/`swift test`) never compiles the real glue. **No podspec exists**, so Path B (CocoaPods) is a manual, undocumented-by-code integration. The research blueprint recommended the stasel `WebRTC` pod `150.0.0` (2026-07-11) or official `GoogleWebRTC 1.1.32000` (2023-03-07, stale) — the code is written against that module surface, but the module is never linked or exercised.
- Semantic issues in the (uncompiled) glare path: on a colliding remote offer the impolite branch calls `setRemoteDescription(.rollback, "")` — rollback is a *local* description operation; the correct behavior (TS/Kotlin/Dart) is to **ignore** the colliding offer. Also `handleIncoming` never filters by `envelope.senderId`, and candidates are added immediately (no queue until remote description), so trickle ICE candidates arriving before the remote offer are dropped by GoogleWebRTC.

### 3.3 Library alternatives

| Dep (pinned) | Published | Verdict |
|---|---|---|
| Foundation `Codable` (stdlib) | — | **Correct choice** vs hand-rolled JSON: schema mirrors are concise, `JSONValue` handles `type: object` payloads, `LenientStringEnum` handles enums. Hand-rolled JSON would duplicate this for zero benefit. |
| `WebRTC` (stasel) 150.0.0 / `GoogleWebRTC` 1.1.32000 | 2026-07-11 / 2023-03-07 | **Not actually adopted** — no dependency is declared. When adopted, stasel 150.0.0 is the right pick (monthly M-builds; 151.0.0 was too fresh at adoption). GoogleWebRTC is the fallback but 3.5y stale. |

### 3.4 API parity vs TS core

Single-peer only: `negotiate()` / `addLocalAudioTrack` / `addLocalVideoTrack` / `startCameraCapture` / `restartIce` (none) / `leave()`. No participant roster, no presence, no data-channel bus, no recording, no unicast (`targetSenderId` not in `Envelope`), no ordering/dedupe, no auto-pong. `onRemoteMediaStream` delivers whole streams rather than per-track publications (`track`/`track-unpublished` parity missing).

### 3.5 L0 conformance, caveats, quality

- Fixtures `envelope-join/offer/ice.json` round-trip byte-for-byte (13 protocol tests green); the client tests (6) cover seq/config/session-id override only. **No test exercises an actual socket** (fine — L2), and none exercises the WebRTC layer.
- Platform: iOS 13+ / macOS 10.15+ declared; the commented xcframework claims iOS+macOS slices. No README.md exists in `packages/swift` although `Package.swift` and `VidcallWebRTC.swift` both reference "README.md 'WebRTC integration'" — dangling doc pointer.
- Code quality: excellent structure and documentation in the protocol layer; the client is thread-safe (`NSLock`, weak listeners, `@unchecked Sendable` is justified and commented); the WebRTC layer is well-written but **unverifiable as shipped**.

---

## 4. Dart binding (`packages/dart`)

### 4.1 Architecture

```
lib/src/protocol/  envelope.dart, message_type.dart, payloads.dart  (manual schema mirrors, zero deps)
lib/src/client.dart       VidcallClient over dart:io WebSocket (Stream-based events)
lib/src/webrtc/rtc_session.dart  VidcallRtcSession over flutter_webrtc (single peer connection)
```

- `Envelope` keeps the raw payload map, `decodePayload()` returns typed `Payload` subclasses; unknown `type` → `type == null` + `rawType` preserved (forward-compat ✓). `fromJson` enforces `v == 1` and required fields.
- `VidcallClient`: `connect(uri)`, typed senders, 0-based `seq`, no dedupe/ordering, no auto-pong. `dart:io` only — **no Flutter web**.
- `VidcallRtcSession`: one `RTCPeerConnection`; perfect negotiation with polite/impolite; trickle ICE via `onIceCandidate`; `restartIce()` exists; `leave` envelope triggers `dispose()`.

### 4.2 Library alternatives

| Dep (pinned) | Published | Verdict |
|---|---|---|
| `flutter_webrtc 1.5.2` | 2026-06-19 | **Correct choice.** (`webrtc_flutter` does not exist on pub.dev — 404; the parent-prompt comparison resolves to `flutter_webrtc`.) 1.6.0 (2026-08-03) was correctly **not** adopted (too fresh at 08-11). Transitives `webrtc_interface 1.5.1` / `dart_webrtc 1.8.1` arrive pinned via `pubspec.lock` — `dart_webrtc` would be the alternative for web/desktop parity. |
| hand-rolled `fromJson/toJson` (no `json_serializable`/`freezed`) | — | Acceptable (minimal deps per policy) but the **highest drift risk** of the three bindings: no codegen from schema, no shared-fixture harness to catch drift (§5). |
| `lints 4.0.0` / `test 1.25.2` (dev) | 2024-05-09 / 2024-01-24 | Fine. |

### 4.3 API parity vs TS core

Same single-peer gaps as Swift (no mesh roster, no data-channel bus, no recording, no `targetSenderId`, no ordering/dedupe, no auto-pong), plus: `sendOffer`/`sendAnswer` have **no unicast target**; `_handleOffer` answers offers from **any** sender on the single connection (no `senderId` check — a mesh broadcast would corrupt a one-to-one session); no `track-unpublished`; no `subscribe`/`setEnabled`. Positives: `onConnectionState`/`onIceConnectionState` streams, `restartIce`, `onTrack` — closer to the JS event surface than Swift.

### 4.4 L0 conformance, caveats, quality

- Fixtures: 3 envelopes in `test/fixtures/sample_envelopes.json`; `protocol_roundtrip_test.dart` asserts exact byte round-trip and validation edge cases (29 tests green, `dart analyze` clean).
- Caveats: `dart:io` WebSocket → no web target despite `flutter_webrtc` web support; `VidcallRtcSession` is untested (no `flutter_webrtc` fake; platform channels unavailable in `dart test`) — the whole WebRTC layer has zero test coverage.
- Code quality: clean, idiomatic, well-documented; streams instead of callbacks are a nice fit for Dart.

---

## 5. L0 fixture conformance — are the sample envelopes identical?

**No.** The three bindings each ship their own copies of the same three envelopes (join/offer/ice) with **different values**:

| Field | Kotlin (room-42) | Swift | Dart |
|---|---|---|---|
| `roomId` | `room-42` | `room-abc` | `room-abc` |
| `senderId` (join) | `user-ada` | `user-42` | `user-42` |
| `sessionId` | `sess-abc-0001` | `sess-001` | `sess-1` |
| `ts` (join) | 1786000000000 | 1780000000000 | 1780000000000 |
| `seq` (join) | 1 | 1 | **0** |
| `deviceProfile.platform` | `kotlin` | `swift` | `dart` |
| ICE candidate | `…192.168.1.10 53520…` | `…192.0.2.1 54321… ufrag 7Qyq…` | `…192.168.1.10 54231… ufrag xyz` |

- Structures and key order match; values differ everywhere except `v`/`type`.
- **No shared fixture directory exists** (`protocol/fixtures/` from the blueprint was never created); each binding's "L0" test only round-trips its own self-authored fixture, so the conformance suite is effectively **per-binding smoke tests**, not an interop contract.
- Coverage is only join/offer/ice — 3 of 14 message types. No shared scenarios (glare, renegotiation, ICE-before-offer, unknown-type tolerance, version guard).

### Divergent wire behaviors found while comparing (see §1.4, §6)

- **Unknown `type`:** Kotlin throws; Swift preserves `.unknown`; Dart preserves `rawType`; TS core ignores. Schema says tolerate+log → **Kotlin violates**.
- **`seq` base:** TS 0-based, Dart 0-based, Kotlin/Swift 1-based (harmless for monotonicity, but a shared fixture would have caught it).
- **Auto-pong:** TS + Kotlin auto-reply; Swift/Dart only surface `.ping`.
- **Version guard:** Kotlin reports `protocol-version` error; Dart throws `FormatException`; Swift/TS do not check `v`.
- **Dedupe key:** TS `OrderedMessageBuffer` keys by `sessionId`; Kotlin keys by `(senderId, seq)` (a rejoin with the same `senderId` but fresh `sessionId` and low `seq` is wrongly dropped).
- **Polarity:** TS `polite = selfId < remoteId` vs Kotlin `impolite = myId < theirId` → **opposite roles** for cross-binding pairs (§1.1). Dart/Swift default both sides to `polite` with no deterministic rule.

---

## 6. Parity matrix (TS core vs bindings)

| Capability | TS core | Kotlin | Swift | Dart |
|---|---|---|---|---|
| join / leave / closed | ✓ | ✓ | ✓ | ✓ |
| publish / unpublish | ✓ | ✓ / ✗ | ✓ / ✗ | ✓ / ✗ |
| subscribe + setEnabled | ✓ | ✗ | ✗ | ✗ |
| track / track-unpublished | ✓ | ✓ / ✗ | stream / ✗ | onTrack / ✗ |
| participant-joined/left/updated | ✓ | ✓ / ✓ / ✗ | ✗ | ✗ |
| presence (backend-native) | ✓ | env-only | ✗ | ✗ |
| reaction / chat / screen-share | ✓ | ✓ | ✓ | ✓ |
| quality-warning send/receive | ✓ | ✓ | ✓ | ✓ |
| quality adaptation engine | ✓ (`@vidcall/quality`) | ✗ | ✗ | ✗ |
| ICE restart | ✓ | ✗ | ✗ | ✓ |
| connection-state / ice-conn-state | ✓ / ✓ | ✗ / ✓ | status / ✓ | ✓ / ✓ |
| DataChannelBus (reactions/chat/control) | ✓ | ✗ | ✗ | ✗ |
| recording facade | ✓ | ✗ | ✗ | ✗ |
| ordering/dedupe buffer | ✓ | dedupe only | ✗ | ✗ |
| auto-pong | ✓ | ✓ | ✗ | ✗ |
| unicast `targetSenderId` | ✓ (envelope) | ✓ (transport) | ✗ | ✗ |
| deterministic glare tie-break | ✓ | ⚠ **inverted** | ✗ (default polite) | ✗ (default polite) |

---

## 7. Ranked recommendations

### P0 — blockers (correctness / interop / false claims)

1. **Unify the perfect-negotiation polarity rule and document it in `protocol/schema.json`.** Pick one derivation (recommend TS's `polite = selfId < remoteId`) and implement it identically in Kotlin (`Mapping.kt` currently inverts it), Swift and Dart (both currently default to `polite` with no derivation). Add an L0 scenario that runs the same glare script in two bindings.
2. **Create `protocol/fixtures/` as the single source of L0 envelopes** (all 14 types + edge cases), delete the per-binding copies, and make each binding's conformance test load and byte-round-trip the shared files (CONTRIBUTING.md "shared test matrix" is currently not met). Include the divergences from §5 (unknown-type, version guard, seq base) as explicit conformance cases.
3. **Kotlin: tolerate unknown `type`.** Replace the strict `MessageType` enum decode with a lenient deserializer (Swift-style `.unknown(raw)` / Dart-style rawType) instead of throwing; the current test `unknown envelope type fails to decode` asserts the schema-violating behavior and must be inverted.
4. **Swift: make the WebRTC path real or explicitly experimental.** Either (a) land the pinned `WebRTC 150.0.0` binary target (verify checksum, add a CI job that compiles `VidcallWebRTC` with the module and runs an iOS/macOS smoke test), or (b) strip the product from the manifest and mark the glue "experimental, not yet integrated". As shipped, `VidcallWebRTC` is unverified dead code that the README-level claims contradict; fix the glare rollback bug and the missing trickle-ICE queue while in there.

### P1 — important gaps

5. **Add unicast to Swift/Dart signaling** (`targetSenderId` envelope field — already the TS core's additive extension) and a `senderId` filter in Dart's `_handleOffer` so a broadcast backend can't corrupt single-peer sessions; without this, Swift/Dart peers cannot interop with the JS mesh's targeted offer/answer/ICE.
6. **Port the ordering/idempotency layer** (per-`sessionId` monotonic accept — TS `OrderedMessageBuffer`) to Swift and Dart clients, and key Kotlin's dedupe by `sessionId` instead of `senderId`. Add auto-pong to Swift/Dart for parity.
7. **Implement the data-channel bus** (reactions/chat/control over SCTP) in at least Kotlin (stub already present) and Dart; wire into the same typed senders as the backend path (TS `DataChannelBus`).
8. **Participant roster + track lifecycle parity**: Kotlin should merge join metadata (`participant-updated`), and all three should emit `track-unpublished`/unpublish/subscribe semantics or document mesh-tier explicitly as one-to-one for Swift/Dart.
9. **Test the WebRTC layers**: a fake `PeerConnectionFactory`/`RTCPeerConnection` for Kotlin's `PeerConnectionManager` (glare, trickle-before-offer, renegotiation), a fake `flutter_webrtc` interface for Dart's `VidcallRtcSession` (the interface package `webrtc_interface` is already in the lockfile), and a compile-gated Swift test once P0-4 lands.

### P2 — polish

10. **Recording facade** (composite `MediaRecorder`-equivalent per platform + uploader) — required only when mobile parity with TS `room.recording` is a product goal; otherwise document as JS-only.
11. **Adaptive quality**: mobile bindings can already emit/consume `quality-warning`; porting `@vidcall/quality`'s pure tier ladder (stats → action) would give mobile the same adaptation; low urgency for v1 mesh.
12. **Kotlin `RestTransport`**: move blocking HTTP off the caller thread; add reconnect/backoff to `WebSocketTransport`.
13. **Swift**: add the missing `README.md` (referenced by `Package.swift`/`VidcallWebRTC.swift`), consider `Int64` JSON numbers in `JSONValue` for `seq` precision at extreme values, and document macOS support status.
14. **Dart**: document the `dart:io`-only limitation (no Flutter web) in the README; consider `web_socket_channel` for a web-capable connector.
15. **CI**: add `dart analyze` already present ✓; add a compile check for the Kotlin Android module on a real emulator (L2) and, per blueprint §4.3, a macOS runner that can host both iOS simulator and Android emulator; keep kotlin job pinned to the JDK version actually used (21).

---

## 8. Supply-chain verification (2026-08-12, live)

All pins satisfy CONTRIBUTING.md (≥14 days old at the 2026-08-11 adoption cutoff; exact pins; lockfiles committed):

| Dep | Pin | Published | Source |
|---|---|---|---|
| kotlinx-serialization-json | 1.11.0 | 2026-04-09 | repo1.maven.org pom Last-Modified |
| okhttp | 5.4.0 | 2026-06-08 | repo1.maven.org |
| io.getstream:stream-webrtc-android | 1.3.10 | 2025-09-11 | repo1.maven.org |
| junit | 4.13.2 | 2021-02-13 | repo1.maven.org |
| Kotlin Gradle plugin | 2.4.10 | 2026-07-14 | repo1.maven.org |
| Android Gradle plugin | 8.13.2 | 2025-12-11 | dl.google.com maven-metadata |
| flutter_webrtc | 1.5.2 | 2026-06-19 | pub.dev API (1.6.0 on 08-03 correctly not adopted) |
| lints / test | 4.0.0 / 1.25.2 | 2024-05-09 / 2024-01-24 | pub.dev API |
| Swift | none | — | zero external deps |

---

## 9. Verification log (read-only)

```
swift:  cd packages/swift && swift test           → 19 tests, 0 failures (Swift 6.3.3, arm64)
dart:   cd packages/dart && dart pub get && dart analyze && dart test
                                                 → analyze: No issues found; 29 tests, all passed (Dart 3.4.1)
kotlin: cd packages/kotlin && JAVA_HOME=<temurin-21> ./gradlew test --console=plain --offline
                                                 → BUILD SUCCESSFUL; protocol 10, client 12,
                                                   android 4 (debug) + 4 (release), 0 failures
                                                 (local run was possible via the mise Temurin 21 toolchain)
```

No source files were modified; the only artifact of this review is this document.
