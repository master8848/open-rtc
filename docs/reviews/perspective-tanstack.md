# vidcall — Review from the TanStack-team perspective

> Reviewed: 2026-08-25 · Read-only review; only this file was written.
> Lens: "how would the team behind `@tanstack/query-core` + `@tanstack/react-query`,
> `@tanstack/history`, `@tanstack/store` judge this repo?" Framework-agnostic core,
> thin adapters, zero runtime deps, TypeScript-first inference, tree-shakeable ESM,
> exhaustive exports maps, fixture/conformance-driven testing, meticulous release
> hygiene.
>
> Every claim below is grounded in files read at HEAD (`638c864`). Paths are relative
> to the repo root.

---

## TL;DR

The **engine layer is genuinely TanStack-grade**: `@vidcall/core` and `@vidcall/quality`
have zero external runtime dependencies, the WebRTC seam (`peerFactory`, injected
fakes, pluggable `SignalingTransport`) is exactly how we'd isolate a platform API,
and the shared-adapter-suite idea (`packages/transport/src/shared-tests.ts`) plus the
canonical fixture corpus (`protocol/fixtures/`) is more disciplined than most
commercial SDKs manage.

The **missing half is everything we'd call the product**: there is no observable
snapshot/state layer and therefore no real adapter story — no `@vidcall/react`
package at all, just an example that hand-wires emitter callbacks into `useState`
under `<StrictMode>` with a join/leave race. There is also no release engineering
(no changesets, inconsistent exports maps), a split test-runner brain
(`node:test` vs vitest), and — surprisingly — the TS implementation never runs the
canonical L0 fixtures that Kotlin/Dart/Swift conform to.

Scorecard (TanStack lens):

| Dimension | Grade | One-liner |
|---|---|---|
| Core/adapter seam | B | Seam exists and is clean, but stops at the emitter; no observer/store layer, no adapters |
| Dependency discipline | A− | Zero-dep core/quality/transport is real; `@vidcall/server` drags native + DB deps |
| Packaging/resolution | C+ | `sideEffects:false` everywhere, but `types` → `src/*.ts` on some packages, dist on others |
| API surface | B− | LiveKit-grade naming, inconsistent event style, weak error taxonomy |
| Protocol/type sharing | A− | Schema + fixtures + targeted variants are exemplary; TS doesn't eat its own dog food |
| Testing/DX | B | Excellent fakes & shared suites; two runners, no coverage, no devtools |
| Repo hygiene/release | C | No changesets, no publish path, dangling CONTRIBUTING reference |

---

## 1. Core/adapter architecture — is the seam done the TanStack way?

### What's there

The framework-agnostic *library* boundary is real and clean:

- `packages/core` contains **zero React, zero DOM-framework, zero external imports**
  (verified: `grep` over `packages/core/src` shows only `@vidcall/*` and relative
  imports). Platform APIs are injected, not assumed: `RoomConfig.peerFactory`
  (`packages/core/src/room.ts:182`), `mediaDevices` override
  (`room.ts:160-166`), `MediaRecorder` ctor and `fetch` impl overrides
  (`room.ts:196-205`), and an injectable `debug` logger (`room.ts:226`). This is the
  `query-core` move: put every environment touchpoint behind an option so tests and
  non-DOM runtimes work without monkey-patching.
- The transport seam (`SignalingTransport`, 7 members, `packages/core/src/transport.ts:29-44`)
  is small enough to implement in an afternoon, and the engine deliberately owns
  ordering/idempotency/glare so "backends stay dumb"
  (`packages/core/src/ordering.ts`, `PeerConnectionManager` header,
  `packages/core/src/peer-connection-manager.ts:1-21`). Correct instinct: it mirrors
  how `query-core` owns cache semantics while `QueryPersistor`-style integrations stay dumb.
- `examples/vanilla/main.ts` proves the seam: a full call app with no framework.

### Where it diverges from the TanStack model

**There is no observer/store layer, so there is nothing for adapters to bind to.**
`query-core` is not "an EventEmitter you can use from React" — it is a subscribable
snapshot store (`Subscribable`, `QueryObserver.getResult()`), and the React adapter
is a thin `useSyncExternalStore` shim. vidcall's `Room` is the former, not the latter:

- Roster state is a private mutable map (`remoteById`, `room.ts:286`) exposed only via
  `getParticipants()` / `getParticipant(id)` (`room.ts:532-538`); `RemoteParticipant`
  objects are long-lived mutable class instances whose `presence`,
  `connectionState`, `publications` fields mutate in place
  (`packages/core/src/participants.ts:69-119`).
- There is no `subscribe(fn)`/`getSnapshot()` pair anywhere on `Room`. The only change
  notifications are ~20 distinct emitter events (`RoomEventMap`, `room.ts:97-142`).

Consequence: a UI consumer must reconstruct "current truth" from event deltas by
hand. `examples/react/src/App.tsx:81-82` is exactly the smell —
`room.on('participant-joined', () => setParticipants(room.getParticipants()))` plus a
second listener for `participant-left`, hoping every mutation path emits one of the
two. Any missed event = stale UI forever. This is the problem `useSyncExternalStore`
was invented to eliminate, and vidcall currently makes it unsolvable because
snapshots aren't stable values (mutable objects → referential equality lies to React).

**No React (or Solid/Vue/Svelte) adapter package exists.** The TanStack shape would be:

```
@vidcall/core        ← engine + a small subscribable state layer   (exists, minus state layer)
@vidcall/react       ← useSyncExternalStore bindings, ~200 LOC       (missing)
```

Instead the only React code in the repo is an example
(`examples/react/src/App.tsx`) that also owns the Supabase client construction
(`App.tsx:70-71`) inside an effect.

**Strict-mode double-mount is unsafe in the example.** `examples/react/src/main.tsx:7-11`
renders under `<StrictMode>`; the effect at `App.tsx:65-101` creates a Room with a
fresh random `selfId` (`App.tsx:72`), calls `room.join()` (`:94`), and cleans up with
`void room.leave()` — fire-and-forget (`:98`). In dev, mount→unmount→mount means:

1. join #1 may still be in flight when leave #1 runs (unawaited), racing presence;
2. a second Room joins with a *different* selfId, so the roster briefly shows a ghost;
3. `Room.leave()` sets `closed = true` permanently and `join()` throws afterwards
   (`room.ts:362`, `:388-390`), so "reuse the room on remount" is impossible — an
   adapter must key rooms by `(roomId, selfId)` and treat instances as disposable.
   None of this is documented or handled.

A `useRoom()` primitive needs: stable identity per config, abort/cancellation of an
in-flight `join()` (there is no `AbortSignal` option in `RoomConfig`,
`room.ts:168-227`), and idempotent teardown. Today's core API makes a correct hook
harder than it should be.

**The structural-twin transport interface.** `SignalingTransport` is declared twice —
`packages/core/src/transport.ts:29-44` and `packages/transport/src/types.ts:36-56` —
with comments explaining that TS structural typing keeps them assignable
(`types.ts:5-15`). It works today, but twins drift (this is a two-file diff away from
a silent breaking mismatch), and other-language ports get no help from TS structural
typing. We'd put the contract in the leaf package everyone already depends on
(`@vidcall/protocol`, or a `@vidcall/transport-contract`) and have core import it —
same reason `@tanstack/history` exists as a dependency-free contract package.

**Would TanStack extract a pure observable layer? Yes.** Concretely: keep
`TypedEmitter` (`packages/core/src/events.ts:16-67` — nicely implemented, emit-time
listener snapshot at `:49`) for *imperative* media events (`track`, `connection-state`),
and add a derived, immutable `RoomSnapshot` (roster array + per-participant records +
aggregate connection state + current quality tier), rebuilt on mutation, exposed via
`room.subscribe(listener)` / `room.getSnapshot()`. Everything else falls out:

- `@vidcall/react`: `useRoom(config)` = instance management; `useRoomState(selector)`
  = `useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))`.
- Dart/Kotlin/Swift ports get a `StateFlow`/`AsyncSequence` for free from the same
  snapshot stream (their clients already invent their own shapes — see §4).
- Devtools (§5) becomes trivial: render the snapshot tree.

This is the single highest-leverage architectural change available.

---

## 2. Bundle size & dependency discipline

### Runtime deps audit (from `package.json` files + import grep)

| Package | Runtime deps | External runtime deps | Verdict |
|---|---|---|---|
| `@vidcall/protocol` | none | none | ✅ perfect leaf |
| `@vidcall/quality` | `@vidcall/protocol` | none | ✅ pure policy engine, no WebRTC imports (`packages/quality/src/index.ts` docblock) |
| `@vidcall/core` | `protocol`, `quality` | none | ✅ zero-dep claim holds (grep over `src` confirms) |
| `@vidcall/test-utils` | none | none | ✅ |
| `@vidcall/transport` | `protocol` | none (vitest is dev-only) | ✅ |
| `backend-*` (×6) | `transport` + their SDK | supabase-js, convex, firebase, appwrite, @libsql/client | ✅ appropriate — SDK-per-adapter is the point |
| `@vidcall/server` | `protocol`, **better-sqlite3, mysql2, pg, ws** | ⚠️ see below |
| `@vidcall/sfu-gateway` | `protocol` | none at runtime (`import type` only, `sfu-gateway/src/mediasoup-adapter.ts:30`) | ✅ clever, ⚠️ types leak (below) |

Genuine wins:

- `D1` ("zero runtime deps in core") is not aspirational — it's enforced by the
  dependency graph and the import grep. `TypedEmitter` replaces Node's EventEmitter
  specifically to keep browsers dep-free (`events.ts:1-11`). We do the same thing in
  `query-core`.
- `"sideEffects": false` on every TS package ✅ — tree-shaking contracts are honored.
- Hand-rolled SigV4 instead of the AWS SDK in the server
  (`packages/server/src/aws-sigv4.ts`) — very much our kind of trade.

What we'd cut/change:

1. **`@vidcall/server` hard-depends on three database drivers including a *native*
   module.** `better-sqlite3` (compiled addon), `pg`, `mysql2` sit in
   `dependencies` (`packages/server/package.json`), and the root barrel re-exports
   all four stores from `src/stores/index.ts` via `src/index.ts:31` — so
   `import { createServer } from '@vidcall/server'` pulls every driver, native build
   included, even if you use `InMemoryStore`. Express/Fastify are already optional
   peers (`peerDependenciesMeta`); `ws`/`pg`/`mysql2`/`better-sqlite3` should be too,
   and each store should live behind a subpath export (`@vidcall/server/store-postgres`).
   This is the difference between "small enough to fit anywhere" and "npm install
   compiles SQLite on your CI".
2. **`sfu-gateway`'s type-only mediasoup still leaks.** Root barrel re-exports the
   adapter (`packages/sfu-gateway/src/index.ts:18`), whose public signatures reference
   `mediasoup` types (`mediasoup-adapter.ts:30`) while mediasoup is a devDependency —
   consumers must install it to *typecheck* the barrel. Move the adapter to a
   `/mediasoup` subpath export + optional peer.
3. **Exports-map inconsistency across the family** (see §6 for detail): core /
   quality / protocol / test-utils point `"types"` at `./src/index.ts` and ship `src`
   (`packages/core/package.json` `exports`+`files`), while transport / server /
   sfu-gateway / backends point at `dist/index.d.ts`. Both patterns exist in the wild
   (shipping TS source à la Deno-friendly packages), but *mixing them in one org*
   guarantees support pain, and `publint`/`are-the-types-wrong` would flag several.
   Pick one (dist `.d.ts`), apply everywhere.
4. No build pipeline beyond `tsc -b` (composite projects, `tsconfig.base.json:14-20`)
   — no bundled/flattened `.d.ts`, no minified artifact, no size budget. Acceptable
   pre-release; before "shipped tomorrow" we'd add `size-limit` budgets on
   core+quality and a dts bundler so the public types don't leak internal modules.

---

## 3. API surface design

**Naming & ergonomics.** `Room` / `publish` / `unpublish` / `subscribe` /
`participant-joined` will feel familiar to anyone who has touched LiveKit — good,
low-surprise choice, well documented inline (`room.ts:10-16` usage snippet). Facades
(`room.recording`, `room.devices`, `room.quality`, `room.controls`) keep the top-level
surface flat while features grow — composition over configuration, correctly applied
(`room.ts:259-282`).

Nits we'd fix before 1.0:

- **Two event-name grammars** collide in one map: kebab-case
  (`participant-joined`, `track-unpublished`, `connection-state`) and
  colon-namespaced (`quality:changed`, `recording:started`, `devices:changed`)
  (`room.ts:97-142`). Pick one.
- **Weak error taxonomy.** The wire has typed errors (`ErrorPayload{code,message}`,
  `protocol/schema.json:452-463`) but the client collapses everything to a bare
  `new Error(...)` on the single `'error'` event (`room.ts:708`, `:890-893`). No
  error classes, no codes, no `cause` chaining. Hooks/ErrorBoundary UX lives or dies
  on this.
- **Dead-end APIs:** data-channel `control` messages are received and immediately
  debug-logged (`room.ts:848`) — either spec them into the protocol or don't surface them.
- **Options stability:** today's usage is construct-once (`new Room(config)`), so
  referential-equality pitfalls haven't bitten. But the moment a `useRoom(options)`
  adapter exists, `metadata?: Record<string, unknown>` (`room.ts:174`) and
  `iceServers?: RTCIceServer[]` (`:183`) become re-render hazards unless the core
  documents structural-compare semantics (query-core does exactly this for
  `QueryObserverOptions`). Cheap insurance now: document "config is read at
  construction; X/Y/Z can be updated via setters".

**Subscription model readiness:** as built, *not* `useSyncExternalStore`-ready (see
§1). The `TrackSubscription` handle returned by `room.subscribe()`
(`room.ts:471-491`) is a nice control-plane idea, but its `publication` getter returns
a fresh lookup per read — another place where snapshot semantics matter later.

**Suspense/error boundaries:** nothing exists yet; fair, since there's no adapter.
With the §1 snapshot layer, `useSuspenseQuery`-style patterns (promise + status in
the snapshot, throw the promise in the adapter) fall out naturally — the async
lifecycle (`join()` resolving, `connection-state` transitions) is already
status-shaped.

**Positives worth keeping:** `join()` is idempotent and returns `this`
(`room.ts:360-361`); `leave()`/`close()` are safe to double-call (`:388-390`);
envelope echo/target filtering happens before any handler runs
(`room.ts:614-619`); late-arriving SDP synthesizes a participant shell instead of
dropping (`room.ts:791-798`). These are the boring-correctness details we sweat.

---

## 4. Protocol & type-sharing

This is the strongest part of the repo, and closer to our internal contract discipline
than anything else here:

- `protocol/schema.json` is a real draft-07 schema with per-type payload dispatch
  (`if/then`, lines 57-250) and the wire rules written into the schema description
  itself: additive = non-breaking, unknown fields/types ignored, `seq` monotonic per
  sender session, unicast via `targetSenderId`, deterministic glare polarity
  `polite = selfId < remoteId` (`schema.json:5`). Putting the *semantics* in the
  contract (not a wiki) is exactly right.
- `protocol/fixtures/` — 23 canonical envelopes with broadcast + `-targeted` variants
  and a README specifying naming/validation/how-to-add-a-type
  (`protocol/fixtures/README.md`). Dart parses these exact files
  (`packages/dart/test/protocol_roundtrip_test.dart:1-15`) and so does Kotlin
  (`packages/kotlin/vidcall-protocol/src/test/kotlin/io/vidcall/protocol/EnvelopeSerializationTest.kt:13-23`).
- `PROTOCOL_VERSION` / `MESSAGE_TYPES` are derived consts, not magic numbers
  (`protocol/types.ts:19-35`).

Gaps:

1. **The TS reference implementation never reads the canonical fixtures.** Grep for
   `protocol/fixtures` across `*.ts` finds nothing; core's tests import unrelated
   helpers from `../../test-utils/src/fixtures.ts` (e.g.
   `packages/core/test/room.test.ts:11` — note also the deep relative path reaching
   into another package's `src/`, which breaks the moment packages stop living
   sibling-to-sibling). So the "L0 conformance" gate claimed in `docs/testing.md:11`
   is enforced for Dart/Kotlin/Swift but *not* for the language every web user gets.
   A ~60-line vitest/node-test suite iterating `protocol/fixtures/*.json` through
   `createEnvelope` + `isEnvelope` closes this; it's the cheapest high-value fix in
   this report.
2. **Schema ↔ TS mirror is manual.** `protocol/types.ts:3-5` admits quicktype codegen
   was deferred. Until then, nothing verifies that `MESSAGE_TYPES` matches the schema
   enum or that payloads match definitions. A CI job validating every fixture against
   `schema.json` (e.g. ajv in a devDep) + asserting `MESSAGE_TYPES.length === fixture
   count` would pin the drift until codegen lands.
3. **Versioning posture is fine for v1 but unexercised:** `v` is `const: 1`; unknown
   types must be ignored (good — Kotlin got a fix commit for exactly this,
   `cec4a32`). There's no version negotiation field in `JoinPayload.capabilities`;
   adding `protocolVersion` there is additive and cheap.
4. **Binding-shape drift:** the Dart client exposes a completely different mental
   model (`VidcallClient` WebSocket client owning seq/ts, `packages/dart/lib/src/client.dart:1-54`;
   plus a separate `RtcMeshSession`) vs TS `Room` over pluggable transports. The wire
   is shared, the developer experience is not. TanStack keeps conceptual parity across
   adapters (same observers, same result shape). Not urgent, but the roadmap should
   name one canonical state model and port it, rather than letting each binding grow
   its own idiom.

---

## 5. Testing & DX

**Genuinely good — better than our early-days average:**

- `FakeRTCPeerConnection` with real signaling-state transitions, wired peer pairs,
  SDP origin handling, trickle-ICE exchange (`packages/test-utils/src/fake-rtc.ts:1-24`)
  is the kind of platform fake we consider a capital investment. It's why 84+ engine
  tests can run in bare node:test with no browser.
- The shared adapter matrix `runAdapterTestSuite`
  (`packages/transport/src/shared-tests.ts:76-352`) — join, offer/answer round-trip,
  ordered burst, 30-candidate ICE trickle, fan-out, presence, chunking, room
  isolation — is executed by all six backends (per-package vitest suites; counts in
  `docs/testing.md:22-27`). This is the mechanism that makes "pluggable signaling" a
  *testable claim*, and the server side has the mirror concept
  (`runStoreTestSuite`, `packages/server/src/shared-tests.ts`).
- Env-gated integration tests for real infrastructure
  (`VIDCALL_MEDIASOUP_INTEGRATION=1`, `VIDCALL_TEST_POSTGRES_URL`, root
  `package.json:16-23`) — correct cost/coverage trade.
- Multi-language CI matrix incl. macOS Swift job (`.github/workflows/ci.yml`).

**Where it diverges from our norms:**

- **Two test runners.** Root `npm test` is `node:test` over core/quality/test-utils/
  server/sfu-gateway (`package.json:15`), while transport and every backend run
  vitest (their `package.json` `test` scripts). The shared suite imports vitest
  (`shared-tests.ts:22`), so the two ecosystems can't share assertions. One runner
  (vitest) everywhere; `node:test` buys nothing here and forces the
  `--conditions=development` trick to resolve workspace sources.
- **Hidden toolchain coupling:** `--conditions=development` resolves packages to raw
  `.ts` sources (export maps like `packages/core/package.json`), i.e. tests rely on
  Node type-stripping (needs modern Node ≥22.x) while `engines` claims `>=18.18`
  (`package.json:25-27`) and CI matrices node 20 + 22 (`.github/workflows/ci.yml`).
  Either the node-20 leg is silently doing something different or it's broken;
  reconcile engines/matrix/runner.
- **No devtools story, minimal observability.** Debug logging is a single injectable
  no-op function (`room.ts:226`, `:571-573`) with ad-hoc string namespaces. For a
  *realtime* library, inspectability is a feature: we'd add (a) a structured
  `onLog`/`Logger` interface with levels, (b) an in-memory ring buffer of last-N
  envelopes/state transitions exposed on the room (instant bug-report payload), and
  eventually a devtools panel rendering the §1 snapshot (roster, PC states, tier
  ladder, reorder buffer depth). Given the snapshot layer, the panel is a weekend.
- **No coverage, no benchmarks**, despite `docs/architecture.md:4` planning an `e2e/`
  benchmarks area that doesn't exist. Fine pre-release; list it.
- Lint/prettier are configured and enforced (flat ESLint, `eslint.config.mjs`; root
  `lint` script) — but the config is bare `recommended`; we'd add import-boundary
  rules (forbid `@vidcall/core` importing adapters, forbid deep `../../pkg/src`
  imports like the ones in `packages/core/test/*.test.ts`).

---

## 6. Repo hygiene the TanStack way

- **Workspace/build:** npm workspaces + `tsc -b` composite project references
  (`package.json:8-11`, `tsconfig.base.json:14-20`). Right call at this scale — we
  ran on tsc -b for years; turborepo/nx would be premature. (`strict`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules` — the
  tsconfig discipline is on point.)
- **Release/versioning: effectively absent.** Root is `private: true`; all 14 TS
  packages pinned at `0.1.0`; no `.changeset/`, no release workflow; the only
  CHANGELOG in the repo is the pub.dev-mandated one
  (`packages/dart/CHANGELOG.md`). Cross-package deps are exact-pinned
  (`"@vidcall/protocol": "0.1.0"`), which means the first real release requires
  touching every manifest. Adopt changesets *now* so the habit forms while the API
  is churning — our changelogs are a third of our DX reputation.
- **Publish-readiness gaps:** mixed exports maps (`types` → `src/*.ts` on
  core/quality/protocol/test-utils vs `dist/*.d.ts` elsewhere; backend-appwrite lacks
  the `development` condition others have); no `repository`/`keywords` metadata; no
  provenance/npm-publish pipeline. Add `publint` + `arethetypeswrong` to CI as gates.
- **React peer-deps strategy:** N/A today because there is no react package. When it
  exists: `"react": ">=18"` peer (works for 19), `react-dom` not needed, and devDep
  on both 18 and 19 for matrix testing — the standard grid we run.
- **CI (`.github/workflows/ci.yml`):** solid bones — node 20/22 build+test+typecheck+
  lint+backend loop, swift/dart/kotlin jobs, kotlin report artifact. Missing: release
  job, publint/attw, coverage, size budget, gradle/swift caching, and a
  `concurrency:` group to cancel superseded runs.
- **Small stuff:** `docs/architecture.md:5` cites a root `CONTRIBUTING.md` policy
  document that doesn't exist in the repo (dangling governance reference);
  `format` script omits `packages/transport` while `lint` includes it
  (`package.json:19-20`); examples use `file:` deps + a committed second lockfile
  (`examples/react/package-lock.json`) — works, but `workspace:*`-style linking with
  a single lockfile is less surprising once published.

---

## 7. Prioritized roadmap — "if TanStack shipped this lib tomorrow"

Ranked by impact; effort S ≈ ≤1 day, M ≈ a few days, L ≈ 1–2 weeks.

| # | Change | Why (impact) | Files | Effort |
|---|---|---|---|---|
| 1 | **Add a snapshot/state layer to core**: immutable `RoomSnapshot` (roster, per-participant state, publications, quality tier) + `room.subscribe()/getSnapshot()`, rebuilt on every mutation | Unlocks everything else: real adapters, strict-mode-safe hooks, devtools, parity with bindings. This is the query-core→react-query seam vidcall is missing | `packages/core/src/room.ts`, new `packages/core/src/store.ts` | L |
| 2 | **Ship `@vidcall/react`** on `useSyncExternalStore`: `useRoom()`, `useParticipants()`, `usePublication()`, `useQuality()`; keyed instance cache, AbortSignal-aware join, StrictMode-tested | Turns a good engine into a usable library; kills the hand-rolled `examples/react` wiring | new `packages/react`; rewrite `examples/react/src/App.tsx` | M (after #1) |
| 3 | **TS L0 conformance suite over `protocol/fixtures/*.json`** (+ validate all fixtures against `schema.json` in CI) | The reference implementation currently doesn't prove conformance to its own contract; cheapest correctness win in the repo | new `packages/core/test/protocol.conformance.test.ts`; `.github/workflows/ci.yml` | S |
| 4 | **Fix `@vidcall/server` weight**: move `pg`/`mysql2`/`better-sqlite3`/`ws` to optional peers; subpath exports per store (`/store-postgres`, …); same treatment for sfu-gateway `/mediasoup` | Removes a native-module compile from every install; aligns with "fits anywhere" positioning | `packages/server/package.json`, `src/stores/index.ts`, `src/index.ts`, `packages/sfu-gateway/src/index.ts` | S |
| 5 | **Unify on vitest**; delete the `node:test` + `--conditions=development` path or make it dev-only; reconcile `engines >=18.18` with reality (drop to `>=20` or bundle tests) | One runner = shared assertions (adapter suite reusable by core), honest engine requirements, simpler CI log | root `package.json`, `packages/*/package.json`, `ci.yml` | M |
| 6 | **Adopt changesets + release pipeline** (version bumps, npm publish dry-run, GitHub Release notes); add `publint`+`attw` CI gates; normalize exports maps to dist-`.d.ts` everywhere | Publishing is currently impossible without a manual sweep of 14 manifests; type-resolution bugs would surface only post-publish | `.changeset/config.json`, all `packages/*/package.json`, new `.github/workflows/release.yml` | M |
| 7 | **Typed error taxonomy**: `VidcallError { code }` mirroring wire `ErrorPayload.code`; replace bare `Error` emission (`reportError`), add `cause` chaining; document which errors are fatal vs recoverable | Every UI above the library branches on error identity today and can't | `packages/core/src/errors.ts` (new), `room.ts:890-893`, `:708` | S/M |
| 8 | **StrictMode/lifecycle hardening**: `AbortSignal` option on `join()`; make `leave()` cancel in-flight joins; write the canonical mount/unmount recipe + a StrictMode test in the react example | The #1 class of user bug reports for realtime libs in React 18+ | `room.ts:360-423`, `examples/react/src/App.tsx:65-101` | S |
| 9 | **Observability**: structured `logger` option replacing single `debug` fn; ring-buffer of recent envelopes/transitions on the room; seed `@vidcall/devtools` panel rendering the snapshot | Realtime debugging over console.log is where adoption goes to die; the snapshot layer makes the panel cheap | `room.ts`, `packages/core/src/events.ts`, new package | M (panel: L) |
| 10 | **Size budget + tree-shake gates**: `size-limit` configs for core/quality/react, a fixture that imports one symbol and asserts dead-code elimination, dts bundling for clean public types | Protects the headline claim ("lightweight") forever; cheap once CI exists | root `package.json`, `.github/workflows/ci.yml`, `tsconfig` for dts rollup | S |

Honorable mentions: pick one event-naming grammar (`room.ts:97-142`); spec-or-remove
data-channel `control` (`room.ts:848`); add `protocolVersion` to `JoinCapabilities`
(`protocol/schema.json` JoinPayload); converge binding state models on the TS
`Room`/snapshot shape (§4.4); restore the missing root `CONTRIBUTING.md`.

---

## Appendix: what we'd brag about

Keep these exactly as they are — they're the moat:

- Zero-dep core with injected platform seams (`room.ts:168-227`), enabling the
  outstanding `FakeRTCPeerConnection`.
- Perfect-negotiation implementation that actually explains itself
  (`peer-connection-manager.ts:1-21`) with rollback, candidate buffering, retry-once
  semantics (`:260-347`) — and an SDP `o=` idempotency guard on top.
- Contract-as-schema with semantics embedded (`schema.json:5`) + canonical fixtures
  consumed cross-language.
- `runAdapterTestSuite` / `runStoreTestSuite`: "pluggable" backed by a mandatory
  conformance matrix, not a blog post.
- Policy purity in `@vidcall/quality` (`adaptive-quality-controller.ts:1-12`: consumes
  stats snapshots, zero WebRTC imports) with hysteresis knobs as plain config — the
  most unit-testable adaptive-quality design we've seen in a JS WebRTC lib.
- The L0/L1/L2 framing in `docs/testing.md` and a CI matrix that actually builds
  Kotlin/Swift/Dart on every push.
