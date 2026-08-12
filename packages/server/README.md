# @vidcall/server

The **backend component** for [vidcall](https://github.com/vidcall): ROOM/SESSION
state, a signaling relay, and recording storage that _any_ app backend can host.
It attaches to other backends — **Express / Fastify natively**, **Django /
Laravel / Rails** via a language-agnostic REST + WebSocket contract — and works
with **any database** through a function-based `Store` interface.

The client side (`@vidcall/core` + pluggable signaling adapters) is the media
plane; this package is its signaling/state plane: rooms, participant rosters,
the per-room signal log, envelope relay, and recording session storage.

```
App (vibe coder)
   │  @vidcall/core (client engine: RTCPeerConnection mesh, adapters)
   ▼
@vidcall/server  ── rooms · roster · signal log · relay · recordings
   │  Store (function-based, ~10 methods)          RecordingStorage (bytes)
   ├── InMemoryStore (dev/tests)                   ├── DiskRecordingStorage
   ├── SqliteStore   (better-sqlite3)              └── S3RecordingStorage
   ├── PostgresStore (pg)                            (fetch + SigV4, no AWS SDK)
   └── MysqlStore    (mysql2)
   │  Hosting
   ├── node:http standalone  (createNodeServer)
   ├── Express router        (createExpressRouter)
   ├── Fastify plugin        (createFastifyPlugin)
   └── sidecar proxy         (Django / Laravel / Rails — see integrations/)
```

## Quick start (Express)

```ts
import express from 'express';
import {
  createExpressRouter,
  createServices,
  InMemoryStore,
  attachWebSocketRelay,
} from '@vidcall/server';

const store = new InMemoryStore(); // or SqliteStore / PostgresStore / MysqlStore
const services = createServices({ store }); // add recordingStorage for recordings

const app = express();
app.use('/vidcall', createExpressRouter(services));

const server = app.listen(3000, () => console.log('vidcall server on :3000'));
attachWebSocketRelay(server, services); // /ws?roomId=... relay
```

See `integrations/` for Express, Fastify, Django, Laravel, Rails, and the
`Store` contract (`DATABASES.md`).

## REST API

| Method | Path                              | Body                                                                                  | Returns                                   |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------- |
| POST   | `/rooms`                          | `{ roomId?, maxParticipants?, metadata? }`                                            | `201 { room }`                            |
| POST   | `/rooms/:id/join`                 | `{ participantId, sessionId, displayName?, metadata? }` (or `{ participant: {...} }`) | `200 { room, participant, participants }` |
| POST   | `/rooms/:id/leave`                | `{ participantId, reason? }`                                                          | `200 { room, participants }`              |
| POST   | `/rooms/:id/signal`               | one protocol envelope (`protocol/schema.json`)                                        | `200 { seq, relayedTo }`                  |
| GET    | `/rooms/:id/state`                | —                                                                                     | `200 { room, participants, signalCount }` |
| GET    | `/rooms/:id/recordings`           | —                                                                                     | `200 { recordings }`                      |
| POST   | `/recordings/:sessionId/chunks`   | raw bytes (`application/octet-stream`), `?index=n`                                    | `201 { sessionId, index, bytes }`         |
| POST   | `/recordings/:sessionId/finalize` | `{}`                                                                                  | `200 { recording, storage }`              |

Errors are always `{ "error": { "code", "message", "details? } }` with a stable
machine-readable `code`: `room_not_found` (404), `room_already_exists` (409),
`room_closed` (409), `room_full` (409), `participant_not_found` (404),
`participant_already_joined` (409), `recording_not_found` (404),
`invalid_envelope` / `invalid_request` (400), `recording_storage_error` (500),
`internal_error` (500).

## WebSocket relay

`attachWebSocketRelay(server, services)` upgrades `GET /ws?roomId=<id>`:

1. Client connects and sends a `join` envelope.
2. Relay registers the participant (`joinRoom`), replies with a server-only
   `{ "type": "joined", "room", "participants" }` message (unknown envelope
   types are ignored by clients, per the wire protocol rule), and broadcasts
   the join to the other members.
3. Every later envelope (`offer` / `answer` / `ice` / `presence` / `reaction` /
   `chat` / ...) is persisted to the room's signal log and relayed to the other
   members — **the sender never receives its own signal back**, matching the
   client engine's expectations.
4. A `leave` envelope — or a dropped connection (auto-leave with
   `reason: "disconnect"`) — removes the participant and broadcasts the leave.

The hub is also wired as `Services.relay`, so REST mutations (HTTP join/leave/
signal) fan out to the same connected sockets.

## Store contract

Every core function takes a `Store` as its first argument — pure functions, no
framework or database imports. A `Store` is ~10 async methods:

```ts
interface Store {
  getRoom(roomId): Promise<Room | null>;
  putRoom(room): Promise<void>;
  deleteRoom?(roomId): Promise<void>; // optional
  getParticipant(roomId, participantId): Promise<Participant | null>;
  putParticipant(participant): Promise<void>;
  deleteParticipant(roomId, participantId): Promise<void>;
  listParticipants(roomId): Promise<Participant[]>;
  putSignal({ roomId, envelope, receivedAt }): Promise<StoredSignal>; // assigns seq
  listSignals(roomId, sinceSeq): Promise<StoredSignal[]>;
  putRecording(recording): Promise<void>;
  listRecordings(roomId): Promise<RecordingSession[]>;
  getRecording(sessionId): Promise<RecordingSession | null>;
}
```

JSON documents round-trip verbatim; the Store assigns the per-room monotonic
`seq` atomically. Implementations: `InMemoryStore`, `SqliteStore`,
`PostgresStore`, `MysqlStore` — all pass the **shared store test suite**
(`@vidcall/server/shared-tests`, run per store in `test/*Store.test.ts`).
Implement one for any other database in ~100 lines — see
`integrations/DATABASES.md`.

## Recording storage

- `RecordingStorage`: `saveChunk(sessionId, chunk, index)` ·
  `finalize(sessionId)` · `getStream(sessionId)` · `delete?(sessionId)`.
- `DiskRecordingStorage` — local directory, zero deps.
- `S3RecordingStorage` — any S3-compatible object store (AWS S3, MinIO, R2,
  GCS XML API) via a minimal **SigV4 `fetch` client** (`src/aws-sigv4.ts`) —
  deliberately **no AWS SDK dependency**.

Chunks are indexed (`chunk-000000`, ...) so out-of-order uploads reassemble
correctly; `finalize` writes a `manifest.json` (chunks/bytes) and seals the
recording session in the Store.

## Supply-chain (policy: ≥14-day-old pins, exact versions, lockfile committed)

Verified 2026-08-12 via `npm view <pkg> time --json`; package-lock.json is
committed at the repo root.

| Package                       | Pin      | Published    | Age    | Why                                          |
| ----------------------------- | -------- | ------------ | ------ | -------------------------------------------- |
| `@vidcall/protocol`           | `0.1.0`  | in-workspace | —      | wire envelope types (single source of truth) |
| `better-sqlite3`              | `13.0.1` | 2026-07-21   | 21 d   | SQLite store driver (synchronous, prebuilt)  |
| `pg`                          | `8.22.0` | 2026-06-19   | 54 d   | PostgreSQL store driver                      |
| `mysql2`                      | `3.23.2` | 2026-07-27   | 15 d   | MySQL store driver                           |
| `ws`                          | `8.9.0`  | 2022-09-22   | 1419 d | WebSocket relay (`/ws?roomId=`)              |
| `express` (dev/peer)          | `5.2.1`  | 2025-12-01   | 253 d  | Express router adapter + mount smoke tests   |
| `fastify` (dev/peer)          | `5.10.0` | 2026-07-05   | 37 d   | Fastify plugin adapter + mount smoke tests   |
| `@types/better-sqlite3` (dev) | `7.6.13` | 2025-04-04   | 494 d  | typings                                      |
| `@types/express` (dev)        | `5.0.6`  | 2025-12-01   | 253 d  | typings                                      |

> Rejected as too new on 2026-08-12: `better-sqlite3@13.0.3` (6 d),
> `pg@8.23.0` (3 d), `mysql2@3.23.3` (1 d), `ws@8.21.3` (4 d),
> `fastify@5.11.3` (3 d). Re-run the age check before bumping anything.

## Tests

```sh
npm run build
npm run test:server                     # core + 4-store shared suite + REST/WS/Express/Fastify/recording
# real Postgres + MySQL integration (docker):
npm run test:server:pg
npm run test:server:mysql
```

The Postgres/MySQL suites run the same shared suite against live servers when
`VIDCALL_TEST_POSTGRES_URL` / `VIDCALL_TEST_MYSQL_URL` are set and skip
gracefully otherwise.

## License

MIT
