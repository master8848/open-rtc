# vidcall Skill

> vidcall — audio + video calling for any frontend. Vanilla functions; framework wrappers are thin adapters. WebRTC mesh with a small signaling relay.

Repo is the docs. All paths relative to repo root.

## What it does

- Mesh audio + video calls: signaling relay introduces peers, media flows peer-to-peer via WebRTC.
- Any frontend: core is vanilla functions/classes; React wrappers are optional.
- Handles glare, reordering, renegotiation, and reconnects.

## Client integration

### Vanilla JS

```js
import { Room } from '@mbsks/openrtc-core';
import { SupabaseBackend } from '@mbsks/openrtc-backend-supabase';

const room = new Room({ roomId: 'my-room', selfId: 'user-1', transport: new SupabaseBackend({ client }) });
await room.join();
room.on('track', ({ participant, track }) => { /* attach to <video> */ });
const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
await room.publish(stream.getVideoTracks()[0], { source: 'camera' });
```

- `new Room({ roomId, selfId, transport })` → `await room.join()` → `room.publish(track)` / `room.leave()`
- Events: `track`, `participant-joined`, `participant-left`, `error`

### React

```tsx
import { Room } from '@mbsks/openrtc-core';
import { useJoin, useParticipants, useRoomState } from '@mbsks/openrtc-react';

const room = new Room({ roomId: 'my-room', selfId, transport });
function Call({ room }: { room: Room }) {
  useJoin(room);
  const participants = useParticipants(room);
  return <ul>{participants.map(p => <li key={p.id}>{p.displayName ?? p.id}</li>)}</ul>;
}
```

- Create `Room` once per `(roomId, selfId)`; discard after `leave()` (single-use).
- Use `useJoin` instead of calling `room.join()` in an effect directly.

## Server integration

- **Node (Express/Fastify):** mount in-process — `createExpressRouter(services)` / Fastify plugin + `attachWebSocketRelay(server, services)`.
- **Other stacks (Python, PHP, Ruby, Go, Java, C#, Gleam, Elixir):** run `@mbsks/openrtc-server` as a sidecar; proxy `/vidcall/*` (REST) and `/ws?roomId=...` (WS) via nginx.

```ts
import { createServices, InMemoryStore } from '@mbsks/openrtc-server';
import { createExpressRouter } from '@mbsks/openrtc-server/express';
const services = createServices({ store: new InMemoryStore() });
app.use('/vidcall', createExpressRouter(services));
```

## Protocol

- Single JSON envelope for all signaling (join/offer/answer/ICE). Schema: `protocol/schema.json`; fixtures: `protocol/fixtures/`.
- Custom transports implement `SignalingTransport` from `@mbsks/openrtc-transport` and validate with `runAdapterTestSuite`.

## Where to read more

- Quick start: `docs/getting-started.md`
- Protocol: `protocol/schema.json`
- Server guides: `integrations/README.md`, `integrations/EXPRESS.md`, `integrations/FASTIFY.md`, `integrations/DJANGO.md`, `integrations/LARAVEL.md`, `integrations/RAILS.md`, `integrations/DATABASES.md`
- Packages: `packages/core/README.md`, `packages/react/README.md`, `packages/server/README.md`, `packages/transport/README.md`, `packages/quality/README.md`
