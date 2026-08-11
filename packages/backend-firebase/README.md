# @vidcall/backend-firebase

Firebase Realtime Database signaling adapter — RTDB is a superb signaling
plane: per-path sequential-write ordering, ms-class latency, native
`onDisconnect` presence, and a 200 k concurrent-connection ceiling (the
highest of any backend here).

## Usage

```ts
import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import { FirebaseBackend } from '@vidcall/backend-firebase';

const app = initializeApp({ databaseURL: 'https://<project>-default-rtdb.firebaseio.com' });
const backend = new FirebaseBackend({ database: getDatabase(app) }); // or { app }
await backend.join('room-42', { id: 'me' });
backend.onMessage((envelope) => { /* engine */ });
await backend.emit({ v: 1, type: 'chat', roomId: 'room-42', senderId: 'me', sessionId: 's', ts: Date.now(), seq: 0, payload: { text: 'hi' } });
await backend.setPresence('online', { camOn: true });
await backend.leave();
await backend.dispose();
```

## How it maps

| vidcall concept | RTDB |
|---|---|
| room signal log | `rooms/{room}/signals/{pushId}` = `{ senderId, frame }` |
| `emit(envelope)` | `push()` onto the log; far peers get it via `onChildAdded` (fires **only for new children** — no diffing needed) |
| `onMessage` | `onChildAdded` -> JSON.parse -> chunk reassembly -> reorder |
| presence | `presence/{room}/{userId}` row + **native `onDisconnect()`** hook (server flips the row to `offline` on any disconnect — clean close or crash) + heartbeat refresh of `lastSeen` |
| leave | cancel hook, remove own row, detach listeners |
| ordering | `guaranteed` for sequential writes to a path; push keys sort chronologically |

## Presence: native, crash-safe

RTDB's `onDisconnect` runs **server-side** when a client's connection drops —
no heartbeat timeout lag, works through crashes and network loss. The adapter
re-arms the hook on every heartbeat write (the server executes it at most
once). A stale sweeper remains as a second safety net
(`presenceTimeoutMs`, default 30 s).

## Limits & caveats

- **16 MB SDK single-write cap** — `maxPayloadBytes = 16 MiB`; signaling
  frames never come close, chunking is effectively never used.
- **Own echoes**: RTDB pushes your own writes back through the listener; the
  adapter filters by `senderId` (base also drops self-envelopes).
- **Security rules**: enable private-room authz with RTDB rules
  (`.read`/`.write` on `rooms/{room}` + `presence/{room}`).
- **Write rate**: ~1,000 writes/s soft cap per database — far above
  signaling needs (a room's trickle burst of 30 ICE candidates is nothing).
- Browser + Node both work out of the box (WebSocket-based).

## Package

- Pin: `firebase@12.16.0` (published 2026-06-17 — 55 d old at implementation
  time). Uses the modular `firebase/app` + `firebase/database` entrypoints.
- Dev pins: `@types/node@22.19.1`, `typescript@5.9.3`, `vitest@4.1.10`.
