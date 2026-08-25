# @mbsks/openrtc-backend-sqlite

Signaling adapter for **SQLite/libSQL** — one of the six interchangeable
backends for the vidcall engine. See
[`@mbsks/openrtc-transport`](../transport/README.md) for the contract every adapter
implements and the shared test suite each one must pass.

## The short version

SQLite has **no server push**, so this adapter implements **same-device
mode**: a per-room `BroadcastChannel` (Web platform API; a global in Node ≥ 18) carries envelopes between tabs of the same browser — two tabs, zero
infra, real mesh calls. The [vanilla example](../../examples/vanilla) is
exactly that: no server, no accounts, just `Room` + `SqliteBackend`.

Multi-device calls would need Turso sync, which is eventually consistent
(seconds-level) — **not** suitable for an SDP offer/answer handshake. Use one
of the other five backends, or `@mbsks/openrtc-server`, when participants are on
different devices.

## How it works

- **Live channel** — a `BroadcastChannel` per room carries envelope frames
  with ~ms latency and FIFO per-channel ordering.
- **Durable log (best-effort)** — every frame is also appended to a local
  libSQL database (`vidcall_signals` log + `vidcall_presence` upserts): a
  queryable, offline-first record. Signaling **never depends on the log**, so
  a read-only or failed database cannot break a call.
- **Presence** — peers broadcast `presence` frames on the room channel, reply
  to `presence-sync` requests from late joiners, and the shared presence
  sweeper (heartbeat + stale timeout) drops peers whose tab died without a
  leave.

## Install

```sh
npm i @mbsks/openrtc-backend-sqlite           # once published
# today (workspace): npm i file:../vidcall/packages/backend-sqlite
```

## Usage

```ts
import { createClient } from '@libsql/client';
import { SqliteBackend } from '@mbsks/openrtc-backend-sqlite';
import { Room } from '@mbsks/openrtc-core';

const backend = new SqliteBackend({
  client: createClient({ url: 'file:local.db' }), // durable log
  // or just: new SqliteBackend() — in-memory db owned by the adapter
});

const room = new Room({
  roomId: 'demo',
  selfId: 'alice',
  transport: backend,
});
await room.join();
await room.publish(cameraTrack);
```

Open the same page in a second tab with `selfId: 'bob'` and the two rooms
peer up over the BroadcastChannel.

> Browser note: libSQL's `:memory:` client doesn't run in the browser, so in
> a browser page you can pass a localStorage-backed `Client` shim (signaling
> never touches the log) — see `examples/vanilla/main.ts`.

## Options (`SqliteBackendOptions`)

| Option              | Default     | What it does                                                                        |
| ------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `client`            | —           | libSQL client (`createClient({ url })`); default: in-memory db owned by the adapter |
| `url`               | —           | libSQL URL alternative to `client`: `':memory:'`, `'file:…'`, `'libsql://…'`        |
| `channelPrefix`     | `'vidcall'` | BroadcastChannel name prefix                                                        |
| `heartbeatMs`       | 5000        | presence heartbeat interval                                                         |
| `presenceTimeoutMs` | 15 000      | stale-peer sweep timeout                                                            |

## Caveats

- **Same-device only** — the BroadcastChannel never leaves the browser
  (Turso sync is eventually consistent and unsuitable for SDP handshakes).
- **Log is best-effort** — it records what happened; the call itself runs on
  the live channel.
- **Ordering** — FIFO per channel; SDP-bearing kinds go through the shared
  reorder buffer anyway.

## Tests

```sh
cd packages/backend-sqlite && npm run test   # adapter unit tests
```

The shared adapter suite (`@mbsks/openrtc-transport/shared-tests`) also runs in CI
for this backend.
