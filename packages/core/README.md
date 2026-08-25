# @mbsks/openrtc-core

The vidcall client mesh engine: `Room` wraps the full WebRTC lifecycle —
perfect negotiation, trickle ICE, renegotiation, ICE restart, data channel,
adaptive-quality integration, controls, devices, and recording — behind a
small typed API.

**Zero runtime dependencies**: builds on the platform `RTCPeerConnection`
(browser WebRTC, werift/wrtc in Node, or injected fakes in tests).

## Install

```sh
npm i @mbsks/openrtc-core            # once published
# today (workspace): npm i file:../vidcall/packages/core  — see the root README
```

## The 30-second tour

```ts
import { Room } from '@mbsks/openrtc-core';
import { SupabaseBackend } from '@mbsks/openrtc-backend-supabase';

const room = new Room({
  roomId: 'demo',
  selfId: 'alice',
  displayName: 'Alice',
  transport: new SupabaseBackend({ client }), // any SignalingTransport
});

room.on('participant-joined', (p) => console.log('joined', p.displayName));
room.on('track', ({ participant, track }) => {
  const el = document.createElement('video');
  el.srcObject = new MediaStream([track]);
  el.autoplay = true;
  document.body.append(el); // remote media, mesh auto-subscribed
});
room.on('quality-warning', (e) => console.log(`${e.from} -> ${e.to}`, e.reason));

await room.join(); // subscribe to the room channel
await room.publish(camera); // your camera to everyone in the room
```

The transport is any object with the six-method signaling contract
(`join/leave/emit/onMessage/onPresence/setPresence/dispose` — see
[`@mbsks/openrtc-transport`](../transport/README.md)). The engine is backend-agnostic:
swap Supabase for Convex, Firebase, Appwrite, Postgres, or SQLite by swapping
one line.

## API surface

### `new Room(config)`

| Option              | Default                      | What it does                                                                |
| ------------------- | ---------------------------- | --------------------------------------------------------------------------- |
| `roomId`            | —                            | room to join (matches the envelope's `roomId`)                              |
| `selfId`            | —                            | stable peer id — matches `Envelope.senderId`                                |
| `displayName`       | —                            | announced to other participants                                             |
| `sessionId`         | random                       | per-join id — guards stale tabs/duplicates                                  |
| `transport`         | —                            | `SignalingTransport` (required)                                             |
| `peerFactory`       | platform `RTCPeerConnection` | inject fakes in tests                                                       |
| `iceServers`        | —                            | STUN/TURN servers for the peer connections                                  |
| `polite`            | `selfId < remoteId`          | politeness rule for perfect negotiation                                     |
| `autoRestartIce`    | —                            | restart ICE when a peer's connection state turns `failed`                   |
| `dataChannelName`   | `'vidcall'`                  | data channel label                                                          |
| `deviceProfile`     | —                            | adaptive-quality device capability                                          |
| `quality`           | auto (browsers only)         | `{ intervalMs, simulcast, enabled, … }` — local adaptive-quality controller |
| `recordingEndpoint` | —                            | base URL for uploading recording chunks to `@mbsks/openrtc-server`                |

### Events

| Event                                                                                  | Payload                                                | When                                               |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| `participant-joined` / `participant-left` / `participant-updated`                      | `RemoteParticipant`                                    | roster changes (leave envelope or presence expiry) |
| `track` / `track-unpublished`                                                          | `RemoteTrackEvent { participant, publication, track }` | remote media                                       |
| `connection-state` / `ice-connection-state`                                            | `{ participantId, state }`                             | per-peer connection health                         |
| `reaction` / `chat` / `screen-share`                                                   | room events                                            | over backend pub/sub and/or data channel           |
| `quality-warning`                                                                      | `{ from, to, reason, … }`                              | adaptive-quality tier change                       |
| `presence`                                                                             | `ParticipantInfo & { state }`                          | backend presence updates                           |
| `recording:started` / `recording:stopped` / `recording:error` / `recording:blob-chunk` | —                                                      | recording facade events (re-emitted on the room)   |
| `devices:changed`                                                                      | —                                                      | platform media-device change                       |
| `error` / `closed`                                                                     | —                                                      | fatal errors; once after `leave()` completes       |

### Methods & facades

- `join()` / `leave()` — room lifecycle; `leave()` stops any in-progress recording.
- `publish(track)` / `unpublish(track)` — local media in/out.
- `getParticipants()` / `getParticipant(id)` — roster.
- `room.controls` — mute/camera/screen-share/raise-hand + device selection.
- `room.devices` — `listDevices()`, `switchCamera()`, `restartTrack()`.
- `room.recording` — composite MediaRecorder of local + remote streams, chunked
  upload when `recordingEndpoint` is set:
  ```ts
  await room.recording.startRecording({
    localStream, // composed camera+mic stream
    remoteStreams: [{ participantId: 'alice', stream: aliceStream }],
    createObjectUrl, // recording-store factory
  });
  ```
- `room.getStats()` — per-peer `RTCStatsSnapshot`s for `@mbsks/openrtc-quality` or
  your own monitors.
- `room.quality` — local adaptive-quality controller (docs/architecture.md D5):
  samples `getStats()` every `intervalMs` (default 2s) while video is
  published, feeds the `@mbsks/openrtc-quality` policy ladder, and applies tier
  changes via `setParameters` (simulcast) or `track.applyConstraints`
  (single-encoding). Emits `quality:changed` and `quality:warning` on the
  room: payloads carry `{ from, to, reason, tier, stats }` and
  `{ code, message, level }` — codes `cpu-high`, `network-degraded`,
  `uplink-starved`, `device-capped`, `recovered`, `manual`, `monitor-error`.
  Inert in non-browser environments unless `quality: { enabled: true }` is set.

## Design

- **Perfect negotiation** — one polite / one impolite peer per pair; glare is
  resolved by the protocol rules, so signaling is _dumb_: the engine keeps the
  WebRTC state machine, backends only move envelopes.
- **Dumb transports** — backends carry JSON envelopes and expose backend-native
  presence; ordering/idempotency/reordering/glare all live here (see
  `ordering.ts`, `sdp.ts`).
- **Tracks, not streams** — mesh auto-subscribes remote tracks; publication
  state is tracked per peer (`participants.ts`).

See [`docs/architecture.md`](../../docs/architecture.md) for the full
blueprint, and `packages/core/test/` for the engine test suite (fake RTC from
`@mbsks/openrtc-test-utils`).
