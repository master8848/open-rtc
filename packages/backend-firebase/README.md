# @vidcall/backend-firebase

Firebase **Realtime Database** signaling adapter — the highest-connection
backend in the lineup (200k concurrent), offline-first, with **native
presence** via `onDisconnect()` (clean close *or* crash is reflected
server-side, no heartbeats required).

## Usage

```ts
import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import { FirebaseBackend } from '@vidcall/backend-firebase';

const app = initializeApp({
  apiKey: '...',
  projectId: '...',
  databaseURL: 'https://<project>-default-rtdb.firebaseio.com',
});
const backend = new FirebaseBackend({ app }); // or pass a `database` directly

await backend.join('room-42', { id: 'me', displayName: 'Alice' });
backend.onMessage((envelope) => { /* engine handles SDP/ICE */ });
backend.onPresence((p) => console.log(p.participantId, p.state, p.metadata));
await backend.emit({
  v: 1, type: 'chat', roomId: 'room-42', senderId: 'me',
  sessionId: 'my-session', ts: Date.now(), seq: 0,
  payload: { text: 'hi' },
});
await backend.setPresence('online', { camOn: true, muted: false });
// ... later
await backend.leave();
await backend.dispose();
```

## How it maps

| vidcall concept | Firebase Realtime Database |
|---|---|
| room channel | `rooms/{room}/signals` — a push-key signal log |
| `emit(envelope)` | `push(rooms/{room}/signals, { senderId, frame })` |
| `onMessage` | `onChildAdded(rooms/{room}/signals)` — RTDB pushes only NEW children (natural diffing) |
| presence | `presence/{room}/{userId}` heartbeat row + **native `onDisconnect`** (server flips `state:'offline'` on any disconnect) |
| leave | cancel hook + `remove(presence/{room}/{userId})` (peers see offline immediately) |

Ordering is `guaranteed`: push keys are chronological, so SDP offer/answer
arrive in order.

## Limits & caveats

- **Payloads**: RTDB single-write cap is 16 MB (SDK) — SDP/ICE fit with
  enormous headroom; no chunking is ever triggered for signaling.
- **Native presence**: `onDisconnect` runs server-side on any disconnect —
  no heartbeat needed for correctness. The adapter still refreshes
  `lastSeen` on a 10 s heartbeat and re-arms the hook (the server executes
  it at most once), so `setPresence` updates keep the row fresh.
- **Own echoes**: the writer's own pushes come back through the same path;
  the adapter filters them by `senderId`.
- **Late joiners** see the whole signal log (RTDB replay on subscribe) and
  current presence rows — fine for live signaling; the engine's glare/retry
  logic handles duplicates.
- **Auth**: secure the paths with RTDB rules (room membership + per-user
  presence writes). The adapter passes the Firebase app through untouched.
- **Regional**: RTDB is regional (choose a region near your users; the
  global Firestore backend is an alternative but has no native presence).

## Package

- Pin: `firebase@12.16.0` (published 2026-07-09 — 33 d old at implementation
  time; `firebase@12.17.1` is only 7 d old, rejected per the 14-day policy —
  re-verified `npm view firebase time`).
- Runtime deps: `firebase` (modular: `firebase/app` + `firebase/database`
  only), `@vidcall/transport`.
