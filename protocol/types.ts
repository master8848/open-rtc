/**
 * vidcall wire protocol — TypeScript mirror of `protocol/schema.json`.
 *
 * `protocol/schema.json` is the single source of truth for the wire protocol;
 * this file is the hand-written TS mirror (quicktype codegen is a later step).
 * It is shared by every binding (JS/Kotlin/Swift/Dart) via the schema.
 *
 * Wire rules (schema.json — single source of truth):
 *  - One JSON envelope per message, carried over any backend pub/sub.
 *  - `v` bumps only on breaking changes; additive changes are non-breaking.
 *  - SDP/ICE payloads are opaque; the engine owns ordering/idempotency/glare.
 *  - Unknown fields are ignored; unknown `type` values are ignored + logged.
 *  - `seq` is monotonic per sender per `sessionId`, starting at 0; the engine
 *    dedupes per `sessionId` and reorders by `seq`.
 *  - Unicast: optional `targetSenderId` addresses one peer; absent = room
 *    broadcast (relayed to everyone except the sender), present = relayed only
 *    to that participant. Receivers MUST filter on it.
 *  - Glare (perfect negotiation): `polite = selfId < remoteId` (lexicographic
 *    comparison of `senderId`) — every binding derives the same polarity.
 */

/** Wire protocol version (schema.json `properties.v.const`). */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** All envelope `type` values (schema.json `properties.type.enum`). */
export const MESSAGE_TYPES = [
  'join',
  'leave',
  'offer',
  'answer',
  'ice',
  'presence',
  'reaction',
  'chat',
  'screen-share',
  'quality-warning',
  'sfu',
  'transcript',
  'error',
  'ping',
  'pong',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** schema.json `DeviceProfile`. */
export const PLATFORMS = ['browser', 'node', 'kotlin', 'swift', 'dart'] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface DeviceProfile {
  /** Logical processor cores (`navigator.hardwareConcurrency`). */
  hardwareConcurrency: number;
  /** Approximate device RAM in GB; Chrome-only (`navigator.deviceMemory`). */
  deviceMemory?: number;
  /** Mobile heuristic (`navigator.userAgentData.mobile` / UA sniffing). */
  mobile: boolean;
  screenWidth?: number;
  screenHeight?: number;
  platform?: Platform;
}

/** schema.json `JoinPayload.capabilities`. */
export interface JoinCapabilities {
  /** Send-side simulcast support (Chrome/Edge/Firefox; not iOS Safari). */
  simulcast?: boolean;
  /** SVC support (VP9/AV1 scalability modes). */
  svc?: boolean;
  /** Supported codec mime types, e.g. `["video/VP8","video/H264"]`. */
  codecs?: string[];
}

export interface JoinPayload {
  displayName?: string;
  metadata?: Record<string, unknown>;
  deviceProfile?: DeviceProfile;
  capabilities?: JoinCapabilities;
}

export interface LeavePayload {
  reason?: string;
}

/** Offer AND answer both carry an `OfferPayload` (mirrors schema.json). */
export interface OfferPayload {
  /** Full SDP (unified-plan); treated as opaque by signaling. */
  sdp: string;
  /** Optional label, e.g. `renegotiation` or a mid. */
  label?: string;
}

/** schema.json `IcePayload` (trickle ICE, RFC 8838). */
export interface IcePayload {
  /** `RTCIceCandidate.candidate` string, or `''` for end-of-candidates. */
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export const PRESENCE_STATES = ['online', 'away', 'busy', 'offline'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

export interface PresencePayload {
  state: PresenceState;
  metadata?: Record<string, unknown>;
}

export interface ReactionPayload {
  emoji: string;
  targetSenderId?: string;
  /** Client timestamp of the reaction, epoch ms. */
  ts?: number;
}

export interface ChatReplyTo {
  senderId?: string;
  seq?: number;
}

export interface ChatPayload {
  text: string; // maxLength 4000 per schema
  replyTo?: ChatReplyTo;
}

export const SCREEN_SHARE_ACTIONS = ['start', 'stop'] as const;
export type ScreenShareAction = (typeof SCREEN_SHARE_ACTIONS)[number];

export interface ScreenSharePayload {
  action: ScreenShareAction;
  label?: string;
}

/** Quality tier ids, e.g. `"1080p@30"`, `"audio-only"`. */
export type QualityTierId = string;

/** Reason a quality tier changed (schema.json `QualityWarningPayload.reason`). */
export const QUALITY_WARNING_REASONS = ['network', 'cpu', 'device', 'manual', 'recovery'] as const;
export type QualityWarningReason = (typeof QUALITY_WARNING_REASONS)[number];

export const QUALITY_WARNING_DIRECTIONS = ['send', 'receive'] as const;
export type QualityWarningDirection = (typeof QUALITY_WARNING_DIRECTIONS)[number];

export interface QualityWarningPayload {
  from: QualityTierId;
  to: QualityTierId;
  reason: QualityWarningReason;
  direction: QualityWarningDirection;
}

export const SFU_ACTIONS = [
  'publish',
  'subscribe',
  'layer-change',
  'keyframe-request',
  'leave',
] as const;
export type SfuAction = (typeof SFU_ACTIONS)[number];

export const SFU_KINDS = ['audio', 'video', 'screen'] as const;
export type SfuKind = (typeof SFU_KINDS)[number];

export interface SfuPayload {
  action: SfuAction;
  trackId?: string;
  kind?: SfuKind;
  senderId?: string;
  layer?: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export interface TranscriptPayload {
  text: string;
  isFinal: boolean;
  lang?: string;
}

/** Payload type per envelope `type` (schema.json `definitions`). */
export type MessagePayloadMap = {
  join: JoinPayload;
  leave: LeavePayload;
  offer: OfferPayload;
  answer: OfferPayload;
  ice: IcePayload;
  presence: PresencePayload;
  reaction: ReactionPayload;
  chat: ChatPayload;
  'screen-share': ScreenSharePayload;
  'quality-warning': QualityWarningPayload;
  sfu: SfuPayload;
  transcript: TranscriptPayload;
  error: ErrorPayload;
  ping: Record<string, never>;
  pong: Record<string, never>;
};

/** Common envelope fields (schema.json `required`). */
export interface EnvelopeBase {
  /** Protocol version — must equal `PROTOCOL_VERSION`. */
  v: ProtocolVersion;
  roomId: string;
  senderId: string;
  /** Per-join id; guards against stale tabs/duplicates. */
  sessionId: string;
  /** Sender clock, epoch ms. */
  ts: number;
  /** Monotonic per sender; the engine dedupes/reorders. */
  seq: number;
  /**
   * schema.json `targetSenderId`: optional target for peer-addressed signal
   * payloads (join/leave/offer/answer/ice/presence/reaction/chat). Absent =
   * room broadcast (sender-excluded relay); present = unicast to that peer.
   * Backends may ignore it; receivers MUST filter on it.
   */
  targetSenderId?: string;
}

/**
 * Discriminated envelope union: every `type` carries its schema payload.
 * `payload` is optional at the wire level (schema does not require it).
 */
export type Envelope = EnvelopeBase &
  {
    [K in MessageType]: { type: K; payload?: MessagePayloadMap[K] };
  }[MessageType];

/** Narrow a parsed envelope to a concrete type (also validates `v`). */
export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  if (e.v !== PROTOCOL_VERSION) return false;
  if (typeof e.type !== 'string' || !(MESSAGE_TYPES as readonly string[]).includes(e.type))
    return false;
  if (
    typeof e.roomId !== 'string' ||
    typeof e.senderId !== 'string' ||
    typeof e.sessionId !== 'string'
  )
    return false;
  if (typeof e.ts !== 'number' || typeof e.seq !== 'number') return false;
  return true;
}

/** Build a valid envelope with defaults for ts/seq (caller may override). */
export function createEnvelope<K extends MessageType>(
  type: K,
  fields: Pick<EnvelopeBase, 'roomId' | 'senderId' | 'sessionId'> &
    Partial<Pick<EnvelopeBase, 'ts' | 'seq' | 'targetSenderId'>> & {
      payload?: MessagePayloadMap[K];
    },
): Envelope {
  const { ts, seq, ...rest } = fields;
  return {
    v: PROTOCOL_VERSION,
    ts: ts ?? Date.now(),
    seq: seq ?? 0,
    ...rest,
    type,
  } as Envelope;
}
