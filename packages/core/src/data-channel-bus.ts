/**
 * DataChannelBus — typed data channel for reactions / chat / control (D6).
 *
 * One SCTP data channel (RFC 8831/8832) per peer connection carries a small
 * JSON protocol on top of the platform channel:
 *
 * ```json
 * { "v": 1, "t": "reaction", "d": { "emoji": "👍" } }
 * { "v": 1, "t": "chat",     "d": { "text": "hello" } }
 * { "v": 1, "t": "control",  "d": { "action": "keyframe-request" } }
 * ```
 *
 * The bus handles the both-sides-create-a-channel race: the channel created
 * locally is used unless/until a remote channel arrives (`ondatachannel`),
 * in which case the remote channel becomes active (this matches how
 * negotiation actually negotiates only the offerer's channel).
 */
import type { ChatPayload, ReactionPayload, TranscriptPayload } from '@mbsks/openrtc-protocol';
import { TypedEmitter } from './events.ts';

export interface ControlMessage {
  action: string;
  [key: string]: unknown;
}

interface WireMessage {
  v: 1;
  t: 'reaction' | 'chat' | 'transcript' | 'control';
  d: ReactionPayload | ChatPayload | TranscriptPayload | ControlMessage;
}

export type DataChannelBusEventMap = {
  open: [];
  close: [];
  error: [Error];
  reaction: [ReactionPayload];
  chat: [ChatPayload];
  transcript: [TranscriptPayload];
  control: [ControlMessage];
};

export interface DataChannelBusOptions {
  /** Data channel label (default `'vidcall'`). */
  name?: string;
  /** Explicit channel to adopt (for tests / custom stacks). */
  channel?: RTCDataChannel;
  /** Called when a remote channel arrives and is adopted. */
  onRemoteChannel?: (channel: RTCDataChannel) => void;
  /**
   * Wire `pc.ondatachannel` in the constructor (default true). Set false when
   * the owner (e.g. Room) feeds remote channels via `adoptRemote()` instead.
   */
  wireOnDataChannel?: boolean;
  /** Diagnostic logger. */
  debug?: (message: string, data?: unknown) => void;
}

export class DataChannelBus extends TypedEmitter<DataChannelBusEventMap> {
  readonly name: string;
  private readonly pc: RTCPeerConnection;
  private readonly debug: (message: string, data?: unknown) => void;
  private readonly onRemoteChannel?: (channel: RTCDataChannel) => void;

  /** Locally created channel (initiator side). */
  private localChannel: RTCDataChannel | null = null;
  /** Remote channel adopted from `ondatachannel` (answers negotiation). */
  private remoteChannel: RTCDataChannel | null = null;
  private closed = false;

  constructor(pc: RTCPeerConnection, options: DataChannelBusOptions = {}) {
    super();
    this.pc = pc;
    this.name = options.name ?? 'vidcall';
    this.debug = options.debug ?? (() => {});
    this.onRemoteChannel = options.onRemoteChannel;

    if (options.channel) {
      this.adopt(options.channel, true);
      return;
    }

    // Initiator: create the channel locally so it is present in our first offer.
    try {
      const channel = pc.createDataChannel(this.name, { ordered: true });
      this.adopt(channel, true);
    } catch (err) {
      this.debug('createDataChannel:failed', err);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
    // Receiver: adopt the channel the remote side negotiated (unless the owner
    // feeds channels via adoptRemote()).
    if (options.wireOnDataChannel !== false) {
      pc.ondatachannel = (event: RTCDataChannelEvent) => {
        if (event.channel.label !== this.name) return;
        this.debug('datachannel:adopt', event.channel.label);
        this.adopt(event.channel, false);
      };
    }
  }

  /**
   * Adopt a remote channel delivered by the owner (e.g. from a
   * PeerConnectionManager `onDataChannel` callback).
   */
  adoptRemote(channel: RTCDataChannel): void {
    if (channel === this.remoteChannel) return;
    this.debug('datachannel:adopt-remote', channel.label);
    this.adopt(channel, false);
  }

  get readyState(): RTCDataChannelState | 'closed' {
    return this.activeChannel()?.readyState ?? 'closed';
  }

  get isOpen(): boolean {
    return this.readyState === 'open';
  }

  /** The channel currently used for I/O. */
  private activeChannel(): RTCDataChannel | null {
    // The remote channel wins: it is the one actually negotiated on the wire.
    return this.remoteChannel ?? this.localChannel;
  }

  private adopt(channel: RTCDataChannel, isLocal: boolean): void {
    const wire = (data: string) => {
      this.handleRaw(data);
    };
    channel.onmessage = (event: MessageEvent) => wire(String(event.data));
    channel.onopen = () => {
      this.debug('datachannel:open', channel.label);
      this.emit('open');
    };
    channel.onclose = () => {
      this.debug('datachannel:close', channel.label);
      this.emit('close');
    };
    channel.onerror = (event: Event) => {
      const message = (event as RTCErrorEvent).error?.message ?? 'data channel error';
      this.emit('error', new Error(message));
    };

    if (isLocal) {
      this.localChannel = channel;
    } else {
      this.remoteChannel = channel;
      this.onRemoteChannel?.(channel);
    }
  }

  /**
   * Resolve when the active channel is open (or reject on timeout).
   */
  async open(timeoutMs = 10_000): Promise<void> {
    if (this.isOpen) return;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(`DataChannelBus: channel '${this.name}' did not open within ${timeoutMs}ms`),
        );
      }, timeoutMs);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`DataChannelBus: channel '${this.name}' closed before opening`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('open', onOpen);
        this.off('close', onClose);
      };
      this.on('open', onOpen);
      this.on('close', onClose);
    });
  }

  // ------------------------------------------------------------------ send

  sendReaction(emoji: string, targetSenderId?: string, ts?: number): void {
    this.send('reaction', { emoji, targetSenderId, ts } as ReactionPayload);
  }

  sendChat(text: string, replyTo?: ChatPayload['replyTo']): void {
    this.send('chat', { text, replyTo });
  }

  sendTranscript(payload: TranscriptPayload): void {
    this.send('transcript', payload);
  }

  sendControl(message: ControlMessage): void {
    this.send('control', message);
  }

  /** Low-level typed send. Throws if the channel is not open. */
  send(t: WireMessage['t'], data: WireMessage['d']): void {
    const channel = this.activeChannel();
    if (!channel || channel.readyState !== 'open') {
      throw new Error(
        `DataChannelBus: channel '${this.name}' not open (state=${channel?.readyState ?? 'none'})`,
      );
    }
    const wire: WireMessage = { v: 1, t, d: data };
    channel.send(JSON.stringify(wire));
  }

  // --------------------------------------------------------------- receive

  private handleRaw(raw: string): void {
    let wire: WireMessage;
    try {
      wire = JSON.parse(raw) as WireMessage;
    } catch {
      this.debug('datachannel:bad-json', raw.slice(0, 80));
      return;
    }
    if (wire.v !== 1) {
      this.debug('datachannel:unknown-version', wire);
      return;
    }
    switch (wire.t) {
      case 'reaction':
        this.emit('reaction', wire.d as ReactionPayload);
        break;
      case 'chat':
        this.emit('chat', wire.d as ChatPayload);
        break;
      case 'transcript':
        this.emit('transcript', wire.d as TranscriptPayload);
        break;
      case 'control':
        this.emit('control', wire.d as ControlMessage);
        break;
      default:
        this.debug('datachannel:unknown-type', wire);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.localChannel?.close();
    this.remoteChannel?.close();
    this.pc.ondatachannel = null;
    this.removeAllListeners();
  }
}
