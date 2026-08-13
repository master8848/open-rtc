//
//  RTCPeerConnectionSession.swift
//  VidcallWebRTC
//
//  Real GoogleWebRTC adapter for `PeerConnectionSession` / `DataChannelSession`
//  (module name `WebRTC`, pinned WebRTC 150.0.0 xcframework — see
//  Package.swift / README "WebRTC integration"). Compiled only when the
//  `WebRTC` module is linked; the negotiation state machine itself is
//  WebRTC-agnostic and lives in PeerConnectionManager.swift.
//

#if canImport(WebRTC)

import AVFoundation
import Foundation
import Vidcall
import WebRTC

/// `RTCDataChannel` adapter.
final class RTCDataChannelSession: NSObject, DataChannelSession, RTCDataChannelDelegate {
    private let channel: RTCDataChannel

    init(channel: RTCDataChannel) {
        self.channel = channel
        super.init()
        channel.delegate = self
    }

    var label: String { channel.label }

    var readyState: DataChannelState {
        switch channel.readyState {
        case .connecting: return .connecting
        case .open: return .open
        case .closing: return .closing
        case .closed: return .closed
        @unknown default: return .closed
        }
    }

    var bufferedAmount: UInt64 { channel.bufferedAmount }

    @discardableResult
    func sendData(_ data: Data, isBinary: Bool = false) -> Bool {
        channel.sendData(RTCDataBuffer(data: data, isBinary: isBinary))
    }

    func close() {
        channel.close()
    }

    var onOpen: (() -> Void)?
    var onClose: (() -> Void)?
    var onError: ((Error) -> Void)?
    var onMessage: ((Data) -> Void)?
    var onBufferedAmountChange: ((UInt64) -> Void)?

    // MARK: RTCDataChannelDelegate

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        switch dataChannel.readyState {
        case .open:
            onOpen?()
        case .closed:
            onClose?()
        default:
            break
        }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        onMessage?(buffer.data)
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didChangeBufferedAmount amount: UInt64) {
        onBufferedAmountChange?(amount)
    }
}

/// `RTCPeerConnection` + factory adapter. Created via
/// `RTCPeerConnectionSession.make(configuration:)`.
final class RTCPeerConnectionSession: NSObject, PeerConnectionSession, RTCPeerConnectionDelegate {
    let factory: RTCPeerConnectionFactory
    let peerConnection: RTCPeerConnection

    // MARK: PeerConnectionSession callbacks

    var onLocalIceCandidate: ((IceCandidate) -> Void)?
    var onDataChannel: ((DataChannelSession) -> Void)?
    var onNegotiationNeeded: (() -> Void)?
    var onConnectionStateChange: ((PeerConnectionState) -> Void)?

    private init(factory: RTCPeerConnectionFactory, peerConnection: RTCPeerConnection) {
        self.factory = factory
        self.peerConnection = peerConnection
        super.init()
        peerConnection.delegate = self
    }

    /// Builds the factory + peer connection from the vidcall configuration.
    /// Returns nil if the peer connection could not be created.
    static func make(configuration: PeerConnectionConfiguration) -> RTCPeerConnectionSession? {
        let encoderFactory = RTCDefaultVideoEncoderFactory()
        let decoderFactory = RTCDefaultVideoDecoderFactory()
        let factory = RTCPeerConnectionFactory(encoderFactory: encoderFactory, decoderFactory: decoderFactory)

        let rtcConfiguration = RTCConfiguration()
        rtcConfiguration.sdpSemantics = .unifiedPlan
        rtcConfiguration.iceServers = configuration.iceServers.map { RTCIceServer(urlStrings: [$0]) }

        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peerConnection = factory.peerConnection(
            with: rtcConfiguration,
            constraints: constraints,
            delegate: nil
        ) else {
            return nil
        }
        return RTCPeerConnectionSession(factory: factory, peerConnection: peerConnection)
    }

    // MARK: PeerConnectionSession

    var signalingState: PeerSignalingState {
        switch peerConnection.signalingState {
        case .stable: return .stable
        case .haveLocalOffer, .haveLocalPrAnswer: return .haveLocalOffer
        case .haveRemoteOffer, .haveRemotePrAnswer: return .haveRemoteOffer
        case .closed: return .closed
        @unknown default: return .closed
        }
    }

    var remoteDescriptionIsSet: Bool {
        peerConnection.remoteDescription != nil
    }

    func createOffer(iceRestart: Bool) async throws -> SessionDescription {
        let constraints = RTCMediaConstraints(
            mandatoryConstraints: iceRestart ? ["IceRestart": "true"] : nil,
            optionalConstraints: nil
        )
        if iceRestart {
            // W3C-style restart: the next offer carries fresh ICE credentials
            // (RFC 8445 §9). M150 also honors the `IceRestart` constraint as
            // a belt-and-braces fallback for stacks without `restartIce`.
            peerConnection.restartIce()
        }
        return try await withCheckedThrowingContinuation { continuation in
            peerConnection.offer(for: constraints) { sdp, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let sdp {
                    continuation.resume(returning: SessionDescription(type: .offer, sdp: sdp.sdp))
                } else {
                    continuation.resume(throwing: VidcallError.invalidMessage("offer produced no SDP"))
                }
            }
        }
    }

    func createAnswer() async throws -> SessionDescription {
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        return try await withCheckedThrowingContinuation { continuation in
            peerConnection.answer(for: constraints) { sdp, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let sdp {
                    continuation.resume(returning: SessionDescription(type: .answer, sdp: sdp.sdp))
                } else {
                    continuation.resume(throwing: VidcallError.invalidMessage("answer produced no SDP"))
                }
            }
        }
    }

    func setLocalDescription(_ description: SessionDescription) async throws {
        let sdp = RTCSessionDescription(type: rtcSdpType(description.type), sdp: description.sdp)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peerConnection.setLocalDescription(sdp) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    func setRemoteDescription(_ description: SessionDescription) async throws {
        let sdp = RTCSessionDescription(type: rtcSdpType(description.type), sdp: description.sdp)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peerConnection.setRemoteDescription(sdp) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    func addIceCandidate(_ candidate: IceCandidate) async throws {
        let rtcCandidate = RTCIceCandidate(
            sdp: candidate.sdp,
            sdpMLineIndex: candidate.sdpMLineIndex,
            sdpMid: candidate.sdpMid
        )
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peerConnection.add(rtcCandidate) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    func createDataChannel(label: String) -> DataChannelSession? {
        let configuration = RTCDataChannelConfiguration()
        configuration.isOrdered = true
        guard let channel = peerConnection.dataChannel(forLabel: label, configuration: configuration) else {
            return nil
        }
        return RTCDataChannelSession(channel: channel)
    }

    func close() {
        peerConnection.close()
    }

    // MARK: Media (convenience)

    /// Creates a local audio track (factory default audio source) and adds it
    /// to the peer connection.
    @discardableResult
    func addLocalAudioTrack() -> RTCAudioTrack? {
        let source = factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let track = factory.audioTrack(with: source, trackId: "audio0")
        peerConnection.add(track, streamIds: [PeerConnectionManager.localStreamId])
        return track
    }

    /// Creates a local video source (for `RTCCameraVideoCapturer`).
    func makeVideoSource() -> RTCVideoSource {
        factory.videoSource()
    }

    /// Wraps a video source in a track and adds it to the peer connection.
    @discardableResult
    func addLocalVideoTrack(source: RTCVideoSource) -> RTCVideoTrack? {
        let track = factory.videoTrack(with: source, trackId: "video0")
        peerConnection.add(track, streamIds: [PeerConnectionManager.localStreamId])
        return track
    }

    /// Starts the camera on a capturer backed by the given video source.
    /// Picks the front camera and its highest-resolution format ≤ 1280px wide.
    func startCameraCapture(
        on capturer: RTCCameraVideoCapturer,
        position: AVCaptureDevice.Position = .front,
        maxFrameRate: Int = 30
    ) {
        guard let device = RTCCameraVideoCapturer.captureDevices().first(where: { $0.position == position })
            ?? RTCCameraVideoCapturer.captureDevices().first
        else {
            onConnectionStateChange?(.failed)
            return
        }
        let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
        let format = formats.first { format in
            let width = CMVideoFormatDescriptionGetDimensions(format.formatDescription).width
            return Int(width) <= 1280
        } ?? formats.first
        guard let format else {
            onConnectionStateChange?(.failed)
            return
        }
        capturer.startCapture(with: device, format: format, fps: maxFrameRate) { [weak self] error in
            if let error {
                self?.onConnectionStateChange?(.failed)
            }
        }
    }

    // MARK: RTCPeerConnectionDelegate

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {
        // No public action required; kept for parity with the JS core events.
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        // Streams are surfaced as tracks via `didAddReceiver`/`ontrack` in
        // unified plan; retained for plan B fallback.
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {
        // Unified Plan does not call this; retained for completeness.
    }

    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {
        onNegotiationNeeded?()
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        // Standardized connection state is delivered via
        // `didChangeConnectionState`; this legacy callback is retained for
        // completeness.
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        // ICE gathering lifecycle; candidates arrive via didGenerate.
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        onLocalIceCandidate?(IceCandidate(
            sdp: candidate.sdp,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex
        ))
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {
        // Candidate removal is not signaled by vidcall's protocol; ignore.
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        onDataChannel?(RTCDataChannelSession(channel: dataChannel))
    }

    func peerConnection(
        _ peerConnection: RTCPeerConnection,
        didChange newState: RTCPeerConnectionState
    ) {
        switch newState {
        case .connected:
            onConnectionStateChange?(.connected)
        case .failed:
            onConnectionStateChange?(.failed)
        case .disconnected:
            onConnectionStateChange?(.disconnected)
        case .closed:
            onConnectionStateChange?(.closed)
        case .new:
            onConnectionStateChange?(.new)
        case .connecting:
            onConnectionStateChange?(.connecting)
        @unknown default:
            break
        }
    }

    // MARK: Internals

    private func rtcSdpType(_ kind: SessionDescription.Kind) -> RTCSdpType {
        switch kind {
        case .offer: return .offer
        case .answer: return .answer
        case .rollback: return .rollback
        }
    }
}

// MARK: - Media helpers on the manager (real-WebRTC only)

extension PeerConnectionManager {
    /// The underlying `RTCPeerConnection` (advanced use); nil when the session
    /// is not the real WebRTC adapter (e.g. tests with fakes).
    public var peerConnection: RTCPeerConnection? {
        (session as? RTCPeerConnectionSession)?.peerConnection
    }

    /// Creates a local audio track (factory default audio source) and adds it
    /// to the peer connection. No-op (nil) without the real WebRTC session.
    @discardableResult
    public func addLocalAudioTrack() -> RTCAudioTrack? {
        (session as? RTCPeerConnectionSession)?.addLocalAudioTrack()
    }

    /// Creates a local video source (for `RTCCameraVideoCapturer`); nil
    /// without the real WebRTC session.
    public func makeVideoSource() -> RTCVideoSource? {
        (session as? RTCPeerConnectionSession)?.makeVideoSource()
    }

    /// Wraps a video source in a track and adds it to the peer connection.
    @discardableResult
    public func addLocalVideoTrack(source: RTCVideoSource) -> RTCVideoTrack? {
        (session as? RTCPeerConnectionSession)?.addLocalVideoTrack(source: source)
    }

    /// Starts the camera on a capturer backed by the given video source.
    /// Picks the front camera and its highest-resolution format ≤ 1280px wide.
    public func startCameraCapture(
        on capturer: RTCCameraVideoCapturer,
        position: AVCaptureDevice.Position = .front,
        maxFrameRate: Int = 30
    ) {
        (session as? RTCPeerConnectionSession)?.startCameraCapture(
            on: capturer,
            position: position,
            maxFrameRate: maxFrameRate
        )
    }
}

#endif // canImport(WebRTC)
