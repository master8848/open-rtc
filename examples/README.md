# vidcall examples

Three ways to see vidcall in action — from a zero-infra two-tab call to a
backend-hosted signaling server.

| Example                | Stack                          | What it shows                                                                                                                                                                                          | Needs                                  |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| [`vanilla/`](vanilla/) | plain TypeScript, no framework | `Room` + the **sqlite BroadcastChannel** backend: two tabs of one browser = a 1:1 mesh call with **no server at all**. Mute/camera toggles, local adaptive-quality monitoring, start-recording wiring. | a browser (Chrome/Edge/Firefox/Safari) |
| [`react/`](react/)     | Vite + React 19                | `Room` + the **Supabase** backend wired into React state: join/leave, mute/camera, `quality-warning` events, participant roster.                                                                       | a Supabase project (free tier is fine) |
| [`server/`](server/)   | Express + `@mbsks/server`    | Host the signaling/state plane yourself: rooms, REST API, WebSocket relay. Ships a REST client snippet.                                                                                                | Node 18+                               |

All examples consume the workspace packages exactly the way an external app
would consume the unpublished `@mbsks/*` packages (via the npm workspace
symlinks / `file:` deps — see the install section of the [root README](../README.md)).

## Prerequisites

```sh
git clone <repo-url> vidcall
cd vidcall
npm ci          # or: npm install
npm run build   # builds @mbsks/core, @mbsks/transport, @mbsks/server, ...
```

> The vanilla example bundles directly from the TypeScript sources, so it
> works without the `npm run build` step — but it doesn't hurt.

## vanilla — two tabs, no server

```sh
node examples/vanilla/build.mjs        # one esbuild step (uses the repo's esbuild)
npx serve examples/vanilla             # or: (cd examples/vanilla && python3 -m http.server 8000)
```

Open `http://localhost:8000` in **two tabs**. Both join `demo-room`
automatically; press **Camera on** in each tab and you are in a 1:1 call. The
event log shows joins, presence, quality tier changes (fed from
`getStats()`), and recording chunks. Add `?room=<id>` to the URL to pick a
different room.

## react — Room + Supabase in React state

```sh
cd examples/react
cp .env.example .env       # fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm install                # installs react/vite + links the workspace @mbsks/* packages
npm run dev                # http://localhost:5173
```

Open it in two tabs (or two devices) with the same Supabase project — the
Supabase adapter uses Realtime **broadcast** for envelopes and **presence**
for the roster, over one WebSocket. Mute/camera state and `quality-warning`
events live in React state.

> Production build (`npm run build` in `examples/react`) resolves the
> `@mbsks/*` packages to their compiled `dist/`, so build the workspace
> first: `npm run build` at the repo root **plus**
> `(cd packages/backend-supabase && npm run build)`.

## server — mount @mbsks/server in Express

```sh
node examples/server/server.mjs    # terminal 1 — http://localhost:3000/vidcall
node examples/server/client.mjs    # terminal 2 — REST client snippet
```

The client creates a room, joins two participants, relays one SDP `offer`
envelope, and reads room state. The WebSocket relay (`/vidcall/ws?roomId=…`)
is mounted too — see `packages/server/README.md` for the full REST/WS API and
`integrations/` for Fastify, Django, Laravel, and Rails hosting.
