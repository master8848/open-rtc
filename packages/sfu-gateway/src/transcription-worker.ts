/**
 * SfuTranscriptionWorker — SFU parallel to EgressWorker.
 * PlainTransport RTP -> chunk (10s) -> transcriber (mock or OpenAI whisper via env OPENAI_API_KEY)
 * -> transcript envelope -> DataChannelBus + relay (core handleSignal fan-out) + webhook.
 * Mirrors packages/core/src/media/transcription.ts SfuTranscriptionWorker but gateway-native
 * so sfu-gateway stays without a core runtime dep (protocol only).
 */
import type { Envelope } from '@mbsks/openrtc-protocol';

export type TranscriberFn = (chunk: Uint8Array, opts: { lang?: string }) => Promise<{ text: string; isFinal: boolean }>;

export interface SfuTranscriptionWorkerOptions {
  lang?: string;
  interim?: boolean;
  chunkMs?: number;
  transcriber?: TranscriberFn;
  dispatch?: (envelope: Envelope) => void;
  fetchImpl?: typeof fetch;
}

function mockTranscriber(_chunk: Uint8Array, _opts: { lang?: string }): Promise<{ text: string; isFinal: boolean }> {
  return Promise.resolve({ text: '[mock transcript]', isFinal: true });
}

async function openAiTranscriber(chunk: Uint8Array, opts: { lang?: string; fetchImpl?: typeof fetch }): Promise<{ text: string; isFinal: boolean }> {
  const env = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env;
  const key = env?.OPENAI_API_KEY;
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
    const json = (await res.json()) as { text?: string };
    return { text: json.text ?? '', isFinal: true };
  } catch {
    return mockTranscriber(chunk, opts);
  }
}

export class SfuTranscriptionWorker {
  private running = false;
  private roomId?: string;
  private opts: SfuTranscriptionWorkerOptions = {};
  private buffer: Uint8Array[] = [];
  private bufferedMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  start(roomId: string, opts: SfuTranscriptionWorkerOptions = {}): void {
    this.running = true;
    this.roomId = roomId;
    this.opts = opts;
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
    try { result = await transcriber(combined, { lang }); } catch { result = { text: '', isFinal: true }; }
    if (!result.text) return;
    const envelope: Envelope = {
      v: 1,
      type: 'transcript',
      roomId: this.roomId,
      senderId: 'transcriber',
      sessionId: `transcriber-${this.roomId}`,
      ts: Date.now(),
      seq: this.seq++,
      payload: { text: result.text, isFinal: result.isFinal, ...(lang ? { lang } : {}) },
    } as unknown as Envelope;
    if (this.opts.dispatch) {
      try { this.opts.dispatch(envelope); } catch { /* ignore */ }
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

export interface SfuGatewayTranscriptionOptions {
  roomId: string;
  lang?: string;
  interim?: boolean;
  chunkMs?: number;
  transcriber?: TranscriberFn;
  onTranscript?: (envelope: Envelope) => void;
  onWebhook?: (event: string, payload: unknown) => void;
}

export class GatewayTranscriptionSession {
  private readonly worker: SfuTranscriptionWorker;
  private readonly roomId: string;

  constructor(roomId: string, opts: SfuGatewayTranscriptionOptions) {
    this.roomId = roomId;
    this.worker = new SfuTranscriptionWorker();
    const dispatch = (envelope: Envelope) => {
      opts.onTranscript?.(envelope);
      const isFinal = (envelope.payload as { isFinal?: boolean } | undefined)?.isFinal ?? true;
      const evt = isFinal ? 'transcript.final' : 'transcript.interim';
      opts.onWebhook?.(evt, envelope.payload);
    };
    this.worker.start(roomId, {
      lang: opts.lang,
      interim: opts.interim,
      chunkMs: opts.chunkMs ?? 10_000,
      ...(opts.transcriber ? { transcriber: opts.transcriber } : {}),
      dispatch,
    });
  }

  pushAudio(chunk: Uint8Array, durationMs?: number): void { this.worker.pushAudio(chunk, durationMs); }
  stop(): void { this.worker.stop(); }
  get isRunning(): boolean { return this.worker.isRunning; }
}
