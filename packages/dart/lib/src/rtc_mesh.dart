/// Multi-peer mesh session: one [RTCPeerConnection] per remote participant
/// over a single shared signaling socket (the [VidcallClient]).
///
/// Mirrors the JS core's `Room` surface (docs/architecture.md D3): per-peer
/// perfect negotiation with the schema polarity rule
/// (`polite = selfId < remoteId`, lexicographic), trickle ICE relayed
/// verbatim, a per-peer data channel (reactions/chat/control over SCTP),
/// and an envelope-level ordering/dedupe window keyed on `sessionId` + `seq`.
///
/// Envelope semantics follow `protocol/schema.json`:
///  - **Unicast**: offer/answer/ICE/join/pong envelopes are addressed with
///    `targetSenderId` (the remote peer's `senderId`). Receivers MUST filter
///    on it — this session drops any envelope whose `targetSenderId` is set
///    and is not ours, and only the envelope's `senderId` may drive that
///    peer's connection.
///  - **Ordering**: `seq` is monotonic per sender per `sessionId`; stale or
///    duplicate envelopes (replayed by an unordered backend) are dropped.
///  - **Ping/pong**: a `ping` envelope is answered automatically with a
///    targeted `pong` (no payload).
///
/// The mesh is intentionally pure-Dart at the type level: it builds on
/// `package:webrtc_interface` (the same abstract interfaces `flutter_webrtc`
/// implements), so it can be unit-tested with fakes under plain `dart test`.
/// The app supplies the platform factory, e.g.
/// `RtcMeshSession(client: client, peerFactory: createPeerConnection)`
/// where `createPeerConnection` comes from `package:flutter_webrtc`.
library;

import 'dart:async';
import 'dart:convert';

import 'package:webrtc_interface/webrtc_interface.dart' hide MessageType;

import 'client.dart';
import 'protocol/envelope.dart';
import 'protocol/message_type.dart';
import 'protocol/payloads.dart';

/// Creates the platform [RTCPeerConnection] for one mesh peer.
///
/// Flutter apps pass `package:flutter_webrtc`'s top-level
/// `createPeerConnection`; tests inject fakes.
typedef PeerConnectionFactory =
    Future<RTCPeerConnection> Function(Map<String, dynamic> configuration);

/// A remote participant on the mesh roster (join/leave/presence).
class MeshParticipant {
  MeshParticipant({
    required this.id,
    this.displayName,
    this.metadata,
    this.presence = PresenceState.offline,
    DateTime? joinedAt,
  }) : joinedAt = joinedAt ?? DateTime.now();

  /// Stable `senderId` (matches `Envelope.senderId`).
  final String id;

  /// Display name from the last `join` payload, if any.
  String? displayName;

  /// Metadata from the last `join`/`presence` payload, if any.
  Map<String, dynamic>? metadata;

  /// Presence state as last announced (defaults to [PresenceState.offline]
  /// until a `presence` envelope arrives).
  PresenceState presence;

  /// When the participant was first seen on this mesh.
  final DateTime joinedAt;
}

/// A remote media track arrival on one peer connection.
class MeshTrackEvent {
  const MeshTrackEvent({required this.participantId, required this.event});

  /// The sending participant's `senderId`.
  final String participantId;

  /// The underlying platform track event.
  final RTCTrackEvent event;

  /// The first stream of the event, or null when the event carries none.
  MediaStream? get stream => event.streams.isEmpty ? null : event.streams.first;

  /// The remote media track (audio/video).
  MediaStreamTrack get track => event.track;
}

/// Connection-state change for one peer.
class MeshConnectionStateEvent {
  const MeshConnectionStateEvent({
    required this.participantId,
    required this.state,
  });

  final String participantId;
  final RTCPeerConnectionState state;
}

/// Payload kinds carried on the per-peer data channel (mirrors the JS core's
/// `DataChannelBus` wire format: `{"v":1,"t":<kind>,"d":{...}}`).
enum MeshDataKind {
  reaction('reaction'),
  chat('chat'),
  control('control');

  const MeshDataKind(this.wire);

  /// The exact `t` value used on the wire.
  final String wire;

  /// Parses [wire] into a [MeshDataKind], or null for unknown kinds
  /// (forward compatibility: unknown frames are dropped).
  static MeshDataKind? tryParse(String wire) {
    for (final kind in MeshDataKind.values) {
      if (kind.wire == wire) {
        return kind;
      }
    }
    return null;
  }
}

/// One typed message received on a per-peer data channel.
class MeshDataMessage {
  const MeshDataMessage({
    required this.participantId,
    required this.kind,
    required this.payload,
  });

  /// The sending participant's `senderId`.
  final String participantId;

  final MeshDataKind kind;

  /// The decoded `d` object of the wire frame.
  final Map<String, dynamic> payload;
}

/// The SCTP data channel bus for one peer (reactions / chat / control).
///
/// Both sides may create a channel during negotiation; the channel adopted
/// from the remote (`ondatachannel`) wins, matching how negotiation actually
/// negotiates only the offerer's channel.
class MeshDataChannel {
  MeshDataChannel({required this.participantId, required this.label});

  /// The peer this channel belongs to.
  final String participantId;

  /// Channel label (default `'vidcall'`); remote channels with other labels
  /// are ignored.
  final String label;

  RTCDataChannel? _local;
  RTCDataChannel? _remote;

  /// Invoked for every decoded inbound [MeshDataMessage] (wired by the mesh).
  void Function(MeshDataMessage message)? onMessage;

  /// The active platform channel (remote wins over local).
  RTCDataChannel? get channel => _remote ?? _local;

  /// Current data-channel state, or null before any channel exists.
  RTCDataChannelState? get state => channel?.state;

  /// True once the active channel is open.
  bool get isOpen => state == RTCDataChannelState.RTCDataChannelOpen;

  /// Adopts the channel this side created (present in our first offer).
  void attachLocal(RTCDataChannel channel) {
    _local = channel;
    _wire(channel);
  }

  /// Adopts a remote channel delivered via `ondatachannel`.
  void attachRemote(RTCDataChannel channel) {
    _remote = channel;
    _wire(channel);
  }

  /// Sends a `reaction` frame over the data channel.
  ///
  /// Throws [StateError] when the active channel is not open.
  Future<void> sendReaction(String emoji, {String? targetSenderId, int? ts}) {
    return _send('reaction', {
      'emoji': emoji,
      if (targetSenderId != null) 'targetSenderId': targetSenderId,
      if (ts != null) 'ts': ts,
    });
  }

  /// Sends a `chat` frame over the data channel.
  ///
  /// Throws [StateError] when the active channel is not open.
  Future<void> sendChat(String text, {Map<String, dynamic>? replyTo}) {
    return _send('chat', {'text': text, if (replyTo != null) 'replyTo': replyTo});
  }

  /// Sends a `control` frame over the data channel (e.g. keyframe requests).
  ///
  /// Throws [StateError] when the active channel is not open.
  Future<void> sendControl(String action, [Map<String, dynamic>? data]) {
    return _send('control', {'action': action, ...?data});
  }

  Future<void> _send(String type, Map<String, dynamic> payload) async {
    final active = channel;
    if (active == null ||
        active.state != RTCDataChannelState.RTCDataChannelOpen) {
      throw StateError(
          'data channel "$label" for $participantId is not open '
          '(state: ${active?.state})');
    }
    await active.send(RTCDataChannelMessage(jsonEncode({
      'v': 1,
      't': type,
      'd': payload,
    })));
  }

  void _wire(RTCDataChannel channel) {
    channel.onMessage = (RTCDataChannelMessage message) {
      if (message.isBinary) {
        return;
      }
      final decoded = _decode(message.text);
      if (decoded != null) {
        onMessage?.call(decoded);
      }
    };
  }

  MeshDataMessage? _decode(String raw) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) {
        return null;
      }
      if (decoded['v'] != 1) {
        return null;
      }
      final type = decoded['t'];
      final payload = decoded['d'];
      if (type is! String || payload is! Map<String, dynamic>) {
        return null;
      }
      final kind = MeshDataKind.tryParse(type);
      if (kind == null) {
        return null;
      }
      return MeshDataMessage(
          participantId: participantId, kind: kind, payload: payload);
    } catch (_) {
      return null;
    }
  }

  /// Closes both local and remote channels. Idempotent.
  void close() {
    _local?.close();
    _remote?.close();
  }
}

/// One peer connection + negotiation state for a remote participant.
class _MeshPeer {
  _MeshPeer({
    required this.participantId,
    required this.pc,
    required this.polite,
    required this.dataChannel,
  });

  final String participantId;
  final RTCPeerConnection pc;

  /// Perfect-negotiation polarity: `selfId < remoteId` by default.
  final bool polite;

  final MeshDataChannel dataChannel;

  /// Trickle ICE candidates buffered until a remote description is applied
  /// (spec requires `addIceCandidate` after `setRemoteDescription`).
  final List<RTCIceCandidate> pendingCandidates = <RTCIceCandidate>[];

  /// Tracks already added to this connection (identity guard against
  /// duplicate `addTrack`).
  final List<MediaStreamTrack> addedTracks = <MediaStreamTrack>[];

  /// An offer is being created/sent by us.
  bool makingOffer = false;

  /// A colliding remote offer was ignored (impolite glare loss).
  bool ignoreOffer = false;

  bool closed = false;
}

/// A local track being published to every (current and future) peer.
typedef _LocalTrack = ({MediaStreamTrack track, MediaStream? stream});

/// Multi-peer mesh over a single [VidcallClient] signaling socket.
///
/// ```dart
/// final mesh = RtcMeshSession(
///   client: client,
///   peerFactory: createPeerConnection, // from package:flutter_webrtc
///   displayName: 'Ada',
/// );
/// await mesh.start();
///
/// final local = await VidcallRtcSession.captureLocalMedia();
/// await mesh.addLocalStream(local); // one PC per participant + offers
///
/// mesh.onTrack.listen((event) {
///   // render event.stream / event.track in an RTCVideoView
/// });
/// mesh.onParticipantJoined.listen((p) => print('${p.id} joined'));
///
/// await mesh.dispose();
/// ```
class RtcMeshSession {
  RtcMeshSession({
    required this.client,
    required PeerConnectionFactory peerFactory,
    Map<String, dynamic>? configuration,
    this.dataChannelName = 'vidcall',
    this.displayName,
    this.joinMetadata,
    this.politeRule,
  })  : _peerFactory = peerFactory,
        _configuration = configuration ?? defaultConfiguration();

  /// The shared signaling client. Join once via `client.join()` before or
  /// after `start()`; the mesh announces itself back to newcomers with a
  /// targeted `join` (roster reply).
  final VidcallClient client;

  /// Label for the per-peer data channels (default `'vidcall'`).
  final String dataChannelName;

  /// Display name announced in the targeted roster-reply `join` envelopes.
  final String? displayName;

  /// Metadata announced in the targeted roster-reply `join` envelopes.
  final Map<String, dynamic>? joinMetadata;

  /// Custom perfect-negotiation polarity rule. When null the schema rule is
  /// used: `selfId < remoteId` (lexicographic `senderId` comparison).
  final bool Function(String selfId, String remoteId)? politeRule;

  final PeerConnectionFactory _peerFactory;
  final Map<String, dynamic> _configuration;

  final Map<String, _MeshPeer> _peers = <String, _MeshPeer>{};

  /// Peer creations in flight per participant: concurrent signaling (e.g. a
  /// join racing a publish loop) can call [_ensurePeer] for the same
  /// participant while the (async) factory is still running; without this
  /// guard we would open two connections to the same peer.
  final Map<String, Future<_MeshPeer>> _peerCreating =
      <String, Future<_MeshPeer>>{};

  final Map<String, MeshParticipant> _participants =
      <String, MeshParticipant>{};

  /// Last accepted `seq` per sender `sessionId` (ordering/dedupe window).
  final Map<String, int> _lastSeqBySession = <String, int>{};

  final List<_LocalTrack> _localTracks = <_LocalTrack>[];

  StreamSubscription<Envelope>? _subscription;
  bool _disposed = false;

  final StreamController<MeshParticipant> _joinedController =
      StreamController<MeshParticipant>.broadcast();
  final StreamController<MeshParticipant> _updatedController =
      StreamController<MeshParticipant>.broadcast();
  final StreamController<MeshParticipant> _leftController =
      StreamController<MeshParticipant>.broadcast();
  final StreamController<MeshTrackEvent> _trackController =
      StreamController<MeshTrackEvent>.broadcast();
  final StreamController<MeshConnectionStateEvent> _connectionStateController =
      StreamController<MeshConnectionStateEvent>.broadcast();
  final StreamController<MeshDataMessage> _dataController =
      StreamController<MeshDataMessage>.broadcast();
  final StreamController<Object> _errorsController =
      StreamController<Object>.broadcast();

  /// Whether [start] has been called (envelope subscription active).
  bool get isStarted => _subscription != null;

  /// Whether [dispose] has completed.
  bool get isDisposed => _disposed;

  /// Roster snapshot: every remote participant seen via join/leave/presence
  /// or synthesized when SDP/ICE arrived before their join.
  List<MeshParticipant> get participants =>
      List<MeshParticipant>.unmodifiable(_participants.values);

  /// Looks up a roster entry by `senderId`.
  MeshParticipant? participant(String participantId) =>
      _participants[participantId];

  /// The peer connection for [participantId], or null if none exists yet.
  RTCPeerConnection? peerConnection(String participantId) =>
      _peers[participantId]?.pc;

  /// The data channel bus for [participantId], or null if none exists yet.
  MeshDataChannel? dataChannel(String participantId) =>
      _peers[participantId]?.dataChannel;

  /// A remote participant was added to the roster.
  Stream<MeshParticipant> get onParticipantJoined => _joinedController.stream;

  /// A roster participant was updated (re-join with new info, presence).
  Stream<MeshParticipant> get onParticipantUpdated => _updatedController.stream;

  /// A remote participant left the room (their `leave` envelope).
  Stream<MeshParticipant> get onParticipantLeft => _leftController.stream;

  /// Remote media tracks, tagged with the sending participant's `senderId`.
  Stream<MeshTrackEvent> get onTrack => _trackController.stream;

  /// Per-peer aggregate connection-state changes.
  Stream<MeshConnectionStateEvent> get onConnectionState =>
      _connectionStateController.stream;

  /// Typed data-channel messages (reactions/chat/control) from any peer.
  Stream<MeshDataMessage> get onData => _dataController.stream;

  /// Negotiation/signaling errors surfaced to the application.
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

  /// Subscribes to the client's envelope stream. Idempotent.
  Future<void> start() async {
    if (_subscription != null || _disposed) {
      return;
    }
    _subscription = client.events.listen(_handleEnvelope);
  }

  /// Publishes every track of [stream] to all (current and future) peers.
  Future<void> addLocalStream(MediaStream stream) async {
    for (final track in stream.getTracks()) {
      await publish(track, stream: stream);
    }
  }

  /// Publishes [track] to every participant on the roster, opening a peer
  /// connection where needed and triggering an offer per peer.
  Future<void> publish(MediaStreamTrack track, {MediaStream? stream}) async {
    _requireActive();
    _localTracks.add((track: track, stream: stream));
    for (final participantId in _participants.keys.toList()) {
      final peer = await _ensurePeer(participantId);
      await _addTrackToPeer(peer, track, stream);
      await _negotiate(peer, reason: 'track-added');
    }
  }

  /// Sends an explicit offer to [participantId] (e.g. ICE restart).
  Future<void> sendOffer(String participantId, {String? label}) async {
    _requireActive();
    final peer = await _ensurePeer(participantId);
    await _negotiate(peer, reason: label);
  }

  /// Restarts ICE for one peer, or for all peers when [participantId] is
  /// omitted.
  Future<void> restartIce([String? participantId]) async {
    _requireActive();
    final targets =
        participantId == null ? _peers.keys.toList() : <String>[participantId];
    for (final id in targets) {
      final peer = _peers[id];
      if (peer == null) {
        continue;
      }
      try {
        await peer.pc.restartIce();
      } catch (_) {
        // Stack without restartIce: the manual renegotiation below still
        // produces a fresh offer with new ICE ufrag/pwd.
      }
      await _negotiate(peer, reason: 'ice-restart');
    }
  }

  /// Tears down every peer connection and the envelope subscription.
  /// Idempotent; the session cannot be reused afterwards.
  Future<void> dispose() async {
    if (_disposed) {
      return;
    }
    _disposed = true;
    await _subscription?.cancel();
    _subscription = null;
    for (final peer in _peers.values.toList()) {
      await _closePeer(peer);
    }
    _peers.clear();
    _participants.clear();
    _lastSeqBySession.clear();
    _localTracks.clear();
    await _joinedController.close();
    await _updatedController.close();
    await _leftController.close();
    await _trackController.close();
    await _connectionStateController.close();
    await _dataController.close();
    await _errorsController.close();
  }

  // ------------------------------------------------------------ internals

  Future<void> _handleEnvelope(Envelope envelope) async {
    // Our own echo (broadcast backends).
    if (envelope.senderId == client.senderId) {
      return;
    }
    // Unicast addressed to someone else: must be filtered here because
    // backends MAY ignore targetSenderId and broadcast anyway.
    final target = envelope.targetSenderId;
    if (target != null && target != client.senderId) {
      return;
    }
    // Ordering/idempotency: stale or duplicate envelopes per sender session.
    if (!_acceptOrdered(envelope)) {
      return;
    }
    try {
      switch (envelope.type) {
        case MessageType.join:
          await _handleJoin(envelope);
        case MessageType.leave:
          await _handleLeave(envelope);
        case MessageType.offer:
          await _handleOffer(envelope);
        case MessageType.answer:
          await _handleAnswer(envelope);
        case MessageType.ice:
          await _handleIce(envelope);
        case MessageType.presence:
          _handlePresence(envelope);
        case MessageType.ping:
          await _handlePing(envelope);
        case MessageType.reaction:
        case MessageType.chat:
        case MessageType.screenShare:
        case MessageType.qualityWarning:
        case MessageType.sfu:
        case MessageType.pong:
        case MessageType.error:
        case null:
          break;
      }
    } catch (error) {
      if (!_disposed) {
        _errorsController.add(error);
      }
    }
  }

  Future<void> _handleJoin(Envelope envelope) async {
    final payload = envelope.decodePayload();
    final join = payload is JoinPayload ? payload : null;
    final existing = _participants[envelope.senderId];
    if (existing != null) {
      existing.displayName = join?.displayName ?? existing.displayName;
      existing.metadata = join?.metadata ?? existing.metadata;
      existing.presence = PresenceState.online;
      if (!_disposed) {
        _updatedController.add(existing);
      }
      return;
    }
    final participant = MeshParticipant(
      id: envelope.senderId,
      displayName: join?.displayName,
      metadata: join?.metadata,
      presence: PresenceState.online,
    );
    _participants[envelope.senderId] = participant;
    if (!_disposed) {
      _joinedController.add(participant);
    }
    // Roster reply: announce ourselves back to the newcomer (targeted
    // unicast) so they learn about us even if our join was missed.
    await _sendSignal(
      envelope.senderId,
      MessageType.join,
      JoinPayload(displayName: displayName, metadata: joinMetadata).toJson(),
    );
    // We already have local tracks: open the peer connection and offer.
    if (_localTracks.isNotEmpty) {
      final peer = await _ensurePeer(envelope.senderId);
      await _negotiate(peer, reason: 'remote-joined');
    }
  }

  Future<void> _handleLeave(Envelope envelope) async {
    await _removePeer(envelope.senderId);
    final participant = _participants.remove(envelope.senderId);
    if (participant != null && !_disposed) {
      _leftController.add(participant);
    }
  }

  Future<void> _handleOffer(Envelope envelope) async {
    final payload = envelope.decodePayload();
    if (payload is! SdpPayload) {
      return;
    }
    final peer = await _ensurePeer(envelope.senderId);
    final description = RTCSessionDescription(payload.sdp, 'offer');
    final collision = peer.makingOffer ||
        peer.pc.signalingState != RTCSignalingState.RTCSignalingStateStable;
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) {
      // Impolite peer loses the glare: ignore the colliding remote offer.
      return;
    }
    if (peer.polite && collision) {
      // Polite peer backs out of its own in-flight offer (JSEP rollback).
      try {
        await peer.pc.setLocalDescription(RTCSessionDescription('', 'rollback'));
      } catch (error) {
        if (!_disposed) {
          _errorsController.add(error);
        }
        return;
      }
    }
    await peer.pc.setRemoteDescription(description);
    final answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    await _sendSignal(
      peer.participantId,
      MessageType.answer,
      SdpPayload(sdp: answer.sdp ?? '').toJson(),
    );
    await _flushPendingCandidates(peer);
  }

  Future<void> _handleAnswer(Envelope envelope) async {
    final payload = envelope.decodePayload();
    if (payload is! SdpPayload) {
      return;
    }
    final peer = await _ensurePeer(envelope.senderId);
    if (peer.ignoreOffer) {
      // This answer belongs to the offer we ignored during glare.
      peer.ignoreOffer = false;
      return;
    }
    // JSEP: an answer only applies to a pending local offer. A stray answer
    // (glare artifact — the remote answered an offer whose local description
    // has not landed yet, or a duplicate) must be dropped, not applied.
    if (peer.pc.signalingState !=
        RTCSignalingState.RTCSignalingStateHaveLocalOffer) {
      if (!_disposed) {
        _errorsController.add(StateError(
            'stray answer from ${envelope.senderId}: no pending local offer '
            '(state=${peer.pc.signalingState})'));
      }
      return;
    }
    await peer.pc
        .setRemoteDescription(RTCSessionDescription(payload.sdp, 'answer'));
    await _flushPendingCandidates(peer);
  }

  Future<void> _handleIce(Envelope envelope) async {
    final payload = envelope.decodePayload();
    if (payload is! IcePayload) {
      return;
    }
    final peer = await _ensurePeer(envelope.senderId);
    final candidate =
        RTCIceCandidate(payload.candidate, payload.sdpMid, payload.sdpMLineIndex);
    final remote = await peer.pc.getRemoteDescription();
    if (remote == null) {
      // addIceCandidate requires a remote description (spec): buffer until
      // the matching description lands.
      peer.pendingCandidates.add(candidate);
      return;
    }
    await _addCandidate(peer, candidate);
  }

  void _handlePresence(Envelope envelope) {
    final payload = envelope.decodePayload();
    if (payload is! PresencePayload) {
      return;
    }
    final participant = _participants[envelope.senderId];
    if (participant == null) {
      return;
    }
    participant.presence = payload.state;
    if (payload.metadata != null) {
      participant.metadata = payload.metadata;
    }
    if (!_disposed) {
      _updatedController.add(participant);
    }
  }

  Future<void> _handlePing(Envelope envelope) async {
    // Auto-pong: answer the heartbeat, unicast back to the sender.
    await _sendSignal(envelope.senderId, MessageType.pong, null);
  }

  /// Gets (or creates) the peer entry for [participantId]. Only envelopes
  /// from that exact `senderId` ever route here (enforced upstream).
  Future<_MeshPeer> _ensurePeer(String participantId) async {
    final existing = _peers[participantId];
    if (existing != null) {
      return existing;
    }
    final inFlight = _peerCreating[participantId];
    if (inFlight != null) {
      return inFlight;
    }
    _requireActive();
    // SDP/ICE can arrive before the join envelope on unordered backends:
    // synthesize a roster entry so signaling still works.
    if (!_participants.containsKey(participantId)) {
      final shell = MeshParticipant(id: participantId);
      _participants[participantId] = shell;
      if (!_disposed) {
        _joinedController.add(shell);
      }
    }
    final creating = _createPeer(participantId);
    _peerCreating[participantId] = creating;
    try {
      final peer = await creating;
      _peers[participantId] = peer;
      return peer;
    } finally {
      _peerCreating.remove(participantId);
    }
  }

  /// Creates the [RTCPeerConnection] and data channel for [participantId]
  /// and re-publishes local tracks onto it. Not guarded against concurrent
  /// calls — route through [_ensurePeer].
  Future<_MeshPeer> _createPeer(String participantId) async {
    final pc = await _peerFactory(_configuration);
    final dataChannel = MeshDataChannel(
      participantId: participantId,
      label: dataChannelName,
    );
    dataChannel.onMessage = _handleDataMessage;
    final peer = _MeshPeer(
      participantId: participantId,
      pc: pc,
      polite: _isPolite(participantId),
      dataChannel: dataChannel,
    );
    _wirePeer(peer);
    // Local data channel (initiator side); the remote side adopts the
    // channel it negotiated via onDataChannel.
    try {
      final localChannel =
          await pc.createDataChannel(dataChannelName, RTCDataChannelInit());
      dataChannel.attachLocal(localChannel);
    } catch (error) {
      if (!_disposed) {
        _errorsController.add(error);
      }
    }
    // Re-publish local tracks onto the fresh connection.
    for (final localTrack in _localTracks) {
      await _addTrackToPeer(peer, localTrack.track, localTrack.stream);
    }
    return peer;
  }

  bool _isPolite(String participantId) {
    final rule = politeRule;
    if (rule != null) {
      return rule(client.senderId, participantId);
    }
    return client.senderId.compareTo(participantId) < 0;
  }

  void _wirePeer(_MeshPeer peer) {
    final pc = peer.pc;
    pc.onIceCandidate = (RTCIceCandidate candidate) {
      final value = candidate.candidate;
      if (value == null || value.isEmpty) {
        return; // end-of-candidates marker: nothing to signal
      }
      _emitSignal(
        peer.participantId,
        MessageType.ice,
        IcePayload(
          candidate: value,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        ).toJson(),
      );
    };
    pc.onTrack = (RTCTrackEvent event) {
      if (!_disposed) {
        _trackController.add(
            MeshTrackEvent(participantId: peer.participantId, event: event));
      }
    };
    pc.onConnectionState = (RTCPeerConnectionState state) {
      if (!_disposed) {
        _connectionStateController.add(MeshConnectionStateEvent(
            participantId: peer.participantId, state: state));
      }
    };
    pc.onRenegotiationNeeded = () {
      unawaited(_negotiate(peer, reason: 'renegotiation-needed'));
    };
    pc.onDataChannel = (RTCDataChannel channel) {
      if (channel.label != dataChannelName) {
        return;
      }
      peer.dataChannel.attachRemote(channel);
    };
  }

  Future<void> _negotiate(_MeshPeer peer, {String? reason}) async {
    if (peer.closed || peer.makingOffer || _disposed) {
      return;
    }
    peer.makingOffer = true;
    try {
      final offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      await _sendSignal(
        peer.participantId,
        MessageType.offer,
        SdpPayload(sdp: offer.sdp ?? '', label: reason).toJson(),
      );
    } finally {
      peer.makingOffer = false;
    }
  }

  Future<void> _addTrackToPeer(
      _MeshPeer peer, MediaStreamTrack track, MediaStream? stream) async {
    if (peer.addedTracks.any((existing) => identical(existing, track))) {
      return;
    }
    peer.addedTracks.add(track);
    if (stream == null) {
      await peer.pc.addTrack(track);
    } else {
      await peer.pc.addTrack(track, stream);
    }
  }

  Future<void> _addCandidate(_MeshPeer peer, RTCIceCandidate candidate) async {
    try {
      await peer.pc.addCandidate(candidate);
    } catch (error) {
      if (peer.ignoreOffer) {
        return;
      }
      // Remote description changed under us: re-queue for the next flush.
      peer.pendingCandidates.add(candidate);
    }
  }

  Future<void> _flushPendingCandidates(_MeshPeer peer) async {
    if (peer.pendingCandidates.isEmpty) {
      return;
    }
    final remote = await peer.pc.getRemoteDescription();
    if (remote == null) {
      return;
    }
    final queue = List<RTCIceCandidate>.of(peer.pendingCandidates);
    peer.pendingCandidates.clear();
    for (final candidate in queue) {
      await _addCandidate(peer, candidate);
    }
  }

  Future<void> _removePeer(String participantId) async {
    final peer = _peers.remove(participantId);
    if (peer == null) {
      return;
    }
    await _closePeer(peer);
  }

  Future<void> _closePeer(_MeshPeer peer) async {
    if (peer.closed) {
      return;
    }
    peer.closed = true;
    peer.dataChannel.close();
    try {
      await peer.pc.close();
    } catch (_) {
      // best-effort: the connection may already be gone
    }
    try {
      await peer.pc.dispose();
    } catch (_) {
      // best-effort: dispose may be a no-op after close on some stacks
    }
  }

  void _handleDataMessage(MeshDataMessage message) {
    if (!_disposed) {
      _dataController.add(message);
    }
  }

  /// Awaited targeted send (used by offer/answer/join/pong handlers).
  Future<void> _sendSignal(
    String participantId,
    MessageType type,
    Map<String, dynamic>? payload,
  ) {
    return client.sendMessage(type, payload, targetSenderId: participantId);
  }

  /// Fire-and-forget targeted send (used by sync platform callbacks).
  void _emitSignal(
    String participantId,
    MessageType type,
    Map<String, dynamic>? payload,
  ) {
    client
        .sendMessage(type, payload, targetSenderId: participantId)
        .catchError((Object error) {
      if (!_disposed) {
        _errorsController.add(error);
      }
    });
  }

  /// Envelope-level ordering/dedupe window keyed on sender `sessionId`:
  /// accepts an envelope only if its `seq` is newer than everything accepted
  /// from that session.
  bool _acceptOrdered(Envelope envelope) {
    final key = envelope.sessionId;
    final last = _lastSeqBySession[key];
    if (last == null) {
      _lastSeqBySession[key] = envelope.seq;
      return true;
    }
    if (envelope.seq <= last) {
      return false;
    }
    _lastSeqBySession[key] = envelope.seq;
    return true;
  }

  void _requireActive() {
    if (_disposed) {
      throw StateError('RtcMeshSession has been disposed');
    }
  }
}
