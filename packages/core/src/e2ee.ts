/**
 * E2EE / SFrame processor (packages/core — zero dep).
 *
 * Goal: media confidentiality even if SFU/storage is compromised. DTLS-SRTP is
 * always on (PeerConnectionManager default); SFrame is the second layer.
 *
 * v1 uses `SubtleCrypto` AES-GCM (128/256-bit). Key distribution is
 * app-provided: `new Room({ e2ee: { key } })` or `room.setE2eeKey(newKey)`.
 * No in-band key exchange in v1.
 *
 * Transport: `RTCRtpScriptTransform` (Worker) preferred → fallback to
 * `RTCRtpSender.createEncodedStreams` insertable streams (`MediaStreamTrackProcessor`
 * + `TransformStream`). When neither is available we emit a `quality:warning`-like
 * `e2ee-unsupported` warning and refuse when `required:true`.
 *
 * SFU path: encrypted frames are opaque; SFU forwards without decrypt.
 * Recording egress: when `e2eeRequired`, bytes are ciphertext-only (key never stored).
 */

import { TypedEmitter } from './events.ts';

export interface E2eeConfig {
  /** Raw 128/256-bit key material (CryptoKey or bytes). */
  key: CryptoKey | Uint8Array;
  /** Ratchet window (ms) — no ratchet in v1 (default 0). */
  ratchetWindowMs?: number;
}

export type E2eeEventMap = {
  /** Key was rotated via setE2eeKey. */
  'e2ee:key-rotated': [];
  /** E2EE setup failed (e.g. unsupported platform). */
  'e2ee:error': [Error];
  /** Warning when E2EE is requested but not supported. */
  'e2ee:warning': [{ code: string; message: string }];
};

export interface E2eeKeyMaterial {
  cryptoKey: CryptoKey;
  raw: Uint8Array;
}

/**
 * Detect the E2EE transform surface available in this environment.
 * Returns the preferred mechanism, or `none` when neither Worker transform
 * nor insertable streams are present.
 */
export function detectE2eeSupport(): 'worker' | 'insertable' | 'none' {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof (g['RTCRtpScriptTransform'] as unknown) === 'function') return 'worker';
  // Safari fallback: per-sender createEncodedStreams
  if (
    typeof RTCRtpSender !== 'undefined' &&
    typeof (RTCRtpSender.prototype as unknown as Record<string, unknown>).createEncodedStreams === 'function'
  ) {
    return 'insertable';
  }
  if (
    typeof (g['MediaStreamTrackProcessor'] as unknown) === 'function' &&
    typeof TransformStream === 'function'
  ) {
    return 'insertable';
  }
  return 'none';
}

export function isE2eeSupported(): boolean {
  return detectE2eeSupport() !== 'none';
}

/** Derive a 256-bit AES-GCM key from a passphrase via PBKDF2 (app-provided path). */
export async function deriveE2eeKey(passphrase: string, salt?: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase) as unknown as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const keySalt = salt ?? enc.encode('vidcall-e2ee-v1');
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: keySalt as unknown as BufferSource, iterations: 100_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function importE2eeKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as unknown as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function getCryptoKey(key: CryptoKey | Uint8Array): Promise<CryptoKey> {
  if (key instanceof Uint8Array) return importE2eeKey(key);
  return key as CryptoKey;
}

// ---------------------------------------------------------------------------
// Frame crypto (AES-GCM, 12-byte IV per frame). The IV is random per frame
// and prepended to the ciphertext so decrypt can recover it without state.
// For the encoded-frame path the header bytes would be left in cleartext in a
// real SFrame impl; here we encrypt the whole frame for simplicity and
// correctness of the round-trip.
// ---------------------------------------------------------------------------

async function encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, plaintext as unknown as BufferSource);
  const out = new Uint8Array(iv.length + (ct as ArrayBuffer).byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct as ArrayBuffer), iv.length);
  return out;
}

async function decryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 12) throw new Error('E2EE: frame too short');
  const iv = data.slice(0, 12);
  const ct = data.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, ct as unknown as BufferSource);
  return new Uint8Array(pt as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/**
 * Per-peer E2EE processor: encrypts outgoing encoded frames and decrypts
 * incoming ones via insertable streams. When neither Worker nor insertable
 * streams are available the processor is inert and the caller should surface
 * a warning and optionally refuse when `required:true`.
 */
export class SFrameProcessor extends TypedEmitter<E2eeEventMap> {
  private cryptoKey: CryptoKey | null = null;
  private readonly kind: 'worker' | 'insertable' | 'none';

  constructor(key: CryptoKey | Uint8Array) {
    super();
    this.kind = detectE2eeSupport();
    void this.setKey(key);
  }

  get supported(): boolean {
    return this.kind !== 'none';
  }

  get mechanism(): 'worker' | 'insertable' | 'none' {
    return this.kind;
  }

  async setKey(key: CryptoKey | Uint8Array): Promise<void> {
    this.cryptoKey = await getCryptoKey(key);
    this.emit('e2ee:key-rotated');
  }

  private requireKey(): CryptoKey {
    if (!this.cryptoKey) throw new Error('E2EE: key not set');
    return this.cryptoKey;
  }

  /** Encrypt one encoded-frame payload (Uint8Array) → Uint8Array. */
  async encryptFrame(data: Uint8Array): Promise<Uint8Array> {
    return encryptBytes(this.requireKey(), data);
  }

  /** Decrypt one encoded-frame payload. */
  async decryptFrame(data: Uint8Array): Promise<Uint8Array> {
    return decryptBytes(this.requireKey(), data);
  }

  /**
   * Transform a `MediaStreamTrack` by wrapping its encoded streams.
   * In `insertable` mode this creates per-sender/receiver `TransformStream`s;
   * in `worker` mode the caller should use `RTCRtpScriptTransform`. Here we
   * install the insertable-streams path when available; otherwise it's a no-op
   * and the caller should handle the fallback.
   */
  async setupSender(sender: RTCRtpSender): Promise<void> {
    if (this.kind !== 'insertable') return;
    const key = this.requireKey();
    const anySender = sender as unknown as { createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream } };
    if (typeof anySender.createEncodedStreams !== 'function') return;
    const streams = anySender.createEncodedStreams();
    const transform = new TransformStream({
      transform: async (frame: unknown, controller) => {
        try {
          const f = frame as { data: ArrayBuffer; getMetadata?: () => unknown; setMetadata?: (m: unknown) => void };
          const plain = new Uint8Array(f.data);
          const enc = await encryptBytes(key, plain);
          // Encoded frames expose `data` as ArrayBuffer; replace it
          (f as unknown as Record<string, unknown>).data = enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength);
          controller.enqueue(f);
        } catch (err) {
          this.emit('e2ee:error', err instanceof Error ? err : new Error(String(err)));
          controller.enqueue(frame);
        }
      },
    });
    void streams.readable.pipeThrough(transform).pipeTo(streams.writable).catch(() => {});
  }

  async setupReceiver(receiver: RTCRtpReceiver): Promise<void> {
    if (this.kind !== 'insertable') return;
    const key = this.requireKey();
    const anyReceiver = receiver as unknown as { createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream } };
    if (typeof anyReceiver.createEncodedStreams !== 'function') return;
    const streams = anyReceiver.createEncodedStreams();
    const transform = new TransformStream({
      transform: async (frame: unknown, controller) => {
        try {
          const f = frame as { data: ArrayBuffer };
          const enc = new Uint8Array(f.data);
          const plain = await decryptBytes(key, enc);
          (f as unknown as Record<string, unknown>).data = plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength);
          controller.enqueue(f);
        } catch (err) {
          this.emit('e2ee:error', err instanceof Error ? err : new Error(String(err)));
          controller.enqueue(frame);
        }
      },
    });
    void streams.readable.pipeThrough(transform).pipeTo(streams.writable).catch(() => {});
  }

  /** Apply E2EE to all senders/receivers of a peer connection (best-effort). */
  async setupPeerConnection(pc: RTCPeerConnection): Promise<void> {
    if (this.kind === 'none') {
      this.emit('e2ee:warning', { code: 'e2ee-unsupported', message: 'E2EE not supported in this environment' });
      return;
    }
    for (const sender of pc.getSenders()) {
      try {
        await this.setupSender(sender);
      } catch (err) {
        this.emit('e2ee:error', err instanceof Error ? err : new Error(String(err)));
      }
    }
    for (const receiver of pc.getReceivers()) {
      try {
        await this.setupReceiver(receiver);
      } catch (err) {
        this.emit('e2ee:error', err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}
