/**
 * Transcribe registry — multi-provider STT abstraction (optional, zero deps).
 * Providers: openai (Whisper), deepgram, custom (HTTP), local/mock.
 */
export type TranscriberFn = (chunk: Uint8Array, opts: { lang?: string }) => Promise<{ text: string; isFinal: boolean }>;

export interface TranscriptionProvider {
  id: string;
  label: string;
  transcribe: TranscriberFn;
}

function mockTranscriber(_c: Uint8Array, _o: { lang?: string }): Promise<{ text: string; isFinal: boolean }> {
  return Promise.resolve({ text: '[mock transcript]', isFinal: true });
}

async function openAiTranscriber(chunk: Uint8Array, opts: { lang?: string; fetchImpl?: typeof fetch }): Promise<{ text: string; isFinal: boolean }> {
  const env = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env;
  const key = env?.OPENAI_API_KEY;
  if (!key) return mockTranscriber(chunk, opts);
  try {
    const f = opts.fetchImpl ?? fetch;
    const form = new FormData();
    form.append('file', new Blob([chunk as unknown as BlobPart], { type: 'audio/webm' }), 'chunk.webm');
    form.append('model', 'whisper-1');
    if (opts.lang) form.append('language', opts.lang);
    const r = await f('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form as unknown as BodyInit });
    if (!r.ok) return mockTranscriber(chunk, opts);
    const j = (await r.json()) as { text?: string };
    return { text: j.text ?? '', isFinal: true };
  } catch { return mockTranscriber(chunk, opts); }
}

async function deepgramTranscriber(chunk: Uint8Array, opts: { lang?: string; fetchImpl?: typeof fetch }): Promise<{ text: string; isFinal: boolean }> {
  const env = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env;
  const key = env?.DEEPGRAM_API_KEY;
  if (!key) return mockTranscriber(chunk, opts);
  try {
    const f = opts.fetchImpl ?? fetch;
    const lang = opts.lang ?? 'en-US';
    const r = await f(`https://api.deepgram.com/v1/listen?model=nova-2&language=${encodeURIComponent(lang)}`, { method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/webm' }, body: chunk as unknown as BodyInit });
    if (!r.ok) return mockTranscriber(chunk, opts);
    const j = (await r.json()) as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } };
    const text = j.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    return { text, isFinal: true };
  } catch { return mockTranscriber(chunk, opts); }
}

async function customTranscriber(chunk: Uint8Array, opts: { lang?: string; fetchImpl?: typeof fetch; endpoint?: string }): Promise<{ text: string; isFinal: boolean }> {
  const env = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env;
  const url = (opts as { endpoint?: string }).endpoint ?? env?.TRANSCRIBE_ENDPOINT;
  if (!url) return mockTranscriber(chunk, opts);
  try {
    const f = opts.fetchImpl ?? fetch;
    const r = await f(url, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: chunk as unknown as BodyInit });
    if (!r.ok) return mockTranscriber(chunk, opts);
    const j = (await r.json()) as { text?: string; transcript?: string };
    return { text: j.text ?? j.transcript ?? '', isFinal: true };
  } catch { return mockTranscriber(chunk, opts); }
}

const builtins: Record<string, TranscriptionProvider> = {
  local: { id: 'local', label: 'Local/mock', transcribe: mockTranscriber },
  mock: { id: 'mock', label: 'Local/mock', transcribe: mockTranscriber },
  openai: { id: 'openai', label: 'OpenAI Whisper', transcribe: openAiTranscriber as TranscriberFn },
  deepgram: { id: 'deepgram', label: 'Deepgram', transcribe: deepgramTranscriber as TranscriberFn },
  custom: { id: 'custom', label: 'Custom HTTP', transcribe: customTranscriber as unknown as TranscriberFn },
};

const registry = new Map<string, TranscriptionProvider>(Object.entries(builtins));

export function registerTranscriptionProvider(p: TranscriptionProvider): void { registry.set(p.id, p); }
export function getTranscriptionProvider(id: string): TranscriptionProvider | undefined { return registry.get(id); }
export function listTranscriptionProviders(): TranscriptionProvider[] { return [...registry.values()]; }
export function resolveTranscriber(id?: string, fallback?: TranscriberFn): TranscriberFn {
  if (!id) return fallback ?? mockTranscriber;
  return registry.get(id)?.transcribe ?? fallback ?? mockTranscriber;
}
export { mockTranscriber };
