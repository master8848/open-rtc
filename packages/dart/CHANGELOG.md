## 0.1.0

- Initial release.
- Protocol models mirroring `protocol/schema.json` (envelope + all payloads,
  manual mapping, forward-compatible unknown `type` tolerance).
- `VidcallClient`: backend-agnostic signaling over `dart:io` WebSocket with
  join/leave/reaction/chat/offer/answer/ICE/presence/screen-share/
  quality-warning/SFU/ping methods and Stream-based events.
- `VidcallRtcSession`: `flutter_webrtc: 1.5.2` peer connection wired to the
  signaling stream (perfect-negotiation glare handling, trickle ICE).
