# vidcall

JS/TS video-calling library for vibe coders: add video calls, reactions, and a
simple Zoom clone to any app with pluggable backends (Supabase, Convex,
PostgreSQL, SQLite, Appwrite, Firebase, ...). Adaptive quality switches by
network speed AND device capability, with warnings. Native bindings: Kotlin,
Swift, Dart (Flutter). Shared wire protocol in protocol/schema.json.

Status: implementation in progress (see docs/architecture.md).

## Packages

| Package              | What it is                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@vidcall/core`      | client mesh engine (rooms, perfect negotiation, quality policy)                                                                                                                                         |
| `@vidcall/server`    | **backend component**: rooms/sessions, signaling relay, recording storage — hosts inside Express/Fastify or as a sidecar for Django/Laravel/Rails; works with any database via a function-based `Store` |
| `@vidcall/transport` | signaling transport contract + helpers + shared adapter suite                                                                                                                                           |
| `@vidcall/protocol`  | shared wire protocol (schema.json + TS mirror)                                                                                                                                                          |

`@vidcall/server` lives in `packages/server/` (its README has the REST/WS API,
Store contract, and supply-chain table); hosting guides are in
[`integrations/`](integrations/README.md).
