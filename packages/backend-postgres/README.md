# @vidcall/backend-postgres

PostgreSQL LISTEN/NOTIFY signaling adapter — zero extra services if your app
already runs Postgres. ~ms latency, transactional `NOTIFY`, and the smallest
footprint of the managed backends.

## Usage

```ts
import pg from 'pg';
import { PostgresBackend } from '@vidcall/backend-postgres';

// DEDICATED client — never a pool. Notifications are only delivered on the
// connection that ran LISTEN, and pooled connections get multiplexed away.
const client = new pg.Client({ connectionString: 'postgres://...' });
await client.connect();

const backend = new PostgresBackend({ client });
await backend.join('room-42', { id: 'me', displayName: 'Alice' });
backend.onMessage((envelope) => { /* engine handles SDP/ICE */ });
await backend.emit({ v: 1, type: 'chat', roomId: 'room-42', senderId: 'me', sessionId: 's', ts: Date.now(), seq: 0, payload: { text: 'hi' } });
await backend.setPresence('online', { camOn: true });
await backend.leave();
await backend.dispose();
```

Alternatively let the adapter own its client: `new PostgresBackend({ connectionString })`
(dispose() then ends the client).

## Presence table (required for presence)

`setPresence` UPSERTs a heartbeat row; a sweeper reports stale peers offline.
Create the table once:

```sql
CREATE TABLE IF NOT EXISTS vidcall_presence (
  room TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'online',
  metadata JSONB,
  last_seen BIGINT NOT NULL,
  PRIMARY KEY (room, user_id)
);
```

Set `presenceTable: ''` to disable table presence (NOTIFY-only; late joiners
won't see existing peers).

## How it maps

| vidcall concept | PostgreSQL |
|---|---|
| room channel | `LISTEN/NOTIFY vidcall_msg_<room>` (sanitized, <= 63 bytes, hashed when long) |
| `emit(envelope)` | `NOTIFY <channel>, json` — chunked into <= 7000-byte `ChunkFrame` parts when over the cap |
| `onMessage` | `client.on('notification')` -> chunk reassembly -> reorder |
| presence | heartbeat UPSERT + `NOTIFY vidcall_presence_<room>` + stale sweep |
| leave | `UNLISTEN` + delete presence row + offline NOTIFY |

## Limits & caveats

- **8 KB NOTIFY payload cap** (default config) — the binding constraint. The
  adapter chunks anything above **7000 bytes** into parts (`{k:'chunk', id, i,
  n, d}`) and reassembles on the far side; SDP offer/answer round-trips work
  even for complex multi-codec offers (which can exceed 8 KB).
- **No replay**: NOTIFY delivers only to sessions currently LISTENing. Fine
  for live signaling; peers that join later miss earlier frames (the engine's
  negotiation retry/glare logic handles this).
- **Browser clients need a ws-bridge**: `pg` is Node-only. Run a Node relay
  that owns the LISTEN clients and forwards frames to browsers over `ws`
  (map rooms -> channels). This is the same architecture Supabase Realtime
  provides as a managed service.
- **Dedicated client, not a pool** — see the comment above; this is the #1
  LISTEN/NOTIFY footgun.
- Ordering: FIFO per (session, channel); cross-writer ordering needs the
  per-sender `seq` reorder buffer (on by default).

## Package

- Pin: `pg@8.22.0` (published 2026-06-19 — 53 d old at implementation time;
  `pg@8.23.0` is only 3 d old, skipped per the 14-day policy).
- Dev pins: `@types/pg@8.20.0`.
