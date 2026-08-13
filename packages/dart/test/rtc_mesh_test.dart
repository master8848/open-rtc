/// L1/L2 unit tests for [RtcMeshSession] with a fake signaling hub
/// (broadcast WebSockets) and fake peer connections (injected via
/// [PeerConnectionFactory]): 3-peer join/offer/answer/ICE flow, per-peer
/// sender routing, targetSenderId unicast, seq ordering/dedupe, auto-pong,
/// leave/dispose teardown, data channels, and perfect-negotiation glare.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:vidcall/src/client.dart';
import 'package:vidcall/src/protocol/envelope.dart';
import 'package:vidcall/src/protocol/message_type.dart';
import 'package:vidcall/src/protocol/payloads.dart';
import 'package:vidcall/src/rtc_mesh.dart';
import 'package:webrtc_interface/webrtc_interface.dart' hide MessageType;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/// Dumb broadcast hub: every frame added to any socket is delivered to every
/// other socket in the same room (no targetSenderId filtering — backends MAY
/// ignore it, so the mesh MUST filter).
class _FakeSignalingHub {
  final Map<String, Set<_FakeWebSocket>> _rooms = <String, Set<_FakeWebSocket>>{};

  void register(_FakeWebSocket socket) {
    _rooms.putIfAbsent(socket.roomId, () => <_FakeWebSocket>{}).add(socket);
  }

  void unregister(_FakeWebSocket socket) {
    _rooms[socket.roomId]?.remove(socket);
  }

  void broadcast(_FakeWebSocket sender, String text) {
    final room = _rooms[sender.roomId];
    if (room == null) {
      return;
    }
    for (final socket in List<_FakeWebSocket>.of(room)) {
      if (socket == sender) {
        continue;
      }
      socket.deliver(text);
    }
  }
}

/// Minimal `dart:io` WebSocket fake: only the surface `VidcallClient` uses
/// (listen/add/close) is implemented; everything else is a no-op.
class _FakeWebSocket implements WebSocket {
  _FakeWebSocket({required this.hub, required this.roomId}) {
    hub.register(this);
  }

  final _FakeSignalingHub hub;
  final String roomId;
  final List<String> sent = <String>[];
  StreamController<dynamic>? _incoming;

  @override
  StreamSubscription<dynamic> listen(
    void Function(dynamic event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    _incoming ??= StreamController<dynamic>();
    return _incoming!.stream.listen(onData,
        onError: onError, onDone: onDone, cancelOnError: cancelOnError);
  }

  @override
  void add(dynamic data) {
    final text = data is String ? data : utf8.decode(data as List<int>);
    sent.add(text);
    hub.broadcast(this, text);
  }

  @override
  Future<void> close([int? code, String? reason]) async {
    hub.unregister(this);
  }

  /// Delivers an inbound frame to the subscriber (async, like a real socket).
  void deliver(String text) => _incoming?.add(text);

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

/// Fake media track.
class _FakeMediaStreamTrack extends MediaStreamTrack {
  _FakeMediaStreamTrack(this.trackId, this.trackKind);

  final String? trackId;
  final String? trackKind;
  bool _enabled = true;

  @override
  String? get id => trackId;

  @override
  String? get kind => trackKind;

  @override
  String? get label => trackId;

  @override
  bool get enabled => _enabled;

  @override
  set enabled(bool value) {
    _enabled = value;
  }

  @override
  bool? get muted => false;

  @override
  Future<void> stop() async {}

  @override
  Future<void> dispose() async {}
}

/// Fake media stream (a track container).
class _FakeMediaStream extends MediaStream {
  _FakeMediaStream(String streamId) : super(streamId, 'fake');

  final List<MediaStreamTrack> _tracks = <MediaStreamTrack>[];

  @override
  bool? get active => true;

  @override
  Future<void> getMediaTracks() async {}

  @override
  Future<void> addTrack(MediaStreamTrack track, {bool addToNative = true}) async {
    _tracks.add(track);
  }

  @override
  Future<void> removeTrack(MediaStreamTrack track,
      {bool removeFromNative = true}) async {
    _tracks.remove(track);
  }

  @override
  List<MediaStreamTrack> getTracks() => List<MediaStreamTrack>.of(_tracks);

  @override
  List<MediaStreamTrack> getAudioTracks() =>
      _tracks.where((track) => track.kind == 'audio').toList();

  @override
  List<MediaStreamTrack> getVideoTracks() =>
      _tracks.where((track) => track.kind == 'video').toList();

  @override
  Future<MediaStream> clone() async => this;

  @override
  Future<void> dispose() async {}
}

/// Fake data channel: records sends, tracks open/closed state.
class _FakeRTCDataChannel extends RTCDataChannel {
  _FakeRTCDataChannel(this.channelLabel) {
    stateChangeStream = StreamController<RTCDataChannelState>().stream;
    messageStream = StreamController<RTCDataChannelMessage>().stream;
  }

  final String channelLabel;
  RTCDataChannelState _state = RTCDataChannelState.RTCDataChannelOpen;
  final List<String> sentText = <String>[];
  bool closed = false;

  @override
  RTCDataChannelState? get state => _state;

  @override
  int? get id => 1;

  @override
  String? get label => channelLabel;

  @override
  int? get bufferedAmount => 0;

  @override
  Future<int> getBufferedAmount() async => 0;

  @override
  Future<void> send(RTCDataChannelMessage message) async {
    sentText.add(message.isBinary ? '<binary>' : message.text);
  }

  @override
  Future<void> close() async {
    closed = true;
    _state = RTCDataChannelState.RTCDataChannelClosed;
  }
}

class _DummyRtpSender implements RTCRtpSender {
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

/// Fake peer connection: records offers/answers/ICE/tracks and exposes the
/// platform callbacks so tests can drive trickle ICE, remote tracks, and
/// remote data channels.
class _FakeRTCPeerConnection extends RTCPeerConnection {
  final List<MediaStreamTrack> addedTracks = <MediaStreamTrack>[];
  final List<MediaStream> addedStreams = <MediaStream>[];
  final List<RTCIceCandidate> addedCandidates = <RTCIceCandidate>[];
  final List<RTCDataChannel> createdChannels = <RTCDataChannel>[];
  RTCSessionDescription? localDescription;
  RTCSessionDescription? remoteDescription;
  int remoteDescriptionSetCount = 0;
  bool closed = false;
  bool disposed = false;
  RTCSignalingState? _signalingState = RTCSignalingState.RTCSignalingStateStable;

  @override
  RTCSignalingState? get signalingState => _signalingState;

  @override
  RTCIceGatheringState? get iceGatheringState =>
      RTCIceGatheringState.RTCIceGatheringStateComplete;

  @override
  RTCIceConnectionState? get iceConnectionState =>
      RTCIceConnectionState.RTCIceConnectionStateNew;

  @override
  RTCPeerConnectionState? get connectionState =>
      RTCPeerConnectionState.RTCPeerConnectionStateNew;

  @override
  Map<String, dynamic> get getConfiguration => <String, dynamic>{};

  @override
  Future<RTCSessionDescription> createOffer(
      [Map<String, dynamic>? constraints]) async {
    return RTCSessionDescription(
        'v=0\r\no=- mesh-offer 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
        'offer');
  }

  @override
  Future<RTCSessionDescription> createAnswer(
      [Map<String, dynamic>? constraints]) async {
    return RTCSessionDescription(
        'v=0\r\no=- mesh-answer 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
        'answer');
  }

  @override
  Future<void> setLocalDescription(RTCSessionDescription description) async {
    localDescription = description;
    _signalingState = description.type == 'offer'
        ? RTCSignalingState.RTCSignalingStateHaveLocalOffer
        : RTCSignalingState.RTCSignalingStateStable;
  }

  @override
  Future<void> setRemoteDescription(RTCSessionDescription description) async {
    remoteDescription = description;
    remoteDescriptionSetCount++;
    _signalingState = description.type == 'offer'
        ? RTCSignalingState.RTCSignalingStateHaveRemoteOffer
        : RTCSignalingState.RTCSignalingStateStable;
  }

  @override
  Future<RTCSessionDescription?> getLocalDescription() async =>
      localDescription;

  @override
  Future<RTCSessionDescription?> getRemoteDescription() async =>
      remoteDescription;

  @override
  Future<void> addCandidate(RTCIceCandidate candidate) async {
    addedCandidates.add(candidate);
  }

  @override
  Future<RTCDataChannel> createDataChannel(
      String label, RTCDataChannelInit dataChannelDict) async {
    final channel = _FakeRTCDataChannel(label);
    createdChannels.add(channel);
    return channel;
  }

  @override
  Future<RTCRtpSender> addTrack(MediaStreamTrack track,
      [MediaStream? stream]) async {
    addedTracks.add(track);
    if (stream != null) {
      addedStreams.add(stream);
    }
    return _DummyRtpSender();
  }

  @override
  Future<void> restartIce() async {}

  @override
  Future<void> close() async {
    closed = true;
    _signalingState = RTCSignalingState.RTCSignalingStateClosed;
  }

  @override
  Future<void> dispose() async {
    disposed = true;
  }

  @override
  Future<void> addStream(MediaStream stream) async {}

  @override
  Future<void> removeStream(MediaStream stream) async {}

  @override
  Future<List<StatsReport>> getStats([MediaStreamTrack? track]) async =>
      <StatsReport>[];

  @override
  List<MediaStream?> getLocalStreams() => <MediaStream?>[];

  @override
  List<MediaStream?> getRemoteStreams() => <MediaStream?>[];

  @override
  RTCDTMFSender createDtmfSender(MediaStreamTrack track) =>
      throw UnimplementedError('not used in mesh tests');

  @override
  Future<List<RTCRtpSender>> getSenders() async => <RTCRtpSender>[];

  @override
  Future<List<RTCRtpReceiver>> getReceivers() async => <RTCRtpReceiver>[];

  @override
  Future<List<RTCRtpTransceiver>> getTransceivers() async =>
      <RTCRtpTransceiver>[];

  @override
  Future<bool> removeTrack(RTCRtpSender sender) async => false;

  @override
  Future<RTCRtpTransceiver> addTransceiver(
          {MediaStreamTrack? track,
          RTCRtpMediaType? kind,
          RTCRtpTransceiverInit? init}) async =>
      throw UnimplementedError('not used in mesh tests');

  @override
  Future<void> setConfiguration(Map<String, dynamic> configuration) async {}
}

/// Fake PC whose `createOffer` blocks until [gate] completes, so tests can
/// hold a peer in the "offer in flight" state to exercise glare.
class _BlockingOfferPc extends _FakeRTCPeerConnection {
  final Completer<void> entered = Completer<void>();
  final Completer<void> gate = Completer<void>();

  @override
  Future<RTCSessionDescription> createOffer(
      [Map<String, dynamic>? constraints]) {
    if (!entered.isCompleted) {
      entered.complete();
    }
    return gate.future.then((_) => super.createOffer(constraints));
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// One mesh participant wired to the fake hub.
class _MeshNode {
  _MeshNode(this.hub,
      {required this.senderId,
      required this.roomId,
      this.displayName,
      PeerConnectionFactory? peerFactory})
      : peerFactory =
            peerFactory ?? ((configuration) async => _FakeRTCPeerConnection());

  final _FakeSignalingHub hub;
  final String senderId;
  final String roomId;
  final String? displayName;
  final PeerConnectionFactory peerFactory;
  final List<_FakeRTCPeerConnection> createdPcs =
      <_FakeRTCPeerConnection>[];

  late final _FakeWebSocket socket;
  late final VidcallClient client;
  late final RtcMeshSession mesh;

  Future<void> connectAndStart() async {
    socket = _FakeWebSocket(hub: hub, roomId: roomId);
    client = VidcallClient(
      roomId: roomId,
      senderId: senderId,
      connector: (Uri uri) async => socket,
    );
    await client.connect(Uri.parse('ws://fake/signal'));
    mesh = RtcMeshSession(
      client: client,
      peerFactory: (Map<String, dynamic> configuration) async {
        final pc = await peerFactory(configuration);
        createdPcs.add(pc as _FakeRTCPeerConnection);
        return pc;
      },
      displayName: displayName,
    );
    await mesh.start();
  }

  /// All envelopes this node has put on the wire so far.
  List<Envelope> sentEnvelopes() =>
      socket.sent.map(Envelope.parse).toList();
}

/// Polls until [condition] holds (the fake hub delivers asynchronously).
Future<void> waitFor(
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 5),
  String? message,
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      fail(message ?? 'condition not met within $timeout');
    }
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

/// Injects a raw envelope into the room from a throwaway socket (bypasses
/// any real client, so arbitrary sessionId/seq/target can be crafted).
void _injectEnvelope(_FakeSignalingHub hub, String roomId, Envelope envelope) {
  _FakeWebSocket(hub: hub, roomId: roomId).add(jsonEncode(envelope.toJson()));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  test('3-peer join/offer/answer/ICE flow over one shared socket', () async {
    final hub = _FakeSignalingHub();
    final a = _MeshNode(hub,
        senderId: 'a', roomId: 'room-1', displayName: 'User a');
    final b = _MeshNode(hub,
        senderId: 'b', roomId: 'room-1', displayName: 'User b');
    final c = _MeshNode(hub,
        senderId: 'c', roomId: 'room-1', displayName: 'User c');
    await a.connectAndStart();
    await b.connectAndStart();
    await c.connectAndStart();

    await a.client.join();
    await b.client.join();
    await c.client.join();

    // Roster converges: broadcast joins + targeted roster replies.
    await waitFor(() =>
        b.mesh.participant('a') != null &&
        c.mesh.participant('a') != null &&
        a.mesh.participant('b') != null &&
        a.mesh.participant('c') != null &&
        b.mesh.participant('c') != null &&
        c.mesh.participant('b') != null);
    // The roster reply carries our join info to the newcomer.
    expect(b.mesh.participant('a')!.displayName, 'User a');
    expect(c.mesh.participant('a')!.displayName, 'User a');

    // A publishes a local stream -> one PC + offer per participant.
    final track = _FakeMediaStreamTrack('cam-1', 'video');
    final stream = _FakeMediaStream('stream-1');
    await stream.addTrack(track);
    await a.mesh.addLocalStream(stream);

    // B and C each open a peer for A and answer A's offer.
    await waitFor(() =>
        b.mesh.peerConnection('a') != null && c.mesh.peerConnection('a') != null);
    final pcB2A = b.mesh.peerConnection('a')! as _FakeRTCPeerConnection;
    final pcC2A = c.mesh.peerConnection('a')! as _FakeRTCPeerConnection;
    await waitFor(() =>
        pcB2A.remoteDescription?.type == 'offer' &&
        pcC2A.remoteDescription?.type == 'offer');

    // A receives both answers on the matching per-peer connections.
    final pcA2B = a.mesh.peerConnection('b')! as _FakeRTCPeerConnection;
    final pcA2C = a.mesh.peerConnection('c')! as _FakeRTCPeerConnection;
    await waitFor(() =>
        pcA2B.remoteDescription?.type == 'answer' &&
        pcA2C.remoteDescription?.type == 'answer');
    expect(pcA2B, isNot(same(pcA2C)));

    // Unicast routing: A's offers carry the per-peer targetSenderId, and
    // B's answer is addressed back to A.
    final offers =
        a.sentEnvelopes().where((e) => e.type == MessageType.offer).toList();
    expect(offers.map((e) => e.targetSenderId).toSet(), {'b', 'c'});
    final answersFromB =
        b.sentEnvelopes().where((e) => e.type == MessageType.answer).toList();
    expect(answersFromB, isNotEmpty);
    expect(answersFromB.every((e) => e.targetSenderId == 'a'), isTrue);

    // Trickle ICE: A's candidate for B lands on B's peer for A.
    pcA2B.onIceCandidate!(RTCIceCandidate(
        'candidate:1 1 udp 1 127.0.0.1 9 typ host', '0', 0));
    await waitFor(() => pcB2A.addedCandidates.length == 1);
    expect(pcB2A.addedCandidates.single.candidate,
        'candidate:1 1 udp 1 127.0.0.1 9 typ host');

    // Remote tracks surface tagged with the sending participant.
    final trackEvents = <MeshTrackEvent>[];
    b.mesh.onTrack.listen(trackEvents.add);
    final remoteStream = _FakeMediaStream('remote-1');
    await remoteStream.addTrack(track);
    pcB2A.onTrack!(
        RTCTrackEvent(streams: <MediaStream>[remoteStream], track: track));
    await waitFor(() => trackEvents.length == 1);
    expect(trackEvents.single.participantId, 'a');
    expect(trackEvents.single.track, track);
    expect(trackEvents.single.stream, remoteStream);

    // One data channel per peer, labeled 'vidcall'.
    expect(pcA2B.createdChannels.single.label, 'vidcall');
    expect(pcB2A.createdChannels.single.label, 'vidcall');

    await a.mesh.dispose();
    await b.mesh.dispose();
    await c.mesh.dispose();
  });

  test('sender filtering: only the matching sender drives that peer', () async {
    final hub = _FakeSignalingHub();
    final a = _MeshNode(hub, senderId: 'a', roomId: 'room-1');
    final b = _MeshNode(hub, senderId: 'b', roomId: 'room-1');
    final c = _MeshNode(hub, senderId: 'c', roomId: 'room-1');
    await a.connectAndStart();
    await b.connectAndStart();
    await c.connectAndStart();
    await a.client.join();
    await b.client.join();
    await c.client.join();
    await waitFor(() =>
        a.mesh.participant('b') != null && a.mesh.participant('c') != null);

    // A-B peer established through A's publish.
    await a.mesh.publish(_FakeMediaStreamTrack('cam-a', 'video'));
    final pcA2B = a.mesh.peerConnection('b')! as _FakeRTCPeerConnection;
    await waitFor(() => pcA2B.remoteDescription?.type == 'answer');

    // C publishes too: A creates a SEPARATE peer for C.
    await c.mesh.publish(_FakeMediaStreamTrack('cam-c', 'video'));
    await waitFor(() => a.mesh.peerConnection('c') != null);
    final pcA2C = a.mesh.peerConnection('c')! as _FakeRTCPeerConnection;
    await waitFor(() => pcA2C.remoteDescriptionSetCount >= 1);

    // C's signaling drove C's connection only: B's PC saw exactly B's answer.
    expect(a.mesh.peerConnection('b'), isNot(same(a.mesh.peerConnection('c'))));
    expect(pcA2B.remoteDescriptionSetCount, 1);

    // Envelopes from an unknown sender addressed to someone else are dropped
    // entirely (no peer, no roster entry).
    _injectEnvelope(hub, 'room-1', Envelope(
      type: MessageType.offer,
      roomId: 'room-1',
      senderId: 'evil',
      sessionId: 'sess-evil',
      ts: 1,
      seq: 0,
      targetSenderId: 'b',
      payload: SdpPayload(sdp: 'v=0 spoofed').toJson(),
    ));
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(a.mesh.peerConnection('evil'), isNull);
    expect(a.mesh.participant('evil'), isNull);
    expect(pcA2B.remoteDescriptionSetCount, 1);

    await a.mesh.dispose();
    await b.mesh.dispose();
    await c.mesh.dispose();
  });

  test('unicast routing: targeted signals only drive the addressed peer',
      () async {
    final hub = _FakeSignalingHub();
    final a = _MeshNode(hub, senderId: 'a', roomId: 'room-1');
    final b = _MeshNode(hub, senderId: 'b', roomId: 'room-1');
    final c = _MeshNode(hub, senderId: 'c', roomId: 'room-1');
    await a.connectAndStart();
    await b.connectAndStart();
    await c.connectAndStart();
    await a.client.join();
    await b.client.join();
    await c.client.join();
    await waitFor(() =>
        a.mesh.participant('b') != null && c.mesh.participant('b') != null);

    // B offers ONLY to A (targeted unicast); the hub broadcasts to everyone.
    await b.mesh.sendOffer('a');
    await waitFor(() => a.mesh.peerConnection('b') != null);
    final pcA2B = a.mesh.peerConnection('b')! as _FakeRTCPeerConnection;
    await waitFor(() => pcA2B.remoteDescription?.type == 'offer');

    // A answered, addressed back to B (unicast on the wire).
    await waitFor(() => a.sentEnvelopes().any((e) =>
        e.type == MessageType.answer && e.targetSenderId == 'b'));
    final offerFromB =
        b.sentEnvelopes().firstWhere((e) => e.type == MessageType.offer);
    expect(offerFromB.targetSenderId, 'a');

    // C received the same broadcast but ignored it (targetSenderId != c):
    // no peer for B is created on C, and C never answers.
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(c.mesh.peerConnection('b'), isNull);
    expect(c.sentEnvelopes().where((e) => e.type == MessageType.answer),
        isEmpty);

    await a.mesh.dispose();
    await b.mesh.dispose();
    await c.mesh.dispose();
  });

  test('ordering/dedupe: duplicate and stale envelopes are dropped per session',
      () async {
    final hub = _FakeSignalingHub();
    final a = _MeshNode(hub, senderId: 'a', roomId: 'room-1');
    await a.connectAndStart();
    Envelope offer(int seq, String sdp) => Envelope(
          type: MessageType.offer,
          roomId: 'room-1',
          senderId: 'b',
          sessionId: 'sess-b',
          ts: 1,
          seq: seq,
          targetSenderId: 'a',
          payload: SdpPayload(sdp: sdp).toJson(),
        );

    _injectEnvelope(hub, 'room-1', offer(10, 'v=0 first'));
    await waitFor(() => a.mesh.peerConnection('b') != null);
    final pcA2B = a.mesh.peerConnection('b')! as _FakeRTCPeerConnection;
    await waitFor(() => pcA2B.remoteDescriptionSetCount == 1);

    // Same seq (duplicate retransmission) and a stale lower seq: both dropped.
    _injectEnvelope(hub, 'room-1', offer(10, 'v=0 first'));
    _injectEnvelope(hub, 'room-1', offer(9, 'v=0 stale'));
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(pcA2B.remoteDescriptionSetCount, 1);

    // A newer seq is processed.
    _injectEnvelope(hub, 'room-1', offer(11, 'v=0 second'));
    await waitFor(() => pcA2B.remoteDescriptionSetCount == 2);
    expect(pcA2B.remoteDescription?.sdp, 'v=0 second');

    await a.mesh.dispose();
  });

  test('auto-pong: a ping is answered with a targeted pong', () async {
    final hub = _FakeSignalingHub();
    final a = _MeshNode(hub, senderId: 'a', roomId: 'room-1');
    final b = _MeshNode(hub, senderId: 'b', roomId: 'room-1');
    await a.connectAndStart();
    await b.connectAndStart();
    await a.client.join();
    await b.client.join();
    await waitFor(() =>
        a.mesh.participant('b') != null && b.mesh.participant('a') != null);

    await b.client.sendPing();
    await waitFor(() =>
        a.sentEnvelopes().any((e) => e.type == MessageType.pong));
    final pong =
        a.sentEnvelopes().firstWhere((e) => e.type == MessageType.pong);
    expect(pong.targetSenderId, 'b');
    expect(pong.payload, isNull);
    expect(jsonDecode(pong.encode()), isNot(contains('payload')));

    await a.mesh.dispose();
    await b.mesh.dispose();
  });

  test('leave removes the participant and closes their peer connection',
      () async {
    final hub = _FakeSignalingHub();
    final a = _MeshNode(hub, senderId: 'a', roomId: 'room-1');
    final b = _MeshNode(hub, senderId: 'b', roomId: 'room-1');
    await a.connectAndStart();
    await b.connectAndStart();
    await a.client.join();
    await b.client.join();
    await a.mesh.publish(_FakeMediaStreamTrack('cam-a', 'video'));
    await waitFor(() => b.mesh.peerConnection('a') != null);
    final pcB2A = b.mesh.peerConnection('a')! as _FakeRTCPeerConnection;
    await waitFor(() => pcB2A.remoteDescription?.type == 'offer');
    final dataChannel = b.mesh.dataChannel('a')!;

    final left = <String>[];
    b.mesh.onParticipantLeft.listen((p) => left.add(p.id));
    await a.client.leave(reason: 'bye');

    await waitFor(() => left.contains('a'));
    expect(b.mesh.participant('a'), isNull);
    expect(b.mesh.peerConnection('a'), isNull);
    expect(pcB2A.closed, isTrue);
    expect(pcB2A.disposed, isTrue);
    expect((dataChannel.channel! as _FakeRTCDataChannel).closed, isTrue);

    await b.mesh.dispose();
  });

  test('dispose closes every peer connection and data channel', () async {
    final hub = _FakeSignalingHub();
    final a = _MeshNode(hub, senderId: 'a', roomId: 'room-1');
    final b = _MeshNode(hub, senderId: 'b', roomId: 'room-1');
    final c = _MeshNode(hub, senderId: 'c', roomId: 'room-1');
    await a.connectAndStart();
    await b.connectAndStart();
    await c.connectAndStart();
    await a.client.join();
    await b.client.join();
    await c.client.join();
    await a.mesh.publish(_FakeMediaStreamTrack('cam-a', 'video'));
    await waitFor(() => a.createdPcs.length == 2);

    final pcs = List<_FakeRTCPeerConnection>.of(a.createdPcs);
    final channels = pcs
        .map((pc) => pc.createdChannels.single as _FakeRTCDataChannel)
        .toList();
    await a.mesh.dispose();

    expect(a.mesh.isDisposed, isTrue);
    for (final pc in pcs) {
      expect(pc.closed, isTrue);
      expect(pc.disposed, isTrue);
    }
    for (final channel in channels) {
      expect(channel.closed, isTrue);
    }
    expect(a.mesh.participants, isEmpty);
    expect(a.mesh.peerConnection('b'), isNull);
    expect(a.mesh.peerConnection('c'), isNull);
    await expectLater(
        a.mesh.publish(_FakeMediaStreamTrack('late', 'video')),
        throwsStateError);

    await b.mesh.dispose();
    await c.mesh.dispose();
  });

  test('data channel per peer: local creation, remote adoption, wire frames',
      () async {
    final hub = _FakeSignalingHub();
    final a = _MeshNode(hub, senderId: 'a', roomId: 'room-1');
    final b = _MeshNode(hub, senderId: 'b', roomId: 'room-1');
    await a.connectAndStart();
    await b.connectAndStart();
    await a.client.join();
    await b.client.join();
    await a.mesh.publish(_FakeMediaStreamTrack('cam-a', 'video'));
    await waitFor(() =>
        a.mesh.peerConnection('b') != null && b.mesh.peerConnection('a') != null);

    final pcA2B = a.mesh.peerConnection('b')! as _FakeRTCPeerConnection;
    final pcB2A = b.mesh.peerConnection('a')! as _FakeRTCPeerConnection;
    await waitFor(() =>
        pcA2B.createdChannels.isNotEmpty && pcB2A.createdChannels.isNotEmpty);
    expect(pcA2B.createdChannels.single.label, 'vidcall');
    expect(pcB2A.createdChannels.single.label, 'vidcall');
    final busB = b.mesh.dataChannel('a')!;
    expect(busB.isOpen, isTrue);

    // Remote channel adoption: the channel the remote side negotiated wins.
    final remoteChannel = _FakeRTCDataChannel('vidcall');
    pcB2A.onDataChannel!(remoteChannel);
    expect(busB.channel, remoteChannel);

    // Inbound frames decode into typed messages tagged with the sender.
    final messages = <MeshDataMessage>[];
    b.mesh.onData.listen(messages.add);
    remoteChannel.onMessage!(RTCDataChannelMessage(
        '{"v":1,"t":"reaction","d":{"emoji":"👍","targetSenderId":"b"}}'));
    remoteChannel.onMessage!(
        RTCDataChannelMessage('{"v":1,"t":"chat","d":{"text":"hi"}}'));
    remoteChannel.onMessage!(RTCDataChannelMessage(
        '{"v":1,"t":"control","d":{"action":"keyframe-request"}}'));
    await waitFor(() => messages.length == 3);
    expect(messages[0].participantId, 'a');
    expect(messages[0].kind, MeshDataKind.reaction);
    expect(messages[0].payload['emoji'], '👍');
    expect(messages[0].payload['targetSenderId'], 'b');
    expect(messages[1].kind, MeshDataKind.chat);
    expect(messages[2].kind, MeshDataKind.control);

    // Outbound frames use the same wire format.
    await busB.sendReaction('🚀');
    expect(jsonDecode(remoteChannel.sentText.single),
        {'v': 1, 't': 'reaction', 'd': {'emoji': '🚀'}});

    // Unknown versions and malformed frames are dropped silently.
    remoteChannel.onMessage!(
        RTCDataChannelMessage('{"v":2,"t":"reaction","d":{}}'));
    remoteChannel.onMessage!(RTCDataChannelMessage('not json'));
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(messages.length, 3);

    await a.mesh.dispose();
    await b.mesh.dispose();
  });

  test('perfect negotiation: polite peer rolls back, impolite peer ignores',
      () async {
    final hub = _FakeSignalingHub();
    // 'a' < 'b' lexicographically -> a is polite, b is impolite.
    final a = _MeshNode(hub,
        senderId: 'a',
        roomId: 'room-1',
        peerFactory: (configuration) async => _BlockingOfferPc());
    final b = _MeshNode(hub,
        senderId: 'b',
        roomId: 'room-1',
        peerFactory: (configuration) async => _BlockingOfferPc());
    await a.connectAndStart();
    await b.connectAndStart();
    await a.client.join();
    await b.client.join();
    await waitFor(() =>
        a.mesh.participant('b') != null && b.mesh.participant('a') != null);

    // --- Impolite side first (no real offers in flight yet): B has an
    // offer in flight when A's offer arrives.
    final offerFutureB = b.mesh.sendOffer('a');
    await waitFor(() => b.mesh.peerConnection('a') != null);
    final pcB2A = b.mesh.peerConnection('a')! as _BlockingOfferPc;
    await pcB2A.entered.future; // createOffer in flight -> makingOffer == true
    _injectEnvelope(hub, 'room-1', Envelope(
      type: MessageType.offer,
      roomId: 'room-1',
      senderId: 'a',
      sessionId: 'sess-a',
      ts: 1,
      seq: 2,
      targetSenderId: 'b',
      payload: SdpPayload(sdp: 'v=0 a-offer').toJson(),
    ));
    await Future<void>.delayed(const Duration(milliseconds: 100));
    // Ignored the colliding remote offer: no remote description, no answer.
    expect(pcB2A.remoteDescription, isNull);
    expect(
        b.sentEnvelopes().where((e) => e.type == MessageType.answer), isEmpty);
    pcB2A.gate.complete();
    await offerFutureB;

    // --- Polite side: A has an offer in flight when B's offer arrives.
    final offerFutureA = a.mesh.sendOffer('b');
    await waitFor(() => a.mesh.peerConnection('b') != null);
    final pcA2B = a.mesh.peerConnection('b')! as _BlockingOfferPc;
    await pcA2B.entered.future; // createOffer in flight -> makingOffer == true
    _injectEnvelope(hub, 'room-1', Envelope(
      type: MessageType.offer,
      roomId: 'room-1',
      senderId: 'b',
      sessionId: 'sess-b',
      ts: 1,
      seq: 2,
      targetSenderId: 'a',
      payload: SdpPayload(sdp: 'v=0 b-offer').toJson(),
    ));
    // Rolled back its in-flight offer and accepted B's offer (the answer is
    // addressed back to b and follows the rollback).
    await waitFor(() => pcA2B.remoteDescription?.sdp == 'v=0 b-offer');
    expect(pcA2B.localDescription?.type, 'answer');
    expect(a.sentEnvelopes().where((e) =>
        e.type == MessageType.answer && e.targetSenderId == 'b'), isNotEmpty);
    pcA2B.gate.complete();
    await offerFutureA;

    await a.mesh.dispose();
    await b.mesh.dispose();
  });
}
