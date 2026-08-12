//
//  VidcallClient.swift
//  Vidcall
//
//  Backend-agnostic signaling client: one WebSocket connection to any
//  signaling backend that relays the vidcall JSON envelopes
//  (protocol/schema.json). Owns the envelope fields `ts`/`seq`, exposes typed
//  join/leave/reaction/chat/... senders, and dispatches typed callbacks.
//
//  The wire protocol is the contract; this class never assumes a specific
//  backend (Supabase/Convex/Firebase/Appwrite/Postgres/custom) — only a
//  WebSocket endpoint that forwards envelopes.
//

import Foundation

/// Errors surfaced by `VidcallClient`.
public enum VidcallError: Error, LocalizedError, Equatable {
    /// No active WebSocket task; call `connect()` first.
    case notConnected
    /// A message could not be encoded/decoded.
    case invalidMessage(String)

    public var errorDescription: String? {
        switch self {
        case .notConnected:
            return "Not connected to the signaling server."
        case .invalidMessage(let detail):
            return "Invalid signaling message: \(detail)"
        }
    }
}

/// Receives typed events from a `VidcallClient` (weak listener; used by the
/// WebRTC layer so it can hook offer/answer/ice without owning `onEvent`).
public protocol VidcallClientListening: AnyObject, Sendable {
    func client(_ client: VidcallClient, didReceive event: VidcallClient.Event)
}

/// A WebSocket signaling client for the vidcall protocol v1.
public final class VidcallClient: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    // MARK: Configuration

    public struct Configuration: Sendable {
        /// WebSocket endpoint of the signaling backend, e.g. `wss://relay.example.com/signal`.
        public var url: URL
        public var roomId: String
        public var senderId: String
        /// Server-assigned session id. When nil, the client generates a UUID
        /// (protocol rule: "Server assigns session/sessionId; clients never
        /// invent them" — replace via `updateSessionId` once the server ack
        /// arrives, or pass the value from your join flow).
        public var sessionId: String?
        /// Envelope `v` (schema.json: const 1).
        public var protocolVersion: Int
        /// Interval for `ping` heartbeats; nil disables them.
        public var heartbeatInterval: TimeInterval?
        /// Queue on which `onEvent`/`onStateChange` fire.
        public var callbackQueue: DispatchQueue
        /// Optional logger for transport-level diagnostics.
        public var logger: (@Sendable (String) -> Void)?

        public init(
            url: URL,
            roomId: String,
            senderId: String,
            sessionId: String? = nil,
            protocolVersion: Int = 1,
            heartbeatInterval: TimeInterval? = nil,
            callbackQueue: DispatchQueue = .main,
            logger: (@Sendable (String) -> Void)? = nil
        ) {
            self.url = url
            self.roomId = roomId
            self.senderId = senderId
            self.sessionId = sessionId
            self.protocolVersion = protocolVersion
            self.heartbeatInterval = heartbeatInterval
            self.callbackQueue = callbackQueue
            self.logger = logger
        }
    }

    // MARK: State & events

    public enum State: Equatable, Sendable {
        case idle
        case connecting
        case connected
        case disconnecting
        case disconnected
        case failed(String)
    }

    /// Typed callbacks. One case per envelope type from schema.json.
    public enum Event: Equatable, Sendable {
        case stateChanged(State)
        case joined(Envelope, JoinPayload)
        case left(Envelope, LeavePayload)
        case offer(Envelope, OfferPayload)
        case answer(Envelope, OfferPayload)
        case ice(Envelope, IcePayload)
        case presence(Envelope, PresencePayload)
        case reaction(Envelope, ReactionPayload)
        case chat(Envelope, ChatPayload)
        case screenShare(Envelope, ScreenSharePayload)
        case qualityWarning(Envelope, QualityWarningPayload)
        case sfu(Envelope, SfuPayload)
        case signalingError(Envelope, ErrorPayload)
        case ping(Envelope)
        case pong(Envelope)
        case unknown(Envelope)
    }

    // MARK: Private state

    private let lock = NSLock()
    private let configuration: Configuration
    private let socketQueue: OperationQueue
    private var _state: State = .idle
    private var _seq: UInt64 = 0
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var heartbeatTimer: DispatchSourceTimer?
    private var weakListeners: [WeakListener] = []
    private let generatedSessionId = UUID().uuidString.lowercased()

    private struct WeakListener {
        weak var value: VidcallClientListening?
    }

    /// Current connection state.
    public var state: State {
        lock.lock()
        defer { lock.unlock() }
        return _state
    }

    /// The session id this client is currently using (override, config value,
    /// or generated UUID).
    public var currentSessionId: String {
        resolvedSessionId
    }

    /// Single typed callback for every incoming event.
    public var onEvent: (@Sendable (Event) -> Void)?

    /// Convenience callback for state changes (also delivered via `.stateChanged`).
    public var onStateChange: (@Sendable (State) -> Void)?

    // MARK: Init

    public init(configuration: Configuration) {
        self.configuration = configuration
        let queue = OperationQueue()
        queue.name = "vidcall.websocket.\(configuration.roomId)"
        queue.maxConcurrentOperationCount = 1
        self.socketQueue = queue
        super.init()
    }

    deinit {
        receiveTask?.cancel()
        heartbeatTimer?.cancel()
        session?.invalidateAndCancel()
    }

    // MARK: Connection lifecycle

    /// Opens the WebSocket and starts receiving envelopes. Idempotent.
    public func connect() async throws {
        guard let (_, socketTask) = beginConnect() else { return }

        socketTask.resume()
        startReceiveLoop(for: socketTask)
    }

    /// Synchronous connection setup. Returns nil when already connected or
    /// connecting (idempotent connect).
    private func beginConnect() -> (URLSession, URLSessionWebSocketTask)? {
        lock.lock()
        defer { lock.unlock() }
        guard _state != .connected, _state != .connecting else { return nil }
        _state = .connecting

        let urlSession = URLSession(configuration: .default, delegate: self, delegateQueue: socketQueue)
        let socketTask = urlSession.webSocketTask(with: configuration.url)
        session = urlSession
        task = socketTask
        setState(.connecting)
        return (urlSession, socketTask)
    }

    /// Closes the WebSocket and tears down timers.
    public func disconnect(closeCode: URLSessionWebSocketTask.CloseCode = .normalClosure) {
        lock.lock()
        let socketTask = task
        let urlSession = session
        let timer = heartbeatTimer
        task = nil
        session = nil
        heartbeatTimer = nil
        lock.unlock()

        timer?.cancel()
        receiveTask?.cancel()
        receiveTask = nil
        socketTask?.cancel(with: closeCode, reason: nil)
        urlSession?.invalidateAndCancel()
        setState(.disconnected)
    }

    /// Adopt a server-assigned session id (e.g. from a join acknowledgement).
    /// Takes precedence over the configuration value.
    public func updateSessionId(_ sessionId: String) {
        lock.lock()
        _overriddenSessionId = sessionId
        lock.unlock()
    }

    private var _overriddenSessionId: String?

    // MARK: Sending

    /// Encodes and sends an envelope over the active socket.
    public func send(_ envelope: Envelope) throws {
        let data = try Self.encoder.encode(envelope)
        guard let socketTask = currentTask else {
            throw VidcallError.notConnected
        }
        let text = String(decoding: data, as: UTF8.self)
        Task { [weak self] in
            do {
                try await socketTask.send(.string(text))
            } catch {
                self?.configuration.logger?("send failed: \(error)")
                self?.setState(.failed(error.localizedDescription))
            }
        }
    }

    /// Builds an envelope with the client's room/sender/session and the next
    /// monotonic `seq`/`ts`. Pass `targetSenderId` to unicast a signal payload
    /// to one peer (absent = room broadcast, sender-excluded relay).
    public func makeEnvelope(
        type: MessageType,
        payload: Payload = .none,
        targetSenderId: String? = nil
    ) -> Envelope {
        Envelope(
            v: configuration.protocolVersion,
            type: type,
            roomId: configuration.roomId,
            senderId: configuration.senderId,
            sessionId: resolvedSessionId,
            ts: Int64(Date().timeIntervalSince1970 * 1000),
            seq: nextSeq(),
            targetSenderId: targetSenderId,
            payload: payload
        )
    }

    // MARK: Typed senders (schema.json message taxonomy)

    public func join(_ payload: JoinPayload) throws {
        try send(makeEnvelope(type: .join, payload: .join(payload)))
    }

    public func leave(reason: String? = nil) throws {
        try send(makeEnvelope(type: .leave, payload: .leave(LeavePayload(reason: reason))))
    }

    public func reaction(emoji: String, targetSenderId: String? = nil, ts: Int64? = nil) throws {
        try send(makeEnvelope(type: .reaction, payload: .reaction(ReactionPayload(emoji: emoji, targetSenderId: targetSenderId, ts: ts))))
    }

    public func chat(text: String, replyTo: ChatReplyTo? = nil) throws {
        try send(makeEnvelope(type: .chat, payload: .chat(ChatPayload(text: text, replyTo: replyTo))))
    }

    public func presence(state: PresenceState, metadata: [String: JSONValue]? = nil) throws {
        try send(makeEnvelope(type: .presence, payload: .presence(PresencePayload(state: state, metadata: metadata))))
    }

    public func screenShare(action: ScreenShareAction, label: String? = nil) throws {
        try send(makeEnvelope(type: .screenShare, payload: .screenShare(ScreenSharePayload(action: action, label: label))))
    }

    public func qualityWarning(from: String, to: String, reason: QualityReason, direction: QualityDirection) throws {
        try send(makeEnvelope(type: .qualityWarning, payload: .qualityWarning(QualityWarningPayload(from: from, to: to, reason: reason, direction: direction))))
    }

    public func sfu(action: SfuAction, trackId: String? = nil, kind: SfuTrackKind? = nil, senderId: String? = nil, layer: String? = nil) throws {
        try send(makeEnvelope(type: .sfu, payload: .sfu(SfuPayload(action: action, trackId: trackId, kind: kind, senderId: senderId, layer: layer))))
    }

    /// Sends an SDP offer (WebRTC layer). SDP is relayed verbatim. Unicast to
    /// `targetSenderId` when set (schema envelope field; absent = broadcast).
    public func sendOffer(_ payload: OfferPayload, targetSenderId: String? = nil) throws {
        try send(makeEnvelope(type: .offer, payload: .offer(payload), targetSenderId: targetSenderId))
    }

    /// Sends an SDP answer (WebRTC layer). SDP is relayed verbatim. Unicast to
    /// `targetSenderId` when set (schema envelope field; absent = broadcast).
    public func sendAnswer(_ payload: OfferPayload, targetSenderId: String? = nil) throws {
        try send(makeEnvelope(type: .answer, payload: .answer(payload), targetSenderId: targetSenderId))
    }

    /// Sends a trickle ICE candidate (WebRTC layer). Unicast to `targetSenderId`
    /// when set (schema envelope field; absent = broadcast).
    public func sendIce(_ payload: IcePayload, targetSenderId: String? = nil) throws {
        try send(makeEnvelope(type: .ice, payload: .ice(payload), targetSenderId: targetSenderId))
    }

    public func ping() throws {
        try send(makeEnvelope(type: .ping))
    }

    public func pong() throws {
        try send(makeEnvelope(type: .pong))
    }

    public func sendError(code: String, message: String) throws {
        try send(makeEnvelope(type: .error, payload: .error(ErrorPayload(code: code, message: message))))
    }

    // MARK: Listeners (for the WebRTC layer)

    /// Registers a weak listener. Listeners receive every event in addition to
    /// `onEvent`.
    public func addListener(_ listener: VidcallClientListening) {
        lock.lock()
        weakListeners.removeAll { $0.value == nil }
        if !weakListeners.contains(where: { $0.value === listener }) {
            weakListeners.append(WeakListener(value: listener))
        }
        lock.unlock()
    }

    public func removeListener(_ listener: VidcallClientListening) {
        lock.lock()
        weakListeners.removeAll { $0.value == nil || $0.value === listener }
        lock.unlock()
    }

    // MARK: URLSessionWebSocketDelegate

    public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocolName: String?
    ) {
        setState(.connected)
        startHeartbeatIfNeeded()
    }

    public func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        lock.lock()
        let current = task
        task = nil
        lock.unlock()
        if current === webSocketTask {
            setState(.disconnected)
        }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error {
            setState(.failed(error.localizedDescription))
        }
    }

    // MARK: Internals

    private var currentTask: URLSessionWebSocketTask? {
        lock.lock()
        defer { lock.unlock() }
        return task
    }

    private var resolvedSessionId: String {
        lock.lock()
        defer { lock.unlock() }
        return _overriddenSessionId ?? configuration.sessionId ?? generatedSessionId
    }

    private func nextSeq() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        _seq += 1
        return _seq
    }

    private func setState(_ newState: State) {
        lock.lock()
        let changed = _state != newState
        _state = newState
        lock.unlock()
        guard changed else { return }
        let callback = onStateChange
        let event = Event.stateChanged(newState)
        configuration.callbackQueue.async {
            callback?(newState)
        }
        dispatch(event)
    }

    private func startReceiveLoop(for socketTask: URLSessionWebSocketTask) {
        let loop = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await socketTask.receive()
                    guard let self, self.currentTask === socketTask else { return }
                    switch message {
                    case .string(let text):
                        self.handleIncoming(text: text)
                    case .data(let data):
                        self.handleIncoming(data: data)
                    @unknown default:
                        break
                    }
                } catch {
                    guard let self, self.currentTask === socketTask else { return }
                    self.setState(.failed(error.localizedDescription))
                    return
                }
            }
        }
        lock.lock()
        receiveTask?.cancel()
        receiveTask = loop
        lock.unlock()
    }

    private func startHeartbeatIfNeeded() {
        guard let interval = configuration.heartbeatInterval, interval > 0 else { return }
        let timer = DispatchSource.makeTimerSource(queue: socketQueue.underlyingQueue ?? .global())
        timer.schedule(deadline: .now() + interval, repeating: interval)
        timer.setEventHandler { [weak self] in
            try? self?.ping()
        }
        lock.lock()
        heartbeatTimer?.cancel()
        heartbeatTimer = timer
        lock.unlock()
        timer.resume()
    }

    private func handleIncoming(text: String) {
        guard let data = text.data(using: .utf8) else { return }
        handleIncoming(data: data)
    }

    private func handleIncoming(data: Data) {
        do {
            let envelope = try Self.decoder.decode(Envelope.self, from: data)
            dispatch(event(for: envelope))
        } catch {
            configuration.logger?("Failed to decode envelope: \(error)")
        }
    }

    private func event(for envelope: Envelope) -> Event {
        switch envelope.payload {
        case .join(let payload): return .joined(envelope, payload)
        case .leave(let payload): return .left(envelope, payload)
        case .offer(let payload): return .offer(envelope, payload)
        case .answer(let payload): return .answer(envelope, payload)
        case .ice(let payload): return .ice(envelope, payload)
        case .presence(let payload): return .presence(envelope, payload)
        case .reaction(let payload): return .reaction(envelope, payload)
        case .chat(let payload): return .chat(envelope, payload)
        case .screenShare(let payload): return .screenShare(envelope, payload)
        case .qualityWarning(let payload): return .qualityWarning(envelope, payload)
        case .sfu(let payload): return .sfu(envelope, payload)
        case .error(let payload): return .signalingError(envelope, payload)
        case .none:
            switch envelope.type {
            case .ping: return .ping(envelope)
            case .pong: return .pong(envelope)
            default: return .unknown(envelope)
            }
        case .unknown:
            return .unknown(envelope)
        }
    }

    private func dispatch(_ event: Event) {
        let callback = onEvent
        lock.lock()
        let listeners = weakListeners.map { $0.value }
        lock.unlock()
        configuration.callbackQueue.async {
            callback?(event)
            for listener in listeners {
                listener?.client(self, didReceive: event)
            }
        }
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    private static let decoder = JSONDecoder()
}
