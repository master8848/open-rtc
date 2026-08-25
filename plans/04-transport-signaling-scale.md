# 04 — Transport, Signaling & Horizontal Scale

> Depends on `03-media-topology.md` (SFU needs signaling that survives N instances). Auth/rate-limit context from `01-security.md`. Server code: `packages/server/src/ws.ts:58`, `stores/InMemoryStore.ts:14`, `packages/transport/src/internal/chunker.ts:53`, `packages/server/src/ws.ts:119`.

## Problem

- **Single instance illusion:** `RoomHub Map<room,Set<Socket>>` (`ws.ts:58-98`) + `InMemoryStore` (`stores/InMemoryStore.ts:14`) are in-process. 2 instances behind a load balancer don't share signals/presence — `broadcast:84` only fans out to local sockets. `services.relay = hub` (`ws.ts:133`) is not pluggable beyond local.
- **Backend limits kill bursts:** Postgres `NOTIFY` payload is 7 KB (`chunker.ts:53`, `docs/architecture.md D4`) — SDP/ICE must be chunked. Supabase/Firebase/Convex each have per-channel/emit rate limits; high-freq ICE bursts (10–30 candidates in 500 ms) trip them without `IceCoalescer` + dedicated server WS relay (`ws.ts:119` coalescing idea). No relay = clients hammer the DB.
- **Single-path transport:** `RoomConfig.transport: SignalingTransport` (`packages/core/src/room.ts:200` + `packages/transport/src/types.ts:44`, `base.ts:56`) is one backend. No fallback (Supabase down → call dies), no reconnect (WS drop → stale), no `WebTransport` datagram path.
- **Presence is local:** `BaseSignalingTransport` heartbeat `5000ms` + `PresenceSweeper 30000ms` (`transport/src/internal/heartbeat.ts` via `base.ts:88`) and `server` presence are in-memory; at scale `presence:offline` must be Redis expiring set, not timer.

## Target architecture

```
App Room
  └─ ResilientTransport (wrapper) ── SignalingTransport (contract)
       ├─ CompositeTransport(primary, fallback, switchMs)   // dual-path
       ├─ ReconnectingTransport(inner, backoff, replay)     // WS drop → re-join + seq replay
       ├─ RateLimitedTransport(inner, IceCoalescer)         // ICE burst → coalesce + chunker
       └─ WebTransportTransport (optional, unordered datagrams)

Server
  └─ Relay (pluggable, ws.ts RoomHub is one impl)
       ├─ RoomHub (local, dev)
       ├─ RedisRoomHub (ioredis pub/sub, prod)
       └─ PostgresNotifyRelay (LISTEN/NOTIFY fan-out, alternative to Redis)

Store stays ~10-method Store contract (packages/server/src/store.ts:22) — no API change.
```

## 1. Relay: pluggable fan-out (P0)

Extract `Relay` already implied by `services.relay` (`ws.ts:33,133`):

```ts
// packages/server/src/relay.ts (new)
interface Relay {
  attach(roomId: string, socket: WebSocket, senderId: string, sessionId: string): void;
  detach(roomId: string, socket: WebSocket): void;
  broadcast(roomId: string, envelope: Envelope, opts?: { exceptSenderId?: string }): void;
  clientCount(roomId: string): number;
}
```

Keep `RoomHub implements Relay` (`ws.ts:58`) as `LocalRelay`. Add:

```ts
// packages/server/src/relays/redis-relay.ts
class RedisRelay implements Relay {
  constructor(private pub: Redis, private sub: Redis) {}
  // publish JSON envelope to channel `vidcall:room:{roomId}`
  // sub subscribes wildcard; on message, fan out to local RoomHub sockets
  // detach unsubscribes when last local socket leaves room
}
```

- Server wiring: `attachWebSocketRelay(server, services, { relay })` or `services.relay = new RedisRelay(pub, sub)` — one-line swap, HTTP `handleSignal` (`core.ts:269`) already computes `recipients`, just calls `relay.broadcast`.
- Sticky sessions are not required: signaling pin is independent of SFU media pin (SFU may still be sticky via `SfuGateway.routerFor(roomId)` consistent hash — see `03` cascading). Redis pub/sub is room-sharded; no global broadcast.
- Alternative without Redis: `PostgresNotifyRelay` — one dedicated `pg` client `LISTEN vidcall_room_{hash}` (`docs/architecture.md:132`), `NOTIFY` with 7 KB chunker (`chunker.ts:53`) already handles chunk reassembly via `BaseSignalingTransport`. Keep for Postgres-only deploys.

Accept: two `node` processes behind round-robin LB share a room; `k6`/`oha` fan-out test at 5k concurrent sockets passes.

## 2. Store horizontal (P0)

`Store` contract (`store.ts:22 getRoom/putRoom/deleteRoom, getParticipant/.../listParticipants, putSignal/listSignals, putRecording/...`) stays.

- `InMemoryStore` stays dev/test.
- `PostgresStore`/`MySQLStore`/`SqliteStore` already exist (`stores/*.ts`) but `LISTEN` must be on a dedicated `pg` client, not the pool (documented risk `docs/architecture.md:132`). Fix: `PostgresStore` holds `pool` + `listenerClient`; `onMessage` uses `LISTEN`, `emit` uses `NOTIFY` (chunked).
- For scale, add `RedisStore` (optional) — `listSignals(roomId, sinceSeq)` becomes `XRANGE room:signals:{roomId}` or `ZSET` scan; TTL on signals so DB doesn't grow. Existing stores keep working; large deploys pick Redis.

## 3. Client transport resilience (P0)

### Composite (dual-path)

```ts
// packages/transport/src/composite.ts
class CompositeTransport implements SignalingTransport {
  constructor(private primary: SignalingTransport, private fallback: SignalingTransport, private opts: { switchMs: number }) {}
  // emit → primary, on error → fallback emit + emit 'transport:fallback'
  // onMessage merges both; OrderedMessageBuffer (ordering.ts:30) dedupes by sessionId+seq
}
```

Usage: `new Room({ transport: new CompositeTransport(new ServerWsTransport(url), new SupabaseBackend(client)) })` or `transport: [primary, fallback]` sugar in `RoomConfig`.

### Reconnecting wrapper

```ts
class ReconnectingTransport implements SignalingTransport {
  constructor(private inner: SignalingTransport, private opts: { backoff: Exponential, maxAttempts: number }) {}
  // on disconnect/error → exponential backoff → re-join(roomId,self) → replay via inner.listSignalsSince(lastSeq) (server Store.listSignals)
  // emits 'connection-state: reconnecting|reconnected|failed' for UI
}
```

Already partially in `Room.join({signal})` abort/StrictMode handling (`room.ts:419-486` `JoinOptions.signal`, `joinChain:317`). Wrapper adds the reconnect loop without Room changes. `RoomConfig.reconnect?: { maxAttempts, backoffMs }` delegates to wrapper.

### Rate limiting / ICE coalescing

- `IceCoalescer` (`transport/src/internal/iceCoalescer.ts`) already exists — wire `BaseSignalingTransport` `coalesceIceMs: number` (`base.ts`) to batch trickle ICE candidates (~50 ms window) before `emit`.
- `chunker.ts:53` (7 KB) stays Postgres-specific; Supabase/Firebase have higher `maxPayloadBytes` (`TransportMetadata: types.ts:44`) so they skip chunking.
- Server WS path `ws.ts:119` dedicated relay avoids per-candidate DB writes — candidate bursts hit WS relay, not `NOTIFY`/`broadcast`. Document: use `packages/server` WS relay in prod when room >20 or burst expected.

## 4. WebTransport (P1, optional)

```ts
class WebTransportSignalingTransport implements SignalingTransport {
  // same Envelope contract over WebTransport datagrams/streams (lower latency than WS)
  // fallback to WS when not available (feature-detect)
}
```

Same `SignalingTransport` — no protocol change. Useful for data-channel-like unreliable signaling and future `WhepMediaTransport` (`06`).

## 5. Backend adapter limits — documented matrix

Ship `docs/limits.md` (new) with per-backend ceiling:

| Backend | Ordering | Max payload | Rate note | Use WS relay? |
|---------|----------|-------------|-----------|---------------|
| `@mbsks/server` WS (`ws.ts`) | `seq-required` | 8 MB (`maxPayloadBytes:104`) | coalesce ICE | required for bursts |
| Supabase broadcast | `guaranteed` | ~256 KB | channel/emit throttle | optional |
| Firebase RTDB | `guaranteed` | ~256 KB | `onDisconnect` best | optional |
| Convex | `seq-required` | ~1 MB | mutation rate | optional |
| Postgres `NOTIFY` | `seq-required` | 7 KB (chunker) | `LISTEN` single client | yes (bridge) |
| SQLite/BroadcastChannel | local | N/A | same-device only | no (dev) |

Each adapter exposes `TransportMetadata` (`types.ts:44 name, ordering, maxPayloadBytes`) — Room/Composite can pick fallback by ceiling.

## API changes (minimal, additive)

```ts
// packages/core/src/room.ts
interface RoomConfig {
  transport: SignalingTransport | SignalingTransport[]; // array → Composite
  reconnect?: { maxAttempts?: number; backoffMs?: number; coalesceIceMs?: number };
  relay?: Relay; // server side
}

// packages/server/src/services.ts
interface Services { store, relay?: Relay, auth?, turn?, recordingStorage? }

// New packages
@mbsks/transport/composite, @mbsks/transport/reconnecting
@mbsks/server/relays/redis, @mbsks/server/relays/postgres-notify
```

## Efficiency notes

- Signaling envelopes are 200 B–10 KB; bottleneck is WS connections + store, not language — JS/Bun relay handles 10k msg/s/core (see `plans/00-overview.md` Rust note: defer Rust relay sidecar until benchmark proves need at >50k concurrent).
- Bun's `ws` (uWebSockets) + `ioredis` pipeline is the cheap win before Rust.

## Acceptance

- [ ] `Relay` interface + `RoomHub` + `RedisRelay` + `PostgresNotifyRelay`; `attachWebSocketRelay` takes `relay` option.
- [ ] `LISTEN` on dedicated `pg` client; chunker reassembly tested via `shared-tests.ts`.
- [ ] `CompositeTransport` + `ReconnectingTransport` (sequence replay) covered by `transport` vitest + `server` 2-instance integration.
- [ ] `IceCoalescer` wired end-to-end; `docs/limits.md` published.
- [ ] No `Room` breaking change; `transport: []` sugar works.

## Out of scope

Full SFU cascading across hosts (belongs to `03-media-topology.md` `router.pipeToRouter`); Rust signaling relay (defer, see `00-overview.md`).
