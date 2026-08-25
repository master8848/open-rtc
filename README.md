# peercall

> Placeholder name — replace `peercall` globally to rename. Same idea: peer-to-peer calling.

Add audio/video calling to any app without wiring WebRTC yourself.

## Why

- Building calling is hard: peer connections, ICE, negotiation races, reordering, bad networks.
- This project exists to make that easier for anyone building audio or video calling.
- Ships with frontend helpers, but not locked to them — use your own UI via vanilla functions.

## What you get

- **Mesh WebRTC** — browsers connect directly, no SFU required for small rooms.
- **Adaptive quality** — downgrades fast under pressure, upgrades cautiously, surfaces warnings.
- **Any signaling backend** — Supabase, Convex, Firebase, Appwrite, Postgres, SQLite, or self-hosted server.
- **Any frontend** — React hooks or plain vanilla JS functions. Use either.
- **Any backend language** — server is a sidecar via REST + WebSocket. Works beside Express/Fastify, Django, Rails, Laravel, etc.
- **Mobile** — Kotlin / Swift / Dart bindings sharing the same protocol.

## How it's efficient

- **Perfect negotiation** — deterministic offer/answer, no glare races.
- **Trickle ICE** — candidates exchanged as they arrive, faster connect.
- **Renegotiation + restarts** — ICE restarts and re-offers handled automatically.
- **Adaptive quality policy engine** — pure functions in `@peercall/quality`, no WebRTC imports, easy to test and tune.
- **Deduplication / reordering** — signaling messages de-duped and ordered before they hit the peer logic.
- **Small bundle** — `@peercall/core` has zero runtime deps, tree-shakeable.
- **Driver-free server** — `@peercall/server` uses a ~10-method `Store` contract; bring SQLite, Postgres, MySQL, or your own.

## Quick start

Not on npm yet — run from source:

```sh
git clone <repo-url> peercall && cd peercall
bun install && bun run build
```

**React:**

```tsx
import { Room } from '@peercall/core';
import { SupabaseBackend } from '@peercall/backend-supabase';
import { useJoin, useParticipants } from '@peercall/react';

const room = new Room({ roomId: 'demo', selfId: 'user-1', transport: new SupabaseBackend({ client }) });

function Call() {
  useJoin(room);
  const participants = useParticipants(room);
  return <p>{participants.length} in room</p>;
}
```

**Vanilla JS:**

```js
import { Room } from '@peercall/core';

const room = new Room({ roomId: 'demo', selfId: 'user-1', transport });
room.on('track', ({ track }) => { videoEl.srcObject = new MediaStream([track]); });
await room.join();
```

No backend? Two tabs in one browser work with no server:

```sh
node examples/vanilla/build.mjs && npx serve examples/vanilla
# open http://localhost:3000 in two tabs
```

## Packages

| Package | Purpose |
|---|---|
| `@peercall/core` | Client engine: `Room`, peers, devices, recording |
| `@peercall/react` | Hooks: `useJoin`, `useRoomState`, `useParticipants` |
| `@peercall/quality` | Adaptive quality policy (pure functions) |
| `@peercall/transport` | `SignalingTransport` contract + shared backend tests |
| `@peercall/server` | Relay server (REST + WS), stores for sqlite/postgres/mysql, adapters for express/fastify |
| `@peercall/sfu-gateway` | Optional SFU path (mediasoup reference, not yet in Room) |
| backends | `supabase` · `convex` · `firebase` · `appwrite` · `postgres` · `sqlite` |
| mobile | `kotlin` · `swift` · `dart` — same wire protocol |
| `protocol` | Versioned JSON envelope (`schema.json` + fixtures) |

## Status

- v0.1.0 pre-release, not published to npm.
- All packages exist and are tested, but expect breaking changes before first release.
- See [CHANGELOG.md](CHANGELOG.md).

## Further reading

- [Getting started](docs/getting-started.md)
- [Testing matrix](docs/testing.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT — see [LICENSE](LICENSE).
