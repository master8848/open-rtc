# Agent Note: Transport, signaling, and horizontal scale

Status: implemented

Rationale: RoomHub Map and InMemoryStore in-process, NOTIFY 7KB limit, single transport path without fallback/reconnect, presence local-only, ICE bursts throttled on managed backends.

Files: `plans/04-transport-signaling-scale.md` → `docs/plans/archive/04-transport-signaling-scale.md`; behavior in `docs/transport.md` + `docs/limits.md` matrix + `packages/transport/src/composite.ts:25` CompositeTransport / `packages/transport/src/reconnecting.ts` ReconnectingTransport / `packages/transport/src/web-transport.ts` / `packages/transport/src/internal/chunker.ts:53` + `iceCoalescer.ts` + `reorder.ts:30` / `packages/server/src/ws.ts:59` RoomHub + `packages/server/src/ws.ts:122` attachWebSocketRelay / `packages/server/src/relays/redis-relay.ts:45` / `packages/server/src/relays/postgres-notify-relay.ts` / `packages/server/src/stores/RedisStore.ts` / `packages/server/src/store.ts:22` Store.

Decisions: Relay pluggable with RoomHub local and RedisRelay/PostgresNotifyRelay distributed via pub/sub channel vidcall:room:{roomId}; Store stays ~10 methods, LISTEN on dedicated pg.Client, Redis ZSET+TTL for signals; client Composite+Reconnecting+IceCoalescer+WebTransport behind array transport sugar; JS relay first, Rust sidecar deferred.
