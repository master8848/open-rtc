# vidcall (Dart/Flutter binding)

Dart/Flutter binding for **vidcall** — WebRTC video calling with a shared JSON
signaling protocol. The wire contract is `protocol/schema.json` at the repo
root: one versioned JSON envelope (`v/type/roomId/senderId/sessionId/ts/seq`)
with typed payloads, carried over any backend pub/sub. This package provides:

- **Protocol models** — Dart classes mirroring `schema.json` (manual mapping,
  forward-compatible with unknown `type` values).
- **`VidcallClient`** — backend-agnostic signaling client over `dart:io`
  WebSocket with Stream-based events. Works with any signaling URL (raw
  WebSocket fallback, or a relay in front of Supabase/Convex/Firebase/Appwrite/
  Postgres — see `docs/research/mobile-bindings.md` §3).
- **`VidcallRtcSession`** — a `flutter_webrtc` peer connection wired to the
  signaling stream: opaque SDP/ICE relayed verbatim, trickle ICE,
  offer/answer/ICE handling, perfect-negotiation glare control.

## Install

```yaml
dependencies:
  vidcall: ^0.1.0
```

Requires Dart `>=3.4.0` and Flutter `>=3.22.0` (the WebRTC session uses
`flutter_webrtc`, which is a Flutter plugin; the protocol models and
`VidcallClient` are pure Dart).

## Usage

### Signaling only (join / reactions / chat)

```dart
import 'package:vidcall/vidcall.dart';

final client = VidcallClient(roomId: 'room-abc', senderId: 'user-42');

// Events: decoded envelopes from the signaling backend.
final sub = client.events.listen((envelope) {
  final payload = envelope.decodePayload();
  if (payload is ChatPayload) print('${envelope.senderId}: ${payload.text}');
  if (payload is ReactionPayload) print('${payload.emoji}');
});

await client.connect(Uri.parse('wss://signal.example.com'));
await client.join(displayName: 'Ada');
await client.sendReaction('👋', targetSenderId: 'user-7');
await client.sendChat('hello!', replyTo: ChatReply(senderId: 'user-7', seq: 3));

await client.leave(reason: 'bye');
await client.close();
await sub.cancel();
```

### WebRTC session

```dart
final client = VidcallClient(roomId: 'room-abc');
await client.connect(Uri.parse('wss://signal.example.com'));
await client.join(displayName: 'Ada');

final session = VidcallRtcSession(client: client); // polite peer by default
await session.start();

final local = await VidcallRtcSession.captureLocalMedia();
await session.addLocalStream(local); // triggers negotiation when stable

session.onTrack.listen((event) {
  // render event.streams.first / event.track in an RTCVideoView
});

// Remote offer -> answer, remote ICE candidates, and onRenegotiationNeeded
// are handled automatically through the client envelope stream.
// Explicit offer (e.g. ICE restart):
await session.restartIce();

await session.dispose();
await client.close();
```

## Test matrix

The binding follows the shared matrix from `docs/research/mobile-bindings.md`
(§4) — same fixture-driven suites as the JS/Kotlin/Swift bindings:

| Layer | What it covers | Where it runs |
|---|---|---|
| **L0 protocol conformance** | encode/decode of the canonical wire fixtures (`protocol/fixtures/`, the single source of truth shared with the Kotlin/Swift/TS suites — see `protocol/fixtures/README.md`), unknown-field/type tolerance, version guard | `dart test` — CI (no devices) |
| **L1 unit tests** | `VidcallClient` over an in-process `dart:io` WebSocket broadcast server: send/receive round-trip, seq monotonicity, state transitions, schema validation | `dart test` — CI (no devices) |
| **L2 integration** | two real peers through a local signaling server + native WebRTC loopback | `flutter test integration_test` on iOS simulator + Android emulator (macOS GitHub Actions runner) |

Local checks (all green in CI):

```bash
dart pub get
dart analyze    # 0 issues
dart test       # L0 + L1
```

## Dependency audit (supply-chain policy)

`CONTRIBUTING.md` requires exact pins, every dependency published ≥ 14 days
before adoption, and an audit trail. Verified 2026-08-11 (cutoff 2026-07-28):

| Dep | Pin | Published | Why |
|---|---|---|---|
| `flutter_webrtc` | 1.5.2 | 2026-06-19 | cross-platform WebRTC plugin (Android/iOS/macOS/Windows/Linux/web). `1.6.0` (2026-08-03) was too fresh at adoption; `webrtc_flutter` does not exist on pub.dev (404, verified). |
| `test` (dev) | 1.25.2 | 2024-01-24 | test runner; `test_api 0.7.0` keeps `meta` compatible with the Flutter-pinned 1.12.0. |
| `lints` (dev) | 4.0.0 | 2024-05-09 | recommended lint set; newer `lints` require Dart ≥ 3.5 (this package supports 3.4). |

`pubspec.lock` is committed (workspace policy). No runtime dependency beyond
`flutter_webrtc` — protocol models and the client use only `dart:convert` /
`dart:io` / `dart:math` from the stdlib.

## Publishing (pub.dev)

- Publish with `dart pub publish` from this directory after removing
  `publish_to: none` from `pubspec.yaml` (it is set to prevent accidental
  publishes from the monorepo).
- **Verified publisher:** register a publisher domain first
  (<https://pub.dev/create-publisher>) and verify it via DNS TXT or an HTML
  file — a verified publisher is required to claim/transfer the `vidcall`
  package name and to satisfy the repo's publishing policy
  (`docs/research/mobile-bindings.md` §6.3). Package names are
  first-come-first-served; claim `vidcall` early.
- CI publishes only from git tags (conventional commits → tag → release).

## Known gaps (from research)

- **Convex has no official Dart client** — use this client's raw WebSocket
  against a signaling relay, or the community `convex_dart` (0.5.0,
  eligible).
- **macOS** WebRTC comes via `flutter_webrtc`'s macOS platform (native
  CocoaPods are iOS-only).
- The SFU gateway (`sfu` messages) is modeled in the protocol but no SFU
  client is bundled — see `docs/architecture.md` §3 (D2).
