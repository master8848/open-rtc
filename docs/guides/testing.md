# Testing your app — fakes and harnesses

Use vidcall's test utilities so your app tests never need a real browser or camera.

## 1. What to install

```sh
bun add -D @mbsks/openrtc-test-utils
```

No extra deps: the package is zero-runtime and tree-shakeable (`packages/test-utils/package.json`). This is distinct from contributor `docs/testing.md:14` which describes L0/L1/L2 for the library itself.

## 2. FakeRTCPeerConnection — test engine logic without WebRTC

`packages/test-utils/src/fake-rtc.ts` is a faithful-enough `RTCPeerConnection` seam: real `signalingState` transitions, trickle ICE, data channels, `ontrack` via fake SDP `o=` lines, and `wirePeers(a,b)` to link two peers.

```ts
import { FakeRTCPeerConnection, wirePeers, FakeMediaStreamTrack } from '@mbsks/openrtc-test-utils';
import { Room } from '@mbsks/openrtc-core';
import { InMemoryTransport } from '@mbsks/openrtc-test-utils/fixtures'; // or your adapter

const a = new Room({ roomId: 'test', selfId: 'alice', transport, peerFactory: () => new FakeRTCPeerConnection() as unknown as RTCPeerConnection });
const b = new Room({ roomId: 'test', selfId: 'bob',   transport: () => new FakeRTCPeerConnection() });
// join + publish: engine's perfect negotiation, glare, ICE restart paths run over fakes
await a.join(); await b.join();
await a.publish(new FakeMediaStreamTrack('video'));
await new Promise(r => b.on('track', r));
```

Helpers: `createPeerPair()`, `installFakeRTC()`, `resetFakeRTC()`, `asFake(pc)`, `FakeDataChannel`, `FakeRTCRtpSender` with `setParameters`/`replaceTrack` tracking (`packages/test-utils/src/fake-rtc.ts:232`).

## 3. Fake devices and recording

`FakeMediaDevices` (`packages/test-utils/src/fake-media-devices.ts`) lets `room.controls` acquire tracks without `getUserMedia` permissions; `FakeMediaRecorder` (`packages/test-utils/src/fake-media-recorder.ts`) drives `room.recording` `blob-chunk` without encoding. Inject via `room.devices` / `ControlsManager` constructor (see `docs/features/controls.md:8`).

## 4. Mock AdaptiveQualityController

The policy engine is pure (`packages/quality/src/adaptive-quality-controller.ts:115`). In app tests, inject a stub `RoomQualityController` harness that returns deterministic tiers, or drive `FakeRTCRtpSender.setParameters` assertions (`FakeRTCRtpSender` records `applyConstraintsCalls`). The real controller polls `media.getPeerConnections()`/`getSenders()` (`docs/media.md:17`), so feeding it fake senders is enough.

## 5. What not to do

Don't test against real `RTCPeerConnection` in unit tests — that is L2 integration (`docs/testing.md:36`). Keep L0/L1 (protocol + unit + `runAdapterTestSuite`) for contributors; apps use fakes for speed and determinism.

Related: `packages/test-utils/src/index.ts`, `packages/transport/src/shared-tests.ts` (`runAdapterTestSuite`), `docs/features/controls.md`.
