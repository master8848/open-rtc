/**
 * Transcription — `transcript` envelope + `room.on('transcript')` / client STT hook.
 *
 * Two sources, same event (06-advanced-media 2. Transcription/STT):
 *  1. Client STT (zero infra): Web Speech API / Whisper.wasm → DataChannelBus `transcript` → `room.emit('transcript')`.
 *  2. Server STT (prod): SFU audio Consumer → STT service → `transcript` envelope (`protocol/schema.json` additive `transcript` type) → `room.on('transcript')`.
 *
 * The envelope is additive: `{ v, type:'transcript', roomId, senderId, sessionId, ts, seq, payload:{ text, isFinal, lang } }`
 * already added to `protocol/types.ts` (+ `protocol/fixtures/transcript.json`).
 */

import type { TranscriptPayload } from '@mbsks/openrtc-protocol';

export interface TranscriptEvent extends TranscriptPayload {
  participantId: string;
}

export interface TranscriptionOptions {
  lang?: string;
  interim?: boolean;
}

export interface TranscriptionHandle {
  stop(): Promise<void>;
}

export interface TranscriptionSource {
  onTranscript(cb: (e: TranscriptEvent) => void): () => void;
}

/** Server-side STT worker stub (parallel to EgressWorker): SFU Consumer -> STT -> transcript envelope */
export class SfuTranscriptionWorker {
  private running = false;
  start(_roomId: string, _opts: TranscriptionOptions = {}): void { this.running = true; }
  stop(): void { this.running = false; }
  get isRunning(): boolean { return this.running; }
  // In prod, consume SFU audio PlainTransport RTP -> STT service -> dispatch transcript envelope
}

export class TranscriptionController implements TranscriptionSource {
  private running = false;
  private lang = 'en-US';
  private interim = true;
  private recognition: unknown | null = null;
  private readonly cbs = new Set<(e: TranscriptEvent) => void>();
  readonly sfuWorker = new SfuTranscriptionWorker();

  async start(opts: TranscriptionOptions = {}): Promise<TranscriptionHandle> {
    this.running = true;
    this.lang = opts.lang ?? 'en-US';
    this.interim = opts.interim ?? true;
    const Ctor = (globalThis as unknown as Record<string, unknown>)['webkitSpeechRecognition'] ?? (globalThis as unknown as Record<string, unknown>)['SpeechRecognition'];
    if (typeof Ctor === 'function') {
      const r = new (Ctor as unknown as new () => Record<string, unknown>)();
      try {
        (r as Record<string, unknown>)['lang'] = this.lang;
        (r as Record<string, unknown>)['interimResults'] = this.interim;
        (r as { start?: () => void }).start?.();
      } catch { /* best effort */ }
      this.recognition = r;
    }
    return { stop: async () => this.stop() };
  }

  async stop(): Promise<void> {
    this.running = false;
    const r = this.recognition as unknown as { stop?: () => void } | null;
    try { r?.stop?.(); } catch { /* ignore */ }
    this.recognition = null;
  }

  get isRunning(): boolean { return this.running; }

  emitTranscript(payload: TranscriptPayload & { participantId?: string }): void {
    const ev: TranscriptEvent = {
      text: payload.text,
      isFinal: payload.isFinal,
      ...(payload.lang ? { lang: payload.lang } : {}),
      participantId: payload.participantId ?? 'local',
    };
    for (const cb of [...this.cbs]) cb(ev);
  }

  onTranscript(cb: (e: TranscriptEvent) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
}
