# Agent Note: Media and topology mesh to SFU

Status: implemented

Rationale: Room owned both signaling transport and N RTCPeerConnections with no seam, blocking WHIP/WHEP and SFU migration; simulcast/SVC/codec ranking and active-speaker were missing.

Files: `plans/03-media-topology.md` → `docs/plans/archive/03-media-topology.md`; behavior in `docs/media.md` + `packages/core/src/media/media-transport.ts:47` MediaTransport / `packages/core/src/media/mesh-transport.ts` / `packages/core/src/media/sfu-transport.ts` / `packages/core/src/media/topology.ts:11` TopologyController / `packages/core/src/media/processor.ts:20` ProcessorChain / `packages/core/src/media/active-speaker.ts` / `packages/core/src/media/whip-transport.ts:35` / `packages/sfu-gateway/src/sfu-gateway.ts:109` / `docs/architecture.md:32` wiring note.

Decisions: Room delegates publish/unpublish/subscribe to MediaTransport; MeshMediaTransport extracted from Room, SfuMediaTransport one PC to SfuSession with sfu envelope routing; TopologyController auto mesh→SFU at threshold 4, manual downgrade; processor order denoise→background→custom→e2ee last with Safari fallback warning; publish maps simulcast/svc/codecPreferences to WebRTC primitives, receiver layer via setPreferredLayers/requestKeyframe.
