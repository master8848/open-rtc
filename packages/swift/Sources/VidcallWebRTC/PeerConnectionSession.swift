//
//  PeerConnectionSession.swift
//  VidcallWebRTC
//
//  WebRTC-agnostic session abstraction for the peer-connection state machine.
//
//  The negotiation logic in `PeerConnectionManager` is written against these
//  protocols (not against `import WebRTC`) so it can be unit-tested with an
//  injected fake peer connection — the real GoogleWebRTC adapter lives in
//  `RTCPeerConnectionSession.swift` (compiled only when the `WebRTC` module is
//  linked). Value types mirror the parts of the WebRTC surface the state
//  machine touches; SDP and ICE payloads are relayed verbatim, per the
//  protocol rules in protocol/schema.json.
//

import Foundation

// MARK: - Value types

/// Signaling state of a peer connection (RFC 3264 / W3C `signalingState`).
public enum PeerSignalingState: Equatable, Sendable {
    case stable
    case haveLocalOffer
    case haveRemoteOffer
    case closed
}

/// Combined ICE+DTLS connection state (W3C `connectionState`).
public enum PeerConnectionState: Equatable, Sendable {
    case new
    case connecting
    case connected
    case disconnected
    case failed
    case closed
}

/// Data channel state (W3C `RTCDataChannelState`).
public enum DataChannelState: String, Equatable, Sendable {
    case connecting
    case open
    case closing
    case closed
}

/// An SDP description. SDP is an opaque string on the wire — this type only
/// carries the type tag + body (RFC 3264 / W3C `RTCSessionDescription`).
public struct SessionDescription: Equatable, Sendable {
    public enum Kind: String, Sendable {
        case offer
        case answer
        /// Local rollback (glare resolution, W3C `RTCSdpType.rollback`).
        case rollback
    }

    public let type: Kind
    public let sdp: String

    public init(type: Kind, sdp: String) {
        self.type = type
        self.sdp = sdp
    }
}

/// One trickled ICE candidate (RFC 8445). Mirrors the wire `IcePayload`
/// fields so candidates can be queued before the remote description lands.
public struct IceCandidate: Equatable, Sendable {
    public let sdp: String
    public let sdpMid: String?
    public let sdpMLineIndex: Int32

    public init(sdp: String, sdpMid: String?, sdpMLineIndex: Int32) {
        self.sdp = sdp
        self.sdpMid = sdpMid
        self.sdpMLineIndex = sdpMLineIndex
    }
}

// MARK: - Data channel session

/// Minimal surface of a data channel the bus + manager rely on. The real
/// adapter wraps `RTCDataChannel`; tests inject an in-memory fake.
public protocol DataChannelSession: AnyObject {
    var label: String { get }
    var readyState: DataChannelState { get }
    /// Bytes queued but not yet transmitted (W3C `bufferedAmount`).
    var bufferedAmount: UInt64 { get }

    /// Sends raw bytes. Returns false when the underlying transport refused
    /// the send (channel closing, etc.). `isBinary` selects a binary frame
    /// (text frames are UTF-8 data with `isBinary: false`). Implementations
    /// may default `isBinary` to false.
    @discardableResult
    func sendData(_ data: Data, isBinary: Bool) -> Bool

    /// Closes the channel (idempotent).
    func close()

    /// Fired when the channel transitions to open.
    var onOpen: (() -> Void)? { get set }
    /// Fired when the channel closes.
    var onClose: (() -> Void)? { get set }
    /// Fired on a channel-level error.
    var onError: ((Error) -> Void)? { get set }
    /// Fired for each inbound message (raw bytes, UTF-8 for text messages).
    var onMessage: ((Data) -> Void)? { get set }
    /// Fired when `bufferedAmount` changes.
    var onBufferedAmountChange: ((UInt64) -> Void)? { get set }
}

// MARK: - Peer connection session

/// The peer-connection surface the negotiation state machine needs. The real
/// implementation wraps `RTCPeerConnection` (GoogleWebRTC); fakes implement it
/// for offline state-machine tests and the in-process loopback (L2) test.
public protocol PeerConnectionSession: AnyObject {
    /// Current signaling state (used by perfect-negotiation glare handling).
    var signalingState: PeerSignalingState { get }
    /// True once a remote description has been applied. Trickle ICE
    /// candidates are queued until this is true (W3C requires
    /// `addIceCandidate` after `setRemoteDescription`).
    var remoteDescriptionIsSet: Bool { get }

    /// Creates an SDP offer. When `iceRestart` is true the offer carries fresh
    /// ICE credentials (RFC 8445 §9 / W3C `restartIce`).
    func createOffer(iceRestart: Bool) async throws -> SessionDescription
    /// Creates an SDP answer for the current remote offer.
    func createAnswer() async throws -> SessionDescription
    /// Applies a local description (offer/answer/rollback). Rollback is a
    /// *local* operation used by the polite peer to back out of its own
    /// in-flight offer during glare.
    func setLocalDescription(_ description: SessionDescription) async throws
    /// Applies a remote description (offer/answer).
    func setRemoteDescription(_ description: SessionDescription) async throws
    /// Adds a remote trickle ICE candidate.
    func addIceCandidate(_ candidate: IceCandidate) async throws
    /// Creates a local data channel (included in the next offer).
    func createDataChannel(label: String) -> DataChannelSession?
    /// Closes the underlying peer connection (idempotent).
    func close()

    /// Fired for each locally gathered ICE candidate (trickle).
    var onLocalIceCandidate: ((IceCandidate) -> Void)? { get set }
    /// Fired when the remote side opens a data channel (`ondatachannel`).
    var onDataChannel: ((DataChannelSession) -> Void)? { get set }
    /// Fired when the stack wants to negotiate (`negotiationneeded`).
    var onNegotiationNeeded: (() -> Void)? { get set }
    /// Fired on connection-state changes.
    var onConnectionStateChange: ((PeerConnectionState) -> Void)? { get set }
}
