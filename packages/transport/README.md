# @vidcall/transport

The **signaling transport contract** for vidcall — plus the shared plumbing
and the test suite every backend adapter must pass.

Every backend adapter (`@vidcall/backend-supabase`, `-convex`, `-firebase`,
`-appwrite`, `-postgres`, `-sqlite`) implements the same interface, so the
engine and your app are backend-agnostic: swap backends by swapping one
constructor argument.

```ts
interface SignalingTransport {
  join(roomId: string, self: ParticipantInfo): Promise<void>;
  leave(): Promise<void>;
  emit(envelope: Envelope): Promise<void>; // broadcast, or unicast when targetSenderId set
  onMessage(cb: (envelope: Envelope) => void): () => void;
  onPresence(cb: (presence: ParticipantPresence) => void): () => void;
  setPresence(state: PresenceState, metadata?): Promise<void>;
  dispose(): Promise<void>;
}
```

- **One room per instance** — `join`/`leave` bind the transport to a single
  room; create one transport per room.
- **Envelopes, not app messages** — payloads are `Envelope`s from
  `@vidcall/protocol` (`protocol/schema.json` mirror): `{ v, type, roomId,
senderId, sessionId, ts, seq, targetSenderId?, payload }`. The engine owns
  `seq` (monotonic per sender) and the ordering/glare state machine; backends
  stay dumb and just move JSON.
- **Backend-native presence** — `onPresence` delivers per-peer
  `ParticipantPresence { participantId, state, metadata }`; backends map this
  to their native presence (Supabase Realtime presence, Appwrite heartbeat
  docs, BroadcastChannel frames, …).

The same interface lives structurally in `@vidcall/core` (the engine's
`transport.ts`); this package declares an identical twin so adapters depend on
the light transport package instead of the engine. TypeScript structural
typing makes implementations interchangeable.

## What's in the package

| Export                                                           | What it is                                                                                                                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SignalingTransport` / `ParticipantInfo` / `ParticipantPresence` | the contract types (`types.ts`)                                                                                                                                       |
| `BaseSignalingTransport`                                         | shared adapter plumbing: envelope **chunking/assembly**, **seq reorder buffer** (SDP-bearing kinds), **heartbeat + presence sweeper**, **ICE coalescing** (`base.ts`) |
| `InMemoryBackend`                                                | in-process test double — one room per instance, microtask delivery, optional echo; the reference implementation for the shared suite and a "no backend" dev default   |
| `@vidcall/transport/internal`                                    | `Sequencer`, `randomSessionId`, chunker, reorder buffer, heartbeat, ICE coalescer (`internal/`)                                                                       |
| `@vidcall/transport/shared-tests`                                | `runAdapterTestSuite({ name, createPeer, destroyPeer, supportsLargePayload })` — the shared adapter test matrix                                                       |

## Writing an adapter

1. Extend `BaseSignalingTransport` and implement the backend hooks —
   `doJoin`, `doLeave`, `doSendFrame`, `doSetPresence`, `doDispose` — plus
   `name`, `ordering`, `maxPayloadBytes`.
2. Feed inbound backend events into `handleMessage` (the base re-assembles
   chunks, reorders, and fans out to `onMessage` listeners).
3. Export the metadata constants (`name`, `ordering`, `maxPayloadBytes`) as
   the reference implementation does.

The pattern is documented end-to-end in
[`docs/research/backend-adapters.md`](../../docs/research/backend-adapters.md)
(§10) and in each backend's source (`packages/backend-*/src/*.ts`).

## Shared adapter tests

Every backend must pass the shared matrix (join/leave · SDP offer/answer
round-trip ordering · ICE trickle burst · presence join/leave · reaction
fan-out · payload-over-limit chunking · two concurrent rooms):

```ts
import { runAdapterTestSuite } from '@vidcall/transport/shared-tests';

runAdapterTestSuite({
  name: 'mybackend',
  createPeer: async (peerId) => new MyBackend({/* ... */}),
  destroyPeer: async (peer) => peer.dispose(),
  supportsLargePayload: true,
});
```

Backends run the suite twice: against in-memory SDK mocks (unit, always in
CI) and against real infrastructure (env-var-gated integration tests).

## Install

```sh
npm i @vidcall/transport            # once published
# today (workspace): npm i file:../vidcall/packages/transport
```
