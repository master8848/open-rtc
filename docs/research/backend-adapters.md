# vidcall — Pluggable Backends Research: Signaling, Presence & State

> **Status:** research blueprint (implementation target: tomorrow)
> **Date:** 2026-08-11
> **Scope:** adapter-based signaling + presence + state layer for `vidcall` (JS/TS video-calling library). WebRTC media plane is out of scope; only the **signaling plane** (SDP offer/answer, ICE trickle, presence, reactions, chat) is covered.
> **Policy compliance:** every recommended npm package was checked against the repo supply-chain policy (`npm view <pkg> time` — pin versions published **≥ 14 days ago**). Exact pins and per-version publish dates are listed below.

---

## 0. TL;DR — recommendations

| Rank | Backend | Verdict for vidcall | Why |
|---|---|---|---|
| 1 | **Supabase Realtime** | ⭐ Recommended default | Native `broadcast` + `presence` over one WebSocket; 256 KB broadcast payload (Free) ≫ SDP; generous free tier; the *only* backend with first-class presence + broadcast out of the box. |
| 2 | **Convex** | ⭐ Recommended for reactive-state apps | Queries are live subscriptions; mutations are transactional & ordered; presence via official `@convex-dev/presence` component; 16 MiB args/returns ⇒ no chunking ever. |
| 3 | **PostgreSQL LISTEN/NOTIFY** | ✅ Recommended self-host / own-infra | Zero extra services (uses the app DB); ~ms latency; **8 KB payload cap is the binding constraint** → need chunking or store-and-reference; browsers need a `ws` bridge. |
| 4 | **Firebase Realtime DB** | ✅ Recommended when Firebase already in stack | Native presence (`onDisconnect`), offline-first, 200k concurrent connections; strong ordering per path. |
| 5 | **Appwrite** | ⚠️ Workable with caveats | Realtime is **one-way (server→client)**; no client broadcast and no presence primitive → signal via doc writes + events; 256 KB msg (Free) / 3 MB (Pro). |
| 6 | **SQLite / libSQL / Turso** | ⚠️ Dev/test & same-device only | No server push. Same-device multi-tab works via `BroadcastChannel`; multi-device requires Turso sync (seconds-level, eventual) — **not suitable for SDP exchange across devices**. |
| — | Redis / Ably / Pusher / Centrifugo | ℹ️ "Others" (see §8) | Redis Pub/Sub is fire-and-forget + browser bridge needed; Ably/Pusher are managed alternatives; Centrifugo is the best self-hosted generic realtime server. |

**Unified interface:** one `SignalingBackend` TS interface (§9) implemented by all six adapters; per-backend caveats handled inside each adapter (e.g. Postgres chunker, Appwrite doc-event emulation, SQLite BroadcastChannel).

---

## 1. Supply-chain compliance (pinned versions, publish dates, sizes)

Policy: *"every dependency must have been published at least 14 days before we add it… Pin exact versions."* — checked 2026-08-11 via `npm view <pkg> time --json`.

| Package | Role | **Pin (exact)** | Publish date | Age | unpacked size |
|---|---|---|---|---|---|
| `convex` | Convex client | `1.42.3` | 2026-07-16 | 25 d | 30.83 MB (includes CLI/server tooling; client is tree-shaken `convex/browser`) |
| `@supabase/supabase-js` | Supabase client (includes realtime) | `2.110.9` | 2026-07-27 | 14 d | 0.63 MB |
| `@supabase/realtime-js` | Supabase Realtime (dep of supabase-js) | `2.110.9` | 2026-07-27 | 14 d | 0.74 MB |
| `pg` | PostgreSQL client | `8.22.0` | 2026-06-19 | 53 d | 0.10 MB |
| `postgres` (porsager) | PostgreSQL client (alt; built-in `listen()`) | `3.4.9` | 2026-04-05 | 127 d | 0.30 MB |
| `@libsql/client` | Remote libSQL/Turso driver (Hrana) | `0.17.4` | 2026-06-15 | 56 d | 0.14 MB |
| `@tursodatabase/database` | Local/embedded SQLite (Turso rewrite) | `0.7.1` | 2026-07-22 | 20 d | 0.06 MB |
| `@tursodatabase/sync` | Local + cloud sync | `0.7.1` | 2026-07-22 | 20 d | 0.04 MB |
| `@tursodatabase/serverless` | Remote Turso (fetch-only) | `1.4.0` | 2026-07-27 | 15 d | 0.27 MB |
| `better-sqlite3` | Embedded SQLite (native, Node only) | `13.0.1` | 2026-07-21 | 21 d | 27.30 MB (native binding) |
| `appwrite` | Appwrite client | `26.2.0` | 2026-07-13 | 29 d | 3.10 MB |
| `firebase` | Firebase (modular; use `firebase/app`, `/database`, `/firestore`) | `12.16.0` | 2026-07-09 | 33 d | 36.67 MB unpacked (modular imports pull only what you use) |
| `ioredis` | Redis client | `5.11.1` | 2026-06-04 | 68 d | 1.29 MB |
| `ably` | Ably realtime client (managed alt.) | `2.26.0` | 2026-07-23 | 18 d | 9.80 MB |
| `pusher-js` | Pusher Channels client (managed alt.) | `8.6.0` | 2026-07-23 | 19 d | 7.15 MB |
| `centrifuge` | Centrifugo client (self-hosted alt.) | `5.7.0` | 2026-06-15 | 56 d | — |
| `@convex-dev/presence` | Convex presence component | `0.4.0` | 2026-07-21 | 21 d | — |

> ⚠️ **Latest versions were deliberately NOT chosen** — they are < 14 days old and violate the policy:
> `convex@1.43.0` (10 d), `@supabase/supabase-js@2.112.3` (0 d), `pg@8.23.0` (2 d), `firebase@12.17.1` (6 d), `ioredis@6.0.0` (10 d), `ably@2.27.0` (0 d), `@tursodatabase/database@0.7.2` (12 d). Verify again at implementation time; the pins above are the newest **policy-safe** versions as of this writing.
> Note: `npm view <pkg> time.created` for `convex` shows 2014 (a pre-existing name owner published 0.x–3.x before Convex took over in 2023); the relevant check is the **pinned version's** publish date, not the namespace's first publish.

---

## 2. WebRTC signaling payload facts (context for every backend)

| Message | Typical size | Notes / source |
|---|---|---|
| SDP offer/answer (JSON-encoded, 1 video + 1 audio m-line) | **1–5 KB** | "A standard Offer/Answer is ~2.5 KB JSON" ([air-gapped WebRTC writeup](https://www.reddit.com/r/WebRTC/comments/1qlk942/airgapped_webrtc_how_i_compressed_the_signaling/)); grows with codecs/transceivers/`rtx`/`fec` — complex multi-codec offers can exceed **8 KB** ([SDP minimization reference](https://webrtchacks.com/the-minimum-viable-sdp/)) |
| ICE candidate (trickle) | **0.1–0.5 KB** | one per candidate; typical session exchanges 10–50 candidates |
| Reactions (emoji bursts) | tens of bytes | fine everywhere |
| Chat line | tens–hundreds of bytes | fine everywhere |

Consequences:
- **Every backend's payload limit fits SDP/ICE except PostgreSQL's 8 KB NOTIFY cap** (needs chunking / store-and-reference).
- ICE candidates tolerate reorder (they carry `sdpMid`/`sdpMLineIndex`); **SDP offer/answer MUST be ordered** → the adapter interface must expose per-message `seq` and a small reorder buffer (see §9).
- Trickle candidates arrive in bursts → rate limits matter (Supabase Free: 100 msg/s; Ably Free: 500 msg/s).

---

## 3. Convex

**Package:** `convex@1.42.3` (pin), 30.83 MB unpacked. Client subpath `convex/browser` (browser entry) — the top-level package also contains the CLI/dev server; keep as a devDependency for codegen and use the browser client in apps. `@convex-dev/presence@0.4.0` for presence.

### 3.1 Realtime model
- Client opens a **persistent WebSocket** to `wss://<deployment>.convex.site`; a "sync worker" manages sessions, a "function runner" executes `query`/`mutation`/`action` functions, and a custom transactional database stores state. ([How Convex Works](https://stack.convex.dev/how-convex-works))
- **Queries are live subscriptions**: the server tracks each query's read-set and re-runs + pushes new results when underlying data changes; `useQuery` re-renders automatically. ([Convex React docs](https://docs.convex.dev/client/react/overview))
- **Mutations are transactional writes** executed server-side; they trigger subscription updates for affected queries. All client calls (queries + mutations) flow over the same WebSocket; optimistic updates supported client-side.
- No chat/broadcast primitive: you model rooms as documents (`rooms/{id}`) and messages as child documents; subscribers see updates reactively.

### 3.2 Limits (verified from [Convex Limits](https://docs.convex.dev/production/state/limits))
| Limit | Free/Starter | Notes |
|---|---|---|
| Function args / return value | **16 MiB** | Node actions: args ≤ 5 MiB |
| Document size | 1 MiB (1,024 fields, depth 16) | |
| Mutation write throughput | 4 MiB (S16) | S16 = free/starter deployment class |
| Concurrent sessions (WebSockets) | **1,000** | Pro: 10,000 |
| Concurrent queries / mutations | 16 each (S16) | Pro S256 |
| Function calls | 1,000,000 / month (free) | $2.20 per extra 1M |
| DB storage / I/O | 0.5 GB / 1 GB per month (free) | |

### 3.3 WebRTC signaling fit
- SDP + ICE fit trivially (16 MiB args). Mutations are serialized and transactions are strongly consistent → **ordering is guaranteed** (no reorder buffering needed for SDP).
- Latency: request latencies in the **milliseconds** range (SSD-backed transactional store); end-to-end mutation→subscription push is sub-100 ms typical.
- Pattern: `rooms` table + `signals` table (`{roomId, kind: 'offer'|'answer'|'ice', sdp?, candidate?, seq}`) + a `messages` table for chat; subscribers query `signals` per room. Trickle ICE = insert rows; remote query sees them reactively.

### 3.4 Presence / reactions / chat
- **Presence:** no built-in primitive; canonical pattern is a presence table + periodic heartbeat mutation + a reactive query ([Implementing Presence with Convex](https://stack.convex.dev/presence-with-convex)). Official drop-in: `@convex-dev/presence` component (live room member list, `usePresence`, "last online" status). ([component docs](https://www.convex.dev/components/presence))
- **Reactions:** fire-and-forget writes to a `reactions` table or ephemeral fields — fine.
- **Chat:** document-per-message with query subscription; cursor pagination supported.

### 3.5 Auth, pricing, performance
- **Auth:** pluggable providers (Clerk, Auth0, custom JWT) via `convex/auth.config.ts`; anonymous auth supported; fine-grained permissions only on Business plan. ([docs](https://docs.convex.dev/auth/overview))
- **Pricing:** Free $0 (1M calls/mo, 0.5 GB storage); Starter pay-as-you-go; Pro $25/developer/mo (25M calls included). ([Convex pricing](https://www.convex.dev/pricing))
- **Performance:** S16 = 16 concurrent queries; 1,000 concurrent sessions on Free — fine for a signaling layer; heavy chat apps should mind function-call billing (every subscription update counts).
- **Self-host:** `convex-backend` is open source (community-managed).

**Sources:** [Convex Limits](https://docs.convex.dev/production/state/limits) · [React client](https://docs.convex.dev/client/react/overview) · [How Convex Works](https://stack.convex.dev/how-convex-works) · [Presence guide](https://stack.convex.dev/presence-with-convex) · [Presence component](https://www.convex.dev/components/presence) · [Pricing](https://www.convex.dev/pricing)

---

## 4. Supabase

**Packages:** `@supabase/supabase-js@2.110.9` (0.63 MB) + `@supabase/realtime-js@2.110.9` (0.74 MB, a dependency of supabase-js — version numbers are synced). `supabase-js` alone is enough; Realtime is enabled by default.

### 4.1 Realtime model
Supabase Realtime is a **globally distributed Elixir (Phoenix) cluster**; clients connect via one WebSocket (`wss://<ref>.supabase.co/realtime/v1/websocket`, Phoenix Channels protocol). Three features ([overview](https://supabase.com/docs/guides/realtime)):
- **Broadcast** — ephemeral client↔client messages on a channel (perfect for SDP/ICE/reactions). Private by default; `self: true` option to echo to sender; binary payloads supported; 72 h replay (up to 25 msgs/request).
- **Presence** — each client publishes a small payload under a unique key; server keeps merged view; events: `sync` (full state), `join`, `leave`. Explicitly *not* for high-frequency updates.
- **Postgres Changes** — DB-change events via **WAL (logical replication)**; `INSERT/UPDATE/DELETE` filters per table; payload cap 1,024 KB (over-limit fields dropped >64 B values).

### 4.2 Limits (verified from [Realtime Limits](https://supabase.com/docs/guides/realtime/limits))
| Limit | Free | Pro / no-cap |
|---|---|---|
| Concurrent connections | **200** | 500 / 10,000 |
| Messages per second | **100** | 500 / 2,500 |
| Channel joins per second | 100 | 500 / 2,500 |
| Channels per connection | 100 | 100 |
| **Broadcast payload size** | **256 KB** | 3,000 KB |
| Postgres-change payload | 1,024 KB | 1,024 KB |
| Presence keys per object | 10 | 10 |
| Presence messages/sec | 20 | 50 / 1,000 |
| Presence calls per client / 30 s | 5 | 5 |
| Broadcast replay retention | 72 h | 72 h |

### 4.3 WebRTC signaling fit
- **Broadcast is the right primitive**: `channel('room-1').on('broadcast', {event: 'sdp'}, cb)` / `.send({type:'broadcast', event:'sdp', payload})` — SDP (≤5 KB) and ICE fit with 50× headroom on Free.
- **Ordering:** no strict cross-publisher ordering guarantee (Phoenix pubsub) → adapter should attach `seq` and reorder SDP messages; ICE candidates tolerate reorder natively.
- **Latency:** sub-100 ms typical in-region; globally-distributed cluster helps cross-region pairs.
- **Rate limits:** Free 100 msg/s — a trickle burst of 30 candidates + offer/answer is ~35 msgs, fine; high-frequency cursor/reaction streams should be throttled client-side.

### 4.4 Presence / reactions / chat
- **Presence:** native — `channel.track({user, ...})` / `untrack()`; `on('presence', {event:'sync'|'join'|'leave'})`; perfect for "who's in the call" + typing indicators. Watch the 5-calls-per-30 s client limit and 20 msg/s (Free).
- **Reactions:** broadcast events (`event: 'reaction'`).
- **Chat:** broadcast (ephemeral) or Postgres table + `postgres_changes` (durable, replayable).

### 4.5 Auth, pricing, performance
- **Auth:** GoTrue — email/password, OTP, OAuth, phone, anonymous; JWT; **RLS** policies gate both DB access and Realtime authorization (private channels require signed JWT).
- **Pricing:** Free $0 — 500 MB DB, 5 GB egress, 50 k MAU, 2 projects (paused after 1 week idle); Pro from $25/mo — 8 GB disk, 250 GB egress. ([Supabase pricing](https://supabase.com/pricing))
- **Performance:** 200 conn / 100 msg/s on Free is the real ceiling for a signaling layer; Realtime errors surface as `too_many_channels`, `too_many_connections`, `tenant_events` (auto-reconnect on drop).
- **Self-host:** open source (supabase/realtime is Elixir; self-hosting Realtime on a single node is fine for small deploys).

**Sources:** [Realtime overview](https://supabase.com/docs/guides/realtime) · [Broadcast](https://supabase.com/docs/guides/realtime/broadcast) · [Presence](https://supabase.com/docs/guides/realtime/presence) · [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes) · [Limits](https://supabase.com/docs/guides/realtime/limits) · [Architecture](https://supabase.com/docs/guides/realtime/architecture) · [Pricing](https://supabase.com/pricing)

---

## 5. PostgreSQL (LISTEN/NOTIFY)

**Packages:** `pg@8.22.0` (0.10 MB) — classic client; or `postgres@3.4.9` (0.30 MB) which has a built-in `postgres.prototype.listen()` with auto-reconnect. Browser clients additionally need a WebSocket bridge (e.g. `ws` in your Node server — or use Supabase Realtime, which is exactly a managed version of this).

### 5.1 Realtime model
- `LISTEN channel` / `NOTIFY channel, payload` — PostgreSQL's built-in interprocess messaging. ([NOTIFY docs](https://www.postgresql.org/docs/current/sql-notify.html))
- **Transactional**: `NOTIFY` fires only on **commit**; a transaction can't be prepared for 2PC after NOTIFY.
- **Delivery:** only to sessions currently `LISTEN`ing — **no queueing for offline clients, no replay**. A global notification queue (8 GB default) holds undelivered notifications; `pg_notification_queue_usage()` monitors it; if full, `NOTIFY` fails at commit.
- **Payload cap: payload must be shorter than 8000 bytes** in default config. Docs explicitly suggest: *"put it in a database table and send the key of the record"* for larger data.

### 5.2 Node.js specifics
- `pg.Client` emits `'notification'` events after `LISTEN`.
- **Pool pitfall:** with `pg.Pool`, LISTEN must be issued on a **dedicated connection** — pooled connections are multiplexed and notifications are only delivered on the connection that ran `LISTEN`. Pattern: one long-lived `pg.Client` per room server (or per process with a multiplexer that fans out over `EventEmitter`). (`node-postgres` notifications docs)
- Reconnect logic must re-issue `LISTEN` (and re-join rooms).
- Browser bridge: Node server (`ws` + `pg`) that maps rooms→channels and forwards frames; a room can be a channel name (channel names are arbitrary identifiers, 63-byte limit).

### 5.3 WebRTC signaling fit
- **8 KB cap is the binding constraint.** Typical SDP (1–5 KB) usually fits, but complex offers can exceed it → the adapter needs a **chunker** (split payload into ≤7 KB chunks with `{chunkId, index, total}`) or **store-and-reference** (write SDP to `signals` table, NOTIFY with row id).
- **Ordering:** FIFO per (session, channel); across concurrent writers ordering is not guaranteed → `seq` + reorder buffer for SDP; ICE fine.
- **Latency:** ~1–5 ms on local Postgres; plus network for the ws bridge. Best-in-class latency among non-managed options.
- **Rate:** no message-rate cap other than DB throughput; 8 GB queue ≈ 1M+ pending 8 KB notifications.

### 5.4 Presence / reactions / chat
- **Presence:** none native. Build it: `presence` table keyed `(room, user)` with heartbeat `UPDATE` (e.g. every 5 s) + `NOTIFY presence_changed`; stale rows swept by a cron (or read `last_seen` and treat > N s as offline). No `onDisconnect` equivalent — heartbeats only.
- **Reactions:** NOTIFY payload (tiny) or table.
- **Chat:** `messages` table + NOTIFY or `pg` polling; durable, queryable, SQL-powered.

### 5.5 Auth, pricing, performance
- **Auth:** your own — DB roles / TLS / SCRAM; RLS for per-row authz; JWT verification in the bridge server. No managed auth.
- **Pricing:** self-host free; managed (Neon, RDS, Supabase) per their tiers. No per-message pricing — the cost model is just the DB.
- **Performance:** thousands of NOTIFY/s per instance are trivial; the bottleneck is per-connection overhead for LISTEN sessions (one connection per room-server process is the right granularity).

**Sources:** [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html) · [node-postgres notifications](https://node-postgres.com/features/notifications) · [postgres (porsager) repo](https://github.com/porsager/postgres)

---

## 6. SQLite / libSQL / Turso

**Packages:** local/embedded — `@tursodatabase/database@0.7.1` (0.06 MB, Turso engine) or `better-sqlite3@13.0.1` (Node native) / `sql.js@1.14.1` (WASM, browser); remote — `@libsql/client@0.17.4` (Hrana protocol over HTTP/WebSocket, 0.14 MB) or `@tursodatabase/serverless@1.4.0` (fetch-only); local+sync — `@tursodatabase/sync@0.7.1`.

### 6.1 Realtime model — local-first, **no server push**
- SQLite itself has **no push channel**. Same-device multi-tab: **`BroadcastChannel`** (Web platform API) + `storage` events for cross-tab coordination — fast, same-origin, but browser-only and same-device-only.
- Multi-device: **Turso Embedded Replicas** — local read replica; reads hit local file (µs), writes go to the cloud primary and are reflected back on `sync()` (manual or interval, e.g. every 60 s). ([Embedded Replicas](https://docs.turso.tech/features/embedded-replicas/introduction)) `@tursodatabase/sync` adds a sync engine on top.
- libSQL server (`sqld`) exposes the DB over HTTP/WebSocket (Hrana) for remote clients — a self-hosted option with connection-based push-ish polling (still request/response, not true push).
- Turso's sync engine is **eventually consistent, seconds-level** — *not* realtime in the WebRTC sense.

### 6.2 WebRTC signaling fit
- **Same-device (multi-tab) calls:** works — `BroadcastChannel` delivers in order, ~ms latency; use for dev, demos, and same-browser multi-preview.
- **Multi-device calls:** ❌ sync latency (seconds) and eventual consistency are unacceptable for SDP offer/answer handshake. If you must: write SDP to a `signals` table and **poll** on a 200–500 ms interval on the remote side, with heartbeats for presence — a degraded but functional mode.
- **Rate/payload:** no message caps (it's a local file / Hrana requests); document size effectively unlimited for our use.

### 6.3 Presence / reactions / chat
- Same-device: BroadcastChannel-based presence + reactions (local, instant).
- Multi-device: heartbeat rows in SQLite synced via Turso sync (presence updates lag the sync interval); chat rows sync the same way.
- Everything is durable locally (offline-first is a genuine strength here).

### 6.4 Auth, pricing, performance
- **Auth:** local = none; Turso Cloud = JWT bearer tokens scoped to a database with read/write permissions; no user-management platform.
- **Pricing:** Turso free tier — 100 databases / 5 GB storage (per [turso.tech/pricing](https://turso.tech/pricing)); Developer $4.99/mo; Scaler from ~$24.92/mo. Self-host `sqld` free.
- **Performance:** reads are ~µs locally; writes round-trip to the primary when using embedded replicas (tens–hundreds of ms).

> **Recommendation:** ship the SQLite adapter as the **default in-memory/test backend and same-device demo mode**; document multi-device as "polling mode, not recommended for production calls."

**Sources:** [@libsql/client](https://www.npmjs.com/package/@libsql/client) · [TS SDK reference](https://docs.turso.tech/sdk/ts/reference) · [Embedded Replicas](https://docs.turso.tech/features/embedded-replicas/introduction) · [Turso pricing](https://turso.tech/pricing) · [BroadcastChannel (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel)

---

## 7. Appwrite

**Package:** `appwrite@26.2.0` (3.10 MB).

### 7.1 Realtime model
- WebSocket-based Realtime API: subscribe to **channels** for `account`, `databases.<dbId>.collections.<colId>.documents[.<docId>]`, and `files`. ([Subscribe docs](https://appwrite.io/docs/apis/realtime/subscribe))
- **One WebSocket per client, many subscriptions** — the SDK manages a single socket and drives subscriptions with messages; `subscribe(channels, cb)`, `subscription.update(...)` (switch channels without reconnect), `unsubscribe()`, `realtime.disconnect()`. ([message-based SDK announcement](https://appwrite.io/blog/post/announcing-message-based-realtime-sdk))
- **Direction: server → client only.** Events fire when backend state changes (documents created/updated/deleted, account changes, file events). There is **no client-to-client broadcast** and **no presence primitive** — the realtime RFC explicitly scoped 2-way communication out.

### 7.2 Limits (verified from [Appwrite changelog: Realtime usage limits](https://appwrite.io/changelog/entry/2026-03-19))
| Limit | Free | Pro |
|---|---|---|
| Messages | 2,000,000 / month | 6,000,000 / month |
| Concurrent connections | 250 | 500 |
| **Max message size** | **256 KB** | **3 MB** |
| Overage | $2.50 per 1M messages; $5 per 1,000 connections | |

### 7.3 WebRTC signaling fit
- **Emulate signaling with document events:** clients write SDP/ICE into a `signals` collection (`{roomId, from, kind, payload, seq}`) and subscribe to `databases.main.collections.signals.documents` (optionally per-document with `queries`). Remote clients receive the event callback with the new doc.
- 256 KB message ≫ SDP/ICE; no chunking needed. Ordering per document follows commit order; cross-writer ordering → use `seq`.
- Latency: WebSocket push from a regional Appwrite Cloud endpoint; low but region-dependent; self-host for on-prem latency control.
- Rate: message-volume billing means noisy trickle streams cost money — coalesce ICE candidates (batch per 100–200 ms) and throttle reactions.

### 7.4 Presence / reactions / chat
- **Presence:** none native → heartbeat-document pattern (each client upserts `presence/{room}/{user}` every ~5 s with `lastSeen`; a cron or lazy read treats stale entries as offline). No `onDisconnect` equivalent.
- **Reactions:** doc writes (counts) or rely on event push to animate then expire client-side.
- **Chat:** `messages` collection + realtime subscription; paginated and durable.

### 7.5 Auth, pricing, performance
- **Auth:** email/password, magic URL, OAuth, phone, JWT sessions; per-document **permissions** (role-based read/write) gate who can see signaling docs — solid fit for private rooms.
- **Pricing:** Free $0 (5 GB bandwidth, 2 GB storage); Pro from $25/mo. ([Appwrite pricing](https://appwrite.io/pricing)) Realtime message volume is metered — a chatty app can exceed 2M msgs/mo.
- **Performance:** fine for signaling; keep message volume down (coalescing, server-side Realtime queries to filter events).

**Sources:** [Realtime subscribe](https://appwrite.io/docs/apis/realtime/subscribe) · [How Appwrite Realtime works](https://appwrite.io/blog/post/appwrite-realtime) · [Message-based SDK](https://appwrite.io/blog/post/announcing-message-based-realtime-sdk) · [Realtime limits changelog](https://appwrite.io/changelog/entry/2026-03-19) · [Pricing](https://appwrite.io/pricing)

---

## 8. Firebase (Realtime Database + Firestore)

**Package:** `firebase@12.16.0` (36.67 MB unpacked — **modular**: import `firebase/app`, `firebase/database`, `firebase/firestore`; tree-shaking keeps the used subset small).

### 8.1 Realtime model
- **Realtime Database (RTDB):** full-duplex push over WebSockets; **offline-first** (local cache, sync on reconnect); every write at a path is pushed to all listeners (`onValue`, `onChildAdded`, …). Native **presence primitives**: `.info/connected` + `onDisconnect()` writes run *server-side* on any disconnect (clean or crash). ([offline capabilities](https://firebase.google.com/docs/database/web/offline-capabilities))
- **Firestore:** realtime `onSnapshot` listeners on documents/collections/queries; offline persistence; strong consistency per document; **no native presence** — official guidance is to mirror RTDB presence via Cloud Functions. ([Firestore presence](https://firebase.google.com/docs/firestore/solutions/presence))

### 8.2 Limits (verified from [RTDB limits](https://firebase.google.com/docs/database/usage/limits) & [Firestore quotas](https://firebase.google.com/docs/firestore/quotas))
| Limit | RTDB | Firestore |
|---|---|---|
| Concurrent connections | **200,000** (Spark: 100) | — (listener-based) |
| Write rate | ~1,000 writes/s (soft) | 20,000 writes/day free |
| Single write size | 16 MB (SDK) / 256 MB (REST) | doc ≤ **1 MiB** |
| Bytes written | 64 MB/min | — |
| Depth / key / string | 32 levels / 768 B keys / 10 MB strings | field name ≤ 1,500 B |
| Responses/sec | ~100,000 | — |
| Free tier | 1 GB stored, 10 GB/mo transfer | 1 GiB, 50 k reads/day, 20 k writes/day |
| Latency | ≤ 10 ms typical (regional) | regional, ms-class |

### 8.3 WebRTC signaling fit
- **RTDB is a superb signaling plane:** write `rooms/{id}/signals/{seq}` (or use `push()`), listen with `onChildAdded`; **per-path ordering is guaranteed** for sequential writes; 16 MB write cap and ~1,000 writes/s are far above needs. Presence is native.
- **Firestore** also works (1 MiB doc cap ≫ SDP); `onSnapshot` on a `signals/{roomId}` doc — but you must serialize offer/answer/candidates as a single-doc log (append-only array or subcollection) because per-field updates on the same doc are the unit of atomicity. Subcollection-per-room + `onSnapshot` of latest N is the cleaner pattern.
- Trickle bursts: no message-rate cap per client beyond write rate — safe.
- Latency: single-digit-to-tens of ms in-region; RTDB is regional (choose region near users or use the global Firestore backend).

### 8.4 Presence / reactions / chat
- **Presence:** RTDB native (`onDisconnect` + `.info/connected` — the canonical presence system); Firestore: mirror via Cloud Functions, or heartbeat + TTL (Firestore has no onDisconnect).
- **Reactions:** RTDB: set/delete a `reactions/{key}` child (listeners get add/remove); Firestore: doc field update or subcollection.
- **Chat:** RTDB `push()` per message; Firestore subcollection + `orderBy('ts').limit(50)` snapshot.

### 8.5 Auth, pricing, performance
- **Auth:** Firebase Auth (email, OAuth, phone, anonymous, SSO); **security rules** (RTDB rules / Firestore rules) enforce per-path read/write — the authz model for private rooms.
- **Pricing:** Spark (free): RTDB 100 connections / 1 GB stored / 10 GB transfer per month, Firestore 1 GiB + 50 k reads + 20 k writes per day; Blaze: pay-as-you-go (storage, egress, and connections metered — confirm current rates in the Firebase console at implementation time).
- **Performance:** 200 k concurrent connections is the highest ceiling of any backend here; 1,000 writes/s soft cap per database (shard by room if ever needed).

**Sources:** [RTDB limits](https://firebase.google.com/docs/database/usage/limits) · [RTDB offline/presence](https://firebase.google.com/docs/database/web/offline-capabilities) · [Firestore quotas](https://firebase.google.com/docs/firestore/quotas) · [Firestore presence](https://firebase.google.com/docs/firestore/solutions/presence)

---

## 9. Other backends worth noting

| Option | Package (pin) | Model | Signaling fit | Notes |
|---|---|---|---|---|
| **Redis Pub/Sub** | `ioredis@5.11.1` | fire-and-forget pub/sub; no persistence, no replay | Server-side yes (via Node bridge); **browsers need a ws bridge** (your own, or Centrifugo) | 512 MB default message cap (`proto-max-bulk-len`); ordering per publisher over a connection; presence via sorted sets/heartbeats; a *transport*, not a BaaS — pairs well with Postgres for durable state |
| **Ably** (managed) | `ably@2.26.0` | global edge pub/sub + **presence** + history | Excellent — 64 KB messages, 500 msg/s free | Free: 6 M msgs/mo, 200 conns, 200 channels ([limits](https://ably.com/docs/platform/pricing/limits)); commercial alternative to building your own bridge |
| **Pusher Channels** (managed) | `pusher-js@8.6.0` | pub/sub + presence channels | OK — **10 KB event cap** (chunking protocol exists); presence channels (100 members/cap) | Free tier: 100 conns / 200 k msgs/day; event triggers go through the server API — heavier for P2P signaling |
| **Centrifugo** (self-host) | `centrifuge@5.7.0` | open-source Go realtime server: channels, **presence**, history, recovery | Very good — the standard self-hosted ws bridge for Postgres/Redis | Claims up to 700 k msg/s (protobuf); PRO adds rate limits/analytics ([repo](https://github.com/centrifugal/centrifugo)) |
| **LiveKit** | (out of scope for adapters) | full WebRTC **SFU** with built-in signaling + media | Different architecture: if you adopt an SFU, signaling is provided; vidcall's adapters target P2P/self-hosted media | Mentioned for completeness — not a `SignalingBackend` implementation target |
| **PartyKit / Cloudflare Durable Objects** | `partykit@0.0.115` (stale) | serverless realtime via Durable Objects | Possible future adapter; project direction changed (Cloudflare acquisition) | Not pursued now — revisit later |

---

## 10. Unified adapter interface (implementation blueprint)

Single TS interface in `packages/backends/src/types.ts`; every backend implements it. Design goals: rooms, ordered SDP exchange, presence, ephemeral reactions, pluggable chunking/ordering.

```ts
// packages/backends/src/types.ts

/** A message exchanged within a room. `kind` is app-defined: 'offer' | 'answer' | 'ice' | 'reaction' | 'chat' | ... */
export interface SignalingMessage {
  kind: string;
  payload: unknown;          // e.g. { sdp } or { candidate, sdpMid, sdpMLineIndex }
  from: string;              // peer id (client-generated, stable per session)
  seq?: number;              // per-sender monotonic sequence (adapters fill if backend lacks ordering)
  ts: number;                // client clock, ms epoch
}

export interface PresenceUser {
  id: string;
  data: Record<string, unknown>; // { name, muted, camOn, ... }
  lastSeen: number;
}

export interface JoinedRoom {
  room: string;
  users: PresenceUser[];
}

export type Unsubscribe = () => void;

export interface SignalingBackend {
  readonly name: string;                 // 'supabase' | 'convex' | 'postgres' | 'sqlite' | 'appwrite' | 'firebase'
  readonly ordering: 'guaranteed' | 'seq-required';
  readonly maxPayloadBytes: number;      // adapter enforces chunking below this

  join(room: string, opts?: { self?: PresenceUser }): Promise<JoinedRoom>;
  leave(room: string): Promise<void>;

  /** Fire a message at the room (offer/answer/ice/reaction/chat). */
  emit(room: string, msg: SignalingMessage): Promise<void>;

  onMessage(room: string, cb: (msg: SignalingMessage) => void): Unsubscribe;
  onPresence(room: string, cb: (users: PresenceUser[]) => void): Unsubscribe;
  setPresence(room: string, data: Record<string, unknown>): Promise<void>;

  dispose(): Promise<void>;
}

// ---- helpers used by adapters (packages/backends/src/internal/) ----
// chunker.ts      – split >maxPayloadBytes into {chunkId, index, total} parts + reassembly
// reorder.ts      – per-sender seq buffer; emits SDP only in order, ICE immediately
// heartbeat.ts    – presence heartbeat (5 s default) + stale sweep for backends without onDisconnect
// coalescer.ts    – batch ICE candidates (e.g. 100 ms window) for rate-limited backends (Supabase Free)
```

**Adapter matrix (per-backend caveats):**

| Backend | `emit` maps to | Presence via | Ordering | Chunking needed? | Notes |
|---|---|---|---|---|---|
| Supabase | `channel.send({type:'broadcast', event: kind, payload})` | native `channel.track()` | `seq-required` (cross-publisher) | no (256 KB) | coalesce ICE for Free 100 msg/s |
| Convex | `mutation('signals:send')` → `signals` table | `@convex-dev/presence` or heartbeat query | `guaranteed` (serialized mutations) | no (16 MiB) | room doc + signals collection |
| Postgres | `NOTIFY room_channel, payload` | heartbeat table + NOTIFY | `guaranteed` per session; `seq` across sessions | **yes — 8 KB cap** (7 KB chunks or store-and-reference) | dedicated LISTEN client; browser ws bridge |
| SQLite | BroadcastChannel post (same-device) / poll table (multi-device) | BroadcastChannel heartbeat / sync rows | `guaranteed` same-device | no | multi-device = polling mode, documented as degraded |
| Appwrite | create doc in `signals` collection → realtime event | heartbeat doc + cron sweep | `seq-required` | no (256 KB) | no client broadcast; one-way push |
| Firebase | RTDB `set/push` at `rooms/{id}/signals` (or Firestore doc) | RTDB `onDisconnect` + `.info/connected` | `guaranteed` per path | no (16 MB / 1 MiB) | Firestore: use subcollection-per-room for chat, doc-log for signaling |

**Adapter test matrix** (per CONTRIBUTING: every adapter runs the shared test matrix): join/leave events · SDP offer/answer round-trip ordering · ICE trickle burst (30 msgs) · presence join/leave/expiry · reaction fan-out · payload-over-limit chunking round-trip (Postgres) · disconnect/reconnect recovery · 2 concurrent rooms.

---

## 11. Final comparison table

| Criterion | Convex | Supabase | PostgreSQL | SQLite/Turso | Appwrite | Firebase RTDB |
|---|---|---|---|---|---|---|
| Package (pin) | `convex@1.42.3` | `@supabase/supabase-js@2.110.9` | `pg@8.22.0` | `@libsql/client@0.17.4` / `@tursodatabase/database@0.7.1` | `appwrite@26.2.0` | `firebase@12.16.0` |
| Size (unpacked) | 30.8 MB (dev) | 0.6 MB | 0.1 MB | 0.06–0.27 MB | 3.1 MB | 36.7 MB (modular) |
| Native realtime | ✅ subscriptions+mutation push | ✅ broadcast/presence/postgres_changes | ✅ LISTEN/NOTIFY | ⚠️ none (BroadcastChannel / sync) | ⚠️ one-way events | ✅ full-duplex push |
| Native presence | ⚠️ component/pattern | ✅ | ❌ (heartbeat) | ❌ (local only) | ❌ (heartbeat) | ✅ `onDisconnect` |
| Native chat | ✅ pattern | ✅ broadcast or table | ✅ table+NOTIFY | ✅ local table | ✅ collection | ✅ push()/subcollection |
| SDP/ICE payload headroom | 16 MiB | 256 KB–3 MB | **8 KB (chunk!)** | unlimited (local) | 256 KB–3 MB | 16 MB / 1 MiB doc |
| Ordering | ✅ serialized | ⚠️ seq | ✅ per session | ✅ same-device | ⚠️ seq | ✅ per path |
| Latency class | ms | <100 ms (regional) | ~ms (self-host) | µs local / s sync | <100 ms (regional) | ≤10 ms (regional) |
| Free tier (signaling-relevant) | 1M fn calls/mo, 1,000 conns | 200 conns, 100 msg/s, 256 KB | n/a (self-host) | 100 DB / 5 GB | 2M msgs/mo, 250 conns | 100 conns (Spark) |
| Paid entry | pay-as-you-go / $25/dev | $25/mo | infra cost | $4.99/mo | $25/mo | Blaze (metered) |
| Auth model | providers + custom JWT | GoTrue + RLS | your own (roles/RLS/JWT) | Turso JWT / none local | email/OAuth/JWT + permissions | Firebase Auth + rules |
| Browser direct? | ✅ | ✅ | ❌ (ws bridge) | ✅ same-device / polling | ✅ | ✅ |
| Self-hostable | ✅ (community) | ✅ | ✅ (it's Postgres) | ✅ (`sqld`) | ✅ | ❌ (GCP-only) |
| Effort to implement adapter | low | **lowest** | medium (chunking+bridge) | low (demo mode) | medium (doc-event emulation) | low |

**Implementation order (suggested):** 1) Supabase (reference adapter — broadcast+presence native), 2) Postgres (proves chunking/ordering helpers), 3) Convex, 4) Firebase RTDB, 5) Appwrite, 6) SQLite (dev/test). Both 1+2 give the two-implementation proof required by CONTRIBUTING.md early.

---

## 12. Open questions / verify at implementation time

1. Re-check pin publish dates on the day of implementation (several packages ship weekly; the policy pins shift).
2. Supabase broadcast ordering: confirm Phoenix pubsub behavior for same-publisher ordering over a single socket (assumed FIFO per publisher; verify with the `supabase/realtime` server source before trusting `seq`-less mode).
3. Ably free-tier connection limits changed over time — re-verify from [ably.com/docs/platform/pricing](https://ably.com/docs/platform/pricing) if we add it as an adapter.
4. Firebase RTDB pricing moved toward "usage-based" (Spark/Blaze) — confirm current numbers in the Firebase console at implementation time.
5. Turso sync engine (`@tursodatabase/sync`) is still young (v0.x) — re-verify stability before relying on it for the multi-device mode.
