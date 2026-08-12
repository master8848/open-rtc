# @vidcall/transport

Signaling transport contract + helpers for the vidcall video-calling library.

Every backend adapter (Supabase, Convex, Postgres, SQLite/libSQL, Appwrite,
Firebase) implements the same `SignalingTransport` interface, so the engine
and apps are backend-agnostic. This package also ships the shared adapter
test suite that every adapter must pass.

## Interface

```ts
interface SignalingTransport {
  readonly name: string; // 'supabase' | 'convex' | ...
  readonly ordering: 'guaranteed' | 'seq-required';
  readonly maxPayloadBytes: number; // adapters chunk above this

  join(room: string, opts?: { self?: PresenceUser }): Promise<JoinedRoom>;
  leave(room: string): Promise<void>;
  emit(room: string, msg: SignalingMessage): Promise<void>;
  onMessage(room: string, cb: (msg: SignalingMessage) => void): Unsubscribe;
  onPresence(room: string, cb: (users: PresenceUser[]) => void): Unsubscribe;
  setPresence(room: string, data: Record<string, unknown>): Promise<void>;
  dispose(): Promise<void>;
}
```

- `SignalingMessage = { kind, payload, from, seq?, ts }` — `kind` is
  app-defined (`'offer' | 'answer' | 'ice' | 'reaction' | 'chat' | ...`).
- The wire envelope follows `protocol/schema.json` (`v/type/roomId/senderId/
sessionId/ts/seq`) — see `toWire`/`fromWire`.
- `ordering: 'seq-required'` backends stamp a per-sender `seq` and the
  receiving side reassembles SDP-bearing kinds with `ReorderBuffer`.
- Adapters chunk any payload above `maxPayloadBytes` transparently
  (`ChunkAssembler` reassembles on the far side).

> Reconciliation note: `packages/core` may later define its own
> `SignalingTransport` with the same shape. If `packages/core/src/transport.ts`
> exists, re-export from there; the shape is intentionally identical.

## Helpers (`@vidcall/transport/internal`)

| Helper                                     | Purpose                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `Chunker` / `ChunkAssembler` / `splitUtf8` | split payloads > backend frame cap into byte-aligned chunks; reassemble out-of-order on the far side (Postgres 7 KB NOTIFY cap)   |
| `ReorderBuffer`                            | per-sender `seq` buffer; releases `offer`/`answer`/`sfu` only in order, passes `ice` straight through                             |
| `Heartbeat` / `PresenceSweeper`            | periodic presence refresh + stale-peer sweep for backends with no native disconnect (Postgres, Appwrite)                          |
| `IceCoalescer`                             | batch trickle-ICE candidates into a short window (default 100 ms) before sending — respects rate limits (Supabase Free 100 msg/s) |
| `Sequencer`                                | per-sender monotonic seq stamping                                                                                                 |
| `InMemoryBackend`                          | in-process test double / dev default (used by the shared suite)                                                                   |

## Shared adapter test suite

```ts
import { runAdapterTestSuite } from '@vidcall/transport/shared-tests';

runAdapterTestSuite({
  name: 'supabase',
  createPeer: async (peerId) => new SupabaseBackend({ ... }),
  destroyPeer: async (peer) => peer.dispose(),
  supportsLargePayload: true,   // postgres chunker round-trip
});
```

Covers: join/leave · SDP offer/answer round-trip ordering · ICE trickle burst
(30 candidates) · presence join/leave/update · reaction fan-out (3 peers) ·
payload-over-limit chunking round-trip · 2 concurrent rooms · leave/re-join.

## InMemoryBackend

```ts
import { InMemoryBackend } from '@vidcall/transport';

const backend = new InMemoryBackend();
await backend.join('room-1', { self: { id: 'me', data: {}, lastSeen: Date.now() } });
const unsub = backend.onMessage('room-1', (msg) => console.log(msg));
await backend.emit('room-1', { kind: 'chat', payload: { text: 'hi' }, from: 'me', ts: Date.now() });
```

Same-process fan-out; presence with an optional stale sweeper
(`presenceTimeoutMs`, default 30 s). Use it for unit tests, examples, and as
the engine's no-backend fallback.
