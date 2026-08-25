# Agent Note: Packaging and DX

Status: implemented

Rationale: 16 packages private not on npm, exports map inconsistent, types pointed at src breaking are-the-types-wrong, no CJS dual, no publint/attw gate, core zero-dep isolation needed auditing.

Files: `plans/05-packaging-dx.md` → `docs/plans/archive/05-packaging-dx.md`; fixes in `packages/server/package.json` exports + `packages/core/package.json` types/dist + `packages/transport/package.json:10` exports + `docs/architecture.md` monorepo layout; standing rules in `docs/AGENTS.md` budgets.

Decisions: canonical exports with types/import/require/development + package.json entry, files:["dist"], sideEffects:false; backend SDKs as dependencies (one per adapter), server drivers as optional peers with lazy await import; keep tsc -b, rslib only for publish artifacts; TanStack-inspired roomOptions/select/suspense client patterns stay additive.
