//
//  VidcallWebRTC.swift
//  VidcallWebRTC
//
//  Optional WebRTC integration for Vidcall. The glue compiles to a stub when
//  the `WebRTC` module is unavailable (e.g. offline SwiftPM builds without the
//  binary target). Enable real WebRTC by uncommenting the `.binaryTarget` in
//  Package.swift (Path A) or by using the community `WebRTC` pod 150.0.0 /
//  `GoogleWebRTC` pod via CocoaPods (Path B) — see README.md.
//
//  Protocol/schema.json is the contract: SDP (`OfferPayload`) and ICE
//  (`IcePayload`) are relayed verbatim; this layer only adapts them to/from
//  the platform WebRTC framework.
//

import Foundation
import Vidcall

/// ICE server configuration for the peer connection.
public struct PeerConnectionConfiguration: Sendable {
    /// STUN/TURN server URLs, e.g. ["stun:stun.l.google.com:19302"].
    public var iceServers: [String]
    /// Polite peer flag for perfect negotiation (glare handling).
    public var polite: Bool

    public init(iceServers: [String] = [], polite: Bool = true) {
        self.iceServers = iceServers
        self.polite = polite
    }
}

/// WebRTC-agnostic surface of the peer-connection manager. `VidcallClient`
/// events are fed through `handleIncoming(event:)`; SDP/ICE flow back out via
/// the client's typed senders.
public protocol PeerConnectionManaging: AnyObject, Sendable {
    /// Feeds a decoded client event into the negotiation state machine.
    func handleIncoming(event: VidcallClient.Event)
    /// Applies a remote trickle ICE candidate (type `ice`).
    func addRemoteIceCandidate(_ payload: IcePayload) throws
    /// Ensures an offer/answer exchange (perfect negotiation).
    func negotiate() async throws
    /// Closes the peer connection and removes this manager from the client.
    func leave()
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
    /// `WebRTC` module is not linked (see README "WebRTC integration").
    public static func makePeerConnectionManager(
        client: VidcallClient,
        configuration: PeerConnectionConfiguration = PeerConnectionConfiguration()
    ) -> PeerConnectionManaging? {
        #if canImport(WebRTC)
        return WebRTCPeerConnectionManager(client: client, configuration: configuration)
        #else
        return nil
        #endif
    }
}
