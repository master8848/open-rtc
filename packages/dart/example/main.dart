/// Minimal vidcall usage example.
///
/// Run inside a Flutter app (the WebRTC session requires a Flutter device).
/// The signaling-only part also runs on the Dart VM with `dart run`.
library;

import 'package:vidcall/vidcall.dart';

Future<void> main() async {
  // 1. Signaling client -----------------------------------------------------
  final client = VidcallClient(roomId: 'room-abc', senderId: 'user-42');

  client.events.listen((envelope) {
    final payload = envelope.decodePayload();
    if (payload is ChatPayload) {
      print('${envelope.senderId}: ${payload.text}');
    } else if (payload is ReactionPayload) {
      print('${envelope.senderId} reacted ${payload.emoji}');
    } else if (payload is ErrorPayload) {
      print('error ${payload.code}: ${payload.message}');
    }
  });

  await client.connect(Uri.parse('wss://signal.example.com'));
  await client.join(displayName: 'Ada');

  // 2. WebRTC session -------------------------------------------------------
  final session = VidcallRtcSession(client: client); // polite peer
  await session.start();

  final local = await VidcallRtcSession.captureLocalMedia();
  await session.addLocalStream(local);

  session.onTrack.listen((event) {
    // Attach event.streams.first to an RTCVideoView for rendering.
    print('remote track: ${event.track.kind} (${event.track.id})');
  });

  // 3. Chat + reactions over the same signaling channel ---------------------
  await client.sendChat('hello everyone');
  await client.sendReaction('👋');

  // 4. Teardown --------------------------------------------------------------
  await session.dispose();
  await client.leave(reason: 'done');
  await client.close();
}
