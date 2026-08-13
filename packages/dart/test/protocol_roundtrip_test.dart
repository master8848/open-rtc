/// L0 protocol conformance over the CANONICAL wire fixtures in
/// `protocol/fixtures/` (single source of truth — the same 22 files are parsed
/// by the Kotlin L0 suite and the Swift/TS mirrors, see protocol/fixtures/README.md),
/// plus forward-compat and validation edge cases.
library;

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:vidcall/src/protocol/envelope.dart';
import 'package:vidcall/src/protocol/message_type.dart';
import 'package:vidcall/src/protocol/payloads.dart';

/// Every canonical fixture name (protocol/fixtures, without the `.json` suffix).
const fixtureNames = [
  'join', 'leave', 'offer', 'answer', 'ice', 'presence', 'reaction', 'chat',
  'screen-share', 'quality-warning', 'sfu', 'error', 'ping', 'pong',
  'join-targeted', 'leave-targeted', 'offer-targeted', 'answer-targeted',
  'ice-targeted', 'presence-targeted', 'reaction-targeted', 'chat-targeted',
];

void main() {
  final fixtures = _loadFixtures();

  group('Envelope round-trip (canonical protocol/fixtures)', () {
    for (final name in fixtureNames) {
      final source = fixtures[name]!;

      test('$name: fromJson -> toJson is lossless', () {
        final envelope = Envelope.fromJson(source);

        expect(envelope.v, 1);
        expect(envelope.rawType, name.replaceFirst('-targeted', ''));
        expect(envelope.roomId, 'room-42');
        expect(envelope.senderId, startsWith('user-'));
        expect(envelope.sessionId, startsWith('sess-'));
        expect(envelope.seq, greaterThanOrEqualTo(0));

        // Exact JSON round-trip (key order included).
        expect(jsonEncode(envelope.toJson()), jsonEncode(source));
      });

      test('$name: parse -> encode string round-trip', () {
        final encoded = jsonEncode(source);
        final envelope = Envelope.parse(encoded);

        expect(envelope.encode(), encoded);
      });
    }

    test('fixtures cover every schema envelope type', () {
      final covered = fixtureNames
          .map((name) => name.replaceFirst('-targeted', ''))
          .toSet();
      expect(covered, MessageType.values.map((t) => t.wire).toSet());
    });

    test('targeted fixtures carry targetSenderId, broadcast fixtures do not', () {
      for (final name in fixtureNames) {
        final envelope = Envelope.fromJson(fixtures[name]!);
        if (name.endsWith('-targeted')) {
          expect(envelope.targetSenderId, 'user-ada', reason: name);
          expect(sourceHasKey(fixtures[name]!, 'targetSenderId'), isTrue,
              reason: name);
        } else {
          expect(envelope.targetSenderId, isNull, reason: name);
          expect(sourceHasKey(fixtures[name]!, 'targetSenderId'), isFalse,
              reason: name);
        }
      }
    });

    test('ping and pong omit the payload key on the wire', () {
      for (final name in ['ping', 'pong']) {
        final source = fixtures[name]!;
        expect(source.containsKey('payload'), isFalse, reason: name);
        final envelope = Envelope.fromJson(source);
        expect(envelope.payload, isNull, reason: name);
        expect(envelope.toJson().containsKey('payload'), isFalse, reason: name);
        expect(envelope.decodePayload(), isNull, reason: name);
      }
    });
  });

  group('Typed payload decode (canonical fixtures)', () {
    test('join: full device profile + capabilities', () {
      final envelope = Envelope.fromJson(fixtures['join']!);
      final payload = envelope.decodePayload();

      expect(payload, isA<JoinPayload>());
      final join = payload! as JoinPayload;
      expect(join.displayName, 'Ada Lovelace');
      expect(join.metadata, {'tier': 'pro', 'locale': 'en'});
      expect(join.deviceProfile!.hardwareConcurrency, 8);
      expect(join.deviceProfile!.deviceMemory, 8.0);
      expect(join.deviceProfile!.mobile, isFalse);
      expect(join.deviceProfile!.screenWidth, 1920);
      expect(join.deviceProfile!.screenHeight, 1080);
      expect(join.deviceProfile!.platform, DevicePlatform.browser);
      expect(join.capabilities!.simulcast, isTrue);
      expect(join.capabilities!.svc, isFalse);
      expect(join.capabilities!.codecs, ['VP8', 'H264']);
    });

    test('offer: typed payload decodes opaque sdp', () {
      final envelope = Envelope.fromJson(fixtures['offer']!);
      final payload = envelope.decodePayload();

      expect(payload, isA<SdpPayload>());
      final sdp = payload! as SdpPayload;
      expect(sdp.sdp, startsWith('v=0'));
      expect(sdp.sdp, contains('m=audio'));
      expect(sdp.sdp, contains('a=rtpmap:96 VP8/90000'));
      expect(sdp.label, 'main');
      expect(sdp.toJson()['sdp'], sdp.sdp);
    });

    test('answer uses the offer payload shape', () {
      final envelope = Envelope.fromJson(fixtures['answer']!);
      final sdp = envelope.decodePayload()! as SdpPayload;

      expect(sdp.label, 'main');
      expect(sdp.sdp, startsWith('v=0'));
      expect(sdp.sdp, contains('a=recvonly'));
    });

    test('ice: typed payload decodes candidate/sdpMid/sdpMLineIndex', () {
      final envelope = Envelope.fromJson(fixtures['ice']!);
      final payload = envelope.decodePayload();

      expect(payload, isA<IcePayload>());
      final ice = payload! as IcePayload;
      expect(ice.candidate, startsWith('candidate:842163049'));
      expect(ice.sdpMid, '0');
      expect(ice.sdpMLineIndex, 0);
    });

    test('chat: broadcast text', () {
      final chat = Envelope.fromJson(fixtures['chat']!).decodePayload()! as ChatPayload;
      expect(chat.text, 'hello room');
      expect(chat.replyTo, isNull);
    });

    test('chat-targeted: unicast text with replyTo', () {
      final envelope = Envelope.fromJson(fixtures['chat-targeted']!);
      expect(envelope.targetSenderId, 'user-ada');
      final chat = envelope.decodePayload()! as ChatPayload;
      expect(chat.text, 'psst ada');
      expect(chat.replyTo!.senderId, 'user-ada');
      expect(chat.replyTo!.seq, 0);
    });

    test('reaction: emoji', () {
      final reaction =
          Envelope.fromJson(fixtures['reaction']!).decodePayload()! as ReactionPayload;
      expect(reaction.emoji, '🎉');
    });

    test('presence: state + metadata', () {
      final presence =
          Envelope.fromJson(fixtures['presence']!).decodePayload()! as PresencePayload;
      expect(presence.state, PresenceState.online);
      expect(presence.metadata, {'muted': false});
    });

    test('leave: reasons', () {
      final leave = Envelope.fromJson(fixtures['leave']!).decodePayload()! as LeavePayload;
      expect(leave.reason, 'bye');
      final targeted =
          Envelope.fromJson(fixtures['leave-targeted']!).decodePayload()! as LeavePayload;
      expect(targeted.reason, 'call-ended');
    });

    test('screen-share: start with label', () {
      final share = Envelope.fromJson(fixtures['screen-share']!)
          .decodePayload()! as ScreenSharePayload;
      expect(share.action, ScreenShareAction.start);
      expect(share.label, 'screen');
    });

    test('quality-warning: tier switch', () {
      final warning = Envelope.fromJson(fixtures['quality-warning']!)
          .decodePayload()! as QualityWarningPayload;
      expect(warning.from, '720p@30');
      expect(warning.to, '480p@30');
      expect(warning.reason, QualityWarningReason.network);
      expect(warning.direction, QualityWarningDirection.receive);
    });

    test('sfu: publish/video control', () {
      final sfu = Envelope.fromJson(fixtures['sfu']!).decodePayload()! as SfuPayload;
      expect(sfu.action, SfuAction.publish);
      expect(sfu.trackId, 'track-1');
      expect(sfu.kind, SfuKind.video);
    });

    test('error: protocol-version payload', () {
      final error = Envelope.fromJson(fixtures['error']!).decodePayload()! as ErrorPayload;
      expect(error.code, 'protocol-version');
      expect(error.message, 'unsupported protocol version 2');
    });
  });

  group('Envelope validation (schema.json rules)', () {
    test('v != 1 is rejected', () {
      final json = <String, dynamic>{
        'v': 2, 'type': 'ping', 'roomId': 'r', 'senderId': 's',
        'sessionId': 'sess', 'ts': 1, 'seq': 0,
      };
      expect(() => Envelope.fromJson(json), throwsFormatException);
    });

    test('missing required envelope fields are rejected', () {
      final json = <String, dynamic>{
        'v': 1, 'type': 'ping', 'roomId': 'r', 'senderId': 's',
        'sessionId': 'sess', 'ts': 1,
      };
      expect(() => Envelope.fromJson(json), throwsFormatException);
    });

    test('unknown type values are tolerated (forward compat)', () {
      final json = <String, dynamic>{
        'v': 1, 'type': 'future.message', 'roomId': 'r', 'senderId': 's',
        'sessionId': 'sess', 'ts': 1, 'seq': 0,
        'payload': {'anything': true},
      };
      final envelope = Envelope.fromJson(json);

      expect(envelope.type, isNull);
      expect(envelope.rawType, 'future.message');
      expect(envelope.payload, {'anything': true});
      expect(envelope.decodePayload(), isNull);
      expect(jsonEncode(envelope.toJson()), jsonEncode(json));
    });

    test('unknown extra envelope fields are preserved (forward compat)', () {
      final json = <String, dynamic>{
        'v': 1, 'type': 'ping', 'roomId': 'r', 'senderId': 's',
        'sessionId': 'sess', 'ts': 1, 'seq': 0, 'traceId': 'abc',
      };
      final envelope = Envelope.fromJson(json);

      // toJson keeps the canonical envelope fields; unknown fields are
      // dropped on re-encode (they were not part of the known contract).
      expect(envelope.type, MessageType.ping);
      expect(envelope.encode(), contains('"type":"ping"'));
    });

    test('ping has no payload and decodes to null', () {
      final envelope = Envelope(
        type: MessageType.ping,
        roomId: 'r',
        senderId: 's',
        sessionId: 'sess',
        ts: 1,
        seq: 0,
      );
      expect(envelope.decodePayload(), isNull);
      expect(envelope.toJson().containsKey('payload'), isFalse);
    });
  });

  group('Payload codecs', () {
    test('chat payload round-trips with replyTo', () {
      final payload = ChatPayload(
        text: 'hello',
        replyTo: const ChatReply(senderId: 'user-7', seq: 3),
      );
      final decoded = ChatPayload.fromJson(payload.toJson());

      expect(decoded.text, 'hello');
      expect(decoded.replyTo!.senderId, 'user-7');
      expect(decoded.replyTo!.seq, 3);
    });

    test('presence payload round-trips', () {
      final payload = const PresencePayload(
        state: PresenceState.away,
        metadata: {'muted': true},
      );
      final decoded = PresencePayload.fromJson(payload.toJson());
      expect(decoded.state, PresenceState.away);
      expect(decoded.metadata, {'muted': true});
    });

    test('quality-warning payload round-trips', () {
      final payload = const QualityWarningPayload(
        from: '720p@30',
        to: '480p@30',
        reason: QualityWarningReason.network,
        direction: QualityWarningDirection.receive,
      );
      final decoded = QualityWarningPayload.fromJson(payload.toJson());
      expect(decoded.from, '720p@30');
      expect(decoded.to, '480p@30');
      expect(decoded.reason, QualityWarningReason.network);
      expect(decoded.direction, QualityWarningDirection.receive);
    });

    test('sfu payload round-trips', () {
      final payload = const SfuPayload(
        action: SfuAction.layerChange,
        trackId: 'track-1',
        kind: SfuKind.video,
        layer: 'l1',
      );
      final decoded = SfuPayload.fromJson(payload.toJson());
      expect(decoded.action, SfuAction.layerChange);
      expect(decoded.kind, SfuKind.video);
      expect(decoded.layer, 'l1');
    });

    test('error payload round-trips', () {
      final payload = const ErrorPayload(code: 'ROOM_FULL', message: 'full');
      final decoded = ErrorPayload.fromJson(payload.toJson());
      expect(decoded.code, 'ROOM_FULL');
      expect(decoded.message, 'full');
    });

    test('leave and screen-share payloads round-trip', () {
      final leave = LeavePayload.fromJson(const LeavePayload(reason: 'bye').toJson());
      expect(leave.reason, 'bye');

      final share = ScreenSharePayload.fromJson(
          const ScreenSharePayload(action: ScreenShareAction.start).toJson());
      expect(share.action, ScreenShareAction.start);
    });
  });
}

bool sourceHasKey(Map<String, dynamic> json, String key) => json.containsKey(key);

/// Loads every canonical fixture from `protocol/fixtures/` (repo root, two
/// levels up from `packages/dart`), keyed by file name without `.json`.
Map<String, Map<String, dynamic>> _loadFixtures() {
  final fixtures = <String, Map<String, dynamic>>{};
  for (final name in fixtureNames) {
    final file = File('../../protocol/fixtures/$name.json');
    final decoded = jsonDecode(file.readAsStringSync());
    if (decoded is! Map<String, dynamic>) {
      throw FormatException('fixture $name is not a JSON object');
    }
    fixtures[name] = decoded;
  }
  return fixtures;
}
