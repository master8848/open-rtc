/// The wire envelope defined in `protocol/schema.json`.
///
/// Every message on the signaling channel is a JSON object with a fixed set of
/// envelope fields (`v`, `type`, `roomId`, `senderId`, `sessionId`, `ts`,
/// `seq`) plus an optional `payload` object. Servers and clients ignore
/// unknown fields (forward compatibility) and must tolerate unknown `type`
/// values.
library;

import 'dart:convert';

import 'message_type.dart';
import 'payloads.dart';

/// A single signaling message: the shared envelope + optional payload.
///
/// The payload is kept as the raw JSON map (so unknown/forward-compatible
/// payloads survive a round trip untouched) and can be decoded into a typed
/// [`Payload`] via [`Envelope.decodePayload`].
class Envelope {
  Envelope({
    this.v = protocolVersion,
    required this.type,
    String? rawType,
    required this.roomId,
    required this.senderId,
    required this.sessionId,
    required this.ts,
    required this.seq,
    this.payload,
  }) : rawType = rawType ?? type?.wire ?? '';

  /// Current protocol version (`v` is `const 1` in schema.json).
  static const int protocolVersion = 1;

  /// Protocol version carried on the wire.
  final int v;

  /// Known message type, or `null` for unknown (forward-compatible) types.
  final MessageType? type;

  /// The exact `type` string as received/emitted on the wire.
  final String rawType;

  /// Room this message belongs to.
  final String roomId;

  /// Sender identity (stable across sessions).
  final String senderId;

  /// Session identity (per-connection).
  final String sessionId;

  /// Epoch milliseconds.
  final int ts;

  /// Monotonic per sender; the engine dedupes/reorders on it.
  final int seq;

  /// Raw payload object, or `null` for payload-less messages (e.g. `ping`).
  final Map<String, dynamic>? payload;

  /// Decodes `payload` into its typed [`Payload`] subclass, or `null` when
  /// the payload is absent or the `type` is not one of the known types.
  Payload? decodePayload() {
    final raw = payload;
    if (raw == null) {
      return null;
    }
    switch (type) {
      case MessageType.join:
        return JoinPayload.fromJson(raw);
      case MessageType.leave:
        return LeavePayload.fromJson(raw);
      case MessageType.offer:
      case MessageType.answer:
        return SdpPayload.fromJson(raw);
      case MessageType.ice:
        return IcePayload.fromJson(raw);
      case MessageType.presence:
        return PresencePayload.fromJson(raw);
      case MessageType.reaction:
        return ReactionPayload.fromJson(raw);
      case MessageType.chat:
        return ChatPayload.fromJson(raw);
      case MessageType.screenShare:
        return ScreenSharePayload.fromJson(raw);
      case MessageType.qualityWarning:
        return QualityWarningPayload.fromJson(raw);
      case MessageType.sfu:
        return SfuPayload.fromJson(raw);
      case MessageType.error:
        return ErrorPayload.fromJson(raw);
      case MessageType.ping:
      case MessageType.pong:
      case null:
        return null;
    }
  }

  /// Parses a JSON string into an [Envelope].
  factory Envelope.parse(String source) {
    final decoded = jsonDecode(source);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('envelope must be a JSON object');
    }
    return Envelope.fromJson(decoded);
  }

  /// Builds an [Envelope] from a decoded JSON object, validating the
  /// envelope fields required by schema.json.
  factory Envelope.fromJson(Map<String, dynamic> json) {
    final v = json['v'];
    if (v is! int || v != protocolVersion) {
      throw FormatException('unsupported protocol version: $v');
    }
    final typeValue = json['type'];
    if (typeValue is! String || typeValue.isEmpty) {
      throw const FormatException('envelope is missing a "type"');
    }
    final payloadValue = json['payload'];
    return Envelope(
      v: v,
      type: MessageType.tryParse(typeValue),
      rawType: typeValue,
      roomId: _requireString(json, 'roomId'),
      senderId: _requireString(json, 'senderId'),
      sessionId: _requireString(json, 'sessionId'),
      ts: _requireInt(json, 'ts'),
      seq: _requireInt(json, 'seq'),
      payload: payloadValue is Map<String, dynamic>
          ? payloadValue
          : payloadValue == null
              ? null
              : Map<String, dynamic>.from(payloadValue as Map),
    );
  }

  /// Serializes this envelope to a JSON string.
  String encode() => jsonEncode(toJson());

  /// Serializes this envelope to a JSON object.
  Map<String, dynamic> toJson() {
    return {
      'v': v,
      'type': rawType,
      'roomId': roomId,
      'senderId': senderId,
      'sessionId': sessionId,
      'ts': ts,
      'seq': seq,
      if (payload != null) 'payload': payload,
    };
  }

  @override
  String toString() => 'Envelope($rawType seq=$seq room=$roomId)';

  static String _requireString(Map<String, dynamic> json, String key) {
    final value = json[key];
    if (value is String) {
      return value;
    }
    throw FormatException('envelope is missing string field "$key"');
  }

  static int _requireInt(Map<String, dynamic> json, String key) {
    final value = json[key];
    if (value is int) {
      return value;
    }
    throw FormatException('envelope is missing integer field "$key"');
  }
}
