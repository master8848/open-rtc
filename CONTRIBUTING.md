# Contributing to vidcall

Thanks for your interest in improving vidcall — a lightweight, pluggable
video-calling library (JS/TS core + Kotlin/Swift/Dart bindings + reference
signaling servers) speaking one shared wire protocol.

This document is the single source of truth for engineering policy. Several
docs (`docs/architecture.md`, `docs/research/*`, package READMEs) refer to the
policies defined here.

## Repository layout

| Path                           | What lives there                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `packages/core`                | Framework-agnostic mesh WebRTC engine (zero runtime deps)                           |
| `packages/quality`             | Adaptive-quality policy engine (pure functions over stats snapshots)                |
| `packages/transport`           | Client signaling transports + shared adapter test suite                             |
| `packages/backend-*`           | Signaling backend adapters (Supabase, Convex, Postgres, SQLite, Firebase, Appwrite) |
| `packages/server`              | Reference TS signaling server (pluggable stores)                                    |
| `packages/sfu-gateway`         | Optional SFU path (mediasoup)                                                       |
| `packages/{kotlin,swift,dart}` | Native client bindings speaking the same protocol                                   |
| `protocol/`                    | Wire schema (`schema.json`), types, and canonical fixtures — single source of truth |
| `server/rust`                  | Optional Rust sidecar relay                                                         |
| `examples/`                    | Vanilla JS, React, and server examples                                              |
| `integrations/`                | Per-stack integration guides                                                        |

## Engineering policies

These are the rules the codebase is held to. Proposals that deviate must argue
the case in a review doc under `docs/reviews/`.

### 1. Dependency policy

- **14-day age rule:** every new external dependency (npm crate/crates.io/etc.)
  must have existed at its pinned version for **≥ 14 days** at the time it is
  added (verify via the registry's publish timestamps, e.g.
  `https://registry.npmjs.org/<pkg>` → `time.created`). This window lets
  supply-chain attacks and broken releases surface first.
  `server/rust/scripts/check-supply-chain.sh` enforces this for Rust crates.
- **Exact version pins:** no `^` / `~` ranges. Every dependency is pinned
  exactly so builds are reproducible and upgrades are deliberate.
- **Prefer base/std utilities** over micro-deps (e.g. `node:test`, `node:crypto`
  over test/assert helpers; platform WebSocket where available).
- **Prefer in-workspace sub-libraries** over third-party packages when the
  logic is small and project-specific.

### 2. Adapter policy

- **Every adapter interface needs ≥ 2 implementations** before its contract is
  considered stable. A single implementation cannot reveal which parts of the
  interface are accidental. This applies to signaling backends
  (`SignalingTransport`), server stores, and per-language bindings alike.
- Adapters must pass the **shared test suites**
  (`packages/transport/src/shared-tests.ts`,
  `runStoreTestSuite`) rather than ad-hoc tests only.
- The wire protocol tolerates **unknown envelope types**: consumers skip
  envelopes they don't understand. Never break this rule for forward/backward
  compatibility across versions and languages.

### 3. Protocol-first policy

- `protocol/schema.json` + `protocol/fixtures/` are the single source of truth.
  Behavior changes land in the schema/fixtures **first**, then propagate to TS,
  Kotlin, Swift, Dart implementations and their conformance (L0) suites.
- Envelope semantics (sequence monotonicity, glare polarity, unicast routing)
  are part of the contract, not implementation details — encode them in
  fixtures.

### 4. Docs policy

- Docs are written as if for an open-source audience: complete sentences,
  runnable commands, and links to the sources they summarize or verify against.
- Research docs state their verification date; review docs record the verdicts
  they reached so future decisions don't relitigate them.

## Testing matrix

Testing follows the L0/L1/L2 model described in [`docs/testing.md`](docs/testing.md):

- **L0** — protocol conformance: every language parses the same canonical
  fixture envelopes.
- **L1** — unit + shared adapter suites (TS).
- **L2** — native toolchain builds/tests for Kotlin, Swift, Dart.

A change that touches `protocol/` must update fixtures and all language
implementations in the same change.

## Local development

Tool versions are pinned in [`mise.toml`](mise.toml) — install
[mise](https://mise.jdx.dev) and run `mise install` to get the exact Bun/Node
versions the repo is tested with. In short: [Bun](https://bun.sh) is the
package manager (`bun.lock` is the source of truth; `package-lock.json` is no
longer maintained) and Node runs the test suites (`node:test` runner).
Dependencies are exact-pinned workspaces.

```sh
bun install             # install
bun run build           # tsc -b across workspace projects
bun run test            # L1 TS suites (core, quality, test-utils, server, sfu-gateway)
bun run typecheck       # tsconfig.test.json project-wide type check
bun run lint            # oxlint + oxfmt --check
bun run format          # oxfmt (write pass)

# Backend adapters (each runs the shared transport adapter suite via vitest)
for p in packages/backend-*; do (cd "$p" && bun run test); done

# Non-JS toolchains (each has its own README with prerequisites)
(cd packages/dart   && dart pub get && dart test)
(cd packages/swift  && swift test)
(cd packages/kotlin && ./gradlew test)
```

Script names are unchanged (`test`, `build`, `typecheck`, …) — only the runner
moved from npm to Bun (`bun run <script>`).

## Changelog & releases

Releases are driven by [changesets](https://github.com/changesets/changesets)
(`@changesets/cli`, configured in `.changeset/config.json`). All workspace
packages under `packages/*` and `protocol/` are publishable (`@mbsks/*`,
independent versioning); the root package is private and never released.

**Every PR that changes published behavior must include a changeset.** Run

```sh
bun run changeset
```

and pick affected packages and bump types (patch for fixes, minor for
features). Commit the generated `.changeset/*.md` file with your PR. Changes
that don't affect published packages (docs, CI, examples) need no changeset.

When maintainers are ready to release:

```sh
bun run version   # changeset version — consumes pending changesets:
                  #   bumps package versions, updates internal dependency ranges,
                  #   and writes each released package's CHANGELOG.md
bun run release   # bun run build && changeset publish — builds and publishes
```

`changeset version` updates **package-level** changelogs only; the root
[`CHANGELOG.md`](CHANGELOG.md) is the hand-curated repo-wide summary and is
updated in the same PR as notable user-facing changes. The root README links
to it so newcomers can find it.

Version commits follow the repo's conventional style via
`.changeset/commits.mjs` (`chore: release @mbsks/core@0.2.0, ...`).

## Commit style

Small, focused commits with lowercase conventional prefixes scoped by area,
e.g. `fix(core): ...`, `docs(dart): ...`, `test(server): ...`,
`build(sfu-gateway): ...`. One logical change per commit; formatting-only
changes are marked `(formatting only)`.

## License

By contributing you agree that your contributions are licensed under the MIT
License found in [LICENSE](LICENSE).
