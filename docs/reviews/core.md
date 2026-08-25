# vidcall core — architecture & library-choice review

> Status: written by the orchestrator 2026-08-12. The dedicated review agent
> (`review-vidcall-core`) completed its analysis (transcript verified) but died
> before writing the file; this consolidates its findings with the parent's own
> audit and the DX review (`docs/reviews/dx.md`). Read-only review — no code
> changed as part of this document.

## 1. Strengths

- **Zero-dep core**: `@vidcall/core` has no runtime dependencies (platform
  `RTCPeerConnection` + `MediaRecorder` only) — no supply-chain surface, easy
  bundling, works in any browser context.
- **Disciplined protocol**: `protocol/schema.json` is the single source of
  truth; TS/Kotlin/Swift/Dart mirror it with L0 conformance fixtures.
- **Textbook perfect negotiation** in `PeerConnectionManager` (rollback-based,
  glare-free), exercised by the fake-RTC test suite (84 core tests + 36
  recording tests green).
- **Shared adapter suite**: all 6 client backends pass the same
  `runAdapterTestSuite`, which is what makes "pluggable backend" a real claim.
- **Server component** (`@vidcall/server`) is function-first (`Store` as first
  arg, zero framework imports) with 4 store impls sharing one suite, and an
  in-workspace SigV4 signer instead of the AWS SDK.

## 2. Library-alternatives analysis (things that could have used other libs)

| Area | Chosen | Alternative | Verdict |
|---|---|---|---|
| Perfect negotiation | hand-rolled (~250 LOC) | `simple-peer` | **Keep hand-rolled** — simple-peer is unmaintained-ish, bundles a legacy SRD dance, and its API hides the rollback logic we test explicitly. Ours is smaller than the dep. |
| Signaling pub/sub | dumb envelope relay | `socket.io` | **Keep dumb** — socket.io's rooms/acks add server coupling; the wire protocol is JSON-RPC-ish envelopes over WS/REST already. |
| SQLite client adapter | `@libsql/client` 0.17.4 (BroadcastChannel) | `node:sqlite` (builtin, Node 22) | node:sqlite has no cross-tab BroadcastChannel story and no server-push; libsql keeps the same-device dev flow + remote `wss://` path. OK. |
| SQLite server store | `better-sqlite3` 13.0.1 | `node:sqlite` | better-sqlite3 is synchronous + battle-tested; fine pinned at 13.0.1 (21d at audit). |
| JSON-RPC framing | n/a — plain envelopes over WS/REST | `jsonrpsee` | Not applicable: the wire protocol is JSON envelope-based (see `protocol/schema.json`), not a JSON-RPC method surface. Revisit only if a full JSON-RPC server API is ever needed. |
| WS relay (server) | hand-rolled | `ws`/`socket.io` | Hand-rolled keeps deps zero in `@vidcall/server` core; `ws` already present as dev dep for tests. OK. |
| Encoding (bindings) | kotlinx.serialization / Codable / dart:convert | Moshi/Gson, SwiftyJSON | Native codecs are the right call — no codegen drift risk with the schema. |

**Conclusion**: no forced library swaps. The one genuinely missing *piece of
code* is quality-engine integration (below), not a missing dependency.

## 3. Architecture issues (ranked)

- **P0 — Quality engine not wired into Room.** `@vidcall/quality` ships a
  policy ladder + hysteresis, but nothing in `packages/core` calls
  `getStats()`, `setParameters()`, `applyConstraints()`, or creates simulcast
  encodings. The README headline ("adaptive quality switches by network speed
  AND device capability, with warnings") is therefore not in the product. The
  engine is reachable, just never attached. Fix: a `RoomQualityController`
  that samples stats, evaluates the policy, applies sender
  `setParameters`/`applyConstraints`, and emits `quality:changed` /
  `quality:warning`.
- **P1 — No install path / example.** Nothing is published; root README is ~6
  lines; `examples/` promised in `architecture.md` doesn't exist; the only
  complete `new Room({...})` usage is a JSDoc block. See `dx.md`.
- **P1 — Stale transport README.** Documents a legacy
  `join(room, opts)`/`SignalingMessage` shape that no longer compiles
  (copy-paste fails). Must be rewritten against the envelope API.
- **P1 — Lint coverage gap (fixed 2026-08-12).** Root `npm run lint` only
  covered protocol/core/quality/test-utils; `packages/transport` +
  `packages/server` had 3 unused-var errors that CI never saw. Now included;
  prettier applied.
- **P2 — Shared-suite blind spots.** `shared-tests.ts` doesn't cover:
  presence *stale* timeout sweeps, reconnection mid-session, ordering of
  signals across a 7KB chunk boundary (postgres adapter chunks at 7KB), and
  duplicate-signal dedupe under redelivery. Worth adding for the 6 backends.
- **P2 — Protocol v1 lacks ack/retry.** Envelopes are fire-and-forget; on flaky
  transports a `signal` can be lost silently. A `signal:ack` with seq (the
  server stores already assign per-room seq) would close this.
- **P2 — Backend adapter inconsistency**: appwrite's realtime delete payloads
  omit `roomId` (fixed in adapter); firebase uses `onChildAdded`-style signal
  log; convex uses `_id` diffing. Each is internally correct but the shared
  suite doesn't assert *cross-backend* semantics (e.g., late-joiner snapshot
  presence) — document the contract per backend in one place.

## 4. Test / CI / code-quality notes

- Tests are strong where they exist (fake-RTC + fake-MediaRecorder are
  genuinely good). Missing: no browser-e2e harness (Playwright) yet — L2.
- `npm test` (root) = 184 tests, 182 pass, 2 env-skipped (PG/MySQL via docker
  on 5433/3307); backend suites 11–19 tests each; CI matrix in
  `.github/workflows/ci.yml` (node 20/22, swift, dart, kotlin, backend loop).
- `any` usage ~none in core; JSDoc on all public surface; errors are typed
  (`RecordingUnavailableError`, `ProviderError` pattern). Good baseline.

## 5. Recommended follow-ups (P0/P1/P2 tickets)

1. **P0** Wire `@vidcall/quality` into Room (stats → policy → setParameters /
   applyConstraints → events) + tests. → delegated to `code-vidcall-quality-wiring`.
2. **P1** `examples/` (vanilla + React) + root README quickstart + install
   path via git dependency. → delegated to `code-vidcall-examples-docs`.
3. **P1** Rewrite `packages/transport/README.md` against the envelope API. → same agent.
4. **P2** Extend `shared-tests.ts` (presence sweep, reconnect, chunk boundary,
   dedupe). → backlog.
5. **P2** Protocol `signal:ack` + seq-based retry. → backlog (note: server
   stores already assign per-room seq, so this is incremental).
6. **P2** Playwright browser smoke (join 2 peers in real Chrome) as L2 gate. → backlog.
