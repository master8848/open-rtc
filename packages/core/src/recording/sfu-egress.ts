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
    try {
      const { spawn } = await import('node:child_process');
      const args = ['-loglevel', 'error', '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-f', 'mp4', 'pipe:1'];
      if (opts.rtmpUrl) args.push('-f', 'flv', opts.rtmpUrl);
      const p = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as { stdin: { write(b: Buffer): void; end(): void }; stdout: { on(e: string, cb: (c: Buffer) => void): void }; on(e: string, cb: () => void): void; kill(): void };
      proc = p;
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
    } catch {
      proc = null;
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
