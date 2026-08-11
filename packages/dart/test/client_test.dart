/// L1 unit tests for [VidcallClient] against an in-process dart:io WebSocket
/// signaling server (broadcast echo): envelope send/receive round-trip, seq
/// monotonicity, state transitions, and schema-level validation.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:vidcall/src/client.dart';
import 'package:vidcall/src/protocol/envelope.dart';
import 'package:vidcall/src/protocol/message_type.dart';
import 'package:vidcall/src/protocol/payloads.dart';

void main() {
  late HttpServer server;
  late Uri wsUri;
  final received = <Envelope>[];
  StreamSubscription<dynamic>? subscription;
  final sockets = <WebSocket>[];

  setUp(() async {
    received.clear();
    sockets.clear();
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    wsUri = Uri.parse('ws://127.0.0.1:${server.port}/signal');
    server.listen((HttpRequest request) async {
      if (WebSocketTransformer.isUpgradeRequest(request)) {
        final socket = await WebSocketTransformer.upgrade(request);
        sockets.add(socket);
        socket.listen(
          (dynamic data) {
            // Broadcast each frame back to every connected client so a client
            // sees its own envelopes (echo) and cross-client frames.
            for (final peer in sockets.toList()) {
              peer.add(data);
            }
          },
          onDone: () => sockets.remove(socket),
        );
      }
    });
  });

  tearDown(() async {
    await subscription?.cancel();
    for (final socket in sockets.toList()) {
      await socket.close();
    }
    await server.close(force: true);
  });

  test('connects, joins, and receives the echoed join envelope', () async {
    final client = VidcallClient(roomId: 'room-abc', senderId: 'user-42');
    subscription = client.events.listen(received.add);

    await client.connect(wsUri);
    expect(client.state, VidcallState.connected);
    expect(client.isConnected, isTrue);

    await client.join(displayName: 'Ada');

    final join = await client.events.firstWhere(
        (envelope) => envelope.type == MessageType.join);
    expect(join.roomId, 'room-abc');
    expect(join.senderId, 'user-42');
    expect(join.v, 1);
    expect(join.seq, 0);

    final payload = join.decodePayload()! as JoinPayload;
    expect(payload.displayName, 'Ada');

    await client.close();
    expect(client.state, VidcallState.closed);
  });

  test('seq is monotonic per sender across message types', () async {
    final client = VidcallClient(roomId: 'room-abc');
    subscription = client.events.listen(received.add);
    await client.connect(wsUri);

    await client.join();
    await client.sendChat('hi');
    await client.sendReaction('👋');
    await client.leave(reason: 'done');

    await Future<void>.delayed(const Duration(milliseconds: 100));
    final seqs = received.map((envelope) => envelope.seq).toList()..sort();
    expect(seqs, [0, 1, 2, 3]);
    expect(
      received.map((envelope) => envelope.type),
      containsAll([
        MessageType.join,
        MessageType.chat,
        MessageType.reaction,
        MessageType.leave,
      ]),
    );
    await client.close();
  });

  test('reaction and chat payloads round-trip through the wire', () async {
    final client = VidcallClient(roomId: 'room-abc', senderId: 'user-7');
    subscription = client.events.listen(received.add);
    await client.connect(wsUri);

    await client.sendReaction('🎉', targetSenderId: 'user-42');
    await client.sendChat('nice', replyTo: const ChatReply(senderId: 'user-42', seq: 0));

    await Future<void>.delayed(const Duration(milliseconds: 100));
    final reaction =
        received.firstWhere((envelope) => envelope.type == MessageType.reaction);
    final reactionPayload = reaction.decodePayload()! as ReactionPayload;
    expect(reactionPayload.emoji, '🎉');
    expect(reactionPayload.targetSenderId, 'user-42');

    final chat = received.firstWhere((envelope) => envelope.type == MessageType.chat);
    final chatPayload = chat.decodePayload()! as ChatPayload;
    expect(chatPayload.text, 'nice');
    expect(chatPayload.replyTo!.senderId, 'user-42');
    await client.close();
  });

  test('offer/answer/ice envelopes round-trip through the wire', () async {
    final client = VidcallClient(roomId: 'room-abc');
    subscription = client.events.listen(received.add);
    await client.connect(wsUri);

    await client.sendOffer(r'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n',
        label: 'main');
    await client.sendAnswer(r'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n');
    await client.sendIce('candidate:1 1 udp 1 127.0.0.1 9 typ host',
        sdpMid: '0', sdpMLineIndex: 0);

    await Future<void>.delayed(const Duration(milliseconds: 100));
    final offer = received.firstWhere((e) => e.type == MessageType.offer);
    expect((offer.decodePayload()! as SdpPayload).sdp, startsWith('v=0'));
    expect((offer.decodePayload()! as SdpPayload).label, 'main');

    final ice = received.firstWhere((e) => e.type == MessageType.ice);
    expect((ice.decodePayload()! as IcePayload).sdpMid, '0');
    expect((ice.decodePayload()! as IcePayload).sdpMLineIndex, 0);
    await client.close();
  });

  test('state transitions connecting -> connected -> closed', () async {
    final client = VidcallClient(roomId: 'room-abc');
    final states = <VidcallState>[];
    subscription = client.stateChanges.listen(states.add);

    await client.connect(wsUri);
    // Broadcast-stream events are delivered asynchronously: wait for the
    // final transition before asserting on the collected list.
    final sawClosed =
        client.stateChanges.firstWhere((s) => s == VidcallState.closed);
    await client.close();
    await sawClosed;

    expect(
      states,
      containsAll(
          [VidcallState.connecting, VidcallState.connected, VidcallState.closed]),
    );
    expect(states.first, VidcallState.connecting);
  });

  test('sending before connect throws StateError', () async {
    final client = VidcallClient(roomId: 'room-abc');
    expect(() => client.sendChat('too early'), throwsStateError);
  });

  test('chat text longer than schema maxLength is rejected', () async {
    final client = VidcallClient(roomId: 'room-abc');
    expect(() => client.sendChat('x' * (maxChatTextLength + 1)),
        throwsArgumentError);
  });

  test('malformed inbound JSON is surfaced on errors, not events', () async {
    final client = VidcallClient(roomId: 'room-abc');
    final errors = <Object>[];
    subscription = client.errors.listen(errors.add);
    await client.connect(wsUri);

    // A second connection injects garbage; the server broadcasts it to the
    // client connection.
    final socket = await WebSocket.connect(wsUri.toString());
    socket.add('this is not json');
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(errors, isNotEmpty);
    await socket.close();
    await client.close();
  });

  test('ping envelope carries no payload', () async {
    final client = VidcallClient(roomId: 'room-abc');
    subscription = client.events.listen(received.add);
    await client.connect(wsUri);

    await client.sendPing();
    await Future<void>.delayed(const Duration(milliseconds: 100));

    final ping = received.firstWhere((e) => e.type == MessageType.ping);
    expect(ping.payload, isNull);
    expect(jsonDecode(ping.encode()), isNot(contains('payload')));
    await client.close();
  });
}
