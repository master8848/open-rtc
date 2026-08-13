//
//  DataChannelBus.swift
//  VidcallWebRTC
//
//  Typed data channel for reactions / chat / control (D6) — mirrors
//  packages/core/src/data-channel-bus.ts so mobile and JS peers interoperate
//  on one SCTP channel (RFC 8831/8832) carrying a small JSON protocol:
//
//    { "v": 1, "t": "reaction", "d": { "emoji": "👍" } }
//    { "v": 1, "t": "chat",     "d": { "text": "hello" } }
//    { "v": 1, "t": "control",  "d": { "action": "keyframe-request" } }
//
//  Like the TS bus, this handles the both-sides-create-a-channel race: the
//  locally created channel is used unless/until a remote channel arrives
//  (`onDataChannel`), in which case the remote channel becomes active (only
//  the offerer's channel is actually negotiated on the wire).
//

import Foundation
import Vidcall

// MARK: - Control message

/// A control message (`t: "control"`). `action` is required; any additional
/// fields are preserved losslessly, matching the TS `ControlMessage` index
/// signature (`{ action: string; [key: string]: unknown }`).
public struct ControlMessage: Equatable, Sendable {
    public var action: String
    public var extra: [String: JSONValue]

    public init(action: String, extra: [String: JSONValue] = [:]) {
        self.action = action
        self.extra = extra
    }

    private struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }
}

extension ControlMessage: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Key.self)
        var action: String?
        var extra: [String: JSONValue] = [:]
        for key in container.allKeys {
            if key.stringValue == "action" {
                action = try container.decode(String.self, forKey: key)
            } else {
                extra[key.stringValue] = try container.decode(JSONValue.self, forKey: key)
            }
        }
        guard let action else {
            throw DecodingError.valueNotFound(
                String.self,
                DecodingError.Context(
                    codingPath: decoder.codingPath,
                    debugDescription: "ControlMessage requires an `action` string"
                )
            )
        }
        self.action = action
        self.extra = extra
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        try container.encode(action, forKey: Key(stringValue: "action"))
        for (key, value) in extra {
            try container.encode(value, forKey: Key(stringValue: key))
        }
    }
}

// MARK: - Wire message

/// The JSON frame carried on the data channel (`{ v, t, d }`).
public struct DataChannelWireMessage: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case reaction
        case chat
        case control
    }

    public let v: Int
    public let t: Kind
    public let d: JSONValue

    public init(v: Int = 1, t: Kind, d: JSONValue) {
        self.v = v
        self.t = t
        self.d = d
    }
}

// MARK: - JSONValue helpers (encode payload structs into the wire `d`)

extension JSONValue {
    /// Losslessly converts any `Encodable` payload into a `JSONValue`
    /// (e.g. a `ReactionPayload` for the bus wire frame).
    public init<T: Encodable>(encoding value: T) throws {
        let data = try JSONEncoder().encode(value)
        self = try JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// Decodes this JSON value into a `Decodable` payload struct.
    public func decoded<T: Decodable>(as type: T.Type) throws -> T {
        let data = try JSONEncoder().encode(self)
        return try JSONDecoder().decode(T.self, from: data)
    }
}

// MARK: - DataChannelBus

/// A typed data channel bus for one peer connection. Create it through
/// `PeerConnectionManager.makeDataChannelBus()` (or directly with a session);
/// the locally created channel is part of the next offer, and a remote
/// channel delivered via `adoptRemote` becomes active.
public final class DataChannelBus: @unchecked Sendable {
    /// Default channel label (`'vidcall'` — matches the TS core).
    public static let defaultName = "vidcall"

    public let name: String
    /// Diagnostic logger.
    public var debug: (@Sendable (String) -> Void)?

    /// The locally created channel (offerer side).
    public private(set) var localChannel: DataChannelSession?
    /// The remote channel adopted from `onDataChannel` (answerer side).
    public private(set) var remoteChannel: DataChannelSession?
    /// Called when a remote channel is adopted.
    public var onRemoteChannel: (@Sendable (DataChannelSession) -> Void)?

    // Event callbacks (TS bus events: open/close/error/reaction/chat/control).
    public var onOpen: (@Sendable () -> Void)?
    public var onClose: (@Sendable () -> Void)?
    public var onError: (@Sendable (Error) -> Void)?
    public var onReaction: (@Sendable (ReactionPayload) -> Void)?
    public var onChat: (@Sendable (ChatPayload) -> Void)?
    public var onControl: (@Sendable (ControlMessage) -> Void)?
    public var onBufferedAmountChange: (@Sendable (UInt64) -> Void)?

    private let lock = NSLock()
    private var closed = false

    /// Creates a bus that immediately creates the local channel on `session`
    /// (included in the next offer). Pass `autoCreateLocal: false` when the
    /// owner wants to feed both sides via `adoptRemote` (e.g. tests).
    public init(session: PeerConnectionSession, name: String = DataChannelBus.defaultName, autoCreateLocal: Bool = true) {
        self.name = name
        if autoCreateLocal, let channel = session.createDataChannel(label: name) {
            adopt(channel, isLocal: true)
        }
    }

    /// Creates a bus around an explicit channel (custom stacks / tests).
    public init(channel: DataChannelSession, name: String = DataChannelBus.defaultName) {
        self.name = name
        adopt(channel, isLocal: true)
    }

    /// The channel used for I/O. The remote channel wins: it is the one
    /// actually negotiated on the wire.
    public var activeChannel: DataChannelSession? {
        lock.lock()
        defer { lock.unlock() }
        return remoteChannel ?? localChannel
    }

    public var isOpen: Bool {
        activeChannel?.readyState == .open
    }

    /// Bytes queued but not yet transmitted on the active channel (W3C
    /// `bufferedAmount`); 0 when there is no channel yet.
    public var bufferedAmount: UInt64 {
        activeChannel?.bufferedAmount ?? 0
    }

    /// Adopts a remote channel delivered by the peer connection
    /// (`onDataChannel`). The first remote channel becomes active.
    public func adoptRemote(_ channel: DataChannelSession) {
        lock.lock()
        let closed = self.closed
        let alreadyAdopted = channel === remoteChannel
        lock.unlock()
        guard !closed, !alreadyAdopted else { return }
        debug?("adopt-remote \(channel.label)")
        adopt(channel, isLocal: false)
        onRemoteChannel?(channel)
    }

    /// Sends a raw JSON frame `{ v: 1, t: <kind>, d: <value> }`.
    public func send(kind: DataChannelWireMessage.Kind, d: JSONValue) throws {
        let message = DataChannelWireMessage(v: 1, t: kind, d: d)
        try sendRaw(try JSONEncoder().encode(message), isBinary: false)
    }

    /// Low-level send: one raw UTF-8 text frame (no JSON framing). Use for
    /// custom wire protocols on the shared channel.
    public func sendString(_ text: String) throws {
        guard let data = text.data(using: .utf8) else {
            throw DataChannelBusError.sendFailed(name: name)
        }
        try sendRaw(data, isBinary: false)
    }

    /// Low-level send: one raw binary frame (no JSON framing).
    public func sendBytes(_ data: Data) throws {
        try sendRaw(data, isBinary: true)
    }

    /// Shared send path: validates the active channel and forwards the frame
    /// to it (text frames carry `isBinary: false`, bytes `isBinary: true`).
    private func sendRaw(_ data: Data, isBinary: Bool) throws {
        guard let channel = activeChannel else {
            throw DataChannelBusError.notOpen(name: name, state: "no-channel")
        }
        guard channel.readyState == .open else {
            throw DataChannelBusError.notOpen(name: name, state: channel.readyState.rawValue)
        }
        guard channel.sendData(data, isBinary: isBinary) else {
            throw DataChannelBusError.sendFailed(name: name)
        }
    }

    /// Sends a reaction (`t: "reaction"`).
    public func sendReaction(_ emoji: String, targetSenderId: String? = nil) throws {
        let payload = ReactionPayload(emoji: emoji, targetSenderId: targetSenderId)
        try send(kind: .reaction, d: JSONValue(encoding: payload))
    }

    /// Sends a chat message (`t: "chat"`).
    public func sendChat(_ text: String) throws {
        let payload = ChatPayload(text: text)
        try send(kind: .chat, d: JSONValue(encoding: payload))
    }

    /// Sends a control message (`t: "control"`).
    public func sendControl(_ message: ControlMessage) throws {
        try send(kind: .control, d: JSONValue(encoding: message))
    }

    /// Closes the bus and its channels. Idempotent.
    public func close() {
        lock.lock()
        guard !closed else {
            lock.unlock()
            return
        }
        closed = true
        let local = localChannel
        let remote = remoteChannel
        lock.unlock()
        local?.close()
        remote?.close()
        onClose?()
    }

    // MARK: Internals

    private func adopt(_ channel: DataChannelSession, isLocal: Bool) {
        lock.lock()
        if isLocal {
            localChannel = channel
        } else {
            remoteChannel = channel
        }
        lock.unlock()
        channel.onOpen = { [weak self] in
            self?.debug?("open \(channel.label)")
            self?.onOpen?()
        }
        channel.onClose = { [weak self] in
            self?.debug?("close \(channel.label)")
            self?.onClose?()
        }
        channel.onError = { [weak self] error in
            self?.debug?("error \(channel.label): \(error)")
            self?.onError?(error)
        }
        channel.onMessage = { [weak self] data in
            self?.handleRaw(data)
        }
        channel.onBufferedAmountChange = { [weak self] amount in
            self?.onBufferedAmountChange?(amount)
        }
    }

    private func handleRaw(_ data: Data) {
        let message: DataChannelWireMessage
        do {
            message = try JSONDecoder().decode(DataChannelWireMessage.self, from: data)
        } catch {
            debug?("drop undecodable frame: \(error)")
            return
        }
        guard message.v == 1 else {
            debug?("drop unsupported wire version \(message.v)")
            return
        }
        do {
            switch message.t {
            case .reaction:
                onReaction?(try message.d.decoded(as: ReactionPayload.self))
            case .chat:
                onChat?(try message.d.decoded(as: ChatPayload.self))
            case .control:
                onControl?(try message.d.decoded(as: ControlMessage.self))
            }
        } catch {
            debug?("drop malformed \(message.t.rawValue) payload: \(error)")
        }
    }

    /// Resolves once the active channel is open, or throws after `timeoutMs`.
    /// Supports a single waiter at a time; the open/close callbacks are
    /// detached when the waiter resolves (success, close, or timeout).
    public func open(timeoutMs: TimeInterval = 10_000) async throws {
        if isOpen { return }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let state = OpenState(timeoutMs: timeoutMs)
            state.start(name: name, onFinished: { [weak self] in
                self?.onOpen = nil
                self?.onClose = nil
            }, continuation: continuation)
            onOpen = { state.complete(nil) }
            onClose = { state.complete(DataChannelBusError.closedBeforeOpen) }
            // The channel may have opened between the `isOpen` check above and
            // installing the callbacks (real WebRTC fires `onOpen` on a
            // background thread). `complete` is idempotent, so this is safe.
            if isOpen {
                state.complete(nil)
            }
        }
    }
}

// MARK: - Errors

public enum DataChannelBusError: Error, LocalizedError, Equatable {
    case notOpen(name: String, state: String)
    case sendFailed(name: String)
    case closedBeforeOpen
    case timeout(name: String, timeoutMs: TimeInterval)

    public var errorDescription: String? {
        switch self {
        case .notOpen(let name, let state):
            return "DataChannelBus: channel '\(name)' not open (state=\(state))"
        case .sendFailed(let name):
            return "DataChannelBus: channel '\(name)' rejected the send"
        case .closedBeforeOpen:
            return "DataChannelBus: channel closed before opening"
        case .timeout(let name, let timeoutMs):
            return "DataChannelBus: channel '\(name)' did not open within \(Int(timeoutMs))ms"
        }
    }
}

// MARK: - Open state (one-shot waiter)

/// Tracks a single `open(timeoutMs:)` wait: resolves the continuation on
/// open/close/timeout and cancels the timeout timer.
private final class OpenState: @unchecked Sendable {
    private let timeoutMs: TimeInterval
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?
    private var timer: DispatchSourceTimer?
    private var onFinished: (() -> Void)?
    private var finished = false

    init(timeoutMs: TimeInterval) {
        self.timeoutMs = timeoutMs
    }

    func start(
        name: String,
        onFinished: @escaping () -> Void,
        continuation: CheckedContinuation<Void, Error>
    ) {
        let timeout = timeoutMs
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + timeout / 1000, repeating: .never)
        timer.setEventHandler { [weak self] in
            self?.complete(DataChannelBusError.timeout(name: name, timeoutMs: timeout))
        }
        lock.lock()
        self.continuation = continuation
        self.timer = timer
        self.onFinished = onFinished
        lock.unlock()
        timer.resume()
    }

    func complete(_ error: Error?) {
        lock.lock()
        guard !finished else {
            lock.unlock()
            return
        }
        finished = true
        let continuation = self.continuation
        let timer = self.timer
        let onFinished = self.onFinished
        self.continuation = nil
        self.timer = nil
        lock.unlock()
        timer?.cancel()
        if let error {
            continuation?.resume(throwing: error)
        } else {
            continuation?.resume()
        }
        onFinished?()
    }
}
