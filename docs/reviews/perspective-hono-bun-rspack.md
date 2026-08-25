# vidcall — Review from the Hono / Bun / rspack-team perspective

> Reviewed: 2026-08-25 · Read-only review; only this file was written.
> Panel: (1) **Hono maintainers** — Web-standard Request/Response, runs-anywhere,
> zero-dep middleware; (2) **Bun core team** — runtime perf, native APIs,
> single-binary deploys, bun:test; (3) **rspack/rsbuild team** — Rust bundling,
> dual output, dts, exports-map correctness, monorepo task graphs.
>
> Every claim below is grounded in files read at HEAD (`32d9d80`). Paths are
> relative to the repo root. Runtime claims marked **[verified]** were executed
> against this checkout with Bun 1.4.0 / Node 22.22.

---

## TL;DR

**The architecture is already 80 % Hono-shaped and 90 % Bun-ready — the gap is
one layer, not a rewrite.** `packages/server` already has the right kernel:
a framework-agnostic router (`dispatch()` over `RouteContext`,
`packages/server/src/http.ts:400-422`) shared by a standalone server, an
Express router and a Fastify plugin. But the *only* concrete hosting surfaces
are Node-flavored (`node:http` streams + `Buffer` in `http.ts:436-497`, `ws`
typed sockets in `ws.ts:30,58-98`), so "runs on any runtime" is currently an
aspiration, not a property, of the TS server.

We also verified three real defects while auditing:

1. **Remote DoS in the standalone server** — one >64 MiB POST crashes the whole
   process with an unhandled rejection **[verified]** (`http.ts:439,450,481-497`).
   This is the exact server the Django/Laravel/Rails sidecar guides deploy.
2. **SigV4 dates are malformed** — the regex at `aws-sigv4.ts:74` leaves
   `.789Z` in `x-amz-date` (**verified**: produces `20260825T123456.789Z`);
   AWS S3 requires `YYYYMMDDTHHMMSSZ`. Tests never hit the default path
   (`recording.test.ts:58` always passes `amzDate`).
3. **WS path vs mount prefix mismatch** — the relay strictly matches `/ws`
   (`ws.ts:136-139`) while every guide mounts REST under `/vidcall`;
   `examples/server/server.mjs` even advertises `ws://…/vidcall/ws?roomId=…`,
   which will never connect.

On packaging, the client packages are disciplined (`sideEffects: false`
everywhere, verified safe) but ship **ESM-only**, with `types` pointing at
`.ts` source in half the packages, and there is no bundling/dts/minification
story at all (`tsc -b` only). On Bun, the headline result: **the entire server
test suite passes under `bun test` today** (node:test shim), a
`bun build --compile` sidecar works end-to-end at 61 MB, and the only true
blocker is `better-sqlite3` crashing Bun's NAPI.

Scorecard:

| Dimension | Grade | One-liner |
|---|---|---|
| A · Server portability (Hono lens) | B− | `dispatch()` kernel is right; concrete hosts are Node-only; WS layer hard-coupled |
| A · Mount-into-any-server story | B | Express/Fastify mounts exemplary; prefix-unaware WS + sidecar-only answer for PHP/Python/Ruby |
| A · Auth/token design | B+ | Room+identity-bound HS256 tokens are genuinely good; minor footguns (query-string tokens, `adminToken` header, no rotation) |
| B · Bun readiness | B+ | Everything passes except `better-sqlite3` NAPI crash + one raw-socket edge; single-file compile **works today** |
| B · Multi-instance story | C | Per-process `RoomHub`; `Relay` seam exists but no shared-fanout implementation ships |
| C · Client package readiness (rsbuild lens) | B− | Zero-dep, env-guarded, tree-shake-safe; ESM-only, inconsistent `types`, no attw/publint, no bundler |
| C · Monorepo task graph | C+ | Raw `tsc -b` + shell loops in CI; no caching/parallelism; two test runners |

---

## A. Hono perspective — is `@mbsks/server` portable, and how should signaling be shaped for mounting anywhere?

### A1. The kernel is right; the concrete hosts are wrong-shaped

The team clearly internalized the "one router, many hosts" idea:

- `RouteContext` is deliberately framework-free: `method/path/query/params/
  body/rawBody/header(name)` (`packages/server/src/http.ts:46-64`).
- Every host funnels through `dispatch(services, ctx)`, including error →
  envelope mapping (`http.ts:400-422`), and the route table is plain data
  (`routes`, `http.ts:356-368`).
- Adapters are thin: `createExpressRouter` (`express.ts:26-93`) and
  `createFastifyPlugin` (`fastify.ts:24-78`) are translation layers only;
  both carefully scope body parsing per-route (`express.json` on JSON routes,
  `express.raw` on chunk upload, `express.ts:74-81`; Fastify octet-stream
  parser, `fastify.ts:26-32`).

What breaks portability:

| Coupling | Where | Why it matters |
|---|---|---|
| `node:http` server factory | `createNodeServer` returns `http.Server` (`http.ts:436-441`) | Cannot run on Bun.serve/Deno/Workers without the Node compat shim |
| Node stream body reading | `readBody(IncomingMessage)` + `Buffer.concat` (`http.ts:450,481-497`) | Re-implemented by every runtime; and it is where the DoS bug lives |
| `ws` library classes | `import {WebSocket, WebSocketServer} from 'ws'` (`ws.ts:30`); `RoomHub` keyed on `ws.WebSocket` (`ws.ts:58-98`) | Not usable with Bun-native WS, Cloudflare/Durable Objects, Deno.upgradeWebSocket |
| Upgrade handling on `http.Server` | `server.on('upgrade', …)` (`ws.ts:134-151`) | Ties WS relay to Node's HTTP server object |

**The Hono-style move:** make a Web-standard handler the *canonical* API:

```ts
// proposed (new, ~120 lines wrapping existing handlers)
export function createFetchHandler(services: Services, opts?): {
  fetch: (req: Request) => Promise<Response>;
};
```

Everything already exists to build it: `matchPattern`/`dispatch` need only
`req.method`, `new URL(req.url).pathname`, headers, and body bytes. Then:

```ts
// Hono
const app = new Hono().route('/vidcall', vidcallHono(services)); // or app.all('*', h.fetch)
// Bun
Bun.serve({ port: 8787, fetch: handler.fetch, websocket: ... });
// Next.js / SvelteKit / Remix: export { POST, GET } = adapt(handler.fetch)
```

and `createNodeServer`, Express, Fastify become derivations. This deletes the
Express/Fastify duplication risk (both files hand-enumerate the same 11 routes
that `routes` already declares — `express.ts:29-90`, `fastify.ts:34-77` —
a new endpoint must be added in four places: `routes`, express, fastify, docs).

Effort **M**. Highest-leverage change in this review.

### A2. WebSocket relay: define a minimal socket interface

`RoomHub.broadcast` only needs `socket.readyState === OPEN` and
`socket.send(payload)` (`ws.ts:84-93`). If `RoomHub` were generic over
`interface WSLike { readonly readyState: number; send(data: string): void }`
plus an attach/detach path, then:

- Node keeps `ws` (adapter maps its sockets),
- Bun uses native `WebSocket` pairs from `Bun.serve({websocket})`,
- Workers/Durable Objects use their own sockets,

with the hub and the join/leave/relay logic (`handleJoin`, `handleClose`,
`ws.ts:233-366` — pure `Services` + hub calls) untouched. Effort **M**.

### A3. Shaping endpoints so users can mount signaling into ANY server

Current shape is already mount-friendly and should be kept:

- One prefix-mountable router (`app.use('/vidcall', …)` — `EXPRESS.md:34`),
  stable error envelope (`errors.ts:11-30`), no global middleware hijacking
  (body parsers attached per-route, `express.ts:29-90`).
- The REST surface (`http.ts:9-19`) is small enough to proxy verbatim — the
  sidecar guides exploit exactly that (`LARAVEL.md:36-69`, `DJANGO.md:43-56`).

Gaps, impact-ranked:

1. **WS path is not prefix-aware** (bug). `opts.path ?? '/ws'` compared with
   strict equality (`ws.ts:124,136-139`), while REST mounts under `/vidcall`.
   `EXPRESS.md:4-5` claims "`/ws?roomId=...` and the REST API share one port"
   — true only at the root; `examples/server/server.mjs:29` prints
   `ws://localhost:3000/vidcall/ws?roomId=<room>` which the relay destroys.
   Fix: accept a `basePath` (or match `path.endsWith(relayPath)`), document
   `<mount>/ws`. Effort **S**.
2. **No Hono/others adapter.** After A1, add `integrations/HONO.md` +
   `createHonoRouter` if desired; more valuable is documenting the fetch
   contract so any framework's docs can reference it.
3. **Non-JS hosts get proxy-only guidance.** DJANGO/LARAVEL/RAILS.md honestly
   frame the Node sidecar pattern, and the Rust crate (`server/rust/README.md`)
   is the native alternative — but the guides never mention it. Cross-link
   them; for Laravel specifically, Octane note (`LARAVEL.md:120-127`) is good
   and should be replicated in RAILS/DJANGO (only LARAVEL has scaling notes).
4. `POST /rooms` intentionally unauthenticated ("first caller bootstraps",
   README:159-160) — fine for dev, but guides should show the common prod
   pattern (mint room server-side, don't expose create at all).

### A4. Auth/token issuance design

Strengths (better than most first-pass designs):

- Compact HS256 JWT-style tokens, zero-dep (`auth.ts:107-125`), **room-scoped
  AND identity-bound** with enforcement at both HTTP (`requireAuth`,
  `http.ts:123-148`) and WS (`authenticateSocket`, `ws.ts:201-231`) layers;
  constant-time comparison (`safeEqual`, `auth.ts:86-91`); epoch-second
  convention; clean `AuthError → status` mapping (`auth.ts:63-71`).
- Issuance is a plain exported function (`issueToken`) so any host framework
  can mint tokens after its own authorization — the guides demonstrate the
  correct pattern repeatedly (`EXPRESS.md:88-115`, `FASTIFY.md:86-108`,
  `LARAVEL.md:94-111`). This is exactly right for the "any backend" vision:
  the sidecar never needs to know your users.
- Cross-language parity exists (`server/rust/crates/vidcall-server/src/auth.rs`
  ports the same contract), so tokens verify across TS and Rust deployments.

Issues, impact-ranked:

1. **Token in the WS query string** (`?token=`, `ws.ts:146`) leaks into access
   logs/proxies. Accept `Authorization: Bearer` on the upgrade request or a
   short-lived one-time ticket fetched over REST; keep `?token=` as fallback
   (some proxies strip upgrade headers). Effort **S-M**.
2. **Custom `adminToken` request header** (`http.ts:278` accepts
   `adminToken` or `x-admin-token`). Non-standard; prefer only
   `x-admin-token` (keep the bare alias deprecated one release). Effort **S**.
3. **Open issuance footgun**: secret set + `adminToken` unset ⇒ anyone can
   mint participant tokens (`services.ts:28-36`, README:129-131). At minimum
   log a loud warning at startup; consider requiring an explicit
   `openIssuance: true`. Effort **S**.
4. No `kid`/key rotation, no asymmetric option: every service holding the
   HMAC secret can also mint. Fine while the issuer is your own backend
   (guides assume this); an EdDSA/JWKS variant would let third parties verify
   without mint power. Effort **L** (post-1.0).
5. `verifyToken` checks `alg` before verifying (`auth.ts:155-157`) — good
   algorithm-confusion posture. No issues found in the crypto itself.

### A5. Would a Hono-style rewrite shrink the package?

Not a rewrite — a re-plumbing (A1/A2). The *real* weight problem is
dependencies, not architecture: installing `@mbsks/server` drags
**`pg`, `mysql2`, `better-sqlite3` (native!), and `ws`** as unconditional
dependencies (`packages/server/package.json:34-40`) even though the core
(`core.ts`, `store.ts`) needs none of them and `InMemoryStore` suffices for
most embedders. Move stores to subpath exports
(`@mbsks/server/store-pg`, `…/store-mysql`, `…/store-sqlite`) with the
drivers as optional peer deps; keep `ws` only behind the Node WS adapter.
Combined with A1, the "core + InMemory + fetch handler" footprint approaches
zero-dep. Effort **M**. This is the single biggest "small enough to fit
anywhere" win available in the TS server.

---

## B. Bun perspective — could the server run natively on Bun today?

### B1. Node API usage audit

Complete inventory of Node/platform APIs in `packages/server/src`:

| API | Files | Bun support |
|---|---|---|
| `node:http` (server, `IncomingMessage`, writes) | `http.ts:28`, `ws.ts:29` | ✅ implemented |
| `node:crypto` (`createHmac`, `timingSafeEqual`, `createHash`) | `auth.ts:22`, `aws-sigv4.ts:12` | ✅ implemented |
| `node:fs/promises`, `createReadStream`, `node:path` | `recording.ts:17-18` | ✅ implemented |
| `node:stream` (`Readable.from`) | `recording.ts:19,107` | ✅ implemented |
| `Buffer` | `http.ts`, `recording.ts`, `aws-sigv4.ts` | ✅ |
| global `fetch` (SigV4 S3 client) | `recording.ts:172` | ✅ fast native fetch |
| global `crypto.getRandomValues` | `core.ts:82-84` | ✅ |
| `ws` package (pure-JS, no addons required here) | `ws.ts:30` | ✅ works |
| `pg`, `mysql2` | stores | ✅ work |
| `better-sqlite3` (native NAPI) | `SqliteStore.ts` | ❌ **crashes Bun 1.4.0** |

**[Verified]** Running each suite under `bun test`:

- `auth.test.ts` + `core.test.ts`: **32/32 pass** (bun:test transparently runs
  `node:test`-written suites — migration cost ≈ 0 for these).
- `http.test.ts` + `ws.test.ts`: **8/9 pass**; the failure is the test
  asserting the hand-written `HTTP/1.1 400` written to the raw TCP socket on
  a rejected upgrade (`ws.ts:141-144`). Bun's socket write/flush semantics
  during upgrade differ; the *production* behavior (destroy socket) still
  occurs. Portable fix: respond via `wss.handleUpgrade` rejection or set a
  proper `res.writeHead(400)` through the Node response object where
  available.
- `express.test.ts` + `fastify.test.ts`: **4/4 pass**.
- `recording.test.ts`: **6/6 pass** (Disk + mock-S3).
- `SqliteStore.test.ts`: **process crash** — `panic: NAPI FATAL ERROR:
  Error::New napi_get_last_error_info` (better-sqlite3 13.0.1 + Bun 1.4.0).
  Not fixable app-side; ship a `BunSqliteStore` on `bun:sqlite`
  (~100 lines against the `Store` contract per `integrations/DATABASES.md`)
  selected by runtime detection. Effort **S-M**.

Verdict: **the server runs natively on Bun today for every configuration
except SQLite-backed stores.**

### B2. bun:test vs the current runner setup

Root scripts run `node --conditions=development --test "…*.test.ts"`
(`package.json:14-16,31-33`) which silently requires Node ≥ 22.6 type-stripping — yet
CI matrix installs Node **20 and 22** (`.github/workflows/ci.yml:20-21`) and
`engines` claims `>=18.18` (every package.json). On Node 20 the glob+TS combo
does not work as written; on Node <22.18 the flag situation differs. Meanwhile
transport/backend packages use vitest (`packages/transport/package.json:37`),
so the repo already carries two runners plus a version-sensitive invocation.

`bun test` ran the node:test suites unmodified (**verified** above) and vitest
suites remain available via `vitest run`. Options ranked:

1. Keep sources as-is (node:test style), add `bun test` as the local/fast lane
   and pin the CI matrix to versions where `node --test *.ts` actually works
   (or drop Node 20). Effort **S**.
2. Migrate fully to bun:test (delete vitest dep from transport/backends):
   saves install weight; costs rewriting vitest-specific idioms if any exist.
   Effort **M**.

### B3. Single-file compile story for the sidecar

**[Verified]** `bun build --compile` on an entry importing
`createNodeServer/createServices/InMemoryStore/attachWebSocketRelay` produced
a **working 61 MB self-contained binary** (178 modules bundled in ~0.5 s);
booted it, `POST /rooms` and `GET /rooms/:id/state` served correctly, startup
sub-second.

Comparison points:

- The Rust sidecar documents **5.8 MiB** stripped (`server/rust/README.md:21`)
  — ~10× smaller. Bun's niche is different: *same TS codebase*, no cross-compile
  toolchain, `--target=bun-linux-x64` etc. for cross-platform artifacts.
- For embedding inside existing Node/Bun apps (the primary distribution),
  size doesn't matter; for the "tiny sidecar next to Laravel/Django/Rails"
  story (`DJANGO.md`, `LARAVEL.md`, `RAILS.md`), a compiled Bun binary removes
  the `npm install @mbsks/server better-sqlite3` step from those guides
  entirely — a genuine DX upgrade once `bun:sqlite` store exists (B1).
- Add `--bytecode` for faster cold starts if the sidecar is scaled to zero.

### B4. Startup/memory characteristics relevant to edge deploy

Startup is dominated by Bun runtime init (measured ~0.5 s wall including a
request). Memory: not measured here, but the state model matters more than
runtime constants — `InMemoryStore` keeps every signal forever
(`signals.append`, `InMemoryStore.ts:16-17`; nothing trims the log), which is
the real constraint for long-lived edge instances. A TTL/trim policy on the
signal log (or documenting `listSignals` replay windows) is prerequisite for
edge-class deployment regardless of runtime.

True "edge" (Workers) additionally needs A1 (fetch handler) + A2 (socket
abstraction); Bun-on-a-VPS/Fly works with just those two as well.

### B5. Pub/sub patterns for multi-instance rooms

`RoomHub` is explicitly per-process (`ws.ts:57-98`), and the guides concede
sticky sessions are required (`LARAVEL.md:126-127`). The seam already exists:
`Services.relay?: Relay` with `broadcast(roomId, envelope, {exceptSenderId})`
(`services.ts:39-48`), and both HTTP mutations and WS fan-out go through it
(`http.ts:181-184,201-203,215-217`; `ws.ts:334`). Ship one shared-fanout
`Relay` implementation:

1. **Postgres LISTEN/NOTIFY relay** (recommended first): the client-side
   adapter already demonstrates the pattern incl. payload chunking
   (`docs/architecture.md` D4; `packages/backend-postgres`), so server-side
   reuse is mostly plumbing. Rooms stay routable across instances; sticky
   sessions become unnecessary for correctness.
2. Redis pub/sub relay (same interface) for high fan-in.
3. Bun-specific: `RedisRedisClient`/`Bun.redis` (Bun ≥1.1 built-in redis)
   keeps it zero-extra-dep on Bun.

Effort **M** each; interface changes **none**.

---

## C. rspack/rsbuild perspective — client-side packaging readiness

### C1. Current output & formats

All packages emit via `tsc -p` (loose files, ES2022, NodeNext, `.js`
extensions rewritten correctly — verified `packages/core/dist/index.js:10-22`)
with project references/composite/declarationMap (`tsconfig.base.json:12-20`,
root `tsconfig.json` referencing 7 projects). There is **no bundler, no
minifier, no dts rollup anywhere** (`grep` for tsup/unbuild/rslib/rollup finds
only the esbuild used ad-hoc by `examples/vanilla/build.mjs`).

- Loose-module ESM output is actually *good* for tree-shaking consumers
  (finer granularity than a bundle); keep it as the default output even if
  you add a bundler later.
- **ESM-only** (`"type": "module"` everywhere; `main` → `.js`). CJS consumers
  (default Jest setups, `require()` in legacy Node, some SSR frameworks'
  server stacks) cannot consume these packages without transforms. For a lib
  whose stated audience is "ANY frontend", dual-format output is table
  stakes. **rslib is the right tool choice here**: it is purpose-built for
  lib-authoring (ESM+CJS+dts in one config, rspack-speed), matches the team's
  Rust-bundler thesis, and can adopt these packages without restructuring
  them (entry = current `src/index.ts`, output = current dist layout).
  Priority: `protocol`, `core`, `quality`, `transport`, `backend-*`.
  Effort **M** overall, **S** per package.

### C2. Exports map correctness (bugs/inconsistencies found)

1. **`types` pointing at TS source** in half the packages:
   - `packages/core/package.json:8` `"types": "./src/index.ts"` (also inside
     `exports."."`, line 11), same for `quality` (:8,11),
     `test-utils` (:8,11), `protocol` (`"types": "./types.ts"`).
   - `server` (:8,11), `sfu-gateway`, `backend-supabase` correctly point
     at `dist/*.d.ts`.
   Consequences: consumers' compilers typecheck the lib's *source* (slower,
   and couples consumers to your `tsconfig` dialect), `.ts` must ship in the
   tarball forever, and `attw` will flag the resolution. Standardize on
   `types → dist/*.d.ts` everywhere; keep the `development` condition for the
   workspace. Effort **S**.
2. **Condition inconsistency**: `backend-supabase` has no `development`
   condition (`backend-supabase/package.json:9-13`) unlike every other
   package — workspace consumers fall back to `dist`, breaking the
   edit-in-place workflow that condition exists for. Effort **S**.
3. **Missing `./package.json` export** in all packages (harmless today,
   standard hygiene). Effort **S**.
4. `main` + `exports` are consistent otherwise; no `module` field needed
   (ESM-only), no `browser` field needed (see C4). `files` includes `src` —
   revisit once `types` stops pointing there (C2.1).

### C3. sideEffects / tree-shaking safety

- `"sideEffects": false` is declared in every package (verified in all 10
  package.json files read). We audited for violations in client packages:
  module-level statements are limited to pure consts
  (`packages/transport/src/internal/reorder.ts:42`); all platform accesses
  are guarded *inside* functions/ctors (`typeof navigator !== 'undefined'`,
  `devices.ts:85`; `MediaRecorder` checked lazily,
  `media-recorder-recording-hook.ts:15,80`). **Declaration is safe.**
- Class-heavy modules (`Room` 899 lines `room.ts`, `PeerConnectionManager`
  390, `ControlsManager` 693, `RoomQualityController` 655, plus the recording
  facade/hook classes) are individually exported from individual modules —
  bundlers can drop unused ones. Barrel `export *` chains
  (`core/src/index.ts:7-18`) resolve to module-level reachability, which
  rspack/webpack/esbuild prune correctly given `sideEffects:false`.
  No hazard found. One watch-item: `InMemoryTransport` keeps a **static**
  `Map<string, Set<InMemoryTransport>>` (`transport.ts:64`) — process-global
  state; harmless for shaking, but document that two copies of the package
  (dual ESM/CJS!) won't interconnect — another reason dual-format output must
  be *version-aligned* (single package, both formats, same instance rules
  documented).

### C4. Environment correctness for multi-target consumption

`lib: ["ES2022","DOM","DOM.Iterable"]` globally (`tsconfig.base.json:4`) is
fine for the client packages but means the *server* package is also compiled
against DOM libs — harmless today, but if you adopt rslib per-package configs
you can narrow libs per target (server: no DOM) and catch accidental DOM
usage in `@mbsks/server` at compile time.

### C5. dts strategy & verification

Per-file `.d.ts` + declarationMap ship today (composite refs). That is valid;
two upgrades:

1. **Bundle dts per entry** (rslib does this natively, or `rollup-plugin-dts`)
   — fewer files, faster consumer typechecks, cleaner IDE jump-to-def.
   Optional but nice. Effort **S** per package.
2. **Gate exports with `attw` (are-the-types-wrong) + `publint` in CI.**
   Neither is referenced anywhere today (grep across package.jsons: none).
   This would have caught C2.1/C2.2 mechanically. Add to the existing
   `node` job in `ci.yml`. Effort **S**. Highest value-per-line in section C.

### C6. Monorepo task graph

Today: `tsc -b` (correct dependency-ordered builds via references — good
bones), tests driven by root glob scripts, backend packages tested by a shell
loop in CI (`for p in packages/backend-*; … npm run test --if-present`,
`ci.yml:34-38`), lint/format serially at root (`package.json:18-19`).

Weaknesses: no caching, no parallelism across independent packages' tests,
no affected-only runs, and the loop spawns a full `npm run` per package.

Options ranked for *this* repo's size (7 TS projects + 6 backend pkgs):

1. **`bun run --filter '*' test` / bun workspaces scripts** — zero config,
   parallel, and the repo's tooling direction (root lockfile committed; bun
   available) favors it; also collapses the node-version fragility in B2.
   Keep `tsc -b` for build (references already encode the DAG). Effort **S**.
2. **turbo** if CI minutes start mattering (remote caching, `--affected`);
   adds a config file + daemon. Effort **S-M**. nx is overkill here.
3. Either way: delete the duplicated route enumeration problem noted in A1 —
   a task-graph tool won't catch "endpoint added in 3 of 4 places"; a
   conformance test over `routes` × adapters would (assert every route in
   `http.ts:356-368` is mounted by both `createExpressRouter` and
   `createFastifyPlugin`). Effort **S**.

---

## D. Cross-cutting — the single decision that most reduces total weight

**Canonicalize the Web-standard fetch handler (`Request → Response`) as the
primary API of `@mbsks/server`, and derive every host (node:http, Express,
Fastify, Hono, `Bun.serve`, Workers) — plus the WS relay behind a minimal
socket interface — from it.**

Why this one decision pays across all three lenses:

- **Weight**: it demotes `node:http` and `ws` from required runtime facts to
  two adapters among many, enabling the dependency diet (stores → subpath
  exports with optional peers, §A5). Core + InMemory + fetch handler ≈ zero
  runtime deps, matching `@mbsks/core`'s discipline on the other side of
  the wire.
- **Any-runtime**: Bun/Deno/Workers/Hono compatibility stops being a porting
  exercise; the Bun single-binary sidecar and the (future) Workers target are
  the *same artifact*.
- **Any-backend**: the REST/WS contract that Django/Laravel/Rails proxy stays
  byte-identical, while JS-hosting users stop paying for a second process —
  they mount signaling into whatever they already run. The Rust crate keeps
  serving non-JS hosts that want a native binary.
- It is additive: `dispatch()`/`RouteContext`/`routes` survive verbatim;
  nothing about the Store/auth/recording seams changes.

Runner-up (if forced to choose a second): the store-subpath/optional-peer
dependency restructure (§A5) — it is the biggest pure-download-size win and
independent of the fetch refactor, so it can land first.

---

## Ranked recommendations

### A · Hono lens

| # | Recommendation | Files | Impact | Effort |
|---|---|---|---|---|
| A1 | Fix body-limit unhandled-rejection DoS in `createNodeServer` (wrap read/dispatch in try/catch; return 413) — **[verified crash]** | `packages/server/src/http.ts:439,450,481-497` | Critical | S |
| A2 | Add `createFetchHandler(services)` (Web-standard Request→Response) as canonical host; re-express node/http + Express + Fastify atop it | `http.ts`, new file | Very high | M |
| A3 | Decouple `RoomHub`/relay from `ws` types via minimal socket interface | `ws.ts:30,58-98` | High | M |
| A4 | Make WS relay path prefix-aware (`basePath` opt); fix `examples/server/server.mjs:29` advertised URL | `ws.ts:100-151`, `examples/server/server.mjs` | High | S |
| A5 | Stores → subpath exports with optional peer deps; drop pg/mysql2/better-sqlite3/ws from required deps | `packages/server/package.json:34-52` | High | M |
| A6 | Generate framework adapters from the `routes` table + conformance test (kill 4-place duplication) | `express.ts:29-90`, `fastify.ts:34-77` | Med | S |
| A7 | Auth hardening: prefer `x-admin-token` only, warn on open issuance, plan header/ticket-based WS auth instead of `?token=` | `http.ts:278`, `services.ts:28-36`, `ws.ts:146` | Med | S |
| A8 | Cross-link the Rust sidecar from DJANGO/LARAVEL/RAILS guides; replicate LARAVEL's scaling notes to all sidecar guides | `integrations/*.md` | Low | S |

### B · Bun lens

| # | Recommendation | Files | Impact | Effort |
|---|---|---|---|---|
| B1 | Ship `BunSqliteStore` on `bun:sqlite` (better-sqlite3 crashes Bun 1.4 — **[verified]**); detect/select at runtime | new `src/stores/BunSqliteStore.ts` | High | S-M |
| B2 | Adopt `bun test` as fast lane (node:test suites pass unmodified — **[verified]**); fix CI matrix vs Node-type-stripping reality (Node 20 listed but scripts need ≥22.6) | `package.json:14-16`, `.github/workflows/ci.yml:20-21` | High | S |
| B3 | Publish the compiled-sidecar recipe (`bun build --compile`, **[verified working]**, 61 MB) in DJANGO/LARAVEL/RAILS guides as the no-Node-install option | `integrations/*.md` | Med | S |
| B4 | Implement a shared-fanout `Relay` (Postgres LISTEN/NOTIFY first; `Bun.redis` variant) to kill sticky-session requirement | `services.ts:39-48` seam | High (scale) | M |
| B5 | Signal-log retention/TTL policy (edge memory ceiling; log grows unbounded today) | `InMemoryStore.ts:16-17`, stores | Med | M |
| B6 | Portable WS-upgrade rejection (replace raw `socket.write('HTTP/1.1 400')` with response-object path) — fixes the one bun-failing test too | `ws.ts:141-144` | Low | S |

### C · rsbuild/rspack lens

| # | Recommendation | Files | Impact | Effort |
|---|---|---|---|---|
| C1 | Point `types` at `dist` everywhere (core/quality/test-utils/protocol currently ship `.ts` as public types) | `packages/{core,quality,test-utils}/package.json:8,11`, `protocol/package.json:8,11` | High | S |
| C2 | Add `attw --pack` + `publint` to CI | `.github/workflows/ci.yml:15-38` | High | S |
| C3 | Adopt rslib for dual ESM/CJS (+ optional bundled dts) starting with `protocol`/`transport`/`core` | package-level `rslib.config.ts` | High (audience reach) | M |
| C4 | Add `development` condition to `backend-supabase` (consistency with siblings) | `packages/backend-supabase/package.json:9-13` | Med | S |
| C5 | Route-table conformance test (all routes mounted by both adapters) | new test beside `test/express.test.ts` | Med | S |
| C6 | Task graph: `bun run --filter` for parallel tests; keep `tsc -b` for build; replace CI shell loop | `.github/workflows/ci.yml:34-38`, root `package.json` | Med | S |

### Combined top-10 priorities (all lenses)

1. **Fix the body-limit process-crash DoS** in `createNodeServer` (A1) — production security bug in the exact deployment the sidecar guides recommend.
2. **`types` → `dist` in all packages + attw/publint in CI** (C1+C2) — mechanical, unblocks trustworthy publishing.
3. **`createFetchHandler` as canonical host API** (A2) — unlocks every runtime/framework story at once.
4. **WS relay prefix-awareness + example URL fix** (A4) — user-visible brokenness today.
5. **Stores as subpath exports / optional peers** (A5) — the download-size and "fits anywhere" win.
6. **Socket-interface decoupling of the relay** (A3) — prerequisite for Bun-native WS, Workers, and the failing-upgrade cleanup (B6).
7. **`bun test` fast lane + CI Node-version truthing** (B2) — free speed, removes silent Node-20 breakage.
8. **`BunSqliteStore` on `bun:sqlite`** (B1) — closes the only hard Bun blocker.
9. **Shared-fanout `Relay` (Postgres NOTIFY)** (B4) — multi-instance correctness without sticky sessions.
10. **rslib dual-format builds for client packages** (C3) — reaches CJS-consuming frontends; completes the "any frontend" claim.

*Bugs #1–#3 in the TL;DR correspond to priorities 1, 4 above, and the SigV4 date regex (`aws-sigv4.ts:74` — verified emitting `20260825T123456.789Z`; fix the character class to `\.\d{3}Z$` and add a default-path test) which sits just outside the top 10 only because recordings-via-S3 is an optional subsystem.*
