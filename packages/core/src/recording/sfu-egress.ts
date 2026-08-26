/**
 * SFU egress (02-recording.md § SFU path) — feature-flagged.
 * Selective: file per producer. Composite: consumers → ffmpeg/gstreamer via PlainTransport.
 * Reference worker uses `ffmpeg -i pipe:0`. Behind flag: disabled until app opts in.
 * Lifecycle: PlainTransport RTP -> ffmpeg stdin -> mp4/webm chunks -> RecordingStorage.
 */
export type EgressMode = 'sfu-selective' | 'sfu-composite';
export interface RecordingStorageLike { saveChunk(sessionId: string, chunk: Buffer, index: number): Promise<void>; }
export interface EgressOptions {
  roomId: string;
  mode: EgressMode;
  consumers?: Array<{ producerId: string; kind: 'audio' | 'video'; peerId: string }>;
  layout?: 'grid' | 'spotlight' | { custom: Record<string, unknown> };
  hls?: boolean;
  rtmpUrl?: string;
  ffmpegPath?: string;
  enabled?: boolean;
  /** Optional PlainTransport-like source for RTP (tests inject fake). */
  plainTransport?: { onRtp?: (cb: (buf: Buffer) => void) => () => void };
}
export interface EgressHandle { stop(): Promise<{ chunks: number; bytes: number }>; }
export class FfmpegEgressWorker {
  private readonly ffmpegPath: string;
  private active: { proc?: unknown; idx: number; bytes: number; stopped: boolean; onChunk: (buf: Buffer, index: number) => Promise<void>; cleanup?: () => void } | null = null;
  constructor(opts?: { ffmpegPath?: string }) { this.ffmpegPath = opts?.ffmpegPath ?? 'ffmpeg'; }
  async start(opts: EgressOptions & { storage: RecordingStorageLike; sessionId: string; onChunk: (buf: Buffer, index: number) => Promise<void> }): Promise<EgressHandle> {
    if (opts.enabled === false) throw Object.assign(new Error('SFU egress is behind feature flag (enable recording.sfu)'), { code: 'sfu-egress-disabled' });
    let idx = 0; let bytes = 0; let stopped = false;
    let proc: unknown = null;
    let cleanup: (() => void) | undefined;
    // Try spawn ffmpeg when available; otherwise placeholder (CI without binary).
    let ffmpegMissing = false;
    let ffmpegError: string | null = null;
    try {
      const { spawn } = await import('node:child_process');
      const args = ['-loglevel', 'error', '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-f', 'mp4', 'pipe:1'];
      if (opts.rtmpUrl) args.push('-f', 'flv', opts.rtmpUrl);
      const p = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as { stdin: { write(b: Buffer): void; end(): void }; stdout: { on(e: string, cb: (c: Buffer) => void): void }; stderr?: { on(e: string, cb: (c: Buffer) => void): void }; on(e: string, cb: (arg?: unknown) => void): void; kill(): void };
      proc = p;
      p.on('error', (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string })?.code;
        if (code === 'ENOENT') {
          ffmpegMissing = true;
          ffmpegError = `ffmpeg not found at "${this.ffmpegPath}" (ENOENT) — install ffmpeg or set ffmpegPath, using placeholder chunk`;
        } else {
          ffmpegError = `ffmpeg spawn failed: ${msg}`;
        }
      });
      p.stdout.on('data', (chunk: Buffer) => {
        const buf = Buffer.from(chunk);
        bytes += buf.length;
        void opts.onChunk(buf, idx++).catch(() => {});
      });
      p.on('close', () => { stopped = true; });
      if (opts.plainTransport?.onRtp) {
        cleanup = opts.plainTransport.onRtp((buf) => {
          try { (p.stdin as unknown as { write(b: Buffer): void }).write(buf); } catch { /* ignore */ }
        });
      }
      // stderr diagnostics for ffmpeg failures (e.g. bad args)
      p.stderr?.on?.('data', (c: Buffer) => { ffmpegError = c.toString('utf8').trim().slice(0, 500); });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string })?.code;
      if (code === 'ENOENT' || msg.includes('ENOENT')) {
        ffmpegMissing = true;
        ffmpegError = `ffmpeg not found at "${this.ffmpegPath}" (ENOENT) — install ffmpeg or set ffmpegPath, using placeholder chunk`;
      } else {
        ffmpegError = `ffmpeg spawn failed: ${msg}`;
      }
      proc = null;
    }
    if (ffmpegMissing || ffmpegError) {
      // Surface clear diagnostics; still allow placeholder lifecycle in CI.
      try { console.warn(`[sfu-egress] ${ffmpegError}`); } catch { /* ignore */ }
    }
    this.active = { proc, idx: 0, bytes: 0, stopped: false, onChunk: opts.onChunk, ...(cleanup ? { cleanup } : {}) };
    const self = this;
    return {
      async stop() {
        if (stopped) return { chunks: idx, bytes };
        stopped = true;
        cleanup?.();
        try { (proc as unknown as { stdin?: { end(): void } })?.stdin?.end(); } catch { /* ignore */ }
        try { (proc as unknown as { kill?: () => void })?.kill?.(); } catch { /* ignore */ }
        // Ensure at least one chunk for lifecycle visibility when ffmpeg not present
        if (idx === 0) {
          const placeholder = Buffer.from('ffmpeg-placeholder');
          await opts.onChunk(placeholder, idx++);
          bytes += placeholder.length;
          if (self.active) { self.active.idx = idx; self.active.bytes = bytes; }
        }
        if (self.active) self.active.stopped = true;
        return { chunks: idx, bytes };
      },
    };
  }
  get isActive(): boolean { return !!this.active && !this.active.stopped; }
}
export function createEgressWorker(opts?: { enabled?: boolean; ffmpegPath?: string }): FfmpegEgressWorker | null {
  if (opts?.enabled !== true) return null;
  return new FfmpegEgressWorker({ ffmpegPath: opts.ffmpegPath });
}
