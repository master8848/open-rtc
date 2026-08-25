export type MediaProcessorKind = 'e2ee' | 'denoise' | 'background' | 'custom';

export interface MediaProcessor {
  kind: MediaProcessorKind;
  transform(track: MediaStreamTrack): MediaStreamTrack;
  dispose?(): void;
}

const ORDER: Record<MediaProcessorKind, number> = {
  denoise: 0,
  background: 1,
  custom: 2,
  e2ee: 3,
};

function orderOf(kind: MediaProcessorKind): number {
  return ORDER[kind] ?? ORDER.custom;
}

export class ProcessorChain {
  private readonly processors: MediaProcessor[] = [];
  private readonly warn: (message: string, data?: unknown) => void;

  constructor(opts: { warn?: (message: string, data?: unknown) => void } = {}) {
    this.warn = opts.warn ?? (() => {});
  }

  add(processor: MediaProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => orderOf(a.kind) - orderOf(b.kind));
    if (processor.kind === 'e2ee' && typeof globalThis !== 'undefined') {
      const g = globalThis as unknown as Record<string, unknown>;
      const hasWorker = typeof (g['RTCRtpScriptTransform'] as unknown) === 'function';
      const hasInsertable =
        typeof TransformStream === 'function' &&
        ((typeof RTCRtpSender !== 'undefined' &&
          typeof (RTCRtpSender.prototype as unknown as Record<string, unknown>).createEncodedStreams === 'function') ||
          typeof (g['MediaStreamTrackProcessor'] as unknown) === 'function');
      if (!hasWorker && !hasInsertable) {
        this.warn('e2ee:unsupported', 'E2EE transform not available; Safari fallback no-op');
      }
    }
  }

  remove(processor: MediaProcessor): boolean {
    const i = this.processors.indexOf(processor);
    if (i < 0) return false;
    this.processors.splice(i, 1);
    processor.dispose?.();
    return true;
  }

  process(track: MediaStreamTrack): MediaStreamTrack {
    let t: MediaStreamTrack = track;
    for (const p of this.processors) {
      try {
        const out = p.transform(t);
        if (out) t = out;
      } catch (err) {
        this.warn('processor:failed', { kind: p.kind, error: err });
      }
    }
    return t;
  }

  get list(): readonly MediaProcessor[] {
    return this.processors;
  }

  dispose(): void {
    for (const p of this.processors) p.dispose?.();
    this.processors.length = 0;
  }
}
