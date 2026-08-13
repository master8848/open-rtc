/**
 * SfuRouter — protocol sfu-envelope handling, pure logic.
 *
 * Consumes the wire protocol's `sfu` envelopes (`publish`/`subscribe`/
 * `layer-change`/`keyframe-request`/`leave`, protocol/schema.json
 * `SfuPayload`) plus `offer`/`answer`/`ice` envelopes addressed to the SFU
 * participant (`targetSenderId === 'sfu'` by default). It:
 *
 *  1. validates room membership (`isParticipant`),
 *  2. requires a joined session for the sender (created by `Room` via
 *     `SfuGateway.join`, then registered with `registerSession`),
 *  3. forwards to the gateway session, and
 *  4. emits typed events (`published`, `subscribed`, ..., `error`).
 *
 * No media imports: the router is unit-testable with a fake gateway.
 *
 * ```ts
 * const router = new SfuRouter({
 *   gateway,
 *   isParticipant: (roomId, participantId) => room.members.has(participantId),
 * });
 * transport.onMessage(roomId, (env) => void router.handle(env));
 * ```
 */
import type { Envelope, IcePayload, OfferPayload, SfuKind, SfuPayload } from '@vidcall/protocol';
import { SFU_ACTIONS, SFU_KINDS } from '@vidcall/protocol';
import { TypedEmitter } from './events.ts';
import type { SfuGateway, SfuSession } from './sfu-gateway.ts';

/** Error codes emitted on the router `error` event. */
export const SFU_ROUTER_ERRORS = [
  /** The sender is not a member of the room (or the room is unknown). */
  'not-a-participant',
  /** The sender has no joined `SfuSession` for the room. */
  'not-joined',
  /** The `sfu` envelope carries an action outside the protocol enum. */
  'unknown-action',
  /** The envelope payload is missing fields the action requires. */
  'invalid-payload',
  /** The gateway/session call itself threw. */
  'gateway-error',
] as const;
export type SfuRouterErrorCode = (typeof SFU_ROUTER_ERRORS)[number];

/** Payload of the router `error` event. */
export interface SfuRouterErrorEvent {
  code: SfuRouterErrorCode;
  message: string;
  /** The offending envelope (for logging / error-reply envelopes). */
  envelope: Envelope;
  roomId: string;
  senderId: string;
}

export interface SfuPublishedEvent {
  roomId: string;
  participantId: string;
  trackId: string;
  kind: SfuKind;
}

export interface SfuSubscribedEvent {
  roomId: string;
  participantId: string;
  /** The participant whose tracks were subscribed to. */
  targetSenderId: string;
}

export interface SfuLayerChangedEvent {
  roomId: string;
  participantId: string;
  trackId: string;
  layer: string;
}

export interface SfuKeyframeRequestedEvent {
  roomId: string;
  participantId: string;
  trackId: string;
}

export interface SfuLeftEvent {
  roomId: string;
  participantId: string;
}

export type SfuRouterEventMap = {
  /** A session was registered (Room called `registerSession` after `gateway.join`). */
  'session-registered': [{ roomId: string; participantId: string }];
  /** `sfu {action:'publish'}` was forwarded. */
  published: [SfuPublishedEvent];
  /** `sfu {action:'subscribe'}` was forwarded. */
  subscribed: [SfuSubscribedEvent];
  /** `sfu {action:'layer-change'}` was forwarded. */
  'layer-changed': [SfuLayerChangedEvent];
  /** `sfu {action:'keyframe-request'}` was forwarded. */
  'keyframe-requested': [SfuKeyframeRequestedEvent];
  /** `sfu {action:'leave'}` completed; session unregistered. */
  left: [SfuLeftEvent];
  /** A validation or gateway failure. */
  error: [SfuRouterErrorEvent];
};

export interface SfuRouterOptions {
  /** The gateway sessions are forwarded to. */
  gateway: SfuGateway;
  /**
   * Membership check: does `participantId` belong to `roomId`? Returning
   * `false` for unknown rooms is what makes "unknown room" envelopes fail.
   */
  isParticipant: (roomId: string, participantId: string) => boolean | Promise<boolean>;
  /**
   * The participant id the SFU itself uses in envelopes. `offer`/`answer`/
   * `ice` envelopes are consumed only when `targetSenderId` matches
   * (protocol extension, see protocol/types.ts). Default `'sfu'`.
   */
  sfuParticipantId?: string;
}

/** Internal registry of one room's published tracks (for bare `subscribe`). */
interface TrackRegistration {
  publisherId: string;
  kind: SfuKind;
}

export class SfuRouter extends TypedEmitter<SfuRouterEventMap> {
  readonly gateway: SfuGateway;
  private readonly isParticipant: (
    roomId: string,
    participantId: string,
  ) => boolean | Promise<boolean>;
  readonly sfuParticipantId: string;
  private readonly sessions = new Map<string, SfuSession>();
  private readonly tracks = new Map<string, Map<string, TrackRegistration>>();

  constructor(options: SfuRouterOptions) {
    super();
    this.gateway = options.gateway;
    this.isParticipant = options.isParticipant;
    this.sfuParticipantId = options.sfuParticipantId ?? 'sfu';
  }

  // ------------------------------------------------------------- session map

  /** Register a session (Room calls this right after `gateway.join`). */
  registerSession(session: SfuSession): void {
    const key = sessionKeyOf(session.roomId, session.participantId);
    this.sessions.set(key, session);
    this.emit('session-registered', {
      roomId: session.roomId,
      participantId: session.participantId,
    });
  }

  /** Forget a session; returns true if one was registered. */
  unregisterSession(roomId: string, participantId: string): boolean {
    const key = sessionKeyOf(roomId, participantId);
    const had = this.sessions.delete(key);
    const roomTracks = this.tracks.get(roomId);
    if (roomTracks) {
      for (const [trackId, reg] of roomTracks) {
        if (reg.publisherId === participantId) roomTracks.delete(trackId);
      }
    }
    return had;
  }

  hasSession(roomId: string, participantId: string): boolean {
    return this.sessions.has(sessionKeyOf(roomId, participantId));
  }

  // ------------------------------------------------------------ main entry

  /**
   * Handle one wire envelope. `sfu` envelopes are always consumed; `offer`/
   * `answer`/`ice` envelopes are consumed only when addressed to the SFU
   * participant. Everything else is ignored (mesh traffic keeps flowing).
   */
  async handle(envelope: Envelope): Promise<void> {
    if (envelope.type === 'sfu') {
      await this.handleSfu(envelope);
      return;
    }
    if (envelope.type === 'offer' || envelope.type === 'answer' || envelope.type === 'ice') {
      if (envelope.targetSenderId === this.sfuParticipantId) {
        await this.handleMedia(envelope);
      }
      return;
    }
    // join/leave/presence/reaction/chat/... are not SFU traffic.
  }

  // ------------------------------------------------------------ sfu actions

  private async handleSfu(envelope: Envelope & { type: 'sfu' }): Promise<void> {
    const { roomId, senderId } = envelope;
    if (!(await this.isParticipant(roomId, senderId))) {
      this.emitError(
        'not-a-participant',
        `sender ${senderId} is not a member of room ${roomId}`,
        envelope,
      );
      return;
    }
    const session = this.sessions.get(sessionKeyOf(roomId, senderId));
    if (!session) {
      this.emitError(
        'not-joined',
        `no SfuSession for ${senderId} in room ${roomId} (join first)`,
        envelope,
      );
      return;
    }
    const payload = envelope.payload as SfuPayload | undefined;
    if (
      !payload ||
      typeof payload.action !== 'string' ||
      !(SFU_ACTIONS as readonly string[]).includes(payload.action)
    ) {
      this.emitError('unknown-action', `unknown or missing sfu action`, envelope);
      return;
    }
    try {
      switch (payload.action) {
        case 'publish':
          await this.onPublish(session, envelope, payload);
          break;
        case 'subscribe':
          await this.onSubscribe(session, envelope, payload);
          break;
        case 'layer-change':
          await this.onLayerChange(session, envelope, payload);
          break;
        case 'keyframe-request':
          await this.onKeyframeRequest(session, envelope, payload);
          break;
        case 'leave':
          await this.onLeave(session, envelope);
          break;
      }
    } catch (error) {
      this.emitError('gateway-error', `gateway call failed: ${String(error)}`, envelope);
    }
  }

  private async onPublish(
    session: SfuSession,
    envelope: Envelope & { type: 'sfu' },
    payload: SfuPayload,
  ): Promise<void> {
    const { roomId, senderId } = envelope;
    if (typeof payload.trackId !== 'string' || payload.trackId.length === 0) {
      this.emitError('invalid-payload', 'publish requires a non-empty trackId', envelope);
      return;
    }
    const kind = payload.kind;
    if (typeof kind !== 'string' || !(SFU_KINDS as readonly string[]).includes(kind)) {
      this.emitError(
        'invalid-payload',
        `publish requires kind in ${SFU_KINDS.join('|')}`,
        envelope,
      );
      return;
    }
    await session.publishTrack(payload.trackId, kind as SfuKind, {
      simulcast: payload.layer === 'simulcast',
    });
    let roomTracks = this.tracks.get(roomId);
    if (!roomTracks) {
      roomTracks = new Map();
      this.tracks.set(roomId, roomTracks);
    }
    roomTracks.set(payload.trackId, { publisherId: senderId, kind: kind as SfuKind });
    this.emit('published', {
      roomId,
      participantId: senderId,
      trackId: payload.trackId,
      kind: kind as SfuKind,
    });
  }

  private async onSubscribe(
    session: SfuSession,
    envelope: Envelope & { type: 'sfu' },
    payload: SfuPayload,
  ): Promise<void> {
    const { roomId, senderId } = envelope;
    const targets = new Set<string>();
    if (typeof payload.senderId === 'string' && payload.senderId.length > 0) {
      targets.add(payload.senderId);
    } else {
      // Bare subscribe: every publisher in the room except ourselves.
      const roomTracks = this.tracks.get(roomId);
      if (roomTracks) {
        for (const reg of roomTracks.values()) {
          if (reg.publisherId !== senderId) targets.add(reg.publisherId);
        }
      }
    }
    if (targets.size === 0) {
      this.emitError(
        'invalid-payload',
        'subscribe requires a senderId or at least one published track in the room',
        envelope,
      );
      return;
    }
    for (const target of targets) {
      await session.subscribe(target, { layers: payload.layer ? [payload.layer] : undefined });
      this.emit('subscribed', { roomId, participantId: senderId, targetSenderId: target });
    }
  }

  private async onLayerChange(
    session: SfuSession,
    envelope: Envelope & { type: 'sfu' },
    payload: SfuPayload,
  ): Promise<void> {
    const { roomId, senderId } = envelope;
    if (typeof payload.trackId !== 'string' || payload.trackId.length === 0) {
      this.emitError('invalid-payload', 'layer-change requires a non-empty trackId', envelope);
      return;
    }
    if (typeof payload.layer !== 'string' || payload.layer.length === 0) {
      this.emitError('invalid-payload', 'layer-change requires a non-empty layer', envelope);
      return;
    }
    await session.setPreferredLayers(payload.trackId, payload.layer);
    this.emit('layer-changed', {
      roomId,
      participantId: senderId,
      trackId: payload.trackId,
      layer: payload.layer,
    });
  }

  private async onKeyframeRequest(
    session: SfuSession,
    envelope: Envelope & { type: 'sfu' },
    payload: SfuPayload,
  ): Promise<void> {
    const { roomId, senderId } = envelope;
    if (typeof payload.trackId !== 'string' || payload.trackId.length === 0) {
      this.emitError('invalid-payload', 'keyframe-request requires a non-empty trackId', envelope);
      return;
    }
    await session.requestKeyframe(payload.trackId);
    this.emit('keyframe-requested', { roomId, participantId: senderId, trackId: payload.trackId });
  }

  private async onLeave(session: SfuSession, envelope: Envelope & { type: 'sfu' }): Promise<void> {
    const { roomId, senderId } = envelope;
    await session.leave();
    this.unregisterSession(roomId, senderId);
    this.emit('left', { roomId, participantId: senderId });
  }

  // ------------------------------------------------- offer/answer/ice to SFU

  private async handleMedia(
    envelope: Envelope & { type: 'offer' | 'answer' | 'ice' },
  ): Promise<void> {
    const { roomId, senderId } = envelope;
    const session = this.sessions.get(sessionKeyOf(roomId, senderId));
    if (!session) {
      this.emitError(
        'not-joined',
        `no SfuSession for ${senderId} in room ${roomId} (join first)`,
        envelope,
      );
      return;
    }
    try {
      if (envelope.type === 'offer') {
        await session.handleOffer(envelope.payload as OfferPayload);
      } else if (envelope.type === 'answer') {
        await session.handleAnswer(envelope.payload as OfferPayload);
      } else {
        await session.addIceCandidate(envelope.payload as IcePayload);
      }
    } catch (error) {
      this.emitError('gateway-error', `gateway call failed: ${String(error)}`, envelope);
    }
  }

  // ------------------------------------------------------------------ utils

  private emitError(code: SfuRouterErrorCode, message: string, envelope: Envelope): void {
    this.emit('error', {
      code,
      message,
      envelope,
      roomId: envelope.roomId,
      senderId: envelope.senderId,
    });
  }
}

function sessionKeyOf(roomId: string, participantId: string): string {
  return roomId + '\u0000' + participantId;
}
