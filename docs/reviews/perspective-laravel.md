# vidcall — Laravel-ecosystem perspective review

Reviewed: 2026-08-25 · Scope: how this TypeScript video-calling library would be
adopted by, and integrated with, the Laravel/PHP ecosystem. Read-only review;
only this file was written.

Evidence base (files actually read for this review):

- `integrations/LARAVEL.md`, `RAILS.md`, `DJANGO.md`, `EXPRESS.md`, `DATABASES.md`, `README.md`
- `packages/server/src/{auth.ts,http.ts,ws.ts,services.ts,store.ts,types.ts,errors.ts,express.ts}`
- `packages/server/src/stores/{PostgresStore,MysqlStore}.ts`
- `packages/server/README.md`, `examples/server/server.mjs`
- `protocol/schema.json`, `protocol/types.ts`, `protocol/fixtures/*` (+ `fixtures/README.md`)
- `packages/core/src/{room.ts,transport.ts}` (client-side expectations)
- `packages/backend-postgres/src/PostgresBackend.ts` (LISTEN/NOTIFY + presence pattern)
- `docs/testing.md` (L0/L1/L2), `docs/reviews/dx.md` (format precedent)
- Kotlin L0 suite: `packages/kotlin/vidcall-protocol/src/test/kotlin/io/vidcall/protocol/EnvelopeSerializationTest.kt`

---

## TL;DR

The Laravel story today is **one guide (`integrations/LARAVEL.md`) and zero PHP
code**. The guide's architecture (Node sidecar behind nginx) is the right call
for the current codebase, but it contains a real bug (`storage_path()` used in
plain Node), a latent correctness gap that affects every integration (the
documented REST→WS fan-out via `Services.relay` is **never wired** in
`attachWebSocketRelay`), and none of the things a Laravel dev will look for:
Reverb, queues/events, scheduled cleanup, rate limiting, config file, artisan
commands, or a composer package.

The highest-leverage move for Laravel adoption is small: **a minimal,
zero-dependency PHP SDK (`vidcall/php`) that mirrors `auth.ts` token minting +
the envelope DTOs from `protocol/fixtures`, plus an L0 conformance suite**.
That turns Laravel from "proxy author" into "first-class integrator." A full
Reverb transport is the strategic endgame (pure-PHP stack, no Node ops) but is
an L-sized adapter build with real ordering/replay risks to validate.

---

## 1. `integrations/LARAVEL.md` — critical read

### 1.1 What it gets right

| Guidance | Verdict |
|---|---|
| Sidecar pattern as default | Correct. Nothing PHP exists in this repo (grep confirms zero PHP/composer files); `@mbsks/openrtc-server` is Node-only. |
| nginx `location /vidcall/` + WS upgrade block | Correct and matches `DJANGO.md`; trailing-slash `proxy_pass` correctly strips the prefix so `/vidcall/rooms/:id/join` → `/rooms/:id/join`. |
| Auth flow description | Accurately reflects the code: `adminToken` header guards `POST /auth/token` (`packages/server/src/http.ts:278-285` accepts `adminToken` or `x-admin-token`); tokens are room-scoped + identity-bound (`auth.ts`, guards in `http.ts:123-148`); `?token=` on `/ws` verified at join (`ws.ts:201-231`), close code 4401. |
| "Keep your policies first line of defense" | Right instinct; matches the design intent in `services.ts` (`AuthConfig`). |
| Honesty about per-process WS hub | Good — it does not overclaim horizontal scaling ("pin /ws to one instance or move to a shared pub/sub relay later"). |

### 1.2 Bugs and footguns (must fix)

1. **`storage_path('vidcall.db')` inside `sidecar.mjs` (line 25).**
   `storage_path()` is a Laravel PHP helper; it does not exist in Node. Every
   reader who copies this gets `ReferenceError`. Note `DJANGO.md:26` uses a
   real path (`/var/lib/vidcall/vidcall.db`) — Laravel should do the same.

2. **Two `createServices({ store })` calls (lines 27–28) — and neither gets a
   relay.** See §1.3 below; the second Services object passed to
   `attachWebSocketRelay` is not the one the REST handlers use, and even if it
   were, the relay is never attached (repo-wide bug, not a guide bug).

3. **CSRF will kill Option B.** The proxy route is shown without context; if
   registered in `routes/web.php` (as the comment suggests), every non-GET
   request from the vidcall client JS fails with Laravel's 419 unless the path
   is exempted in `VerifyCsrfToken::$except` (or the route uses
   `WithoutMiddleware`). The guide never mentions CSRF. This is the single most
   likely "it doesn't work" moment for a Laravel dev.

4. **Header forwarding is too naive.** `$request->headers->all()` forwards
   hop-by-hop headers (`host`, `connection`, `content-length`) into an
   `Http::withHeaders(...)` call; `content-length` will mismatch once Guzzle
   rewrites the body. Whitelist `authorization`, `content-type`,
   `x-chunk-index` instead.

5. **Recording uploads through the PHP proxy are a trap.**
   `POST /recordings/:sessionId/chunks` takes raw octet-stream bodies up to
   64 MiB (`http.ts:429 maxBodyBytes`, `express.ts:76 limit 64mb`). Routing
   those through php-fpm buffers them in PHP memory and dies on
   `post_max_size`. The guide should explicitly route recording paths straight
   to the sidecar in nginx and only proxy JSON through Laravel.

### 1.3 Repo-level bug found while auditing the guide (affects all hosts)

`packages/server/src/ws.ts:25-26` claims *"RoomHub doubles as `Services.relay`,
so REST mutations fan out to the same connected sockets"* and
`packages/server/README.md:196` repeats it — but **nothing ever assigns
`services.relay`**. `attachWebSocketRelay()` constructs the `RoomHub` locally
and returns it as `handle.hub` (`ws.ts:129,168-178`); grep across
`packages/server` finds no `.relay =` assignment outside doc comments. Tests
work because they grab `relay.hub` directly (`test/ws.test.ts:242`).

Consequence for Laravel specifically: any server-driven flow — a queue worker
injecting a signal via `POST /rooms/:id/signal`, or an admin closing a room —
persists state but **never reaches connected WS peers**. Pure client-over-WS
signaling still works (that path broadcasts via the local `hub` inside
`handleMessage`), which is why tests are green. Fix is ~2 lines in
`attachWebSocketRelay` (accept the `Services` object and set
`services.relay = hub`, or return the hub for the caller to attach) plus making
all guides share one `createServices(...)` instance.

### 1.4 What's missing entirely (the list a Laravel dev expects)

| Missing item | Why it matters |
|---|---|
| **Reverb** | Zero mentions. Reverb ships with Laravel 11+ and is the idiomatic WS layer; readers will ask "why can't I use my existing Reverb?" (see §3b). |
| **Queue-driven lifecycle events** | No events exist on either side: `@mbsks/openrtc-server` emits no webhooks/events, and the guide defines no Laravel listeners. Room lifecycle can only be observed by polling `GET /rooms/:id/state`. |
| **Scheduled cleanup** | `vidcall_signals` is append-only with no GC anywhere in the repo; participants leak rows if the sidecar dies mid-call (auto-leave happens only on socket `close`, `ws.ts:347-366`). No `schedule:run` recipe, no retention guidance. |
| **Rate limiting** | No `throttle:` middleware on the token-minting route — an authenticated user can hammer `POST /vidcall-token` and burn HMAC work / fill the signal log via joins. |
| **Horizon/Octane considerations** | One bullet about Octane reloads. Nothing about: supervising the sidecar under Forge (`daemons`), systemd/supervisor units (Django's guide has one!), Octane worker-safe HTTP client usage, or Horizon job examples. |
| **config/vidcall.php** | Snippets use `process.env` (JS side, fine) and `config('vidcall.admin_token')` (PHP side) without defining where that config comes from or its shape. |
| **CORS & Sanctum semantics** | Not discussed at all. `createNodeServer` sends **no CORS headers** (`http.ts:474-477` writes only `content-type`), so dev-from-Vite against `:8787` fails without a dev-server proxy. Sanctum SPA-cookie mode vs bearer-token mode implications for the minting endpoint are unstated. |
| **Testing story** | No `Http::fake()` recipes, no CI pattern for running the sidecar, no contract test tying Laravel's minted tokens to the TS verifier. |
| **Process management** | No systemd unit / Forge daemon / Docker snippet for keeping the sidecar alive (DJANGO.md has a systemd unit; LARAVEL.md has nothing). |

**Verdict:** directionally correct, operationally incomplete, two copy-paste
bugs, one repo-wide wiring bug discovered beneath it. Grade for a Laravel
developer today: usable skeleton, not production guidance.

---

## 2. The PHP SDK question — spec for `vidcall/php`

There is currently **no PHP anywhere in the repo**. That's fine for the wire
contract (it is language-agnostic JSON per `protocol/schema.json`), but the
L0-conformance pattern proves the intended expansion path:
`EnvelopeSerializationTest.kt` reads *the same fixture files* as Swift/Dart/TS
(`protocol/fixtures/README.md`: "single source of truth… parsed by the Swift,
Dart, and TS-core conformance suites"; `docs/testing.md` L0 row). A PHP binding
slots straight into that model.

### 2.1 Package layout

Recommend **two packages**, one repo each (or splitsh from this monorepo):

- `vidcall/protocol-php` — zero-runtime-dep DTOs + codec + token primitives.
  Mirrors `protocol/types.ts`. Depends on `ext-json` only.
- `vidcall/laravel` — service provider, facade, config, migrations, commands
  (§5). Depends on protocol-php + PSR-18 (via `php-http/discovery`).

(If one package only: name it `vidcall/vidcall`; `vidcall/php` is legal
Packagist but reads oddly.)

PHP ≥ 8.2 (readonly classes, enums, first-class callable syntax), covered
against Laravel 10/11/12 via `orchestra/testbench` (see §5 compat matrix).

### 2.2 MUST ship in v0.1

**(a) Token minting/verification — port of `packages/server/src/auth.ts`.**
This is the single most valuable function: it lets Laravel mint room-scoped
tokens *locally*, removing the network hop through `POST /auth/token` and the
need to expose `adminToken` beyond server-to-server use. The algorithm is fully
specified by `auth.ts` and must be mirrored exactly:

- Compact form: `base64url(header).base64url(payload).base64url(signature)`
- Header `{"alg":"HS256","typ":"JWT"}` (alg allow-list enforced — `auth.ts:155`)
- Claims `{ roomId, participantId, role: 'participant'|'admin', exp, iat }`,
  **epoch seconds** (`DEFAULT_TOKEN_TTL_SECONDS = 3600`, `auth.ts:53`)
- HMAC-SHA256, constant-time compare → PHP `hash_equals()`
- Error taxonomy must match: `unauthorized` (401), `token_expired` (401),
  `forbidden` (403) — same strings as `errors.ts:23-27`

```php
$token = Vidcall::issueToken(secret: $secret, roomId: 'standup',
    participantId: (string) $user->id, role: TokenRole::Participant);
$claims = Vidcall::verifyToken($secret, $token); // throws TokenExpiredException etc.
```

**(b) Envelope DTOs + tolerant codec — generated/hand-written from
`protocol/schema.json` + `protocol/types.ts`.**

Wire rules to honor (schema.json description block): unknown fields ignored;
unknown `type` ignored + logged, decode MUST NOT fail; `ping`/`pong` carry **no
payload key** (verified in `protocol/fixtures/ping.json`); `seq` ≥ 0;
`targetSenderId` optional.

```php
enum MessageType: string {
    case Join = 'join'; case Leave = 'leave'; case Offer = 'offer';
    case Answer = 'answer'; case Ice = 'ice'; case Presence = 'presence';
    case Reaction = 'reaction'; case Chat = 'chat';
    case ScreenShare = 'screen-share'; case QualityWarning = 'quality-warning';
    case Sfu = 'sfu'; case Error = 'error';
    case Ping = 'ping'; case Pong = 'pong';
}

final class Envelope {
    public function __construct(
        public readonly int $v,                    // const 1
        public readonly MessageType $type,
        public readonly string $roomId,
        public readonly string $senderId,
        public readonly string $sessionId,
        public readonly int $ts,                   // epoch ms
        public readonly int $seq,                  // >= 0
        public readonly ?string $targetSenderId = null,
        public readonly ?array $payload = null,    // typed per $type, see below
    ) {}
}
```

Payload mapping table (schema `definitions.*` → PHP):

| Schema definition | PHP shape (readonly class, public props) |
|---|---|
| `JoinPayload` | `displayName?:string, metadata?:array, deviceProfile?:DeviceProfile, capabilities?:JoinCapabilities{simulcast?,svc?,codecs?:string[]}` |
| `DeviceProfile` | `hardwareConcurrency:int, deviceMemory?:float, mobile:bool, screenWidth?:int, screenHeight?:int, platform?:Platform` (platform enum adds `'php'` upstream discussion) |
| `LeavePayload` | `reason?:string` |
| `OfferPayload` (offer **and** answer) | `sdp:string, label?:string` |
| `IcePayload` | `candidate:string, sdpMid?:?string, sdpMLineIndex?:?int` |
| `PresencePayload` | `state:'online'|'away'|'busy'|'offline', metadata?:array` |
| `ReactionPayload` | `emoji:string, targetSenderId?:string, ts?:int` |
| `ChatPayload` | `text:string (≤4000), replyTo?:{senderId,seq}` |
| `ScreenSharePayload` | `action:'start'|'stop', label?:string` |
| `QualityWarningPayload` | `from:string, to:string, reason:enum(network,cpu,device,manual,recovery), direction:enum(send,receive)` |
| `SfuPayload` | `action:enum(publish,subscribe,layer-change,keyframe-request,leave), trackId?, kind?(audio/video/screen), senderId?, layer?` |
| `ErrorPayload` | `code:string, message:string` |

Encoder detail worth a test: when `payload === null` (ping/pong), **omit the
key** rather than emit `"payload": null`.

**(c) L0 conformance suite (PHPUnit/Pest) reading `protocol/fixtures/*.json`.
** Mirror `EnvelopeSerializationTest.kt`: parse all 22 fixtures
(`join` … `chat-targeted` + `ping`/`pong`), assert headers, semantic re-encode
equality, targeted/broadcast distinction, ping/pong key omission. Logistics:
composer packages can't reach `../../protocol/fixtures`, so sync fixtures at
release time (`scripts/sync-fixtures.mjs` copying into
`resources/fixtures/`, committed) or fetch them in CI before the PHP job — the
Kotlin build solves it with a gradle test-resource dir pointing at the repo
path, which composer cannot do.

**(d) PSR-18 REST client covering the dispatch surface of
`packages/server/src/http.ts:356-368`.**

- Methods: `createRoom`, `joinRoom`, `leaveRoom`, `signal(roomId, Envelope)`,
  `closeRoom`, `deleteRoom`, `getRoomState`, `listRecordings`,
  `uploadChunk`, `finalizeRecording`, `issueTokenViaServer` (the HTTP fallback
  for teams that prefer the sidecar to hold the secret).
- Inject any PSR-18 client + PSR-17 factories; autodiscover via
  `php-http/discovery` so Laravel devs need zero new deps (Guzzle is already
  everywhere).
- Errors: map `{error:{code,message,details}}` to typed exceptions keyed on
  the stable codes in `errors.ts:11-30` (`RoomNotFoundException`,
  `RoomFullException`, …) — these codes are a de-facto public API.

**(e) Server-side admin helpers** built on the above with the `adminToken`
header: create/close/delete rooms, roster reads — everything a controller or
scheduled command needs to manage rooms without touching the data plane.

### 2.3 Explicitly NOT v0.1 (can wait)

- **A full WebSocket client** (Workerman / Ratchet Pawl / amphp/websocket-client
  / ReactPHP). Browsers are the WS clients; the only server-side use case is
  injecting signals from PHP. That works **today** via `POST /rooms/:id/signal`
  from a queued job — no persistent connection needed. Revisit only when
  someone needs PHP-originated realtime push into rooms; then prefer an Amp
  long-lived worker whose lifecycle Horizon manages poorly anyway.
- **Eloquent-backed Store equivalent — with a precision warning:** the TS
  `Store` contract (`store.ts:38-60`, ~13 methods) is executed *inside the Node
  server*; PHP literally cannot implement it there. The realistic Laravel
  equivalents are: (i) **REST admin via adminToken** (recommended default), or
  (ii) **shared-database co-tenancy**: run Laravel migrations that create the
  identical `vidcall_*` schema (Postgres recommended; SQLite sharing between
  better-sqlite3 WAL and pdo_sqlite is possible but locking-risky —
  `DATABASES.md` notes WAL "for multi-process"), letting Eloquent read/GC the
  sidecar's tables directly. Support (ii) as a documented power option, not the
  default.
- Recording storage in PHP, presence sweeping in PHP, SFU anything.

### 2.4 Replay protection (PSR-16) — design note

Tokens carry **no `jti` and there is no revocation** anywhere in `auth.ts`.
That's acceptable for short-TTL room tokens. If PHP-side verification becomes
load-bearing (e.g., validating a token presented by another internal service),
add an *optional* `jti` claim + PSR-16 cache denylist checked in
`verifyToken()` (cache tag per roomId, TTL = remaining token lifetime). Do not
put replay state on the hot browser path; document it as opt-in. Nonce replay
is otherwise irrelevant because every mutation goes through the sidecar's own
state machine (`participant_already_joined`, seq dedupe in the engine).

---

## 3. Signaling topology for Laravel apps

Three candidate architectures:

### (a) PHP signaling endpoint bridging to the TS/Rust server
Laravel routes own join/signal; PHP calls sidecar REST per message.
- ✅ All auth/policy logic stays in Laravel; one process family to reason about.
- ❌ Data-plane latency: every offer/ICE costs a full php-fpm round trip
  (50–200 ms + queueing under load) versus a persistent WS frame (<5 ms).
- ❌ Long-poll/SSE fan-out to browsers doesn't fit php-fpm's process model.
- ❌ Blocked on the §1.3 relay bug: REST-injected signals don't reach WS peers.
- **Verdict: reject for the data plane; keep only as control plane** (token
  minting + room admin), which is what the current guide effectively does.

### (b) Reverb / Pusher-protocol as transport
Write a `SignalingTransport` adapter (`packages/core/src/transport.ts:29-44`
contract) speaking Pusher channels (via laravel-echo/pusher-js) to Reverb.
Channel auth rides Laravel's normal `broadcast/auth` (Sanctum/session aware);
presence channels give native presence; Redis-backed horizontal scaling is a
first-class Reverb feature.
- ✅ **Zero Node processes to operate.** The most Laravel-native possible stack;
  auth, scaling, and deployment all reuse Laravel primitives.
- ✅ Fits the architecture: "backends stay dumb… engine owns
  ordering/idempotency/glare" (`schema.json` description; `transport.ts:1-12`).
- ⚠️ Message size: Pusher-protocol messages cap around 10 KB; SDP offers fit,
  but bursts need the existing chunker/coalescer
  (`@mbsks/openrtc-transport` helpers — chunker, reorder, heartbeat, ICE coalescer,
  root `README.md:98`; `backend-postgres` demonstrates chunked frames against a
  7000-byte cap in `PostgresBackend.ts:29-33,147-159`).
- ⚠️ Client-event rate limits (whisper-style sends) must be validated against
  ICE trickle bursts; Reverb self-host limits are configurable, cloud Pusher
  less so.
- ❌ **No durable signal log / replay.** `@mbsks/openrtc-server` persists envelopes
  (`putSignal`/`listSignals(since)`) so late/cold clients can catch up;
  Reverb is fire-and-forget. The mesh engine tolerates lossy transports by
  design (`OrderedMessageBuffer`, perfect-negotiation renegotiation), and the
  shipped Supabase/Firebase adapters are similarly non-durable — but this needs
  explicit validation through `packages/transport/src/shared-tests.ts` plus a
  dedicated "join-before-subscribe race" test before anyone trusts it.
- Effort: **L** (new backend package + echo wiring + L1 suite pass + docs).

### (c) Sidecar beside Laravel behind the same domain (current recommendation)
What `LARAVEL.md` describes: nginx routes `/vidcall/` + `/ws` to the Node
sidecar; Laravel mints tokens.
- ✅ Works today with shipped code; keeps media signaling off PHP; same-origin
  means cookies/CORS stay trivial.
- ✅ Durable log, recordings, admin API all included.
- ❌ One more process to deploy/monitor (mitigated by Forge daemons/systemd).
- ❌ Multi-instance WS requires sticky sessions **today** because `RoomHub` is
  an in-process `Map` (`ws.ts:58-98`) — the `Relay` seam exists
  (`services.ts:39-48`) but no Redis implementation ships.
- Effort: **S** to adopt now (plus the §1 fixes).

### Tradeoffs table

| Criterion | (a) PHP bridge | (b) Reverb transport | (c) Sidecar (nginx) |
|---|---|---|---|
| Signal latency | High (per-request) | Low | Lowest (persistent WS) |
| Ops burden | Low | **Lowest** (no Node) | Medium (extra daemon) |
| Horizontal scale | n/a (rejected) | Built-in (Redis) | Sticky sessions until Redis Relay exists |
| Presence | Poll state endpoint | Native presence channels | Disconnect-derived leave (`ws.ts:347`) |
| Durability / replay | Full (sidecar store) | None — engine-only tolerance | Full |
| Auth model | Laravel policies + adminToken | Laravel channel gates (Sanctum-native) | Dual: Laravel policy + HMAC room token |
| CORS/cookies | Same-origin | Same-origin | Same-origin via nginx; direct sidecar needs added CORS (none sent today) |
| Exists today | Partially (relay bug) | **No — must be built** | Yes (`LARAVEL.md`) |
| Effort | M (and wrong tool) | L | S now, M later for Redis Relay |

### Recommendation

**Primary path: (c)** — it is the only topology that works with code that
exists, and it isolates risk. **Investment path: (b)** — fund the
`backend-reverb` adapter as the flagship "pure-Laravel" story; it eliminates
the #1 objection (running a foreign runtime) and reuses Laravel's auth/scaling.
Keep (a) strictly as the thin control-plane proxy it already is. Regardless of
topology: put both processes behind **one origin** (cookies and Sanctum SPA
mode keep working untouched; the sidecar never sees Laravel sessions, its HMAC
tokens are independent), and add opt-in CORS + a `/healthz` to
`createNodeServer` for cross-origin dev (Vite `server.proxy` also solves dev).

Scaling honesty checklist for docs: sticky LB until a Redis `Relay` ships;
presence derived from socket close is instant-but-lossy on crash (pair with a
scheduled stale-participant sweep — §6 item 4); the Postgres client backend's
heartbeat+sweeper pattern (`PostgresBackend.ts` presence table + 15 s stale
timeout) is the reference design if presence sweeps move server-side.

---

## 4. Store parity: SQL schemas vs. Eloquent migrations

What ships (verified):

- **Postgres** (`PostgresStore.ts:28-53`): 4 tables (`vidcall_rooms`,
  `vidcall_participants`, `vidcall_signals`, `vidcall_recordings`), JSONB
  documents, composite PKs `(room_id, participant_id)` /
  `(room_id, seq)` with `BIGINT GENERATED ALWAYS AS IDENTITY`.
- **MySQL** (`MysqlStore.ts:21-44`): same shape, `JSON` columns,
  `AUTO_INCREMENT` on a table-global `seq`.
- **Contract rules** (`DATABASES.md:41-58`): JSON documents round-trip
  verbatim; Store assigns seq atomically; `listSignals(roomId, since)`
  ascending; async uniformity.

Portability verdict: **pragmatic and portable**. Everything maps cleanly to
Laravel Blueprints:

```php
// database/migrations/xxxx_create_vidcall_tables.php (power-option co-tenancy)
Schema::create('vidcall_rooms', function (Blueprint $t) {
    $t->string('room_id', 191)->primary();
    $t->json('room_json');                       // jsonb on PgSQL automatically
    $t->unsignedBigInteger('created_at_ms')->index();
    $t->unsignedBigInteger('updated_at_ms');
    $t->string('state', 16)->default('open')->index(); // extracted for GC
});
Schema::create('vidcall_participants', function (Blueprint $t) {
    $t->string('room_id', 191);
    $t->string('participant_id', 191);
    $t->json('participant_json');
    $t->unsignedBigInteger('last_seen_at_ms')->index(); // extracted: staleness sweeps
    $t->primary(['room_id', 'participant_id']);
});
Schema::create('vidcall_signals', function (Blueprint $t) {
    $t->bigIncrements('seq');                    // AUTO_INCREMENT / identity parity
    $t->string('room_id', 191)->index();
    $t->json('envelope_json');
    $t->unsignedBigInteger('received_at_ms');    // epoch-ms BIGINT, matches wire ts
});
Schema::create('vidcall_recordings', function (Blueprint $t) {
    $t->string('session_id', 191)->primary();
    $t->string('room_id', 191)->index();
    $t->json('recording_json');
});
```

Notes and honest caveats:

- **JSON vs normalized: keep documents, extract hot scalars.** Normalizing
  payloads (SDP blobs, free-form `metadata`) buys nothing and invites drift
  between PHP and TS shapes — `DATABASES.md` rule 1 exists precisely because
  deep-equality tests compare nested metadata verbatim. But the shipped schemas
  index *nothing* lifecycle-relevant except room keys, so a Laravel migration
  (which owns GC) should add the three extracted columns shown above. This is
  additive and doesn't violate round-tripping.
- **Seq semantics drift worth documenting (not fixing):** SQLite uses true
  per-room `MAX(seq)+1` in a transaction; Postgres identity and MySQL
  AUTO_INCREMENT are **table-global counters** — per-room monotonicity still
  holds (monotonic subsequence), gaps appear, and the engine tolerates gaps
  (dedupe/reorder per sender/session per `schema.json` wire rule). But
  `DATABASES.md:49-50` says identity gives "per-room monotonic automatically,"
  which overstates it; one clarifying sentence would prevent someone
  "optimizing" it later.
- **Eloquent ergonomics:** composite PKs aren't native to Eloquent. Recommend
  plain query-builder repositories (or models with `protected function
  setKeysForSelectQuery()` overrides and no auto-increment assumptions) over
  fighting the ORM; `$casts = ['room_json' => 'array']` covers the rest.
- MySQL `TEXT PRIMARY KEY` in the TS stores vs `VARCHAR(255)` in the MySQL
  schema — Laravel's default 191-char strings are safe across utf8mb4 index
  limits; keep ids ≤191 chars in validation guidance.

---

## 5. DX the Laravel way (what `vidcall/laravel` should feel like)

**`config/vidcall.php`** (published by `vendor:publish`):

```php
return [
    'sidecar_url' => env('VIDCALL_SIDECAR_URL', 'http://127.0.0.1:8787'),
    'secret'      => env('VIDCALL_SECRET'),          // HMAC key, mirrors services.ts AuthConfig.secret
    'admin_token' => env('VIDCALL_ADMIN_TOKEN'),     // server-to-server issuance credential
    'token_ttl'   => env('VIDCALL_TOKEN_TTL', 3600), // seconds, mirrors DEFAULT_TOKEN_TTL_SECONDS
    'route_prefix'=> 'vidcall',
    'middleware'  => ['auth:sanctum'],               // applied to the token-mint route
    'throttle'    => '20,1',
    'gc'          => ['stale_participant_minutes' => 10, 'closed_room_days' => 7],
];
```

**Facade surface** (`Vidcall::*`): `mintToken(roomId, participantId, role?)`,
`verify(token)`, `createRoom(...)`, `closeRoom(id)`, `deleteRoom(id)`,
`roomState(id)`, `signal(id, Envelope)` — thin PSR-18 calls resolved from the
container; `mintToken`/`verify` are pure-local (no HTTP) per §2.2a.

**Artisan commands worth shipping:**

| Command | Purpose |
|---|---|
| `vidcall:install` | Publish config + migrations + a runnable `sidecar.mjs` stub + nginx location block + supervisor/Forge daemon snippet; prints next steps. Directly fixes §1.2 bugs by generating correct files instead of docs to copy. |
| `vidcall:room:gc {--before=}` | Delete closed rooms past N days, participants stale > M minutes (re-enqueue leave), trim signal logs; `withoutOverlapping()` scheduler entry. The append-only `vidcall_signals` table makes this mandatory, not nice-to-have. |
| `vidcall:room:close {roomId} {--delete}` | Admin wrapper over `POST /rooms/:id/close` / `DELETE /rooms/:id`. |
| `vidcall:healthcheck` | Curl the sidecar (needs the missing `/healthz` — roadmap) for use in Forge deploy hooks / k8s probes. |

**Event/listener extension points** (fire from the SDK after successful admin
calls; webhook ingestion once the server can emit them):
`VidcallRoomCreated`, `VidcallRoomClosed`, `VidcallRoomDeleted`,
`VidcallTokenIssued`, and (webhook-era) `VidcallParticipantJoined/Left`.
Queued listeners then handle notifications ("your meeting started"), billing
meters, and CRM sync — the natural Laravel integration surface, currently
impossible without polling `GET /rooms/:id/state` (the server emits no events
today — roadmap item 7).

**Testing story:**

- `VidcallFake` implementing the facade contract in-memory (rooms, assertable
  token mints, canned errors) — modeled on the repo's own
  `FakeTransport.kt`/`InMemoryTransport` philosophy.
- `Http::fake()` recipes for the sidecar client in the README.
- Contract test option: a Pest suite that runs the real sidecar binary in CI
  (node available on runners) and replays `protocol/fixtures` through
  `POST /rooms/:id/signal`, asserting relay behavior — the L2-style glue the
  testing matrix anticipates (`docs/testing.md`).

**Compat matrix:** PHP `^8.2` · Laravel `^10.0|^11.0|^12.0` (Laravel 10
supports PHP 8.1+, so ^8.2 is safe across all three) · `orchestra/testbench`
^8/^9/^10 per Laravel major · PHPUnit ^10|^11 or Pest ^2/^3 · `ext-json` ·
PSRs: 4 (autoload), 7/17/18 (HTTP), 11 (container), 12 (style), 16 (cache,
opt-in replay guard), 3 (logger). Test against sqlite in-memory; mark
pg/mysql suites env-gated like `VIDCALL_TEST_POSTGRES_URL` in
`packages/server/test`.

---

## 6. Prioritized roadmap (impact-ranked)

| # | Deliverable | Effort | Reuse / pointers |
|---|---|---|---|
| 1 | **Fix `Services.relay` wiring** (REST mutations reach WS peers) + make all guides share one `createServices` instance | **S** | `packages/server/src/ws.ts` (`attachWebSocketRelay` sets `services.relay ??= hub`), guides at `integrations/LARAVEL.md:27-28`, `EXPRESS.md` (already shares the instance), `packages/server/README.md:196` claim becomes true |
| 2 | **Ship `vidcall/php` v0.1**: token mint/verify + envelope DTOs + PSR-18 client + error taxonomy | **M** | Port logic from `packages/server/src/auth.ts`; shapes from `protocol/schema.json` + `protocol/types.ts`; codes from `src/errors.ts:11-30`; routes from `src/http.ts:356-368` |
| 3 | **Rewrite `LARAVEL.md` as a complete guide**: fix `storage_path` bug, CSRF exemption, header whitelist, recording-path bypass, throttle, supervisor/Forge unit, Sanctum/CORS section, config file | **S/M** | Model sections on `DJANGO.md` (systemd unit) and `RAILS.md` (Action-Calcable-style "how Rails pushes in" note → Laravel queue example) |
| 4 | **`vidcall/laravel` package**: provider, facade, config, migrations (extracted GC columns), `vidcall:install` + `vidcall:room:gc` + scheduler | **M/L** | Migration sketch §4; schema parity sources `stores/PostgresStore.ts`, `stores/MysqlStore.ts`; GC rationale §1.4 |
| 5 | **L0 conformance suite for PHP reading canonical fixtures** | **S** (inside #2) | `protocol/fixtures/README.md` naming rules; mirror `packages/kotlin/.../EnvelopeSerializationTest.kt`; fixture-sync script for composer logistics |
| 6 | **`backend-reverb` transport adapter** (Pusher-protocol over laravel-echo/pusher-js) passing the shared adapter suite + race test | **L** | Implement `SignalingTransport` per `packages/core/src/transport.ts:29-44`; validate via `packages/transport/src/shared-tests.ts`; reuse chunker/coalescer patterns from `packages/backend-postgres/src/PostgresBackend.ts`; root `README.md` backend table gains a 7th entry |
| 7 | **Optional event emission from `@mbsks/openrtc-server`** (webhook POST or Redis pub/sub on join/leave/close/delete) → drives Laravel queued listeners without polling | **M** | Hook points already exist where handlers mutate state (`http.ts` joinHandler/leaveHandler/closeRoomHandler); `Services` is the natural place for an `onEvent` callback (`services.ts:50-60`) |
| 8 | **Sidecar ops polish**: opt-in CORS, `/healthz`, docker-compose example (laravel + sidecar + postgres), Redis-backed `Relay` implementation behind the existing interface | **S + M** | `http.ts:436-441` (`createNodeServer` headers), `services.ts:39-48` (`Relay` seam), `ws.ts:58-98` (`RoomHub` to wrap); removes the sticky-session caveat in `LARAVEL.md:126-127` |

Items 1–3 are the adoption floor: without the relay fix, the bridge topology
silently loses server-driven messages; without the guide fixes, the first hour
of every Laravel evaluation hits a 419 or a ReferenceError; without the SDK,
every team hand-rolls HS256 in PHP and drifts from `auth.ts`.

---

## What exists vs. what must be built (summary ledger)

**Exists and is solid:** the wire contract (`schema.json` + 22 fixtures),
HMAC room-token design (`auth.ts`), the full REST/admin surface (`http.ts`),
four stores + shared test suite (`DATABASES.md`), framework-agnostic hosting
seams (`services.ts` `Relay`/`AuthConfig`), honest multi-host docs including a
working-if-thin Laravel guide.

**Does not exist (must be built for Laravel):** any PHP code (SDK, package,
tests), Reverb/echo transport, Redis `Relay`, server-side event emission,
`/healthz` + CORS options, Laravel-flavored lifecycle management (GC,
scheduled cleanup, queue listeners), and the LARAVEL.md corrections listed in
§1.2. The `Services.relay` fan-out described in `ws.ts`/README is documented
but unimplemented — the one finding here that reaches beyond Laravel.
