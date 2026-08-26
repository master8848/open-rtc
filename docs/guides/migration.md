# Migration guide — what breaks and how to update

## 1. Protocol versioning

`protocol/schema.json:5` is `v: 1`. The `v` field bumps **only on breaking wire changes**; additive fields are non-breaking and unknown `type` values are ignored (`protocol/schema.json` Wire rules). If you vendor the schema, regenerate types via `quicktype` from the new `schema.json` rather than hand-editing.

## 2. RoomConfig renames (planned, changeset fixed groups)

The next minor will normalize `RoomConfig` to single-object options (no overloads, explicit groups):

| Before | After | Codemod |
|---|---|---|
| `recordingEndpoint: string` | `recording: { endpoint: string }` (`packages/core/src/room.ts:455`) | `recordingEndpoint:` → `recording: { endpoint:` |
| `sfuGateway` / `sfu.gateway` / `topology.sfu.gateway` (triple alias `packages/core/src/room.ts:485`) | `sfu: { gateway }` | `sfuGateway` → `sfu: { gateway` |
| `iceServers` top-level | `rtc: { iceServers }` | wrap in `rtc:` |
| `publish({ simulcast, svc })` loose | `publishDefaults: { simulcast, svc, codecPreferences }` | group under `publishDefaults` |

Track the `changeset` `fixed` groups in `.changeset/config.json:7` — packages in the same fixed group bump together. `changeset version --dry-run` previews the bump.

## 3. Events and hooks (planned)

Mixed `kebab:colon:bare` events (`packages/core/src/room.ts:118`) will normalize to one style (colon). Prefer `room.on('room:participant-joined')` going forward and add a `RoomEvent` const enum. `room.subscribe(listener)` (snapshot) will move to `room.store.subscribe` to avoid the `subscribe` overload collision (`packages/core/src/room.ts:1028`). React: `createRoomHook({ transport, publishDefaults })` will replace ad-hoc `new Room` per component.

## 4. Topology defaults

`topology` defaults to `'auto'` with `autoThreshold: 4` (`packages/core/src/media/topology.ts:11`). Existing code that relied on mesh-only keeps working; to pin mesh, pass `topology: { topology: 'mesh' }`. `room.setTopology('mesh'|'sfu'|'auto')` switches at runtime (`docs/media.md:13`).

## 5. How to migrate today

1. Pin exact versions (`package.json` exact pins, `bun.lock` committed) and run the 14-day age gate before bumping (`packages/server/README.md:27`).
2. Run `bun run build && bun run typecheck` — renames surface as type errors.
3. Apply the codemod `node codemods/room-config-rename.mjs --write <files>` (stub until `jscodeshift` wiring; table row 2).
4. Regenerate protocol types from `protocol/schema.json` if you codegen.

## 6. Release train (Phase 4.2)

- **Alphas on `next` dist-tag** (`npm publish --tag next`), weekly changelog to `CHANGELOG.md:8` + GitHub Releases; `protocol v` bumps only on break (`protocol/schema.json:5`).
- **Gate:** `bun run changeset:dry-run` (`changeset version --dry-run`, `plans/07-roadmap.md:77`) in CI; `fixed` groups `.changeset/config.json:7` bump `core/quality/transport` and `server/sfu-gateway` together.
- **Quality Wednesdays** — weekly `quality` label papercut (<1h) tracked in GitHub label `quality`.
- **Roadmap:** `docs/discussions/v0.2.0-roadmap.md` stub (Query #4252 style).

Related: `protocol/schema.json`, `.changeset/config.json`, `docs/media.md`, `packages/server/README.md` (supply chain).
