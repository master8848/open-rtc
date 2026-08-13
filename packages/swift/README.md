# Vidcall Swift binding

Swift bindings for the vidcall signaling protocol + WebRTC glue
(`packages/swift`). Wire contract: `protocol/schema.json` (single source of
truth).

## Layout

| Target | What it is |
| --- | --- |
| `Vidcall` | Pure Swift — `Envelope` + payloads (`Codable`) and the `VidcallClient` WebSocket signaling client. Zero dependencies; builds and tests fully offline. |
| `VidcallWebRTC` | WebRTC glue: `PeerConnectionManager` (perfect-negotiation state machine, trickle ICE, ICE restart), `DataChannelBus` (typed `{v,t,d}` JSON frames over one SCTP channel), and `RTCPeerConnectionSession`, the real GoogleWebRTC adapter. The state machine and bus are WebRTC-agnostic — they compile and test offline against injected fakes; the GoogleWebRTC adapter activates with `#if canImport(WebRTC)`. |
| `VidcallTests` | Protocol/client tests: envelope Codable conformance + client behavior (19 tests). |
| `VidcallWebRTCTests` | State-machine tests against fake sessions (18), L2 loopback over an in-process signaling bridge (4), and an env-gated real-WebRTC smoke test (1, runs only when the `WebRTC` module is linked). |

## Build & test

```sh
cd packages/swift
swift build          # offline, zero deps
swift test           # 41 tests green offline
```

With the WebRTC binary target enabled (see below): `swift test` runs 42 tests
— the real-WebRTC loopback negotiates two `RTCPeerConnection`s on one machine
and exchanges chat over live SCTP.

## WebRTC integration

Two paths; the package defaults to **Path A disabled** so builds stay fully
offline. The real-WebRTC test skips gracefully (compiles to nothing) when the
module is not linked.

- **Path A — SwiftPM binary target (default: commented):** the community
  WebRTC 150.0.0 xcframework (stasel) — the same binary the community
  CocoaPod `WebRTC` 150.0.0 ships. Enable with
  `scripts/enable-webrtc.sh` (fetches the pinned 44 MB artifact once, verifies
  the SHA-256 checksum, and uncomments the dependency + binary target);
  disable again with `scripts/disable-webrtc.sh`.
- **Path B — CocoaPods (manual):** `pod 'WebRTC', '150.0.0'` (community, iOS) or
  `pod 'GoogleWebRTC', '1.1.32000'` (official, iOS), and add
  `Sources/VidcallWebRTC` to the app target. No `Package.swift` change needed —
  the glue is `#if canImport(WebRTC)`-guarded.

### Determinism note

All async signaling operations (`negotiate` / `restartIce` /
`receiveRemoteOffer` / `receiveRemoteAnswer`) run through a serial
`SignalingSerialQueue` in `PeerConnectionManager`. This closes the glare race
where a colliding remote offer could arrive while the polite peer's own
`createOffer`/`setLocalDescription` was still in flight (the real stack
rejects the concurrent `setRemoteDescription` with InvalidStateError, leaving
both peers stuck in `haveLocalOffer`). Negotiations are deduped at enqueue
time, mirroring the TS core's `makingOffer` guard.
