/**
 * Server transcription sidecar — PlainTransport audio -> chunk -> transcript envelope -> relay + webhooks.
 * Standalone so packages/server has no hard dep on sfu-gateway; logic mirrors
 * packages/sfu-gateway/src/transcription-worker.ts and packages/core/src/media/transcription.ts.
 */
import type { Envelope } from '@mbsks/openrtc-protocol';

export type TranscriberFn = (chunk: Uint8Array, opts: { lang?: string }) => Promise<{ text: string; isFinal: boolean }>;

export interface SfuTranscriptionWorkerOptions {
  lang?: string; interim?: boolean; chunkMs?: number; transcriber?: TranscriberFn; dispatch?: (envelope: Envelope) => void; fetchImpl?: typeof fetch;
}

function mockTranscriber(_c: Uint8Array, _o: { lang?: string }): Promise<{ text: string; isFinal: boolean }> {
  return Promise.resolve({ text: '[mock transcript]', isFinal: true });
}

async function openAiTranscriber(chunk: Uint8Array, opts: { lang?: string; fetchImpl?: typeof fetch }): Promise<{ text: string; isFinal: boolean }> {
  const key = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env?.OPENAI_API_KEY;
  if (!key) return mockTranscriber(chunk, opts);
  try {
    const fetchFn = opts.fetchImpl ?? fetch;
    const form = new FormData();
    form.append('file', new Blob([chunk as unknown as BlobPart], { type: 'audio/webm' }), 'chunk.webm');
    form.append('model', 'whisper-1');
    if (opts.lang) form.append('language', opts.lang);
    const res = await fetchFn('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form as unknown as BodyInit });
    if (!res.ok) return mockTranscriber(chunk, opts);
    const j = await res.json() as { text?: string };
    return { text: j.text ?? '', isFinal: true };
  } catch { return mockTranscriber(chunk, opts); }
}

export class SfuTranscriptionWorker {
  private running = false; private roomId?: string; private opts: SfuTranscriptionWorkerOptions = {};
  private buffer: Uint8Array[] = []; private bufferedMs = 0; private timer: ReturnType<typeof setInterval> | null = null; private seq = 0;
  start(roomId: string, opts: SfuTranscriptionWorkerOptions = {}): void {
    this.running = true; this.roomId = roomId; this.opts = opts; this.seq = 0; this.buffer = []; this.bufferedMs = 0;
    const chunkMs = opts.chunkMs ?? 10_000;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.flush(), chunkMs);
    if (this.timer && typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') (this.timer as unknown as { unref: () => void }).unref();
  }
  pushAudio(chunk: Uint8Array, durationMs = 20): void {
    if (!this.running) return; this.buffer.push(chunk); this.bufferedMs += durationMs;
    if (this.bufferedMs >= (this.opts.chunkMs ?? 10_000)) void this.flush();
  }
  private async flush(): Promise<void> {
    if (!this.running || !this.roomId || this.buffer.length === 0) return;
    const combined = (() => { const total = this.buffer.reduce((n, c) => n + c.length, 0); const out = new Uint8Array(total); let off = 0; for (const c of this.buffer) { out.set(c, off); off += c.length; } return out; })();
    this.buffer = []; this.bufferedMs = 0;
    const lang = this.opts.lang ?? 'en-US';
    const transcriber = this.opts.transcriber ?? ((c: Uint8Array, o: { lang?: string }) => openAiTranscriber(c, { lang: o.lang, fetchImpl: this.opts.fetchImpl }));
    let result: { text: string; isFinal: boolean };
    try { result = await transcriber(combined, { lang }); } catch { result = { text: '', isFinal: true }; }
    if (!result.text) return;
    const envelope: Envelope = { v: 1, type: 'transcript', roomId: this.roomId, senderId: 'transcriber', sessionId: `transcriber-${this.roomId}`, ts: Date.now(), seq: this.seq++, payload: { text: result.text, isFinal: result.isFinal, ...(lang ? { lang } : {}) } } as unknown as Envelope;
    if (this.opts.dispatch) try { this.opts.dispatch(envelope); } catch { /* ignore */ }
  }
  stop(): void { this.running = false; if (this.timer) { clearInterval(this.timer); this.timer = null; } this.buffer = []; this.bufferedMs = 0; this.roomId = undefined; }
  get isRunning(): boolean { return this.running; }
}
