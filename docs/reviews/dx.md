# vidcall — Developer-Experience & Code-Quality Review (new-user perspective)

Reviewed: 2026-08-12 · Repo HEAD at review start: `73c0521` (review finished at `ebbadbe`)
Scope: README + docs + quickstarts (all docs), API ergonomics of `@vidcall/core`
(Room / transport / events / recording), code-quality pass on `packages/core`,
`packages/backend-supabase`, and the Kotlin binding (`packages/kotlin`).
Read-only review; only this file was written.

---

## TL;DR

The engineering underneath is **genuinely good**: strict TypeScript, zero-dep
core, a disciplined shared wire protocol, clean perfect-negotiation mesh code,
and green tests (183 passing + 2 env-skipped; typecheck + build green). But
**the new-user story does not exist yet**. There is no install path, no example
app, no root-README quickstart, no README for the flagship `@vidcall/core`
package, and the headline feature ("adaptive quality switches by network speed
AND device capability, with warnings") is **not wired into the Room at all** —
the quality engine is a standalone package with no integration code. A fresh
user would have to reverse-engineer the API from JSDoc comments.

---

## 1. Scored checklist

| Dimension | Score | Evidence |
|---|---|---|
| **Onboarding** (fresh app → first call) | **1/5** | No install instructions anywhere (`package.json` is `private`, nothing published to npm); no `examples/` dir; only working `Room` usage example is a JSDoc comment in `room.ts`; no "create backend → new Room → join → publish" walkthrough. |
| **API ergonomics** (join/leave, transport wiring, events, controls, recording) | **3/5** | `Room`/`TypedEmitter`/`SignalingTransport` are clean and typed; but two parallel `SignalingTransport` definitions (core + transport) that must never drift, no quality integration, no convenience helpers (getUserMedia/stream attach), no published event reference. |
| **Docs** (README, architecture, per-package, quickstarts) | **2/5** | `docs/architecture.md` is a good blueprint; per-backend READMEs (supabase/convex/firebase/postgres) are solid; but root README is ~6 lines, `@vidcall/core`/`@vidcall/quality`/`swift`/`appwrite`/`sqlite` have **no README**, `@vidcall/transport` README documents a **stale interface shape**, no API reference or guides. |
| **Errors** (client + server) | **4/5** | Server has stable machine-readable error codes (`room_not_found`, `room_full`, …) and an `{error:{code,message}}` envelope; engine throws meaningful errors ("Room is closed", "unknown participant"). Gap: no client-side error taxonomy doc, several silent no-ops (e.g. `InMemoryTransport.emit` when not joined). |
| **Examples** (runnable code) | **1/5** | Zero runnable examples in the repo. The only code is snippets inside READMEs/JSDoc. Dart has an `example/main.dart`; JS has nothing. |

**Overall: 2/5** — solid library-shaped code, missing library-facing DX.

---

## 2. Fresh-user walkthrough (what a new user hits)

Imagined flow: *"I want to add video calls to my React/Next app."*

1. **Open README.md** → 6 lines: a tagline, a feature list, "Status:
   implementation in progress". No install command, no quickstart, no links to
   packages or docs. Dead end. *(committed version; the package table added in
   the working tree during this review helps but still has no quickstart)*
2. **Find the package** → `npm install @vidcall/core` fails: nothing is
   published (root `package.json` is `"private": true`, all packages are
   `0.1.0` workspaces). No note anywhere on how to consume (git dep? build
   locally?). The Kotlin README says "until the first release, depend via git
   or mavenLocal()" — the JS side has no equivalent note.
3. **Read docs/architecture.md** → excellent blueprint, but §4's monorepo
   layout promises `examples/` (vite-react, node, zoom-clone), `e2e/`, `docs/
   api/`, `docs/guides/`, and an `sfu-gateway/` package — **none exist**. The
   doc is a plan, not a user guide.
4. **Piece together the API** → the only complete `Room` example is the JSDoc
   in `room.ts` (`new Room({roomId, selfId, transport})` → `join()` →
   `publish(track)`). Nothing shows wiring a real backend:
   `new Room({ transport: new SupabaseBackend({ client }) })` appears
   **nowhere** in the repo. The backend READMEs only show the low-level adapter
   API (join/emit/onMessage), not the Room integration.
5. **Try the transport package** → `@vidcall/transport` README shows an
   interface snippet with `join(room, opts?)`, `emit(room, msg)` and
   `SignalingMessage = {kind, payload, from, seq?, ts}`. The actual code
   (`src/types.ts`) is envelope-based: `join(roomId, self)`, `emit(envelope)`
   with `Envelope` from `@vidcall/protocol`. Code written against the README
   **does not compile**. The README even claims "the shape is intentionally
   identical" to core while showing the legacy shape.
6. **Look for quality/recording/screen-share docs** → nothing user-facing.
   `room.recording` is documented only in JSDoc; no guide for controls,
   recording uploads, screen share, or TURN setup. No env-var reference
   (`DATABASE_URL`, `S3_*`, `VIDCALL_TEST_*` appear inline in examples only).
7. **Run the linter** → `npm run lint` is **red on committed code** (3
   unused-var errors in `core/test/peer-connection-manager.test.ts:6`,
   `test-utils/src/fake-rtc.ts:538`, `transport/test/InMemoryBackend.test.ts:87`
   — CI's `npm run lint` step would fail on a clean clone).

Friction inventory: no install path · no example app · no Room+backend wiring
example · stale transport README · no core/quality/swift/appwrite/sqlite
READMEs · docs promise nonexistent examples/e2e/api/guides/sfu-gateway ·
quality engine unwired · lint red · no event reference · no env-var docs ·
Swift/JS sessionId semantics contradict each other (below).

---

## 3. API ergonomics vs a beginner baseline

Compared to simple-peer / PeerJS / LiveKit:

- **Room (join/leave/publish/events)** — clean, typed, promise-based, idempotent
  `leave()`/`close()`. Comparable to LiveKit's `Room`; better typed than
  simple-peer's callback soup. Pain points: no `getUserMedia`/stream-attach
  helpers (users hand-roll `new MediaStream([track])` for `<video>`), no
  auto device-profile detection (`deviceProfile`/`capabilities` are
  caller-supplied even though `@vidcall/quality` ships a `DeviceCapability`
  helper that is never used by Room).
- **Signaling adapter wiring** — the seam is good (one interface, 6 backend
  impls, shared adapter test suite), but **two definitions** of
  `SignalingTransport` (core + transport) exist with a comment asking them to
  stay "structurally identical" — drift risk with no compile-time check, and a
  third (legacy `SignalingBackend`) shape is documented in the transport README
  as if current.
- **Events** — typed event map with kebab-case names; fine, but there is no
  user-facing event reference (only `RoomEventMap` JSDoc). `quality:changed`
  (promised in architecture D5 and README) does **not exist on Room** — only
  `quality-warning` is forwarded from the wire.
- **Adaptive quality** — the README/architecture headline feature is a
  **separate pure package** (`@vidcall/quality`) with zero integration: no
  `getStats()` polling, no `setParameters`/`applyConstraints` application, no
  `DeviceCapability` use anywhere in `packages/core`. A new user gets **no
  adaptive quality out of the box** and no example of how to add it.
- **Recording** — solid hook/facade design (`room.recording.startRecording`/
  `stopRecording`, chunked upload to `@vidcall/server`), documented only in
  JSDoc; the server side exists and is tested, but there is no end-to-end guide.
- **Controls (mute/quality/ICE)** — `publish`/`unpublish`, `subscribe(...)
  .setEnabled()`, `restartIce`, `announceScreenShare` exist and are coherent.
  Screen share requires two calls (`publish(track, {source:'screen'})` +
  `announceScreenShare('start')`) with no helper or docs.
- **Cross-binding drift** — Swift `VidcallClient.Configuration.sessionId` says
  "Server assigns session/sessionId; clients never invent them", while the JS
  core does `config.sessionId ?? randomId()` (client-invented) and Kotlin/Dart
  READMEs show clients passing sessionIds. Same protocol, three stories.

---

## 4. Code-quality pass

### packages/core (engine) — strong
- Strict TS (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `verbatimModuleSyntax`), JSDoc on essentially every public member, zero
  runtime deps, `.ts`-extension imports with `rewriteRelativeImportExtensions`.
- `PeerConnectionManager`: textbook perfect negotiation (polite/impolite glare
  tie-break, trickle-ICE buffering, SDP `o=` idempotency guard, ICE restart
  with fallback, queued-candidate retry). Well-tested via a faithful fake RTC
  (`test-utils`), not mocks — 10 room tests, 10 manager tests.
- `Room`: clean lifecycle (join/leave idempotency, ordered buffer, roster
  reply with `targetSenderId` to avoid echo loops, peer shells for
  unordered backends). Minor: `TypedEmitter` is duplicated in core and quality
  (in-workspace policy, acceptable); `subscribe()`'s `close()` is a no-op
  (honest comment); `handleRemoteLeave` doesn't clear `remoteById` state on
  re-join edge (covered by buffer).
- `any` usage: effectively none in src (only `v.any()` in Convex validators).
- Test quality: good — behavior-focused (`waitFor` conditions, glare/restart/
  idempotency cases), but lint is red in one core test file (unused import).

### packages/backend-supabase (default backend) — strong
- Clean `BaseSignalingTransport` subclass; real subscribe-status handling
  (SUBSCRIBED/CHANNEL_ERROR/TIMED_OUT), presence mapping from
  sync/join/leave, ICE coalescing (100 ms), 256 KB chunking story documented.
- One real bug-adjacent smell: `doSendFrame` throws on broadcast `res !== 'ok'`
  — fine — but `channel.send` failures inside the ICE coalescer flush are
  swallowed by `BaseSignalingTransport` (fire-and-forget loop), so a failed
  candidate batch silently disappears; acceptable for signaling, worth a
  comment.
- Tests: 16 unit + 11 integration (skipped without live Supabase) — good
  coverage of ordering, coalescing, presence, chunk round-trips.

### packages/kotlin (binding) — strong
- `vidcall-protocol` (kotlinx.serialization data classes + L0 fixture tests),
  `vidcall-client` (signaling), `vidcall-android` (org.webrtc mesh):
  documented interfaces, thread-safe `PeerConnectionManager`
  (ConcurrentHashMap/CopyOnWriteArrayList, WebRTC-thread callbacks), clear
  initiator/polite polarity, README with full quickstarts. Best-documented
  binding of the three.

### Cross-cutting
- Build/typecheck/tests green (`npm run build`, `npm run typecheck`, `npm
  test` → 183 pass / 2 env-skipped; supabase suite 16 pass).
- **`npm run lint` is red on committed code** (3 errors listed above) — the CI
  `lint` step fails on a clean clone. P1.
- Conventional commits throughout; lockfile committed; supply-chain pins
  documented with dates per package (14-day policy honored in server README
  table; other packages state dates in their READMEs/version catalogs).

---

## 5. Top fixes

### P0 — blocks any new user
1. **Write an example app** (`examples/vite-react`: two tabs, Supabase or
   `InMemoryBackend`, `new Room(...)` → join → publish → render tracks →
   leave; plus a node example). Rationale: it is the single highest-leverage
   artifact — it proves the API, doubles as the integration test, and is the
   first thing every user will look for.
2. **Publish/consumption path + root README quickstart.** Either publish
   `@vidcall/*` to npm or document the git-dependency/build instructions, and
   turn README.md into a 60-line quickstart (install → backend → Room → events
   → recording) with links. Rationale: today `npm install @vidcall/core` fails
   and there is no entry point to the whole repo.
3. **Wire `@vidcall/quality` into `Room` (or explicitly document it as
   opt-in).** Add stats polling (`pc.getStats()` → `RTCStatsSnapshot`),
   tier application (`setParameters`/`applyConstraints`), and
   `quality:changed` events; if out of scope, ship a worked integration
   example and soften the README claim. Rationale: the headline feature does
   not exist in the product users actually get, which is a promise/truth gap.

### P1 — breaks CI or sends users down wrong paths
4. **Fix the 3 lint errors** in `core/test/peer-connection-manager.test.ts`
   (unused `asFake`), `test-utils/src/fake-rtc.ts:538` (unused `options`),
   `transport/test/InMemoryBackend.test.ts:87` (unused `peerId`). Rationale:
   CI's `npm run lint` step is red on committed code.
5. **Fix the stale `@vidcall/transport` README interface snippet** (shows the
   legacy `SignalingBackend`/`SignalingMessage` shape as current; the code is
   envelope-based `join(roomId, self)`/`emit(envelope)`). Rationale: code
   copied from the README does not compile.
6. **Add READMEs for `@vidcall/core`, `@vidcall/quality`, `swift`,
   `backend-appwrite`, `backend-sqlite`.** Rationale: the engine — the package
   every user imports — has zero documentation, and two shipped backends plus
   one binding have none.
7. **Add a docs/api reference** (event table, `RoomConfig` options, recording
   facade, per-backend setup incl. Supabase RLS/auth and env vars) and
   `docs/guides/` for screen share, recording, TURN. Rationale: the only
   complete API docs today are source JSDoc; no user-facing reference exists.
8. **Reconcile the two `SignalingTransport` definitions** (core + transport)
   with a compile-time conformance check or re-export from one source, and
   delete the legacy `SignalingBackend` from docs. Rationale: three documented
   shapes of the same concept is a trap for adapter authors.

### P2 — polish
9. **Point package `types` at `dist/index.d.ts`** (or document the
   `moduleResolution` requirement for the src-types setup). Rationale: src
   types with `.ts`-extension imports break consumers on classic/node10
   resolution (CRA-class toolchains).
10. **Resolve the sessionId contradiction** between Swift
    ("server assigns; clients never invent") and JS core (`randomId()` by
    default). Rationale: same protocol, opposite documented semantics across
    bindings.
11. **Document env vars in one place** (`DATABASE_URL`, `S3_*`,
    `VIDCALL_TEST_*`) + add a server `.env.example`. Rationale: config is
    currently scattered inline in examples.
12. **Trim or implement architecture.md §4 promises** (`examples/`, `e2e/`,
    `docs/api/`, `docs/guides/`, `sfu-gateway/`). Rationale: a blueprint doc
    listing dirs that don't exist erodes trust in the docs.

---

## 6. Verification evidence (run during review)

```
npm run build     → green (tsc -b)
npm run typecheck → green
npm test          → 185 tests: 183 pass, 2 skipped
                    (Postgres/MySQL integration — env-gated)
npm run lint      → RED: 14 problems (13 errors, 1 warning)
                    3 errors in committed files (core/test, test-utils/src,
                    transport/test); rest in uncommitted server work
backend-supabase  → vitest: 16 pass, 11 integration skipped (no live backend)
```

Commits reviewed (conventional, clean history): `73c0521` … `ebbadbe`.
