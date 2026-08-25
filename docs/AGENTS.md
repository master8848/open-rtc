# Agent rules — vidcall docs

Reference: standing rules for docs and notes. Tutorial-facing guides live elsewhere.

Fact homes: rationale → `.agents/notes/implemented/{class}/YYYY-MM-DD-slug.md`; current behavior → `docs/` reference pages; operator env vars → `packages/server/README.md` and `docs/limits.md`; standing rules → this file. Elsewhere link, do not duplicate.

Doc types: reference = current behavior with file anchors; tutorial = step-by-step guide. This file and `docs/architecture.md`, `docs/security.md`, `docs/recording.md`, `docs/media.md`, `docs/transport.md`, `docs/limits.md`, `docs/testing.md`, `docs/features/*.md` are references. `docs/getting-started.md` is a tutorial.

Writing rules: describe current state, not history. One physical line per paragraph. Concrete prose with exact crates/files/env vars/flags, no metaphors. No reasoning transcripts or worklog narration.

Change rules: non-trivial changes carry an Agent Note in the same change, uniform format `# Agent Note: <title>` then blank line `Status: implemented` then rationale/files/decisions, then delete worklog.

Slop audit: duplicated facts, narrated history, status annotations, hand-restated source, emphasis inflation, paragraph walls.

Verification: every relative link resolves; word budgets hold; note header is exactly `# Agent Note: <title>` blank `Status: implemented`.

Budgets: `docs/AGENTS.md` ≤1000 words; `docs/architecture.md` ≤1800 (current ~1560); `docs/limits.md` ≤600 (current ~455); `docs/testing.md` ≤1000 (current ~620); `docs/features/*.md` ≤2200 each (current 1850-2020); `.agents/notes/README.md` ≤500. Over budget: relocate to correct home, condense, then raise budget with justification.

Links: `docs/architecture.md` is the topology overview; `docs/security.md` is auth/E2EE/TURN; `docs/recording.md` is storage/recording; `docs/media.md` is MediaTransport/topology/processors; `docs/transport.md` is resilience/relays (details in `docs/limits.md`); `packages/server/README.md` is REST/Store/relay operator surface.
