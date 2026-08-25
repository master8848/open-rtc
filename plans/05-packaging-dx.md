# 05 — Packaging & DX: Plug-and-Play, Pay-for-What-You-Use

> Depends on `00-overview.md`. No runtime deps added. All changes are build/publish-time.

## Problem

- **16 packages, not on npm** (`README.md:32`, `package.json:2` `version:0.1.0 private:true`). Breaking changes expected to 1.0 — need a clean exports contract before publish.
- **Bundle cost hidden:** each backend drags one heavy SDK (`firebase 12.16`, `supabase-js 2.110`, `pg 8.22`, `appwrite 26.2` etc. — see sub-agent inventory `packages/backend-*`). If wrongly bundled into `core`, every user pays. Today isolation is good (one SDK per package) but `exports` map is inconsistent.
- **Build is `tsc -b` only** (`tsconfig.json:3`, `tsconfig.base.json:5` `module:NodeNext`). No ESM+CJS dual, no DTS bundling. `types` points at `src/*.ts` in 5 packages (`packages/core/package.json:9`, `quality`, `react`, `protocol`, `test-utils`) — ships source, `are-the-types-wrong` fails. No `require` condition, so `require()`/Jest/default SSR breaks. No `publint`/`attw` gate.
- **DX gap:** `new Room({roomId,selfId,transport})` + `useJoin(room)` (`README.md:43`) is imperative, no `select`/suspense/mutation ergonomics, no devtools. TanStack-level polish missing.

## Goal

`bun add @mbsks/openrtc-core` is <15 kB gz zero-dep; adding a capability is one extra `bun add`. Heavy peers are optional + lazy-imported. Types are correct, dual publish works, and the React layer feels like TanStack.

## Package map — keep sharding, fix boundaries

```
@mbsks/openrtc-protocol        zero dep, every package -> it
@mbsks/openrtc-quality         -> protocol only (pure)
@mbsks/openrtc-transport       -> protocol (contract + chunker/reorder/heartbeat/iceCoalescer)
@mbsks/openrtc-core            -> protocol, quality (mesh engine, MediaTransport seam from 03)
@mbsks/openrtc-react           -> core (peer react>=18)
@mbsks/openrtc-server          core HTTP/WS kernel + Store contract; subpaths for drivers
@mbsks/openrtc-sfu-gateway     -> protocol (router + mediasoup ref, devDep only)
@mbsks/openrtc-backend-{supabase,firebase,convex,appwrite,postgres,sqlite}  one SDK each
@mbsks/openrtc-test-utils      dev only
```

Do not merge. Subpath isolation via `exports`, not folders.

## Exports map — canonical shape (apply everywhere)

```json
{
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "development": "./src/index.ts",
      "default": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": ["dist"],
  "sideEffects": false
}
```

- Server adds subpaths with same 4-condition shape: `"./express"`, `"./fastify"`, `"./stores/sqlite|postgres|mysql"` (`packages/server/package.json:exports` already has subpaths — normalize to this shape).
- Transport keeps `"./internal"` and `"./shared-tests"` (`packages/transport/package.json:10-26`) but with fixed `types:dist`.
- Fix `types` → `dist/index.d.ts` in `core, quality, react, protocol, test-utils` (`package.json:9-12`). Drop `src` from `files` once fixed. Add `development` condition to `backend-supabase` parity. Keep `sideEffects:false` everywhere (audited — `packages/core/src/devices.ts:85` env guards inside fns).

Peer vs dep policy:

- `backend-*` SDKs stay `dependencies` (one SDK per adapter, `npm i @mbsks/openrtc-backend-supabase` just works).
- `server` drivers (`pg`, `mysql2`, `better-sqlite3`, `ws`, `express`, `fastify`) stay `optional peerDependencies` + `peerDependenciesMeta.optional` (`packages/server/package.json:85-101`) with lazy `await import('pg')` (`stores/PostgresStore.ts:62` pattern). Client never pays.
- `react` peer `react>=18` (`packages/react/package.json:30`) + `externals: react` in bundler.

## Toolchain — `bun` + `tsc -b` + `rslib`

| Task | Tool | Why |
|------|------|-----|
| Publish libs (all `packages/*` + `protocol`) | `rslib` (`rslib.config.ts` per pkg) — ESM+CJS+dts in one config, rspack speed | `tsup` slower, `unbuild` less maintained, `Bun.build` gives no DTS |
| Typecheck + project-ref ordering | `tsc -b` (`tsconfig.json:3-28`, `tsconfig.base.json:5`) | stays source of truth; `rslib build` consumes same base |
| Apps / sidecar (`examples/react`, server binary) | `Bun.build` / `rsbuild` | `bun build --compile` verified 61 MB 0.5s; `--bytecode` for cold start |
| Types | DTS bundling per package (`rslib` `dts.bundle:true`) | one public `dist/index.d.ts`, no leaked `src/*.ts` |

Per-package `rslib.config.ts`:

```ts
import { defineConfig } from '@rslib/core';
export default defineConfig({
  lib: [
    { format: 'esm', syntax: 'es2022', dts: { bundle: true } },
    { format: 'cjs', syntax: 'es2022', dts: false },
  ],
  source: { entry: { index: 'src/index.ts' } },
  output: { target: 'web', externals: [/^@mbsks\//, 'react'] },
});
```

`tsc -b --noEmit` stays in CI as typecheck gate.

## Plug-and-play install recipes

```sh
# minimal — 1:1 or mesh 2-4, <15 kB gz
bun add @mbsks/openrtc-core

# with React
bun add @mbsks/openrtc-core @mbsks/openrtc-react

# pick one signaling backend (each is one SDK)
bun add @mbsks/openrtc-backend-supabase   # or firebase | convex | appwrite | postgres | sqlite

# optional server relay (REST+WS sidecar beside Express/Fastify/Django/Rails/Laravel)
bun add @mbsks/openrtc-server ws

# optional large rooms (adds mediasoup types only; worker is server-side)
bun add @mbsks/openrtc-sfu-gateway

# E2EE / processors are inside core (no extra dep); WHIP / transcription are separate subpaths
bun add @mbsks/openrtc-core  # useProcessor() chain from 03
```

Bundle budgets (enforce with `size-limit`):

- `@mbsks/openrtc-core` <15 kB gz, `@mbsks/openrtc-quality` <5 kB gz, `@mbsks/openrtc-react` <3 kB gz. Backend/SFU/server budgets track peer SDK weight (document, not fail — `firebase` is ~2 MB gz, user opts in knowingly).

## TanStack-inspired DX (additive, no new deps)

Port `docs/reviews/perspective-tanstack.md` patterns onto `RoomSnapshot` (`packages/core/src/store.ts:85`, `room.ts:698`):

```ts
// factories (like queryOptions)
function roomOptions(config: RoomConfig) {
  return { queryKey: ['room', config.roomId, config.selfId], queryFn: () => new Room(config).join(), staleTime: 0, gcTime: 5*60_1000 } as const;
}
function participantsOptions(room: Room) { return { queryKey: ['room', room.roomId, 'participants'] } as const; }

// hooks — thin useSyncExternalStore shims (already in packages/react/src/use-room-state.ts:18, use-join.ts:1)
function useRoomState<T>(room: Room, select?: (s: RoomSnapshot) => T): T // with Object.is gate (roomSnapshotsEqual:181, room.ts:742)
function useParticipants(room: Room, select?: (ps: RoomParticipantSnapshot[]) => unknown) => derived
function useSuspenseRoomState(room: Room): RoomSnapshot // throw join promise while status==='joining' (room.ts:157 JoinOptions.signal)
function useChat(room: Room) { return useMutation({ mutationFn: (text:string)=>room.sendChat(text), onMutate: optimistic }) }

// provider + deduping client (like QueryClient)
function VidcallProvider({ client, children }: { client: VidcallClient }) // caches Room by [roomId,selfId]
room.sendChat / sendReaction / setPresence gain isPending/error.code (typed VidcallError, not bare Error room.ts:708)
```

- `VidcallClient` solves StrictMode double-mount ghost (`Room.JoinOptions.signal:157` already handles abort — client adds dedup).
- Chat/reactions become separate cache keys with optimistic `setQueryData`, not emitter-only (`room.ts:392-393` explains they were excluded from snapshot — move to separate keys).
- Devtools: `@mbsks/openrtc-react-devtools` panel rendering `RoomSnapshot` tree + last-N envelope ring buffer (replaces single `debug` fn `room.ts:249`).

## Pre-1.0 gates

- [ ] `types:dist`, `files:["dist"]`, `exports["./package.json"]` everywhere.
- [ ] Dual ESM+CJS via `rslib` (start `protocol→transport→core`, rest mechanical).
- [ ] `publint` + `attw --pack` + `size-limit` in CI; `changeset publish` dry-run.
- [ ] `bun run --filter '*' test --if-present` replaces shell loop; CI Node pinned to 22+ (today `engines >=18.18` vs tests need 22.6).
- [ ] `BunSqliteStore` (`bun:sqlite`) alongside `better-sqlite3` if marketing Bun-first (Bun 1.4 crash noted in reviews).

All additive — `tsc -b` refs + `sideEffects:false` survive; `rslib`/`Bun.build` wrap existing layout.
