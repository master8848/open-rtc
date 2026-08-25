/**
 * Minimal SDP helpers for the mediasoup reference adapter.
 *
 * The gateway is media-agnostic: SDP offers/answers pass through the
 * interface untouched. The adapter needs just enough SDP to drive mediasoup:
 * DTLS fingerprints + role and ICE ufrag/pwd to `connect()` a
 * `WebRtcTransport`, and m-line codecs to build minimal `rtpParameters` for
 * `produce()`.
 *
 * Reference quality: production deployments should swap in a full SDP
 * library (e.g. `sdp-transform`) — this module deliberately covers only the
 * fields the reference adapter uses, and documents what it does not parse
 * (bundled m-lines, rtcp-fb, extmap, fmtp, ...).
 */
import type { SfuKind } from '@mbsks/openrtc-protocol';

/** RFC 4572 hash algorithms mediasoup accepts (its `FingerprintAlgorithm`). */
export const SDP_FINGERPRINT_ALGORITHMS = [
  'sha-1',
  'sha-224',
  'sha-256',
  'sha-384',
  'sha-512',
] as const;
export type SdpFingerprintAlgorithm = (typeof SDP_FINGERPRINT_ALGORITHMS)[number];

export interface SdpFingerprint {
  algorithm: SdpFingerprintAlgorithm;
  value: string;
}

export interface SdpDtlsInfo {
  /** Client setup role from the SDP (`a=setup`). */
  setup: 'active' | 'passive' | 'actpass' | null;
  fingerprints: SdpFingerprint[];
}

export interface SdpIceInfo {
  ufrag: string | null;
  pwd: string | null;
}

/** An ICE candidate as parsed from an SDP `a=candidate:` line. */
export interface RTCIceCandidateLike {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/** An ICE candidate as mediasoup exposes it (its `IceCandidate` shape). */
export interface SdpCandidate {
  foundation: string;
  priority: number;
  protocol: string;
  address: string;
  port: number;
  type: string;
  tcpType?: string;
}

/** Render a candidate as an `a=candidate:` SDP line. */
export function candidateToSdpLine(candidate: SdpCandidate): string {
  let line = `a=candidate:${candidate.foundation} ${candidate.priority} ${candidate.protocol} ${candidate.address} ${candidate.port} typ ${candidate.type}`;
  if (candidate.tcpType !== undefined) line += ` tcptype ${candidate.tcpType}`;
  return line;
}

/** One m-line's codec info (first payload type only). */
export interface SdpCodec {
  payloadType: number;
  /** e.g. `opus`, `VP8`, `H264` (from rtpmap). */
  codec: string;
  clockRate: number;
  channels?: number;
  /** The `a=rtpmap:<n> rtx/...` payload type paired with this codec, if any. */
  rtxPayloadType?: number;
}

export interface SdpMediaSection {
  kind: 'audio' | 'video';
  mid: string | null;
  codec: SdpCodec | null;
}

export interface ParsedSdp {
  dtls: SdpDtlsInfo;
  ice: SdpIceInfo;
  media: SdpMediaSection[];
  candidates: RTCIceCandidateLike[];
}

const KIND_LOOKUP: Record<string, 'audio' | 'video'> = { audio: 'audio', video: 'video' };

/**
 * Parse the fields the reference adapter needs. Never throws: malformed SDP
 * yields `null`s / empty arrays so callers can fail with a clear error.
 */
export function parseSdp(sdp: string): ParsedSdp {
  const lines = sdp.split(/\r?\n/);
  const result: ParsedSdp = {
    dtls: { setup: null, fingerprints: [] },
    ice: { ufrag: null, pwd: null },
    media: [],
    candidates: [],
  };
  let current: SdpMediaSection | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('a=fingerprint:')) {
      const value = trimmed.slice('a=fingerprint:'.length).trim();
      const space = value.indexOf(' ');
      if (space > 0) {
        const algorithm = value.slice(0, space);
        if ((SDP_FINGERPRINT_ALGORITHMS as readonly string[]).includes(algorithm)) {
          result.dtls.fingerprints.push({
            algorithm: algorithm as SdpFingerprintAlgorithm,
            value: value.slice(space + 1),
          });
        }
      }
    } else if (trimmed.startsWith('a=setup:')) {
      const role = trimmed.slice('a=setup:'.length).trim();
      if (role === 'active' || role === 'passive' || role === 'actpass') result.dtls.setup = role;
    } else if (trimmed.startsWith('a=ice-ufrag:')) {
      result.ice.ufrag = trimmed.slice('a=ice-ufrag:'.length).trim();
    } else if (trimmed.startsWith('a=ice-pwd:')) {
      result.ice.pwd = trimmed.slice('a=ice-pwd:'.length).trim();
    } else if (trimmed.startsWith('a=candidate:')) {
      result.candidates.push({
        candidate: trimmed.slice('a=candidate:'.length).trim(),
        sdpMid: current?.mid ?? null,
        sdpMLineIndex: current ? result.media.indexOf(current) : null,
      });
    } else if (trimmed.startsWith('m=')) {
      current = { kind: 'audio', mid: null, codec: null };
      const parts = trimmed.slice(2).trim().split(/\s+/);
      const kind = KIND_LOOKUP[parts[0] ?? ''];
      if (kind) current.kind = kind;
      const pt = Number(parts[3]);
      if (Number.isInteger(pt) && pt >= 0)
        current.codec = { payloadType: pt, codec: '', clockRate: 0 };
      result.media.push(current);
    } else if (trimmed.startsWith('a=mid:')) {
      if (current) current.mid = trimmed.slice('a=mid:'.length).trim();
    } else if (trimmed.startsWith('a=rtpmap:')) {
      if (!current?.codec) continue;
      const spec = trimmed.slice('a=rtpmap:'.length).trim();
      // <payload> <codec>/<clock>[/<channels>]
      const pt = Number(spec.split(/\s+/)[0]);
      const rest = spec.split(/\s+/)[1] ?? '';
      const [codec, clockRateStr, channelsStr] = rest.split('/');
      if (pt !== current.codec.payloadType) continue;
      current.codec.codec = codec ?? '';
      current.codec.clockRate = Number(clockRateStr) || 0;
      if (channelsStr) current.codec.channels = Number(channelsStr) || undefined;
    } else if (trimmed.startsWith('a=rtx:') && current?.codec) {
      // a=rtx:<pt> apt=<original>
      const spec = trimmed.slice('a=rtx:'.length).trim();
      const pt = Number(spec.split(/\s+/)[0]);
      const apt = Number((spec.match(/apt=(\d+)/) ?? [])[1]);
      if (apt === current.codec.payloadType) current.codec.rtxPayloadType = pt;
    }
  }
  return result;
}

/** mediasoup `DtlsParameters` for `transport.connect()` derived from an offer. */
export function dtlsParametersFromSdp(sdp: string): {
  role: 'client' | 'server';
  fingerprints: SdpFingerprint[];
} | null {
  const parsed = parseSdp(sdp);
  if (parsed.dtls.fingerprints.length === 0) return null;
  // The offerer runs DTLS as active; mediasoup wants the *server* role here.
  return {
    role: parsed.dtls.setup === 'passive' ? 'server' : 'client',
    fingerprints: parsed.dtls.fingerprints,
  };
}

/**
 * Minimal mediasoup `RtpParameters` for `produce()`, built from the offer's
 * m-line for `kind`. `'screen'` is mapped to `'video'` (a screen-share is a
 * video track). Reference quality: rtcp-fb, extmap and fmtp are not parsed,
 * and encodings carry a **placeholder SSRC** so the wiring is exercisable
 * without a browser. Production must replace this with the sender's real RTP
 * parameters (e.g. parsed from the client SDP, as mediasoup-client does).
 */
let placeholderSsrc = 1_000_000;

export function minimalRtpParameters(
  sdp: string,
  kind: SfuKind,
): {
  codecs: Array<{ mimeType: string; payloadType: number; clockRate: number; channels?: number }>;
  encodings: Array<{ ssrc: number }>;
} | null {
  const mediaKind: 'audio' | 'video' = kind === 'audio' ? 'audio' : 'video';
  const section = parseSdp(sdp).media.find((m) => m.kind === mediaKind);
  const codec = section?.codec;
  if (!codec || !codec.codec) return null;
  const mimeType = mediaKind === 'audio' ? `audio/${codec.codec}` : `video/${codec.codec}`;
  placeholderSsrc += 1;
  return {
    codecs: [
      {
        mimeType,
        payloadType: codec.payloadType,
        clockRate: codec.clockRate,
        ...(codec.channels !== undefined ? { channels: codec.channels } : {}),
      },
    ],
    encodings: [{ ssrc: placeholderSsrc }],
  };
}

/** Build a minimal SDP answer from a mediasoup transport's local parameters. */
export function buildSdpAnswer(options: {
  iceUfrag: string;
  icePwd: string;
  fingerprints: SdpFingerprint[];
  setup: 'active' | 'passive' | 'actpass';
  /** mediasoup-style candidates (rendered as `a=candidate:` lines). */
  candidates?: SdpCandidate[];
  /** m-lines to include; each is `{ mid, kind }`. */
  media: Array<{ mid: string; kind: 'audio' | 'video' }>;
}): string {
  const fingerprint = options.fingerprints[0];
  const lines = [
    'v=0',
    'o=- 281974575213033 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    ...(options.media.length > 1
      ? [`a=group:BUNDLE ${options.media.map((m) => m.mid).join(' ')}`]
      : []),
  ];
  for (const [i, m] of options.media.entries()) {
    const port = i === 0 ? 9 : 0;
    lines.push(`m=${m.kind} ${port} UDP/TLS/RTP/SAVPF 0`);
    lines.push('c=IN IP4 0.0.0.0');
    lines.push(`a=mid:${m.mid}`);
    lines.push('a=rtcp-mux');
    lines.push(`a=ice-ufrag:${options.iceUfrag}`);
    lines.push(`a=ice-pwd:${options.icePwd}`);
    if (fingerprint) {
      lines.push(`a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`);
      lines.push(`a=setup:${options.setup}`);
    }
    for (const candidate of options.candidates ?? []) {
      lines.push(candidateToSdpLine(candidate));
    }
  }
  return lines.join('\r\n') + '\r\n';
}
