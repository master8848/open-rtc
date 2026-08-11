/// vidcall Dart/Flutter binding.
///
/// - [`Envelope`] and typed [`Payload`] classes mirror `protocol/schema.json`
///   (manual mapping; `decodePayload()` gives a typed view).
/// - [`VidcallClient`] is a backend-agnostic signaling client over
///   `dart:io` WebSocket with Stream-based events.
/// - [`VidcallRtcSession`] wires a `flutter_webrtc` peer connection
///   (offer/answer/ICE) to the signaling stream.
library vidcall;

export 'src/client.dart';
export 'src/protocol/envelope.dart';
export 'src/protocol/message_type.dart';
export 'src/protocol/payloads.dart';
