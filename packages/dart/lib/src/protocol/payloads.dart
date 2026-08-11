/// Typed payloads mirroring the `definitions` of `protocol/schema.json`.
///
/// Every payload class is a manual mapping of the JSON Schema definition:
/// required fields are non-nullable constructor parameters, optional fields
/// are nullable, and `toJson()` omits fields that were not set (matching the
/// wire behaviour of the JS/Kotlin/Swift bindings).
library;

import 'dart:convert';

/// Base class for all typed envelope payloads.
sealed class Payload {
  const Payload();

  /// Serializes this payload to the JSON object carried in `envelope.payload`.
  Map<String, dynamic> toJson();
}

/// `DeviceProfile` — device capability snapshot sent at join time.
class DeviceProfile {
  const DeviceProfile({
    required this.hardwareConcurrency,
    required this.mobile,
    this.deviceMemory,
    this.screenWidth,
    this.screenHeight,
    this.platform,
  });

  /// `hardwareConcurrency` (>= 1).
  final int hardwareConcurrency;

  /// `deviceMemory` in GB (Chrome-only; schema type `number`).
  final num? deviceMemory;

  /// `mobile` — is this a mobile device?
  final bool mobile;

  /// `screenWidth` in CSS pixels.
  final int? screenWidth;

  /// `screenHeight` in CSS pixels.
  final int? screenHeight;

  /// `platform` — which binding produced this profile.
  final DevicePlatform? platform;

  factory DeviceProfile.fromJson(Map<String, dynamic> json) {
    return DeviceProfile(
      hardwareConcurrency: _asInt(json, 'hardwareConcurrency'),
      mobile: _asBool(json, 'mobile'),
      deviceMemory: json['deviceMemory'] == null
          ? null
          : (json['deviceMemory'] as num),
      screenWidth: json['screenWidth'] == null
          ? null
          : (json['screenWidth'] as num).toInt(),
      screenHeight: json['screenHeight'] == null
          ? null
          : (json['screenHeight'] as num).toInt(),
      platform: json['platform'] == null
          ? null
          : DevicePlatform.tryParse(json['platform'] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'hardwareConcurrency': hardwareConcurrency,
      'mobile': mobile,
      if (deviceMemory != null) 'deviceMemory': deviceMemory,
      if (screenWidth != null) 'screenWidth': screenWidth,
      if (screenHeight != null) 'screenHeight': screenHeight,
      if (platform != null) 'platform': platform!.wire,
    };
  }
}

/// `deviceProfile.platform` — which binding produced the profile.
enum DevicePlatform {
  browser('browser'),
  node('node'),
  kotlin('kotlin'),
  swift('swift'),
  dart('dart');

  const DevicePlatform(this.wire);

  final String wire;

  static DevicePlatform? tryParse(String wire) {
    for (final platform in DevicePlatform.values) {
      if (platform.wire == wire) {
        return platform;
      }
    }
    return null;
  }
}

/// `capabilities` — media capabilities advertised at join time.
class Capabilities {
  const Capabilities({this.simulcast, this.svc, this.codecs});

  final bool? simulcast;
  final bool? svc;

  /// Codec names, e.g. `['VP8', 'H264']`.
  final List<String>? codecs;

  factory Capabilities.fromJson(Map<String, dynamic> json) {
    return Capabilities(
      simulcast: json['simulcast'] == null
          ? null
          : json['simulcast'] as bool,
      svc: json['svc'] == null ? null : json['svc'] as bool,
      codecs: json['codecs'] == null
          ? null
          : (json['codecs'] as List<dynamic>).cast<String>(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      if (simulcast != null) 'simulcast': simulcast,
      if (svc != null) 'svc': svc,
      if (codecs != null) 'codecs': codecs,
    };
  }
}

/// `JoinPayload` — sent by a client entering a room.
class JoinPayload extends Payload {
  const JoinPayload({
    this.displayName,
    this.metadata,
    this.deviceProfile,
    this.capabilities,
  });

  final String? displayName;
  final Map<String, dynamic>? metadata;
  final DeviceProfile? deviceProfile;
  final Capabilities? capabilities;

  factory JoinPayload.fromJson(Map<String, dynamic> json) {
    return JoinPayload(
      displayName: json['displayName'] as String?,
      metadata: json['metadata'] == null
          ? null
          : Map<String, dynamic>.from(json['metadata'] as Map),
      deviceProfile: json['deviceProfile'] == null
          ? null
          : DeviceProfile.fromJson(
              Map<String, dynamic>.from(json['deviceProfile'] as Map)),
      capabilities: json['capabilities'] == null
          ? null
          : Capabilities.fromJson(
              Map<String, dynamic>.from(json['capabilities'] as Map)),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      if (displayName != null) 'displayName': displayName,
      if (metadata != null) 'metadata': metadata,
      if (deviceProfile != null) 'deviceProfile': deviceProfile!.toJson(),
      if (capabilities != null) 'capabilities': capabilities!.toJson(),
    };
  }
}

/// `LeavePayload` — sent by a client leaving a room.
class LeavePayload extends Payload {
  const LeavePayload({this.reason});

  final String? reason;

  factory LeavePayload.fromJson(Map<String, dynamic> json) {
    return LeavePayload(reason: json['reason'] as String?);
  }

  @override
  Map<String, dynamic> toJson() {
    return {if (reason != null) 'reason': reason};
  }
}

/// `OfferPayload` / `AnswerPayload` — SDP bodies are relayed verbatim,
/// never parsed or transformed by the signaling layer.
class SdpPayload extends Payload {
  const SdpPayload({required this.sdp, this.label});

  /// Opaque SDP body (RFC 3264). Required.
  final String sdp;

  /// Optional stream/label hint.
  final String? label;

  factory SdpPayload.fromJson(Map<String, dynamic> json) {
    return SdpPayload(sdp: _asString(json, 'sdp'), label: json['label'] as String?);
  }

  @override
  Map<String, dynamic> toJson() {
    return {'sdp': sdp, if (label != null) 'label': label};
  }
}

/// `IcePayload` — one trickled ICE candidate (RFC 8445), relayed verbatim.
class IcePayload extends Payload {
  const IcePayload({required this.candidate, this.sdpMid, this.sdpMLineIndex});

  /// Candidate string. Required.
  final String candidate;

  /// `sdpMid`, nullable per schema.
  final String? sdpMid;

  /// `sdpMLineIndex`, nullable per schema.
  final int? sdpMLineIndex;

  factory IcePayload.fromJson(Map<String, dynamic> json) {
    return IcePayload(
      candidate: _asString(json, 'candidate'),
      sdpMid: json['sdpMid'] as String?,
      sdpMLineIndex: json['sdpMLineIndex'] == null
          ? null
          : (json['sdpMLineIndex'] as num).toInt(),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'candidate': candidate,
      if (sdpMid != null) 'sdpMid': sdpMid,
      if (sdpMLineIndex != null) 'sdpMLineIndex': sdpMLineIndex,
    };
  }
}

/// `presence.state` values.
enum PresenceState {
  online('online'),
  away('away'),
  busy('busy'),
  offline('offline');

  const PresenceState(this.wire);

  final String wire;

  static PresenceState tryParse(String wire) {
    for (final state in PresenceState.values) {
      if (state.wire == wire) {
        return state;
      }
    }
    throw FormatException('unknown presence state: $wire');
  }
}

/// `PresencePayload` — presence state broadcast.
class PresencePayload extends Payload {
  const PresencePayload({required this.state, this.metadata});

  final PresenceState state;
  final Map<String, dynamic>? metadata;

  factory PresencePayload.fromJson(Map<String, dynamic> json) {
    return PresencePayload(
      state: PresenceState.tryParse(_asString(json, 'state')),
      metadata: json['metadata'] == null
          ? null
          : Map<String, dynamic>.from(json['metadata'] as Map),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'state': state.wire,
      if (metadata != null) 'metadata': metadata,
    };
  }
}

/// `ReactionPayload` — emoji reaction.
class ReactionPayload extends Payload {
  const ReactionPayload({required this.emoji, this.targetSenderId, this.ts});

  /// Emoji (or short code). Required.
  final String emoji;

  /// Optional target participant.
  final String? targetSenderId;

  /// Optional client-side timestamp (epoch ms).
  final int? ts;

  factory ReactionPayload.fromJson(Map<String, dynamic> json) {
    return ReactionPayload(
      emoji: _asString(json, 'emoji'),
      targetSenderId: json['targetSenderId'] as String?,
      ts: json['ts'] == null ? null : (json['ts'] as num).toInt(),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'emoji': emoji,
      if (targetSenderId != null) 'targetSenderId': targetSenderId,
      if (ts != null) 'ts': ts,
    };
  }
}

/// `chat.payload.replyTo` — reference to the message being replied to.
class ChatReply {
  const ChatReply({required this.senderId, required this.seq});

  final String senderId;

  /// `seq` of the original message (monotonic per sender).
  final int seq;

  factory ChatReply.fromJson(Map<String, dynamic> json) {
    return ChatReply(
      senderId: _asString(json, 'senderId'),
      seq: _asInt(json, 'seq'),
    );
  }

  Map<String, dynamic> toJson() {
    return {'senderId': senderId, 'seq': seq};
  }
}

/// `ChatPayload` — text chat message.
class ChatPayload extends Payload {
  const ChatPayload({required this.text, this.replyTo});

  /// Message body. Required; schema `maxLength` 4000.
  final String text;

  final ChatReply? replyTo;

  factory ChatPayload.fromJson(Map<String, dynamic> json) {
    return ChatPayload(
      text: _asString(json, 'text'),
      replyTo: json['replyTo'] == null
          ? null
          : ChatReply.fromJson(
              Map<String, dynamic>.from(json['replyTo'] as Map)),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'text': text,
      if (replyTo != null) 'replyTo': replyTo!.toJson(),
    };
  }
}

/// `screen-share.action` values.
enum ScreenShareAction {
  start('start'),
  stop('stop');

  const ScreenShareAction(this.wire);

  final String wire;

  static ScreenShareAction tryParse(String wire) {
    for (final action in ScreenShareAction.values) {
      if (action.wire == wire) {
        return action;
      }
    }
    throw FormatException('unknown screen-share action: $wire');
  }
}

/// `ScreenSharePayload` — screen share start/stop.
class ScreenSharePayload extends Payload {
  const ScreenSharePayload({required this.action, this.label});

  final ScreenShareAction action;
  final String? label;

  factory ScreenSharePayload.fromJson(Map<String, dynamic> json) {
    return ScreenSharePayload(
      action: ScreenShareAction.tryParse(_asString(json, 'action')),
      label: json['label'] as String?,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': action.wire,
      if (label != null) 'label': label,
    };
  }
}

/// `quality-warning.reason` values.
enum QualityWarningReason {
  network('network'),
  cpu('cpu'),
  device('device'),
  manual('manual'),
  recovery('recovery');

  const QualityWarningReason(this.wire);

  final String wire;

  static QualityWarningReason tryParse(String wire) {
    for (final reason in QualityWarningReason.values) {
      if (reason.wire == wire) {
        return reason;
      }
    }
    throw FormatException('unknown quality-warning reason: $wire');
  }
}

/// `quality-warning.direction` values.
enum QualityWarningDirection {
  send('send'),
  receive('receive');

  const QualityWarningDirection(this.wire);

  final String wire;

  static QualityWarningDirection tryParse(String wire) {
    for (final direction in QualityWarningDirection.values) {
      if (direction.wire == wire) {
        return direction;
      }
    }
    throw FormatException('unknown quality-warning direction: $wire');
  }
}

/// `QualityWarningPayload` — adaptive-quality tier change warning.
class QualityWarningPayload extends Payload {
  const QualityWarningPayload({
    required this.from,
    required this.to,
    required this.reason,
    required this.direction,
  });

  /// Quality tier the sender switched from, e.g. `720p@30`.
  final String from;

  /// Quality tier the sender switched to.
  final String to;

  final QualityWarningReason reason;
  final QualityWarningDirection direction;

  factory QualityWarningPayload.fromJson(Map<String, dynamic> json) {
    return QualityWarningPayload(
      from: _asString(json, 'from'),
      to: _asString(json, 'to'),
      reason: QualityWarningReason.tryParse(_asString(json, 'reason')),
      direction:
          QualityWarningDirection.tryParse(_asString(json, 'direction')),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'from': from,
      'to': to,
      'reason': reason.wire,
      'direction': direction.wire,
    };
  }
}

/// `sfu.action` values.
enum SfuAction {
  publish('publish'),
  subscribe('subscribe'),
  layerChange('layer-change'),
  keyframeRequest('keyframe-request'),
  leave('leave');

  const SfuAction(this.wire);

  final String wire;

  static SfuAction tryParse(String wire) {
    for (final action in SfuAction.values) {
      if (action.wire == wire) {
        return action;
      }
    }
    throw FormatException('unknown sfu action: $wire');
  }
}

/// `sfu.kind` values.
enum SfuKind {
  audio('audio'),
  video('video'),
  screen('screen');

  const SfuKind(this.wire);

  final String wire;

  static SfuKind tryParse(String wire) {
    for (final kind in SfuKind.values) {
      if (kind.wire == wire) {
        return kind;
      }
    }
    throw FormatException('unknown sfu kind: $wire');
  }
}

/// `SfuPayload` — SFU gateway control (optional feature).
class SfuPayload extends Payload {
  const SfuPayload({
    required this.action,
    this.trackId,
    this.kind,
    this.senderId,
    this.layer,
  });

  final SfuAction action;
  final String? trackId;
  final SfuKind? kind;
  final String? senderId;
  final String? layer;

  factory SfuPayload.fromJson(Map<String, dynamic> json) {
    return SfuPayload(
      action: SfuAction.tryParse(_asString(json, 'action')),
      trackId: json['trackId'] as String?,
      kind: json['kind'] == null ? null : SfuKind.tryParse(json['kind'] as String),
      senderId: json['senderId'] as String?,
      layer: json['layer'] as String?,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': action.wire,
      if (trackId != null) 'trackId': trackId,
      if (kind != null) 'kind': kind!.wire,
      if (senderId != null) 'senderId': senderId,
      if (layer != null) 'layer': layer,
    };
  }
}

/// `ErrorPayload` — error reported by a server or peer.
class ErrorPayload extends Payload {
  const ErrorPayload({required this.code, required this.message});

  final String code;
  final String message;

  factory ErrorPayload.fromJson(Map<String, dynamic> json) {
    return ErrorPayload(
      code: _asString(json, 'code'),
      message: _asString(json, 'message'),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {'code': code, 'message': message};
  }
}

String _asString(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is String) {
    return value;
  }
  throw FormatException('expected string for "$key", got: $value');
}

int _asInt(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is int) {
    return value;
  }
  if (value is num) {
    return value.toInt();
  }
  throw FormatException('expected integer for "$key", got: $value');
}

bool _asBool(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is bool) {
    return value;
  }
  throw FormatException('expected boolean for "$key", got: $value');
}

/// Decodes [json] as a UTF-8 JSON string (helper for payload round-trips).
Map<String, dynamic> decodeJsonMap(String json) {
  final decoded = jsonDecode(json);
  if (decoded is Map<String, dynamic>) {
    return decoded;
  }
  throw const FormatException('expected a JSON object');
}
