# vidcall

Add video calls to any app in minutes. vidcall is a JS/TS mesh WebRTC engine
with a pluggable signaling layer: bring your own Supabase, Convex, Firebase,
Appwrite, PostgreSQL, SQLite, or host the included server component — the
engine, the wire protocol, and the 3 mobile bindings (Kotlin, Swift, Dart)
don't care which one you picked.

```sh
# the fastest "hello call" — two tabs, zero infra (full walkthrough in examples/)
git clone <repo-url> vidcall && cd vidcall
npm ci && npm run build
node examples/vanilla/build.mjs && npx serve examples/vanilla
# open http://localhost:3000 in TWO tabs → both auto-join the room → Camera on in each = a call
```

The API in 5 lines:

```ts
import { Room } from '@vidcall/core';
import { SupabaseBackend } from '@vidcall/backend-supabase';

const room = new Room({ roomId: 'demo', selfId: 'me', transport: new SupabaseBackend({ client }) });
room.on('track', ({ participant, track }) => attach(participant, track)); // remote media
room.on('quality-warning', (e) => toast(`${e.from} → ${e.to} · ${e.reason}`));
await room.join();
await room.publish(cameraTrack); // your camera to everyone in the room
```

## What you get

| Feature                   | What it is                                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1:1 + multi-user mesh** | perfect negotiation, trickle ICE, renegotiation, ICE restart (`PeerConnectionManager`) — works over any dumb pub/sub                                                                   |
| **Adaptive quality**      | `@vidcall/quality` policy engine: instant downgrade on network/CPU pressure, 10 s-stable upgrade, device-capability caps, user-visible warnings                                        |
| **6 pluggable backends**  | Supabase, Convex, Firebase, Appwrite, PostgreSQL, SQLite — one `SignalingTransport` interface, one shared adapter test suite                                                           |
| **Server component**      | `@vidcall/server`: rooms, participant roster, signal log, envelope relay (REST + WebSocket), recording storage — hosts inside Express/Fastify or as a sidecar for Django/Laravel/Rails |
| **Recording**             | `room.recording` — composite MediaRecorder of local + remote streams, chunked upload to `@vidcall/server`                                                                              |
| **3 mobile bindings**     | Kotlin, Swift, Dart (Flutter) — same wire protocol, L0 conformance fixtures in CI                                                                                                      |
| **Wire protocol**         | one versioned JSON envelope (`protocol/schema.json`) shared by every client and backend                                                                                                |
| **Controls**              | mute/camera/screen-share/raise-hand/device selection (`room.controls`) and reactions + chat over backend pub/sub or the data channel                                                   |

## Install

Nothing is published to npm yet (`0.1.0` workspace packages, root is
`"private": true`). Two supported paths until the first release:

**1. Workspace setup (what the examples use).** Clone, install, build, then
consume the packages from the workspace:

```sh
git clone <repo-url> vidcall && cd vidcall
npm ci && npm run build
```

Your app can then depend on the packages with `file:` deps (npm symlinks
them, no publish needed):

```json
{
  "dependencies": {
    "@vidcall/core": "file:../vidcall/packages/core",
    "@vidcall/backend-supabase": "file:../vidcall/packages/backend-supabase"
  }
}
```

**2. From a git URL.** `npm i git+https://github.com/<owner>/vidcall.git`
installs the repository root — today that is the workspace container, not a
publishable package, so combine it with the `file:` deps above (or wait for
the first npm release: `npm i @vidcall/core`). Either way, follow
`examples/` for a working setup.

> `npm i <git-url>` accuracy note: npm installs the root package of a git
> repo as-is; this repo's root is the private workspace container, which is
> why the `file:`/workspace paths above are the supported ones today.

## Quickstart → working room

1. **Zero-infra, two tabs, no server** — [`examples/vanilla`](examples/vanilla):
   `Room` + the sqlite BroadcastChannel backend; build with one esbuild step,
   serve with `npx serve` or `python3 -m http.server`.
2. **React + Supabase** — [`examples/react`](examples/react): Vite + React 19
   wiring `Room` + `SupabaseBackend` into React state (mute, camera, quality
   events, roster).
3. **Self-hosted signaling** — [`examples/server`](examples/server): a ~30-line
   Express app mounting `@vidcall/server` (`createExpressRouter`) + a REST
   client snippet.

Each example is documented in [`examples/README.md`](examples/README.md).

## Packages

| Package                                              | What it is                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@vidcall/core`](packages/core/README.md)           | client mesh engine: `Room`, `PeerConnectionManager`, `DataChannelBus`, controls, recording facade — **zero runtime deps**                                                                                                                                                                                     |
| [`@vidcall/quality`](packages/quality/README.md)     | adaptive-quality policy engine (`AdaptiveQualityController`, `DeviceCapability`) — pure, no WebRTC imports                                                                                                                                                                                                    |
| [`@vidcall/transport`](packages/transport/README.md) | `SignalingTransport` contract + helpers (chunker, reorder, heartbeat, ICE coalescer) + the shared adapter test suite                                                                                                                                                                                          |
| [`@vidcall/server`](packages/server/README.md)       | backend component: rooms/sessions, REST + WebSocket relay, recording storage; function-based `Store` works with any database                                                                                                                                                                                  |
| [`@vidcall/protocol`](protocol/)                     | the wire protocol — `protocol/schema.json` + TS mirror (`Envelope`, `createEnvelope`, payload types)                                                                                                                                                                                                          |
| backends                                             | [`supabase`](packages/backend-supabase/README.md) · [`convex`](packages/backend-convex/README.md) · [`firebase`](packages/backend-firebase/README.md) · [`appwrite`](packages/backend-appwrite/README.md) · [`postgres`](packages/backend-postgres/README.md) · [`sqlite`](packages/backend-sqlite/README.md) |
| bindings                                             | [`kotlin`](packages/kotlin/README.md) · [`swift`](packages/swift/) · [`dart`](packages/dart/README.md)                                                                                                                                                                                                        |

## Docs

- [Architecture](docs/architecture.md) — the blueprint behind the engine.
- [Testing matrix](docs/testing.md) — L0 protocol conformance / L1 unit +
  shared adapter suites / L2 cross-language integration, and how to run each
  layer locally.
- [Server hosting guides](integrations/README.md) — Express, Fastify, Django,
  Laravel, Rails + the `Store` contract.
- [Research & reviews](docs/) — backend adapters, WebRTC JS options, mobile
  bindings, competitive analysis, DX review.

## Testing

```sh
npm run build && npm test && npm run typecheck && npm run lint   # L1 (workspace)
for p in packages/backend-*; do (cd "$p" && npm run test --if-present); done  # L1 (backends, shared suite)
cd packages/swift && swift test                                   # L2 swift
cd packages/dart && dart test                                     # L2 dart
cd packages/kotlin && ./gradlew test                              # L2 kotlin (JDK 21)
```

CI (`.github/workflows/ci.yml`) runs the full matrix on every push: node
20/22 (build, test, typecheck, lint + every backend suite), swift, dart,
kotlin.

## Status

Implementation in progress — the engine, quality policy, all 6 backends, the
server component, and the 3 bindings exist and are tested; the first npm
release is not out yet (see Install). Tracked in `docs/architecture.md`.
Notable changes are summarized in [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).
