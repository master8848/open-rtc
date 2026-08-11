/// Backend-agnostic signaling client for the vidcall wire protocol.
///
/// Connects to any signaling backend URL speaking the `protocol/schema.json`
/// envelope over WebSocket (raw WebSocket fallback; Supabase/Convex/Firebase/
/// Appwrite adapters are transport plug-ins elsewhere in the repo). The client
/// owns sequence numbering (`seq` monotonic per sender), timestamps, and the
/// decoded event stream; it does not interpret payloads.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'protocol/envelope.dart';
import 'protocol/message_type.dart';
import 'protocol/payloads.dart';

/// Connection lifecycle states of a [VidcallClient].
enum VidcallState {
  /// Not connected and never connected in this lifecycle.
  disconnected,

  /// A connection attempt is in flight.
  connecting,

  /// WebSocket is open; messages can be sent and received.
  connected,

  /// Connection closed (by `close()`, remote close, or transport error).
  closed,
}

/// Strategy for opening the underlying WebSocket. Injectable for tests.
typedef WebSocketConnector = Future<WebSocket> Function(Uri uri);

/// Default [WebSocketConnector] using `dart:io`.
Future<WebSocket> _defaultConnector(Uri uri) => WebSocket.connect(uri.toString());

/// The maximum `chat.text` length allowed by schema.json (`maxLength: 4000`).
const int maxChatTextLength = 4000;

/// A signaling client for the vidcall wire protocol over `dart:io` WebSocket.
///
/// ```dart
/// final client = VidcallClient(roomId: 'room-abc');
/// await client.connect(Uri.parse('wss://signal.example.com'));
/// await client.join(displayName: 'Ada');
/// client.events.listen((envelope) {
///   final payload = envelope.decodePayload();
///   if (payload is ChatPayload) print(payload.text);
/// });
/// ```
class VidcallClient {
  VidcallClient({
    required this.roomId,
    String? senderId,
    String? sessionId,
    this.connectTimeout = const Duration(seconds: 15),
    WebSocketConnector? connector,
  })  : senderId = senderId ?? _randomId('sender'),
        sessionId = sessionId ?? _randomId('session'),
        _connector = connector ?? _defaultConnector;

  /// Room this client joins.
  final String roomId;

  /// Stable sender identity (auto-generated as a UUID v4 when omitted).
  final String senderId;

  /// Per-connection session identity (auto-generated as a UUID v4 when
  /// omitted). The server assigns authoritative session ids; clients must not
  /// invent them for the room roster — this one identifies this connection.
  final String sessionId;

  /// How long [connect] waits for the WebSocket to open.
  final Duration connectTimeout;

  final WebSocketConnector _connector;

  WebSocket? _socket;
  VidcallState _state = VidcallState.disconnected;
  int _seq = 0;
  bool _closed = false;

  final StreamController<Envelope> _eventsController =
      StreamController<Envelope>.broadcast();
  final StreamController<Object> _errorsController =
      StreamController<Object>.broadcast();
  final StreamController<VidcallState> _stateController =
      StreamController<VidcallState>.broadcast();

  /// Current connection state.
  VidcallState get state => _state;

  /// True while the WebSocket is open.
  bool get isConnected => _state == VidcallState.connected;

  /// Live stream of decoded envelopes received from the signaling backend.
  ///
  /// Envelopes with unknown `type` values are still delivered (see
  /// [`Envelope.type`]) — ignore them, per the protocol's forward-compat rule.
  Stream<Envelope> get events => _eventsController.stream;

  /// Transport-level errors (malformed JSON, socket failures). Protocol
  /// `error` envelopes arrive on [events] instead.
  Stream<Object> get errors => _errorsController.stream;

  /// Connection state transitions.
  Stream<VidcallState> get stateChanges => _stateController.stream;

  /// Opens the WebSocket to [uri] and starts the receive loop.
  ///
  /// Completes when the socket is open (or throws on timeout/failure).
  Future<void> connect(Uri uri) async {
    if (_closed) {
      throw StateError('VidcallClient is closed and cannot be reused');
    }
    _setState(VidcallState.connecting);
    try {
      final socket = await _connector(uri).timeout(connectTimeout);
      _socket = socket;
      _listen(socket);
      _setState(VidcallState.connected);
    } catch (error) {
      _setState(VidcallState.closed);
      rethrow;
    }
  }

  /// Sends a `join` envelope.
  Future<void> join({
    String? displayName,
    Map<String, dynamic>? metadata,
    DeviceProfile? deviceProfile,
    Capabilities? capabilities,
  }) {
    return _send(MessageType.join, JoinPayload(
      displayName: displayName,
      metadata: metadata,
      deviceProfile: deviceProfile,
      capabilities: capabilities,
    ).toJson());
  }

  /// Sends a `leave` envelope.
  Future<void> leave({String? reason}) {
    return _send(MessageType.leave, LeavePayload(reason: reason).toJson());
  }

  /// Sends a `reaction` envelope.
  Future<void> sendReaction(String emoji, {String? targetSenderId, int? ts}) {
    return _send(MessageType.reaction, ReactionPayload(
      emoji: emoji,
      targetSenderId: targetSenderId,
      ts: ts,
    ).toJson());
  }

  /// Sends a `chat` envelope. Throws [ArgumentError] when [text] exceeds the
  /// schema `maxLength` of 4000 characters.
  Future<void> sendChat(String text, {ChatReply? replyTo}) {
    if (text.length > maxChatTextLength) {
      throw ArgumentError.value(
        text.length,
        'text',
        'chat text exceeds schema maxLength of $maxChatTextLength',
      );
    }
    return _send(MessageType.chat, ChatPayload(text: text, replyTo: replyTo).toJson());
  }

  /// Sends an `offer` envelope with an opaque SDP body.
  Future<void> sendOffer(String sdp, {String? label}) {
    return _send(MessageType.offer, SdpPayload(sdp: sdp, label: label).toJson());
  }

  /// Sends an `answer` envelope with an opaque SDP body.
  Future<void> sendAnswer(String sdp, {String? label}) {
    return _send(MessageType.answer, SdpPayload(sdp: sdp, label: label).toJson());
  }

  /// Sends an `ice` envelope with one trickled ICE candidate.
  Future<void> sendIce(String candidate, {String? sdpMid, int? sdpMLineIndex}) {
    return _send(MessageType.ice, IcePayload(
      candidate: candidate,
      sdpMid: sdpMid,
      sdpMLineIndex: sdpMLineIndex,
    ).toJson());
  }

  /// Sends a `presence` envelope.
  Future<void> sendPresence(PresenceState state, {Map<String, dynamic>? metadata}) {
    return _send(
        MessageType.presence, PresencePayload(state: state, metadata: metadata).toJson());
  }

  /// Sends a `screen-share` envelope.
  Future<void> sendScreenShare(ScreenShareAction action, {String? label}) {
    return _send(
        MessageType.screenShare, ScreenSharePayload(action: action, label: label).toJson());
  }

  /// Sends a `quality-warning` envelope.
  Future<void> sendQualityWarning({
    required String from,
    required String to,
    required QualityWarningReason reason,
    required QualityWarningDirection direction,
  }) {
    return _send(MessageType.qualityWarning, QualityWarningPayload(
      from: from,
      to: to,
      reason: reason,
      direction: direction,
    ).toJson());
  }

  /// Sends an `sfu` envelope (optional SFU gateway control).
  Future<void> sendSfu(
    SfuAction action, {
    String? trackId,
    SfuKind? kind,
    String? senderId,
    String? layer,
  }) {
    return _send(MessageType.sfu, SfuPayload(
      action: action,
      trackId: trackId,
      kind: kind,
      senderId: senderId,
      layer: layer,
    ).toJson());
  }

  /// Sends a `ping` envelope (heartbeat).
  Future<void> sendPing() => _send(MessageType.ping, null);

  /// Sends a `pong` envelope.
  Future<void> sendPong() => _send(MessageType.pong, null);

  /// Closes the WebSocket and releases the client. Idempotent.
  Future<void> close() async {
    if (_closed) {
      return;
    }
    _closed = true;
    final socket = _socket;
    if (socket != null) {
      try {
        await socket.close();
      } catch (_) {
        // best-effort: the socket may already be gone
      }
    }
    _setState(VidcallState.closed);
  }

  Future<void> _send(MessageType type, Map<String, dynamic>? payload) async {
    final socket = _socket;
    if (socket == null || !isConnected) {
      throw StateError('VidcallClient is not connected (state: $_state)');
    }
    final envelope = Envelope(
      type: type,
      roomId: roomId,
      senderId: senderId,
      sessionId: sessionId,
      ts: DateTime.now().millisecondsSinceEpoch,
      seq: _seq++,
      payload: payload,
    );
    socket.add(envelope.encode());
  }

  void _listen(WebSocket socket) {
    socket.listen(
      (dynamic data) {
        try {
          final text = data is String ? data : utf8.decode(data as List<int>);
          final decoded = jsonDecode(text);
          if (decoded is! Map<String, dynamic>) {
            _errorsController.add(
                const FormatException('expected a JSON object envelope'));
            return;
          }
          _eventsController.add(Envelope.fromJson(decoded));
        } catch (error) {
          _errorsController.add(error);
        }
      },
      onError: (Object error) {
        _errorsController.add(error);
        _setState(VidcallState.closed);
      },
      onDone: () {
        _setState(VidcallState.closed);
      },
      cancelOnError: true,
    );
  }

  void _setState(VidcallState next) {
    if (_state == next) {
      return;
    }
    _state = next;
    _stateController.add(next);
  }

  static String _randomId(String prefix) {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    final hex =
        bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
    return '$prefix-${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
        '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  }
}
