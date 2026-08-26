# vidcall — Backend Adapter Limits

> Per-backend ceiling for signaling. Mirrors `plans/04-transport-signaling-scale.md` §5 and `docs/architecture.md` D4.

| Backend | Ordering | Max payload | Rate note | Use WS relay? |
|---------|----------|-------------|-----------|---------------|
| `@mbsks/openrtc-server` WS (`packages/server/src/ws.ts`) | `seq-required` | 8 MB (`maxPayloadBytes: 8*1024*1024`) | coalesce ICE (`IceCoalescer`, `coalesceIceMs`) | **required for bursts** (candidates hit WS, not DB) |
| Supabase broadcast | `guaranteed` | ~256 KB | channel / emit throttle (per-project rate limit) | optional — use WS relay when room >20 or ICE burst expected |
| Firebase RTDB | `guaranteed` | ~256 KB | `onDisconnect` best; write-rate throttled | optional |
| Convex | `seq-required` | ~1 MB | mutation rate (`listSignals` polling) | optional |
| Postgres `NOTIFY` | `seq-required` | 7 KB (chunker) | `PostgresNotifyRelay` holds a **dedicated `pg.Client`** for `LISTEN` (`packages/server/src/relays/postgres-notify-relay.ts:98`), `pool` only for `NOTIFY` — never reuse a pool client for `LISTEN` | yes — use `PostgresNotifyRelay` or the WS bridge |
| SQLite / BroadcastChannel | local | N/A (same-process) | same-device only | no (dev) |
| Redis (pub/sub + `RedisStore`) | `seq-required` | ~512 MB (server limit) | handle `ioredis` backpressure; set `signalTtlMs` | optional — use `RedisRelay` for multi-instance fan-out |
| WebTransport datagrams | unordered | ~1 KB–64 KB (MTU) | unreliable; app must not assume delivery | fallback to WS via `WebTransportSignalingTransport(fallback)` |

## Chunker

Postgres `NOTIFY` caps payloads at ~8 KB (default `--max-payload`). The transport
`Chunker` (`packages/transport/src/internal/chunker.ts:53`) splits envelopes into
`ChunkFrame`s of ≤7 KB with reassembly via `ChunkAssembler` (mirrored in
`PostgresNotifyRelay`). `BaseSignalingTransport` chunks automatically when
`JSON.stringify(envelope).length > maxPayloadBytes - 1024`; set `maxPayloadBytes`
per adapter so Supabase/Firebase skip chunking.

## ICE coalescing

`IceCoalescer` (`packages/transport/src/internal/iceCoalescer.ts`) batches
trickle-ICE candidates within a ~50–100 ms window (`BaseOptions.coalesceIceMs`)
before `doSendFrame`. Server WS relay (`ws.ts:119` coalescing idea) avoids
per-candidate DB writes — candidate bursts should prefer the WS relay path in
prod when `room > 20` or burst expected.

## Horizontal scale

- **WS relay:** `Relay` (`packages/server/src/services.ts`) is pluggable. Default is `RoomHub` (local). For N instances behind a LB, inject `RedisRelay` (ioredis `pub/sub` channel `vidcall:room:{roomId}` per room, no payload cap) or `PostgresNotifyRelay` (dedicated `pg.Client` `LISTEN vidcall_room` + 7 KB chunker, single-channel bus). Tradeoff: Redis scales by room-sharding and avoids chunking; Postgres needs only Postgres but shared channel + chunk overhead. Wire via `attachWebSocketRelay(server, services, { relay })` — HTTP `handleSignal` already calls `relay.broadcast`.
- **Store:** `PostgresStore` uses the pool only; `PostgresNotifyRelay` holds the dedicated `listener` `pg.Client`. `RedisStore` (`packages/server/src/stores/RedisStore.ts`, optional, peer `ioredis`/`redis`) uses `ZSET` + TTL for `listSignals`. Existing stores keep working; large deploys pick Redis + RedisRelay.

## Transport resilience

- `CompositeTransport` (`@mbsks/openrtc-transport/composite`) — primary + fallback
  (emit → primary, on error → fallback + `onFallback`; dedupes by `sessionId:seq`).
  Array sugar supported: `new Room({ transport: [primary, fallback] })`.
- `ReconnectingTransport` (`@mbsks/openrtc-transport/reconnecting`) — exponential
  backoff + optional seq replay via `fetchSignals(roomId, sinceSeq)`.
- `WebTransportSignalingTransport` (`@mbsks/openrtc-transport/web-transport`) — optional,
  unordered datagrams with WS fallback.

Each adapter exposes `TransportMetadata` (`packages/transport/src/types.ts:62`
`name, ordering, maxPayloadBytes`) — `Room` / `CompositeTransport` can pick
fallback by ceiling.
