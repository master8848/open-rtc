# vidcall

Add video calling to any web app with a small, pluggable library. vidcall
connects your users' browsers directly (WebRTC mesh), adapts quality to their
network, and doesn't care which signaling backend you have.

## Why it exists

Video calls are genuinely hard: peer connections, ICE, negotiation races,
out-of-order messages, flaky networks. vidcall handles all of that inside the
engine so your app code stays boring — usually around 20 lines:

- **Mesh WebRTC**: perfect negotiation, trickle ICE, renegotiation, restarts.
- **Adaptive quality**: fast downgrade under pressure, careful upgrades, visible warnings.
- **Any signaling backend**: six adapters plus a self-hostable server; mobile bindings share the protocol.

## Quick start

Nothing is on npm yet (see [Status](#status)), so start in the repo:

```sh
git clone <repo-url> vidcall && cd vidcall
bun install && bun run build
```

### Option A — React

```tsx
import { createClient } from '@supabase/supabase-js';
import { Room } from '@vidcall/core';
import { SupabaseBackend } from '@vidcall/backend-supabase';
import { useJoin, useParticipants, useRoomState } from '@vidcall/react';

const room = new Room({
  roomId: 'demo',
  selfId: `user-${Math.random().toString(36).slice(2, 8)}`,
  transport: new SupabaseBackend({
    client: createClient(SUPABASE_URL, SUPABASE_ANON_KEY),
  }),
});

function Call() {
  useJoin(room); // auto-join on mount, clean leave on unmount
  const state = useRoomState(room); // status: 'new' | 'joining' | 'joined' | 'closed'
  const participants = useParticipants(room);
  return <p>{state.status} · {participants.length} people here</p>;
}
```

### Option B — vanilla JS (any framework, or none)

```js
import { Room } from '@vidcall/core';
import { SupabaseBackend } from '@vidcall/backend-supabase'; // any adapter works
import { createClient } from '@supabase/supabase-js';

const room = new Room({
  roomId: 'demo',
  selfId: `user-${Math.random().toString(36).slice(2, 8)}`,
  transport: new SupabaseBackend({ client: createClient(SUPABASE_URL, KEY) }),
});

// Remote media arrives on its own; put each track on a <video>.
room.on('track', ({ participant, track }) => {
  document.getElementById('remote-' + participant.id).srcObject =
    new MediaStream([track]);
});

await room.join();

// Send your camera to everyone in the room:
const stream = await navigator.mediaDevices.getUserMedia({ video: true });
await room.publish(stream.getVideoTracks()[0], { source: 'camera' });
```

```sh
# No Supabase handy? Two tabs of ONE browser can call each other, no server:
node examples/vanilla/build.mjs && npx serve examples/vanilla
# open http://localhost:3000 in TWO tabs → Camera on in each tab = a call
```

## Packages

| Package                                             | What it gives you                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`@vidcall/core`](packages/core/README.md)           | The client engine — `Room`, peer connections, devices, recording. Zero runtime deps.                           |
| [`@vidcall/react`](packages/react/README.md)         | Hooks: `useJoin`, `useRoomState`, `useParticipants`.                                                            |
| [`@vidcall/quality`](packages/quality/README.md)     | Adaptive-quality policy engine (pure functions, no WebRTC imports).                                             |
| [`@vidcall/transport`](packages/transport/README.md) | The `SignalingTransport` contract, helpers, and the shared test suite every backend must pass.                  |
| [`@vidcall/server`](packages/server/README.md)       | Rooms, REST + WebSocket relay, recording storage. Stores: `/stores/sqlite`, `/stores/postgres`, `/stores/mysql`; adapters: `/express`, `/fastify`. |
| [`@vidcall/sfu-gateway`](packages/sfu-gateway/README.md) | Optional SFU path (mediasoup reference adapter; not yet wired into `Room`).                                 |
| backends                                             | [`supabase`](packages/backend-supabase/README.md) · [`convex`](packages/backend-convex/README.md) · [`firebase`](packages/backend-firebase/README.md) · [`appwrite`](packages/backend-appwrite/README.md) · [`postgres`](packages/backend-postgres/README.md) · [`sqlite`](packages/backend-sqlite/README.md) |
| mobile bindings                                      | [`kotlin`](packages/kotlin/README.md) · [`swift`](packages/swift/README.md) · [`dart`](packages/dart/README.md) — same wire protocol |
| [`protocol`](protocol/)                              | The versioned JSON envelope everyone speaks (`schema.json` + fixtures).                                         |

## Works everywhere

- **Any frontend**: React gets hooks; every other framework (or none) drives `@vidcall/core` directly.
- **Any backend language**: REST + WebSocket to `@vidcall/server` — mount it in Express/Fastify,
  sidecar beside Django/Laravel/Rails, or try the Rust relay (`server/rust`). Guides:
  [integrations/README.md](integrations/README.md).
- **Any database**: implement the ~10-method `Store` contract ([integrations/DATABASES.md](integrations/DATABASES.md)).
- **Mobile**: Kotlin, Swift, and Dart bindings speak the same protocol.

## Status

The honest version: this is v0.1.0 pre-release. Nothing is published to npm
yet — consume the packages from this repo for now (the examples show how).
Everything here exists and is tested, but expect breaking changes until the
first release. Recent changes: [CHANGELOG.md](CHANGELOG.md).

## Keep reading

- [Getting started](docs/getting-started.md) — build a call step by step, gotchas included.
- [Testing matrix](docs/testing.md) — what L0/L1/L2 mean and how to run them.
- [Contributing](CONTRIBUTING.md) — policies, local development, releases.

## License

MIT — see [LICENSE](LICENSE).
