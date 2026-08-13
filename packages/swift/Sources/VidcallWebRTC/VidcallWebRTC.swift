//
//  VidcallWebRTC.swift
//  VidcallWebRTC
//
//  Optional WebRTC integration for Vidcall. The negotiation state machine,
//  data-channel bus, and value types compile unconditionally (and are unit-
//  tested with injected fakes); only the GoogleWebRTC adapter
//  (`RTCPeerConnectionSession`) is `#if canImport(WebRTC)`-guarded, so the
//  package builds and tests fully offline.
//
//  Two integration paths (see README.md "WebRTC integration"):
//
//    Path A — SwiftPM binary target (default): the `WebRTC` 150.0.0
//             xcframework binary target declared in Package.swift; verified
//             SHA-256 checksum. `swift build` fetches and links it.
//             Toggle offline with scripts/enable-webrtc.sh /
//             scripts/disable-webrtc.sh.
//    Path B — CocoaPods (manual): pod 'WebRTC', '150.0.0' (community) or
//             pod 'GoogleWebRTC', '1.1.32000' (official, 2023-era) and add
//             Sources/VidcallWebRTC to the app target.
//
//  Protocol/schema.json is the contract: SDP (`OfferPayload`) and ICE
//  (`IcePayload`) are relayed verbatim; this layer only adapts them to/from
//  the platform WebRTC framework. Perfect-negotiation polarity for a mesh is
//  `polite = selfId < remoteId` (same rule as the TS core).
//

import Foundation
import Vidcall

/// ICE server configuration for the peer connection.
public struct PeerConnectionConfiguration: Sendable {
    /// STUN/TURN server URLs, e.g. ["stun:stun.l.google.com:19302"].
    public var iceServers: [String]
    /// Polite peer flag for perfect negotiation (glare handling). For a mesh
    /// use the deterministic rule `polite = selfId < remoteId` (same as the
    /// TS core); the default true is for one-to-one sessions where this side
    /// answers.
    public var polite: Bool
    /// Automatically restart ICE when the connection state turns `failed`
    /// (RFC 8445 §9; same default as the TS core).
    public var autoRestartIce: Bool

    public init(iceServers: [String] = [], polite: Bool = true, autoRestartIce: Bool = true) {
        self.iceServers = iceServers
        self.polite = polite
        self.autoRestartIce = autoRestartIce
    }
}

/// Namespace + factory for the WebRTC peer-connection layer.
public enum VidcallWebRTC {
    /// True when the `WebRTC` module is linked into this build.
    public static var isAvailable: Bool {
        #if canImport(WebRTC)
        return true
        #else
        return false
        #endif
    }

    /// Creates a peer-connection manager wired to `client`, or nil when the
    /// `WebRTC` module is not linked (offline builds — see README "WebRTC
    /// integration"). `remotePeerId`, when provided, restricts incoming
    /// signaling to that sender (single-peer safety on broadcast backends).
    public static func makePeerConnectionManager(
        client: VidcallClient,
        configuration: PeerConnectionConfiguration = PeerConnectionConfiguration(),
        remotePeerId: String? = nil
    ) -> PeerConnectionManaging? {
        #if canImport(WebRTC)
        guard let session = RTCPeerConnectionSession.make(configuration: configuration) else {
            return nil
        }
        return PeerConnectionManager(
            session: session,
            configuration: configuration,
            signaling: ClientPeerSignaling(client: client),
            remotePeerId: remotePeerId
        )
        #else
        return nil
        #endif
    }
}

#if canImport(WebRTC)

/// Adapter from `VidcallClient`'s typed senders to the manager's signaling
/// hook.
private final class ClientPeerSignaling: PeerSignaling, @unchecked Sendable {
    private let client: VidcallClient

    init(client: VidcallClient) {
        self.client = client
    }

    func sendOffer(_ payload: OfferPayload) throws {
        try client.sendOffer(payload)
    }

    func sendAnswer(_ payload: OfferPayload) throws {
        try client.sendAnswer(payload)
    }

    func sendIce(_ payload: IcePayload) throws {
        try client.sendIce(payload)
    }
}

#endif // canImport(WebRTC)
