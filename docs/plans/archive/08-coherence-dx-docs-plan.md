# 08 — Coherence, DX & Docs Plan (Linear + TanStack perspective)

> Status: proposal | Depends: 00-07 implemented (2026-08-25 wave) | Author: coherence audit 2026-08-26
> Budgets: respects `docs/AGENTS.md:17` (architecture ≤1800, limits ≤600, features ≤2200). New guides ≤600w each.

## 0. Why this plan

Current project (`0.1.0 private:true` `package.json:4`) has 8 slices landed per `docs/architecture.md:39-50` + `.agents/notes/implemented/*` but:
- API is incoherent: `Room` god object `packages/core/src/room.ts:321`, `subscribe` overload collision `room.ts:1028`, `getPeerConnection` bug `room.ts:1128`, `sfuGateway` triple alias `room.ts:485`, `CompositeTransport` inline duplicate `room.ts:399`, events mixed `kebab:colon:bare` `room.ts:118`.
- Docs are reference-only: `docs/getting-started.md` sole tutorial, no `docs/api/`, no `typedoc.json`, `README.md:1` still `peercall` placeholder, `examples/server/server.mjs:23` open mode insecure, `plans/` vs `docs/plans/archive/` duplicate.
- Zoom parity scaffolded: `poll` ❌, `hand` local-only `packages/core/src/controls/ControlsManager.ts:192`, `lobby` stub `packages/server/src/http.ts:718`, `breakout` stub `http.ts:704`, `ban` 0 hits, server STT missing `packages/core/src/media/transcription.ts:5`, `EgressWorker` in-memory only `packages/core/src/media/egress.ts:36`.

Linear = opinionated momentum + docs as confidence. TanStack = headless core + type-safe composable primitives + docs as CI-checked product.

## 1. Principles to adopt

**From Linear (`linear.app/method`):**
- `Initiatives > Projects > Issues` — Initiative 12mo direction, Project 1-3w 1-3 people with `definition of done` + `beta-done vs GA-done` milestones, Issues plain language not user stories. Scope down to increase quality.
- `Cycles not sprints` — 2-week cycles, unfinished auto-rolls, cadence > velocity. Single roadmap for whole monorepo (not per-package roadmaps).
- `Quality Wednesdays` — each eng fixes 1 papercut <1hr weekly, presents standup, `quality` label. Habit > phase.
- `Spec is baseline, not goal` — `plans/08` is minimum; exceed via taste + beta feedback, not metrics.
- `Triage inbox` — `G T` per-team inbox for operator issues (Slack/Sentry), states `accept/duplicate/decline/snooze`, triage captain rotation.
- `Docs split`: `linear.app/docs` (product) vs `developers.linear.app` (API/SDK) — distinct IA, hub card grid, verb-led descriptions.
- `Codegen SDK`: `_generated` from schema (`protocol/schema.json` is vidcall's schema) — never hand-edit types.
- `Weekly changelog` — `CHANGELOG.md:8` exists but not published externally; flag-gated releases to internal → `Linear Origins` beta → GA.

**From TanStack (`tanstack.com/tenets`):**
- `Core + thin adapter` — `table-core` zero React import, adapters `table-react/vue/solid`. Vidcall already `packages/core` zero deps `packages/core/package.json:174` + `packages/quality` pure — keep, don't leak React into core.
- `Composable primitives`: `createFormHook({fieldComponents})` / `createTableHook({features})` — user binds design-system once, inferred types without generics. Analog: `createRoomHook({transport, publishDefaults})`.
- `Explicit over magic` — `cacheTime→gcTime`, `isLoading→isPending` renames for clarity. Prefer single-object options, no overloads (vidcall's `subscribe` overload violates this).
- `Headless` — state machine owned, markup owned by user. No CSS to override.
- `Docs as product`: `docs/config.json` single source for sidebar + search, `verify-links.ts`, `llms.txt` + `llms-full.txt` per-product, Algolia DocSearch, runnable StackBlitz examples. CI fails on broken links.
- `Testing 5 layers`: `eslint, vitest unit, .test-d types (TS 5.5-5.9 matrix), publint+attw build, Playwright e2e` + `sherif/knip/zizmor`, `size-limit` (~13kB Query), `pkg-pr-new` preview per PR, `nx affected`.
- `Release train`: 91 alphas → 35 betas → 16 RCs on dist-tags (`next/beta/rc`), `changesets` `fixed` groups + `onlyUpdatePeerDependentsWhenOutOfRange`, OIDC trusted publishing, `codemod` for breaking changes.

## 2. Current state anchor

- Spine `plans/00-overview.md:62` + `plans/07-roadmap.md:5` M0-M5 linear; `docs/plans/archive/*` duplicate of `plans/*`.
- `docs/AGENTS.md:5` fact homes correct: rationale `.agents/notes`, behavior `docs/`, env vars `packages/server/README.md`.
- Gaps are P0 publish/horizontal proof + P1 media/recording polish + P2 resilience/advanced — matching `plans/07-roadmap.md:60` M4/M5 polish before 1.0.

## 3. Phased plan

### Phase 0 — Fix foundations (2 weeks, 2 people) — blocks 1.0
**Initiative: Ship as real packages**
**Project 0.1 Branding & publish shape (1w)**
- Issues: `fix README peercall->@mbsks/openrtc-*` `README.md:1,45,82`, sync `examples/README.md` `bun install`, delete or symlink `plans/` → `docs/plans/archive/` canonical, add `typedoc.json` is NOT this phase (defer to P1) but fix `package.json:4 private:true` sweep `grep peercall`.
- Acceptance: `bun run build && publint --pack` passes (`plans/05-packaging-dx.md:34` exports `types/import/require/development + ./package.json`), `attw --pack` clean, `rslib.config.ts` per `protocol,transport,core` (`plans/05:64`), `size-limit` budget `core <15kB gz` (`plans/05:111`).
- Linear cycle: define done (publint green) + milestone beta-done (rslib dual ESM+CJS) vs GA-done (npm `latest` dry-run).

**Project 0.2 Horizontal proof (1w)**
- Issues: verify `packages/server/src/relays/redis-relay.ts:45` + `postgres-notify-relay.ts` + `stores/*` actually exist beyond docs claim `docs/transport.md:9`; add 2-instance LB integration test `plans/04-transport:155`; fix Postgres `LISTEN` dedicated `pg.Client` not pool `docs/limits.md:11`.
- Acceptance: burst test `20 ICE/s zero drops` `plans/00-overview.md:76` against emulated Supabase/Firebase limits `docs/limits.md:8`.

### Phase 1 — API coherence (3 weeks, 2 people) — TanStack primitives
**Initiative: One coherent client surface**
**Project 1.1 Facade & builders (1.5w)**
- Issues: `feat VidcallClient.connect({roomId, token, transport, publishDefaults}) => Promise<Room>` hiding `RoomConfig` sprawl `room.ts:240` (18 fields); group `RoomOptionsBuilder` `{rtc:{iceServers,polite}, publishDefaults:{simulcast,svc,codec}, adaptive:{mode}}` (TanStack `publishDefaults` pattern); single `sfu: {gateway}` not triple alias `room.ts:485`; single `recording:{endpoint}` not `recordingEndpoint` alias `room.ts:455`.
- Remove `subscribe` overload collision — rename snapshot to `room.store.subscribe` / `room.onSnapshot` (`room.ts:1043`); fix `getPeerConnection(id)` bug `room.ts:1128`.
- Add `maxPayloadBytes` to `SignalingTransport` `packages/core/src/transport.ts:29` vs ad-hoc cast `room.ts:418`; delete inline composite `room.ts:399` → import `packages/transport/src/composite.ts:25`.
- Acceptance: no overloads, single-object options, `Room` construction via facade only in examples/docs.

**Project 1.2 Events & hooks (1.5w)**
- Issues: normalize events to one style — pick `colon` (`room:participant-joined`) or `kebab` (`participant-joined`) — currently mixed `room.ts:118` table; export `RoomEvent` const enum (Linear SDK style). Unify `reaction`/`transcript` double `senderId/participantId` `room.ts:133,112`.
- React: add `useRecording, useTranscription, useQuality, useDevices, useActiveSpeaker, useConnectionState, useRemoteTrack` — currently only `useRoomState/useParticipants/useJoin` `packages/react/src/index.ts:1`. Add `createRoomHook` factory `createFormHook` analogue for app-wide defaults + `useRoomState(select)` selector for render perf (TanStack Store).
- Add `room.registerProcessor` plugin registry vs raw `useProcessor` `room.ts:671` with fixed `ORDER denoise(0)<background(1)<custom(2)<e2ee(3)` `packages/core/src/media/processor.ts:9`.
- Acceptance: typedoc shows `RoomEvent` + hooks, `TypedEmitter` try/catch parity with `ObservableStore` `store.ts:85`.

**Project 1.3 Topology auto (0.5w overlaps)**
- Issues: wire `TopologyController.maybeMigrate()` `packages/core/src/media/topology.ts:47` to `participant-joined/left` when `topology==='auto'` (currently manual `room.ts:548`); add `topology:changed` event; keep `stay-sfu` for v1 but document.
- Add `setTile` resize-observer guidance + `setPreferredLayers` `packages/sfu-gateway/src/sfu-gateway.ts:47` unified `VideoQuality` enum (TanStack explicit).
- Linear quality: add `quality` label papercut sweep.

### Phase 2 — Docs as product (2 weeks, 1 person) — Linear split + TanStack CI
**Initiative: Docs that ship**
**Project 2.1 Site & verification (1w)**
- Issues: `docs/config.json` single source for sidebar (order by journey: getting-started → transport → media → recording → security → limits, not package tree), Algolia DocSearch (free OSS), `scripts/verify-links.ts` port from `TanStack/form#2278` (maps `framework/{fw}/examples` → `examples/{fw}`), word budgets enforced in CI `docs/AGENTS.md:17` (fix `controls.md:374` 2100w borderline), link check `docs/AGENTS.md:15`.
- Add `llms.txt` + `llms-full.txt` per-product `scripts/llms-generate.mjs` (TanStack pattern), ensure `.md` URL parity + `Last-Modified`.
- Ship `typedoc.json` + `docs/api/` (was `VC-17` open `docs/research/comparison.md:247`), JSDoc `@example` for `Room, ControlsManager, SfuGateway, RoomRecordingFacade` `packages/core/src/room.ts:695` etc., right-rail TOC for `features/*.md` >1500w.

**Project 2.2 Guides (1w) — 4 new tutorials ≤600w each**
- `docs/guides/deployment.md` — TLS for `getUserMedia`, `turn.secret/urls` coturn `packages/server/README.md`, `RedisRelay vs PostgresNotifyRelay` choice `docs/limits.md:35`, S3 lifecycle, health-check, `VIDCALL_SECRET` forwarding (fix `examples/server/server.mjs:23` open mode).
- `docs/guides/error-handling.md` — taxonomy for `room_full, token_expired 4401 ws.ts:210, e2ee-unsupported processor.ts:32, e2ee-blocks-egress room-recording-facade.ts:131, ice:turn-failed room.ts:829, device:unavailable` — client emits bare `Error` `room.ts:156` today, document code field plan.
- `docs/guides/testing.md` (app) — how to use `packages/test-utils` `FakeRTCPeerConnection`, mock `RoomQualityController` harness (vs contributor `docs/testing.md:14` L0/L1/L2).
- `docs/guides/migration.md` — `protocol v1` break-only `protocol/schema.json:5`, `RoomConfig` rename table (`recordingEndpoint→recording.endpoint`), changeset `fixed` groups.
- Update `docs/getting-started.md:243` stale SFU TODO → `topology:'auto'` + `SfuGateway` snippet `plans/03-media-topology.md:50`; refresh `README.md` hub card grid verb-led (Linear).

### Phase 3 — Zoom parity features (4 weeks, 2 people) — one PR/feature additive
**Initiative: Production calling**
**Project 3.1 Moderation & lobby (1w)**
- Issues: expose `room.moderate({action:'kick|mute|lock|unlock|ban', participantId})` client wrapper for `packages/server/src/core.ts:196` + `http.ts:601`; add `ban` verb + expiry + list (0 hits today), `mute-remote` fanout via `DataChannelBus control` `data-channel-bus.ts:21`; wire `locked` live event + WS broadcast `ws.ts:342` (currently join guard only); implement lobby queue `POST /rooms/:id/lobby/admit` `http.ts:718` → waiting list + `room.on('lobby:waiting')` + webhook `webhooks.ts:12` `lobby.waiting` dispatch `webhooks.ts:26`.
- Additive `poll` envelope `poll {question,options}` + `vote` `plans/06-advanced-media.md:80` + `typing` indicator (Telegram) + `hand` queue server-persisted (today `ControlsManager.ts:192` local flag only).

**Project 3.2 Transcription & captions (1w)**
- Issues: keep `protocol/schema.json:26 transcript` + `media/transcription.ts:31` client STT, add server `SfuTranscriptionWorker` parallel to `EgressWorker` `packages/core/src/media/egress.ts:80` — `SfuSession` audio `PlainTransport` RTP → chunk → OpenAI `audio/transcriptions` → `transcript` envelope → `DataChannelBus` + relay `core.ts:269`; sidecar `RecordingSession.transcriptUrl` + webhook `transcript.final/interim` `webhooks.ts:12`.
- Blurable `DenoiseProcessor wasmUrl` `denoise-processor.ts:34` + `VirtualBackgroundProcessor modelUrl` `virtual-background-processor.ts:29` bundling decision (lazy 0-200KB, keep `sideEffects:false` budget).

**Project 3.3 Recording product (1w)**
- Issues: land `SfuGateway.egress` → `EgressWorker PlainTransport→ffmpeg` `plans/02-recording.md:90`, clarify `client vs sfu-selective vs sfu-composite` `docs/recording.md:7`, `POST /recordings/:id/chunk` sequential `recording.ts:93`, `GET /stream Range` `recording.ts:105`, `manifest.encrypted/keyId` `recording.ts:35`, consent UX `caps.record` `docs/security.md:17`.
- `breakout` assignment `http.ts:704` count→ids `711` + move + parent link `plans/06:77`.

**Project 3.4 Analytics & push (1w)**
- Issues: CDR `Store listSignals + Relay clientCount → metrics` `plans/06:99`, `getCallStats` `room-quality.ts:528` sampler, `push.ts:6` `FCM/APNs` `push.ts:23` trigger on offline join `services.ts:102` (currently in-memory only), webhook join/leave dispatch `core.ts:116` + `ws.ts:399` (currently only `finalizeHandler` `http.ts:474`).

### Phase 4 — Hardening & release (2 weeks, 1 person) — TanStack gates
**Project 4.1 Quality gates (1w)**
- Add `test:types .test-d.tsx` multi-TS `5.5-5.9`, `test:build publint+attw`, `size-limit` per `packages/core`, `sherif/knip/zizmor`, `pkg-pr-new` preview per PR `pr.yml`, `nx affected`/`turbo` for `bun` workspaces, `autofix.yml`, 14-day age already stricter than TanStack — pair with OIDC trusted publishing (drop `NPM_TOKEN`).
- Re-intro CI matrix `docs/testing.md:64` (build/test/typecheck/lint + backend vitest + swift `macos-14` + dart + kotlin `temurin21`), keep local `bun run build && typecheck && test && lint`.
- Fix `engines node >=18.18` `package.json:31` vs `Node 22` pin `plans/05:146` drift.

**Project 4.2 Release train (1w)**
- Open `v0.2.0 Roadmap #4252` discussion (Query style), alphas on `next` dist-tag, 16 RCs pattern, `codemod` for `RoomConfig` renames (Table `useLegacyTable` analogue), `changeset version --dry-run` gate `plans/07-roadmap.md:77`, migration guide per `docs/guides/migration.md`.
- Weekly changelog publishing + feature flags via `protocol v` bump-only-on-break `protocol/schema.json:5`; `Quality Wednesdays` habit tracked `quality` label.

## 4. Timeline (Linear cycles)

- Cycle 1-2 (4w): P0 foundations + P1 facade/builders (M0+M1).
- Cycle 3 (2w): P1 events/hooks + P2 site/guides (M4 DX).
- Cycle 4-5 (4w): P3 parity one PR/feature (M5 advanced, parallelizable after P1).
- Cycle 6 (2w): P4 hardening + RC train → 1.0 freeze `plans/07-roadmap.md:4`.

Total 12w to 1.0 with 2-3 people (matches `plans/07-roadmap.md:5` M0 2-3w + M1 3-4w + M2 2-3w + M3/M4 2w each). Scope down if >3w: split `transcription` server vs client, `breakout` as stretch.

## 5. What makes this coherent (Linear + TanStack check)

- **Linear coherence**: single roadmap, cycles>velocity, opinionated defaults (`Store` 10 methods `packages/server/src/store.ts:22` stays), weekly changelog, triage inbox, codegen from `protocol/schema.json` + fixtures `protocol/test`.
- **TanStack coherence**: same `createXHook` naming (`createRoomHook` like `createFormHook`), same `verify-links` + `llms.txt`, same `core+adapter` separation, same inference without generics, same `size-limit` proof for `zero deps` claim.

## 6. Absolute anchors

- API sprawl: `packages/core/src/room.ts:240,399,485,671,695,829,883,1028,1128`, `packages/core/src/media/processor.ts:9`, `packages/sfu-gateway/src/sfu-gateway.ts:47`, `packages/core/src/media/topology.ts:11,47`
- Docs gaps: `README.md:1`, `docs/AGENTS.md:5,17`, `docs/getting-started.md:243`, `docs/features/controls.md:251`, `packages/server/src/http.ts:601,704,718`, `packages/server/src/webhooks.ts:12,26`
- Plans: `plans/00-overview.md:62`, `plans/07-roadmap.md:5-17`, `plans/05-packaging-dx.md:34-52,111`, `plans/06-advanced-media.md:34-119`
