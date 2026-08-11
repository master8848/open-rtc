/// WebRTC session: wires a `flutter_webrtc` peer connection to a
/// [VidcallClient] signaling stream.
///
/// Mirrors the JS core's `PeerConnectionManager` surface: opaque SDP/ICE
/// payloads are relayed verbatim (never parsed by the signaling layer),
/// offers/answers/ICE candidates flow through the shared wire protocol, and
/// glare is resolved with the standard polite/impolite perfect-negotiation
/// pattern (JSEP rollback for the polite peer).
library;

import 'dart:async';

import 'package:flutter_webrtc/flutter_webrtc.dart' hide MessageType;

import '../client.dart';
import '../protocol/envelope.dart';
import '../protocol/message_type.dart';
import '../protocol/payloads.dart';

/// A `flutter_webrtc` peer connection wired to a [VidcallClient].
///
/// ```dart
/// final client = VidcallClient(roomId: 'room-abc');
/// await client.connect(Uri.parse('wss://signal.example.com'));
/// await client.join(displayName: 'Ada');
///
/// final session = VidcallRtcSession(client: client);
/// await session.start();
/// final local = await VidcallRtcSession.captureLocalMedia();
/// await session.addLocalStream(local);
/// await session.sendOffer(); // or wait for onRenegotiationNeeded
/// ```
class VidcallRtcSession {
  VidcallRtcSession({
    required this.client,
    Map<String, dynamic>? configuration,
    this.polite = true,
  }) : _configuration = configuration ?? defaultConfiguration();

  /// The signaling client this session sends and receives envelopes on.
  final VidcallClient client;

  /// When true (default) this peer is the "polite" peer in perfect
  /// negotiation: on glare it rolls back its own in-flight offer and accepts
  /// the remote offer. Two polite peers are safe; exactly one should be
  /// impolite (`polite: false`) when both peers may offer simultaneously.
  final bool polite;

  final Map<String, dynamic> _configuration;

  RTCPeerConnection? _peer;
  StreamSubscription<Envelope>? _envelopeSubscription;
  bool _makingOffer = false;
  bool _ignoreOffer = false;

  final StreamController<RTCTrackEvent> _trackController =
      StreamController<RTCTrackEvent>.broadcast();
  final StreamController<RTCPeerConnectionState> _connectionStateController =
      StreamController<RTCPeerConnectionState>.broadcast();
  final StreamController<RTCIceConnectionState> _iceStateController =
      StreamController<RTCIceConnectionState>.broadcast();
  final StreamController<Object> _errorsController =
      StreamController<Object>.broadcast();

  /// The underlying peer connection, or null before [start].
  RTCPeerConnection? get peer => _peer;

  /// Whether the peer connection has been created.
  bool get isStarted => _peer != null;

  /// Remote media tracks (audio/video) as they are added.
  Stream<RTCTrackEvent> get onTrack => _trackController.stream;

  /// Peer connection state changes (new/connecting/connected/...).
  Stream<RTCPeerConnectionState> get onConnectionState =>
      _connectionStateController.stream;

  /// ICE connection state changes.
  Stream<RTCIceConnectionState> get onIceConnectionState =>
      _iceStateController.stream;

  /// Signaling/negotiation errors surfaced to the application.
  Stream<Object> get errors => _errorsController.stream;

  /// Default peer configuration: unified plan + a public STUN server.
  /// Override via the [configuration] constructor argument for TURN etc.
  static Map<String, dynamic> defaultConfiguration() {
    return {
      'iceServers': [
        {'urls': 'stun:stun.l.google.com:19302'},
      ],
      'sdpSemantics': 'unified-plan',
    };
  }

  /// Captures local audio/video through `flutter_webrtc`'s `navigator`.
  static Future<MediaStream> captureLocalMedia({
    bool audio = true,
    bool video = true,
    Map<String, dynamic>? videoConstraints,
  }) {
    return navigator.mediaDevices.getUserMedia({
      'audio': audio,
      'video': video ? (videoConstraints ?? true) : false,
    });
  }

  /// Creates the peer connection, wires signaling events, and subscribes to
  /// the client's envelope stream. Idempotent.
  Future<void> start() async {
    if (_peer != null) {
      return;
    }
    final peer = await createPeerConnection(_configuration);
    _peer = peer;
    _wirePeer(peer);
    _envelopeSubscription = client.events.listen(_handleEnvelope);
  }

  /// Adds [stream]'s tracks to the peer connection and triggers negotiation
  /// when the connection is stable.
  Future<void> addLocalStream(MediaStream stream) async {
    final peer = _requirePeer();
    for (final track in stream.getTracks()) {
      await peer.addTrack(track, stream);
    }
    await _maybeCreateOffer();
  }

  /// Creates and sends an SDP offer (and sets it as the local description).
  Future<void> sendOffer() async {
    final peer = _requirePeer();
    _makingOffer = true;
    try {
      final offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await client.sendOffer(offer.sdp ?? '');
    } finally {
      _makingOffer = false;
    }
  }

  /// Sends an explicit ICE restart offer.
  Future<void> restartIce() async {
    final peer = _requirePeer();
    _makingOffer = true;
    try {
      final offer = await peer.createOffer(const {'iceRestart': true});
      await peer.setLocalDescription(offer);
      await client.sendOffer(offer.sdp ?? '');
    } finally {
      _makingOffer = false;
    }
  }

  /// Tears down the peer connection and unsubscribes from the client.
  Future<void> dispose() async {
    await _envelopeSubscription?.cancel();
    _envelopeSubscription = null;
    final peer = _peer;
    _peer = null;
    if (peer != null) {
      await peer.close();
      await peer.dispose();
    }
    await _trackController.close();
    await _connectionStateController.close();
    await _iceStateController.close();
    await _errorsController.close();
  }

  RTCPeerConnection _requirePeer() {
    final peer = _peer;
    if (peer == null) {
      throw StateError('VidcallRtcSession has not been started');
    }
    return peer;
  }

  void _wirePeer(RTCPeerConnection peer) {
    peer.onIceCandidate = (RTCIceCandidate candidate) {
      // Trickle ICE: relay each candidate verbatim.
      client.sendIce(
        candidate.candidate ?? '',
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      );
    };
    peer.onTrack = (RTCTrackEvent event) => _trackController.add(event);
    peer.onConnectionState = (RTCPeerConnectionState state) =>
        _connectionStateController.add(state);
    peer.onIceConnectionState = (RTCIceConnectionState state) =>
        _iceStateController.add(state);
    peer.onRenegotiationNeeded = () {
      _maybeCreateOffer();
    };
  }

  Future<void> _handleEnvelope(Envelope envelope) async {
    try {
      switch (envelope.type) {
        case MessageType.offer:
          await _handleOffer(envelope);
        case MessageType.answer:
          await _handleAnswer(envelope);
        case MessageType.ice:
          await _handleIce(envelope);
        case MessageType.leave:
          await dispose();
        default:
          break;
      }
    } catch (error) {
      _errorsController.add(error);
    }
  }

  Future<void> _handleOffer(Envelope envelope) async {
    final peer = _requirePeer();
    final payload = envelope.decodePayload();
    if (payload is! SdpPayload) {
      return; // malformed offer: ignore
    }
    final description = RTCSessionDescription(payload.sdp, 'offer');
    final readyForOffer =
        !_makingOffer || peer.signalingState == RTCSignalingState.RTCSignalingStateStable;

    if (!readyForOffer && !polite) {
      // Impolite peer loses the glare: ignore the colliding remote offer.
      _ignoreOffer = true;
      return;
    }

    if (!readyForOffer && polite) {
      // Polite peer rolls back its own in-flight offer (JSEP rollback).
      try {
        await peer.setLocalDescription(RTCSessionDescription('', 'rollback'));
      } catch (error) {
        _errorsController.add(error);
        return;
      }
    }

    await peer.setRemoteDescription(description);
    final answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await client.sendAnswer(answer.sdp ?? '');
  }

  Future<void> _handleAnswer(Envelope envelope) async {
    final peer = _requirePeer();
    final payload = envelope.decodePayload();
    if (payload is! SdpPayload) {
      return;
    }
    if (_ignoreOffer) {
      // We ignored a colliding offer; this answer belongs to that exchange.
      _ignoreOffer = false;
      return;
    }
    await peer.setRemoteDescription(RTCSessionDescription(payload.sdp, 'answer'));
  }

  Future<void> _handleIce(Envelope envelope) async {
    final peer = _requirePeer();
    final payload = envelope.decodePayload();
    if (payload is! IcePayload) {
      return;
    }
    await peer.addCandidate(RTCIceCandidate(
      payload.candidate,
      payload.sdpMid,
      payload.sdpMLineIndex,
    ));
  }

  Future<void> _maybeCreateOffer() async {
    final peer = _peer;
    if (peer == null || _makingOffer) {
      return;
    }
    if (peer.signalingState != RTCSignalingState.RTCSignalingStateStable) {
      return;
    }
    await sendOffer();
  }
}
