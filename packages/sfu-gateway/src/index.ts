/**
 * @mbsks/openrtc-sfu-gateway — optional SFU path for vidcall (docs/architecture.md D2).
 *
 * Public surface:
 *  - `SfuGateway` / `SfuSession`: the transport-agnostic, media-agnostic
 *    contract (join / publishTrack / subscribe / onTrack / leave; SDP and ICE
 *    passed through untouched).
 *  - `SfuRouter`: consumes the protocol's `sfu` envelopes plus
 *    `offer`/`answer`/`ice` envelopes addressed to the SFU; validates room
 *    membership; forwards to the gateway; emits typed events. Pure logic.
 *  - `MediasoupAdapter`: reference adapter mapping the contract onto a
 *    mediasoup `Router` (dev-only dependency; integration tests env-gated).
 *  - minimal SDP helpers (`parseSdp`, `dtlsParametersFromSdp`,
 *    `minimalRtpParameters`, `buildSdpAnswer`) used by the reference adapter.
 */
export * from './sfu-gateway.ts';
export * from './sfu-router.ts';
export * from './mediasoup-adapter.ts';
export * from './sdp.ts';
export * from './transcription-worker.ts';
export { TypedEmitter, type EventMap } from './events.ts';
