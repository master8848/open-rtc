# vidcall testing — L0 / L1 / L2 matrix

One library speaks one protocol from several languages, so tests come in
three rings. **L0** checks that TypeScript, Kotlin, Swift, and Dart all read
and write the exact same wire messages. **L1** is the everyday TypeScript
suite: unit tests plus one shared suite that every signaling backend must
pass. **L2** builds and runs each mobile binding on its own native toolchain.
The wire protocol (`protocol/schema.json`) is the single source of truth;
every layer is tested against it.

## Layer model

| Layer | What it validates | Where | Gate |
|---|---|---|---|
| **L0** | Protocol conformance — sample envelopes (join/offer/answer/ICE/presence) serialize/deserialize identically in TS, Kotlin, Swift, Dart | `protocol/*`, `packages/core/test`, `packages/{kotlin,swift,dart}` fixtures | CI `node`, `kotlin`, `swift`, `dart` jobs |
| **L1** | Unit + shared adapter suite — every client signaling backend implements `SignalingTransport` and passes `packages/transport/src/shared-tests.ts` | `packages/backend-*` vitest suites | CI `node` backend loop |
| **L2** | Cross-language integration — each binding compiles and its tests pass on its native toolchain | `packages/swift`, `packages/dart`, `packages/kotlin` | CI `swift`/`dart`/`kotlin` jobs |

## Current status (verified 2026-08-11/12)

| Package | Layer | Tests | Status |
|---|---|---|---|
| `packages/core` (mesh engine) | L0/L1 | 84 (core+quality+test-utils) | ✅ green |
| `packages/quality` (adaptive policy) | L1 | (in 84) | ✅ green |
| `packages/transport` shared suite | L1 | — | ✅ green |
| `backend-supabase` | L1 | 11 | ✅ green |
| `backend-postgres` | L1 | 16 | ✅ green |
| `backend-convex` | L1 | 10 | ✅ green |
| `backend-firebase` | L1 | 11 | ✅ green |
| `backend-appwrite` | L1 | 11 | ✅ green |
| `backend-sqlite` | L1 | 19 | ✅ green |
| `packages/swift` | L0/L2 | 41 (42 with the WebRTC binary target enabled) | ✅ green (local `swift test`; real-WebRTC smoke test env-gated) |
| `packages/dart` | L0/L2 | 29 | ✅ green (verified in-session) |
| `packages/kotlin` | L0/L2 | 30 | ✅ agent-verified (JDK 21 + Gradle 8.14.5); local re-run needs JDK — see below |

## How to run each layer locally

```sh
# L1 TS (core + quality + test-utils)
npm run build && npm test && npm run typecheck && npm run lint

# L1 backends (each runs the shared adapter suite through vitest)
for p in packages/backend-*; do (cd "$p" && npm run test); done

# L2 swift
cd packages/swift && swift build && swift test

# L2 dart
cd packages/dart && dart pub get && dart analyze && dart test

# L2 kotlin (requires JDK 21)
cd packages/kotlin && ./gradlew test
```

## Environment-gated items

- **Kotlin local re-verification** — this machine has no JDK (`JAVA_HOME` points
  at an invalid Android Studio path). The kotlin agent verified 30 tests with its
  own toolchain (JDK 21, Gradle 8.14.5, Android SDK 36). To re-run locally:
  `brew install openjdk` then `cd packages/kotlin && ./gradlew test`.
- **iOS/Android device tests** — L2 runtime (actual `RTCPeerConnection` on device)
  requires simulators/emulators; planned for the 2026-08-12 session.

## CI

Local gate (always): `bun run build && bun run typecheck && bun run test && bun run lint` (plus per-toolchain suites below).

CI matrix (`.github/workflows/ci.yml`, re-introduced Phase 4 — TanStack gates):

| Job | Runner | Steps |
|---|---|---|
| `node` | `ubuntu-latest` Node 22 (pinned `mise.toml:10` `node = "22.22.2"`; `package.json:35` `engines >=18.18` allows ≥18.18 locally) | `bun install` → `bun run build` → `bun run typecheck` → `bun run test` → `bun run test:types` (`.test-d.tsx` multi-TS 5.5-5.9 placeholder) → `bun run test:build` (`publint --pack` + `attw --pack` stub) → `bun run size:core` (`size-limit` <15kB gz per `packages/core`) → backend loop `for p in packages/backend-*; do (cd "$p" && bun run test); done` → `changeset status --verbose` gate (`plans/07-roadmap.md:77` `version --dry-run` intent) |
| `swift` | `macos-14` | `swift build && swift test` |
| `dart` | `ubuntu-latest` dart `stable` | `dart pub get && dart analyze && dart test` |
| `kotlin` | `ubuntu-latest` `actions/setup-java@v4` `temurin 21` | `./gradlew test` |

Additional workflow stubs: `pr-preview.yml` (`pkg-pr-new` per-PR preview), `autofix.yml` (`oxfmt`/`oxlint --fix` autofix), `check:quality` (`sherif`/`knip`/`zizmor` stubs), `affected` (`nx affected`/`turbo` stub for `bun` workspaces). Engines drift fixed: `package.json:35` `>=18.18` is the floor; CI pins Node 22 via `mise.toml:10`; `CONTRIBUTING.md` local dev notes the pin.

## Adding a backend

1. Implement `SignalingTransport` (`packages/transport/src/base.ts`).
2. Import `runAdapterTestSuite` from `@mbsks/openrtc-transport/shared-tests` and wire
   your fake + real-store harness into your vitest suite.
3. Keep your package in `packages/backend-*` so the root scripts and any future
   CI pick it up automatically.
