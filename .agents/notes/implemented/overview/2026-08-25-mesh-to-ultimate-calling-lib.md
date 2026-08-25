# Agent Note: Mesh → Ultimate Calling Lib overview

Status: implemented

Rationale: 0.1.0 mesh-only caps at 4 participants O(N²); SfuGateway scaffold not wired via Room, RoomHub/InMemoryStore in-process, NOTIFY 7KB chunker without WS coalescing, single SignalingTransport path. Target 1:1/mesh 2-4/SFU 5-500/auto, flexible media/transport, horizontal relay, pay-for-what-you-use bundles drove 5 additive phases.

Files: `plans/00-overview.md` archived to `docs/plans/archive/00-overview.md`; current behavior split to `docs/architecture.md` (topology overview), `docs/media.md` (MediaTransport seam), `docs/transport.md` (relay/composite), `docs/security.md` (token/E2EE/TURN), `docs/recording.md` (storage), `docs/limits.md` (backend matrix), `packages/server/README.md` (REST/Store operator surface).

Decisions: additive phases independently shippable, no Rust client until JS relay >10k rooms, bun+tsc -b stay source of truth, sideEffects:false + exports subpaths for tree-shaking, protocol JSON Schema remains single source.
