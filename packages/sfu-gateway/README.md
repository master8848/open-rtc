# @mbsks/sfu-gateway

The optional SFU path for vidcall (docs/architecture.md D2, docs/research/webrtc-js.md §3).

Mesh is the default and stays the core: every participant holds an
`RTCPeerConnection` to every other participant, which works over any dumb
pub/sub backend and is perfect for 2–4 people. Above ~4–6 video participants
it breaks down (N−1 uplinks/downlinks per peer, iOS Safari render limits,
typical home upload). An **SFU (selective forwarding unit)** fixes that by
having each participant send once to a media server which forwards to the
others — this package is the server/gateway side of that path.

This is a **scaffolding milestone**: the gateway contract, the protocol
envelope router, and a reference mediasoup adapter are in place and tested.
Wiring the gateway into `Room` (packages/core) is a parent TODO — the mesh
engine keeps working untouched in the meantime.

## What you get

| Piece                       | File                       | Role                                                                                                                                                                                                                                                                                                    |
| --------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SfuGateway` / `SfuSession` | `src/sfu-gateway.ts`       | transport- and media-agnostic contract: `join` → session, `publishTrack`, `subscribe`, `onTrack`, `leave`; SDP offers/answers and ICE candidates pass through untouched                                                                                                                                 |
| `SfuRouter`                 | `src/sfu-router.ts`        | consumes the protocol's `sfu` envelopes (`publish`/`subscribe`/`layer-change`/`keyframe-request`/`leave`) plus `offer`/`answer`/`ice` envelopes addressed to the SFU (`targetSenderId === 'sfu'`); validates room membership; forwards to the gateway; emits typed events. Pure logic, no media imports |
| `MediasoupAdapter`          | `src/mediasoup-adapter.ts` | reference adapter mapping the contract onto a mediasoup `Router` (`createWebRtcTransport` / `produce` / `consume` / `setPreferredLayers` / `requestKeyFrame` / `close`)                                                                                                                                 |
| SDP helpers                 | `src/sdp.ts`               | minimal SDP↔mediasoup translation used by the reference adapter                                                                                                                                                                                                                                         |

### Protocol mapping

`sfu` envelope action → session method:

| action                              | method                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `publish` (`trackId`, `kind`)       | `session.publishTrack(trackId, kind)`                                                                            |
| `subscribe` (`senderId?`)           | `session.subscribe(participantId)` — bare subscribe fans out to every publisher in the room except the requester |
| `layer-change` (`trackId`, `layer`) | `session.setPreferredLayers(trackId, layer)`                                                                     |
| `keyframe-request` (`trackId`)      | `session.requestKeyframe(trackId)`                                                                               |
| `leave`                             | `session.leave()`                                                                                                |

`offer`/`answer`/`ice` envelopes with `targetSenderId` set to the SFU
participant id (default `'sfu'`) are forwarded to the sender's session
(`handleOffer`/`handleAnswer`/`addIceCandidate`). All other envelopes are
ignored — mesh chat/reactions/presence keep flowing through the same backend.

## Plugging into Room (parent TODO)

```ts
import { SfuRouter, type SfuGateway } from '@mbsks/sfu-gateway';

// 1. Construct one gateway per room (mediasoup Router per room):
const gateway: SfuGateway = new MediasoupAdapter({ router, onAnswer: sendAnswerEnvelope });

// 2. Route protocol envelopes through the router:
const router = new SfuRouter({
  gateway,
  isParticipant: (roomId, participantId) => room.members.has(participantId),
});
transport.onMessage(roomId, (env) => void router.handle(env));

// 3. On participant join (SFU mode): create + register the session.
const session = await gateway.join(roomId, participantId, {
  transportOpts: { listenIps: ['0.0.0.0'] },
});
router.registerSession(session);

// 4. Track events drive subscriptions:
gateway.onTrack(({ roomId, participantId, trackId, direction, publicationId }) => {
  if (direction === 'send') room.participants.forEach((p) => p.session.subscribe(participantId));
});
```

That wiring lives in `Room` (packages/core) — out of scope for this milestone.

## mediasoup vs LiveKit

|                  | mediasoup (`MediasoupAdapter`)                                                                | LiveKit                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Role             | library you embed in your Node server; **you** run the worker                                 | platform (Go server + SDKs); you run the LiveKit server                                                                    |
| Signaling        | yours — vidcall's generic protocol fits directly (this package)                               | LiveKit's own WebSocket protocol; `livekit-client` owns the `RTCPeerConnection`, so pluggable vidcall backends don't apply |
| SDP/codecs       | full control (reference adapter does minimal translation; production swaps in a full SDP lib) | handled by the SDK                                                                                                         |
| Egress/recording | via your app                                                                                  | first-class (Egress)                                                                                                       |
| License          | ISC                                                                                           | Apache-2.0                                                                                                                 |
| Best for         | keeping vidcall's "pluggable everywhere" story; DIY ops                                       | standing up an SFU platform fast with less control                                                                         |

Both map behind `SfuGateway`; LiveKit would be a second adapter (its SDK owns
the PeerConnection, so it is a _platform_ — see webrtc-js.md §3.3).

## Development

```sh
npm run build        # tsc -p tsconfig.json
npm test             # node:test unit + smoke (36 tests; no mediasoup worker needed)
npm run test:integration   # real mediasoup worker (needs Node >= 22)
```

The integration test (`test/integration.mediasoup.test.ts`) exercises the full
wiring on a **real mediasoup Worker** (join → WebRtcTransport, publish →
produce, subscribe → consume, layer change, keyframe, leave). It is env-gated
and skipped by default because the worker is a native binary:

```sh
npm run test:integration   # sets VIDCALL_MEDIASOUP_INTEGRATION=1
```

### Dependencies

- `@mbsks/protocol` (runtime): envelope + `SfuPayload` types.
- `mediasoup` (devDependency only, exact pin `3.23.1`): the adapter `import
type`s mediasoup for compile-time types and the integration test drives a
  real worker. Runtime code never loads the native module.
  - Published 2026-07-28, ≥ 14-day supply-chain gate (CONTRIBUTING.md). The
    later 3.23.2 (2026-07-29) only adds subchannel handling for pipe
    `DataConsumers` — irrelevant to this adapter — so the pin stays on the
    version verified by the integration test. 3.24.x was still inside the
    14-day window at scaffold time; re-check `npm view mediasoup time` before
    any bump.
  - The mediasoup worker requires Node >= 22 (its `engines`); the package
    itself keeps `>=18.18` because mediasoup is a dev-time-only import.
  - Supply-chain check: `node_modules/mediasoup` is absent from the runtime
    graph — `dist/` has no `require('mediasoup')` (type-only import).

### Reference quality notes

The mediasoup adapter is a _reference_: SDP translation is deliberately
minimal (DTLS fingerprints/role, ICE ufrag/pwd, m-line codecs; placeholder
SSRCs for `produce()`). Production deployments must swap in a full SDP↔RTP
mapping (e.g. mediasoup-client on the device side, or a full SDP parser on the
server) — see `src/sdp.ts` doc comments.

Mediasoup 3.23 API notes (verified against the installed `.d.ts` and a real
worker):

- `WebRtcTransport.connect()` takes `{ dtlsParameters }` only — there is no
  remote-ICE input, so `addIceCandidate()` is a contract-keeping no-op (the
  worker handles ICE consent via `iceConsentTimeout`).
- Keyframe requests are receiver-driven: `consumer.requestKeyFrame()`
  (`Producer.requestKeyFrame()` no longer exists).
- `ProducerOptions.keyFrameRequestDelay` (ms) is exposed as
  `PublishOptions.keyFrameRequestDelayMs` (video only; default 0).
- `setPreferredLayers({ spatialLayer, temporalLayer })` maps the protocol's
  `l`/`m`/`h` layers to spatial indices 0/1/2.
