//
//  WebRTCPeerConnectionManager.swift
//  VidcallWebRTC
//
//  Peer connection + offer/answer/ICE wired to `VidcallClient` over the vidcall
//  signaling protocol (protocol/schema.json). SDP (`OfferPayload`) and ICE
//  (`IcePayload`) are relayed verbatim — the signaling layer never parses or
//  transforms them, per the protocol rules.
//
//  Compiled only when the `WebRTC` module is linked:
//    Path A — SwiftPM binary target (uncomment `.binaryTarget` in Package.swift;
//             WebRTC 150.0.0, module name `WebRTC`, iOS + macOS slices).
//    Path B — CocoaPods: pod 'WebRTC', '150.0.0' (community) or
//             pod 'GoogleWebRTC', '1.1.32000' (official, 2023-era).
//  Without either, `VidcallWebRTC.makePeerConnectionManager` returns nil and
//  this file compiles to nothing (see VidcallWebRTC.swift).
//
//  Negotiation follows the "perfect negotiation" pattern (same as the vidcall
//  JS core): a polite/impolite flag resolves glare by rolling back impolite
//  offers, and `onRenegotiationNeeded` triggers offers on demand.
//

#if canImport(WebRTC)

import AVFoundation
import Foundation
import Vidcall
import WebRTC

/// Connection status of the underlying `RTCPeerConnection`.
public enum PeerConnectionStatus: Equatable, Sendable {
    case idle
    case connecting
    case connected
    case disconnected
    case failed(String)
}

/// Concrete peer-connection manager backed by GoogleWebRTC
/// (`import WebRTC`). Create it via `VidcallWebRTC.makePeerConnectionManager`.
public final class WebRTCPeerConnectionManager: NSObject, PeerConnectionManaging, RTCPeerConnectionDelegate, @unchecked Sendable {
    /// Stream id used for local media tracks.
    public static let localStreamId = "vidcall-stream"

    // MARK: Callbacks

    /// A local SDP offer is ready — forward via `client.sendOffer` or relay.
    public var onLocalOffer: (@Sendable (OfferPayload) -> Void)?
    /// A local SDP answer is ready — forward via `client.sendAnswer` or relay.
    public var onLocalAnswer: (@Sendable (OfferPayload) -> Void)?
    /// A local trickle ICE candidate is ready — forward via `client.sendIce`.
    public var onLocalIceCandidate: (@Sendable (IcePayload) -> Void)?
    /// A remote media stream was added (`RTCPeerConnectionDelegate.didAddStream`).
    public var onRemoteMediaStream: (@Sendable (RTCMediaStream) -> Void)?
    /// A remote data channel was opened.
    public var onDataChannel: (@Sendable (RTCDataChannel) -> Void)?
    /// Status changes of the peer connection.
    public var onStatusChange: (@Sendable (PeerConnectionStatus) -> Void)?

    /// The underlying `RTCPeerConnection` (advanced use).
    public let peerConnection: RTCPeerConnection
    /// The client this manager is wired to.
    public let client: VidcallClient
    /// Effective configuration.
    public let configuration: PeerConnectionConfiguration

    /// Current status.
    public private(set) var status: PeerConnectionStatus = .idle {
        didSet {
            guard oldValue != status else { return }
            onStatusChange?(status)
        }
    }

    // MARK: Private state

    private let factory: RTCPeerConnectionFactory
    private let mediaConstraints: RTCMediaConstraints
    private let lock = NSLock()
    private var makingOffer = false

    // MARK: Init

    /// Creates the factory + peer connection and registers as a client
    /// listener. Returns nil if the peer connection could not be created
    /// (e.g. WebRTC unavailable).
    public init?(client: VidcallClient, configuration: PeerConnectionConfiguration) {
        let encoderFactory = RTCDefaultVideoEncoderFactory()
        let decoderFactory = RTCDefaultVideoDecoderFactory()
        self.factory = RTCPeerConnectionFactory(encoderFactory: encoderFactory, decoderFactory: decoderFactory)
        self.client = client
        self.configuration = configuration
        self.mediaConstraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)

        let rtcConfiguration = RTCConfiguration()
        rtcConfiguration.sdpSemantics = .unifiedPlan
        rtcConfiguration.iceServers = configuration.iceServers.map { RTCIceServer(urlStrings: [$0]) }

        guard let peerConnection = factory.peerConnection(
            with: rtcConfiguration,
            constraints: mediaConstraints,
            delegate: nil
        ) else {
            return nil
        }
        self.peerConnection = peerConnection
        super.init()
        peerConnection.delegate = self
        client.addListener(self)
    }

    deinit {
        client.removeListener(self)
        peerConnection.close()
    }

    // MARK: PeerConnectionManaging

    public func handleIncoming(event: VidcallClient.Event) {
        switch event {
        case .offer(let envelope, let payload):
            receiveRemoteOffer(payload, from: envelope.senderId)
        case .answer(let envelope, let payload):
            receiveRemoteAnswer(payload, from: envelope.senderId)
        case .ice(_, let payload):
            do {
                try addRemoteIceCandidate(payload)
            } catch {
                status = .failed(error.localizedDescription)
            }
        default:
            break
        }
    }

    public func addRemoteIceCandidate(_ payload: IcePayload) throws {
        let candidate = RTCIceCandidate(
            sdp: payload.candidate,
            sdpMLineIndex: Int32(payload.sdpMLineIndex ?? 0),
            sdpMid: payload.sdpMid
        )
        peerConnection.add(candidate) { [weak self] error in
            if let error {
                self?.status = .failed(error.localizedDescription)
            }
        }
    }

    public func negotiate() async throws {
        lock.lock()
        guard !makingOffer else {
            lock.unlock()
            return
        }
        makingOffer = true
        lock.unlock()
        defer {
            lock.lock()
            makingOffer = false
            lock.unlock()
        }

        let offer = try await makeOffer()
        try await setLocalDescription(offer)
        let payload = OfferPayload(sdp: offer.sdp, label: "main")
        onLocalOffer?(payload)
        try client.sendOffer(payload)
    }

    public func leave() {
        client.removeListener(self)
        peerConnection.close()
        status = .disconnected
    }

    // MARK: Media (convenience)

    /// Creates a local audio track (factory default audio source) and adds it
    /// to the peer connection.
    @discardableResult
    public func addLocalAudioTrack() -> RTCAudioTrack? {
        let source = factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let track = factory.audioTrack(with: source, trackId: "audio0")
        peerConnection.add(track, streamIds: [Self.localStreamId])
        return track
    }

    /// Creates a local video source (for `RTCCameraVideoCapturer`).
    public func makeVideoSource() -> RTCVideoSource {
        factory.videoSource()
    }

    /// Wraps a video source in a track and adds it to the peer connection.
    @discardableResult
    public func addLocalVideoTrack(source: RTCVideoSource) -> RTCVideoTrack? {
        let track = factory.videoTrack(with: source, trackId: "video0")
        peerConnection.add(track, streamIds: [Self.localStreamId])
        return track
    }

    /// Starts the camera on a capturer backed by the given video source.
    /// Picks the front camera and its highest-resolution format ≤ 1280px wide.
    public func startCameraCapture(
        on capturer: RTCCameraVideoCapturer,
        position: AVCaptureDevice.Position = .front,
        maxFrameRate: Int = 30
    ) {
        guard let device = RTCCameraVideoCapturer.captureDevices().first(where: { $0.position == position })
            ?? RTCCameraVideoCapturer.captureDevices().first
        else {
            status = .failed("No camera device available")
            return
        }
        let formats = RTCCameraVideoCapturer.supportedFormats(for: device)
        let format = formats.first { format in
            let width = CMVideoFormatDescriptionGetDimensions(format.formatDescription).width
            return Int(width) <= 1280
        } ?? formats.first
        guard let format else {
            status = .failed("No supported camera format")
            return
        }
        capturer.startCapture(with: device, format: format, fps: maxFrameRate) { [weak self] error in
            if let error {
                self?.status = .failed(error.localizedDescription)
            }
        }
    }

    // MARK: RTCPeerConnectionDelegate

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {
        // No public action required; kept for parity with the JS core events.
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        onRemoteMediaStream?(stream)
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {
        // Unified Plan does not call this; retained for completeness.
    }

    public func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {
        Task { [weak self] in
            try? await self?.negotiate()
        }
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        switch newState {
        case .connected, .completed:
            status = .connected
        case .failed:
            status = .failed("ICE connection failed")
        case .disconnected, .closed:
            status = .disconnected
        default:
            status = .connecting
        }
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        // ICE gathering lifecycle; candidates arrive via didGenerate.
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let payload = IcePayload(
            candidate: candidate.sdp,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: Int(candidate.sdpMLineIndex)
        )
        onLocalIceCandidate?(payload)
        try? client.sendIce(payload)
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {
        // Candidate removal is not signaled by vidcall's protocol; ignore.
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        onDataChannel?(dataChannel)
    }

    // MARK: Perfect negotiation internals

    private func receiveRemoteOffer(_ payload: OfferPayload, from senderId: String) {
        let sdp = RTCSessionDescription(type: .offer, sdp: payload.sdp)
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.setRemoteDescription(sdp)
                if self.shouldAnswerRemoteOffer() {
                    let answer = try await self.makeAnswer()
                    try await self.setLocalDescription(answer)
                    let answerPayload = OfferPayload(sdp: answer.sdp, label: payload.label)
                    self.onLocalAnswer?(answerPayload)
                    try self.client.sendAnswer(answerPayload)
                } else {
                    // Glare: we were already making an offer; roll back the
                    // impolite remote offer.
                    let rollback = RTCSessionDescription(type: .rollback, sdp: "")
                    try? await self.setRemoteDescription(rollback)
                }
            } catch {
                self.status = .failed(error.localizedDescription)
            }
        }
    }

    private func receiveRemoteAnswer(_ payload: OfferPayload, from senderId: String) {
        let sdp = RTCSessionDescription(type: .answer, sdp: payload.sdp)
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.setRemoteDescription(sdp)
            } catch {
                self.status = .failed(error.localizedDescription)
            }
        }
    }

    /// Polite peers always answer remote offers; impolite peers only answer
    /// when they are not currently making an offer themselves (glare).
    private func shouldAnswerRemoteOffer() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return configuration.polite || !makingOffer
    }

    private func makeOffer() async throws -> RTCSessionDescription {
        try await withCheckedThrowingContinuation { continuation in
            peerConnection.offer(for: mediaConstraints) { sdp, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let sdp {
                    continuation.resume(returning: sdp)
                } else {
                    continuation.resume(throwing: VidcallError.invalidMessage("offer produced no SDP"))
                }
            }
        }
    }

    private func makeAnswer() async throws -> RTCSessionDescription {
        try await withCheckedThrowingContinuation { continuation in
            peerConnection.answer(for: mediaConstraints) { sdp, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let sdp {
                    continuation.resume(returning: sdp)
                } else {
                    continuation.resume(throwing: VidcallError.invalidMessage("answer produced no SDP"))
                }
            }
        }
    }

    private func setLocalDescription(_ sdp: RTCSessionDescription) async throws {
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

    private func setRemoteDescription(_ sdp: RTCSessionDescription) async throws {
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
}

#endif // canImport(WebRTC)
