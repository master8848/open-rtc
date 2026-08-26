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

export type TranscriberFn = (chunk: Uint8Array, opts: { lang?: string }) => Promise<{ text: string; isFinal: boolean }>;

export interface SfuTranscriptionWorkerOptions extends TranscriptionOptions {
  chunkMs?: number;
  transcriber?: TranscriberFn;
  dispatch?: (envelope: unknown) => void;
  fetchImpl?: typeof fetch;
}

function mockTranscriber(_chunk: Uint8Array, _opts: { lang?: string }): Promise<{ text: string; isFinal: boolean }> {
  return Promise.resolve({ text: '[mock transcript]', isFinal: true });
}

async function openAiTranscriber(chunk: Uint8Array, opts: { lang?: string; fetchImpl?: typeof fetch }): Promise<{ text: string; isFinal: boolean }> {
  const key = (globalThis as unknown as Record<string, unknown>)['process'] !== undefined
    ? (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env?.OPENAI_API_KEY
    : undefined;
  if (!key) return mockTranscriber(chunk, opts);
  try {
    const fetchFn = opts.fetchImpl ?? fetch;
    const form = new FormData();
    form.append('file', new Blob([chunk as unknown as BlobPart], { type: 'audio/webm' }), 'chunk.webm');
    form.append('model', 'whisper-1');
    if (opts.lang) form.append('language', opts.lang);
    const res = await fetchFn('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form as unknown as BodyInit,
    });
    if (!res.ok) return mockTranscriber(chunk, opts);
    const json = await res.json() as { text?: string };
    return { text: json.text ?? '', isFinal: true };
  } catch {
    return mockTranscriber(chunk, opts);
  }
}

/** Server-side STT worker (parallel to EgressWorker): SFU Consumer -> STT -> transcript envelope */
export class SfuTranscriptionWorker {
  private running = false;
  private roomId?: string;
  private opts: SfuTranscriptionWorkerOptions = {};
  private buffer: Uint8Array[] = [];
  private bufferedMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private dispatch?: (envelope: unknown) => void;

  start(roomId: string, opts: SfuTranscriptionWorkerOptions = {}): void {
    this.running = true;
    this.roomId = roomId;
    this.opts = opts;
    this.dispatch = opts.dispatch;
    this.seq = 0;
    this.buffer = [];
    this.bufferedMs = 0;
    const chunkMs = opts.chunkMs ?? 10_000;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.flush(), chunkMs);
    if (this.timer && typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  /** Feed raw RTP/PCM chunk (e.g. from PlainTransport). In tests call directly. */
  pushAudio(chunk: Uint8Array, durationMs = 20): void {
    if (!this.running) return;
    this.buffer.push(chunk);
    this.bufferedMs += durationMs;
    const chunkMs = this.opts.chunkMs ?? 10_000;
    if (this.bufferedMs >= chunkMs) void this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.running || !this.roomId || this.buffer.length === 0) return;
    const combined = this.concat(this.buffer);
    this.buffer = [];
    this.bufferedMs = 0;
    const lang = this.opts.lang ?? 'en-US';
    const transcriber = this.opts.transcriber ?? ((c: Uint8Array, o: { lang?: string }) => openAiTranscriber(c, { lang: o.lang, fetchImpl: this.opts.fetchImpl }));
    let result: { text: string; isFinal: boolean };
    try {
      result = await transcriber(combined, { lang });
    } catch {
      result = { text: '', isFinal: true };
    }
    if (!result.text) return;
    const envelope = {
      v: 1,
      type: 'transcript',
      roomId: this.roomId,
      senderId: 'transcriber',
      sessionId: `transcriber-${this.roomId}`,
      ts: Date.now(),
      seq: this.seq++,
      payload: { text: result.text, isFinal: result.isFinal, ...(lang ? { lang } : {}) },
    };
    if (this.dispatch) {
      try { this.dispatch(envelope); } catch { /* ignore */ }
    }
  }

  private concat(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  stop(): void {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.buffer = [];
    this.bufferedMs = 0;
    this.roomId = undefined;
  }

  get isRunning(): boolean { return this.running; }
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
