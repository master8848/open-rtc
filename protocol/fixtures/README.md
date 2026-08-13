# Canonical wire fixtures (L0 conformance)

Single source of truth for vidcall wire envelopes, mirroring
`protocol/schema.json` one-to-one. Every binding's L0 conformance suite
(Kotlin `packages/kotlin/vidcall-protocol`, plus the Swift/Dart/TS mirrors)
parses **these same files**, so a drift between bindings shows up here first.

## Naming

- `<type>.json` — room-broadcast envelope (no `targetSenderId` key).
- `<type>-targeted.json` — unicast variant (`targetSenderId: "user-ada"`),
  for the signal types that support unicast: join/leave/offer/answer/ice/
  presence/reaction/chat.
- `ping.json` / `pong.json` carry **no** `payload` key (schema wire rule).
- All fixtures: `v: 1`, `roomId: "room-42"`, senders `user-ada` / `user-bob`,
  sessions `sess-abc-0001` / `sess-xyz-0002`, `seq` 0-based monotonic.

## Validation

Every fixture validates against `protocol/schema.json` (draft-07, including
the `if/then` payload shape rules). Re-encoding a decoded fixture must
reproduce the fixture bytes semantically (checked by the Kotlin L0 suite).

## Adding a type

1. Add the `type` to the schema enum + payload definition in `schema.json`.
2. Add `<type>.json` (and `<type>-targeted.json` when the schema allows
   unicast) here.
3. Extend `fixtureNames` in the Kotlin `EnvelopeSerializationTest` and the
   equivalent lists in the Swift/Dart/TS conformance suites.
