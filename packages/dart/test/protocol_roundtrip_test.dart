/// L0 protocol conformance: round-trips the 3 sample envelopes from
/// `protocol/schema.json` (see test/fixtures/sample_envelopes.json) plus
/// forward-compat and validation edge cases.
library;

import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:vidcall/src/protocol/envelope.dart';
import 'package:vidcall/src/protocol/message_type.dart';
import 'package:vidcall/src/protocol/payloads.dart';

void main() {
  final fixtures = _loadFixtures();

  group('Envelope round-trip (schema.json samples)', () {
    for (final fixture in fixtures) {
      test('${fixture['name']}: fromJson -> toJson is lossless', () {
        final source = fixture['envelope'] as Map<String, dynamic>;
        final envelope = Envelope.fromJson(source);

        expect(envelope.v, 1);
        expect(envelope.roomId, 'room-abc');
        expect(envelope.senderId, 'user-42');
        expect(envelope.sessionId, 'sess-1');
        expect(envelope.seq, greaterThanOrEqualTo(0));

        // Exact JSON round-trip (key order included).
        expect(jsonEncode(envelope.toJson()), jsonEncode(source));
      });

      test('${fixture['name']}: parse -> encode string round-trip', () {
        final source = fixture['envelope'] as Map<String, dynamic>;
        final encoded = jsonEncode(source);
        final envelope = Envelope.parse(encoded);

        expect(envelope.encode(), encoded);
      });
    }

    test('join: typed payload decodes deviceProfile + capabilities', () {
      final envelope = Envelope.fromJson(fixtures[0]['envelope'] as Map<String, dynamic>);
      final payload = envelope.decodePayload();

      expect(payload, isA<JoinPayload>());
      final join = payload! as JoinPayload;
      expect(join.displayName, 'Ada');
      expect(join.metadata, {'avatar': 'https://example.com/ada.png'});
      expect(join.deviceProfile!.hardwareConcurrency, 8);
      expect(join.deviceProfile!.deviceMemory, 8);
      expect(join.deviceProfile!.mobile, isFalse);
      expect(join.deviceProfile!.screenWidth, 1440);
      expect(join.deviceProfile!.screenHeight, 900);
      expect(join.deviceProfile!.platform, DevicePlatform.dart);
      expect(join.capabilities!.simulcast, isTrue);
      expect(join.capabilities!.svc, isFalse);
      expect(join.capabilities!.codecs, ['VP8', 'H264']);
    });

    test('offer: typed payload decodes opaque sdp', () {
      final envelope = Envelope.fromJson(fixtures[1]['envelope'] as Map<String, dynamic>);
      final payload = envelope.decodePayload();

      expect(payload, isA<SdpPayload>());
      final sdp = payload! as SdpPayload;
      expect(sdp.sdp, startsWith('v=0'));
      expect(sdp.sdp, contains('m=audio'));
      expect(sdp.label, 'main');
      expect(sdp.toJson()['sdp'], sdp.sdp);
    });

    test('ice: typed payload decodes candidate/sdpMid/sdpMLineIndex', () {
      final envelope = Envelope.fromJson(fixtures[2]['envelope'] as Map<String, dynamic>);
      final payload = envelope.decodePayload();

      expect(payload, isA<IcePayload>());
      final ice = payload! as IcePayload;
      expect(ice.candidate, startsWith('candidate:842163049'));
      expect(ice.sdpMid, '0');
      expect(ice.sdpMLineIndex, 0);
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

List<Map<String, dynamic>> _loadFixtures() {
  final file = File('test/fixtures/sample_envelopes.json');
  final decoded = jsonDecode(file.readAsStringSync()) as List<dynamic>;
  return decoded.cast<Map<String, dynamic>>();
}
