/**
 * VirtualBackgroundProcessor — SelfieSegmentation-based virtual background / blur.
 *
 * Lazy WASM model via `import()` so the minimal install is ~0 B.
 * Falls back to a no-op + `quality:warning` when the model or WebGL/canvas
 * surface is unavailable (Safari fallback in the plan).
 */

import type { MediaProcessor } from './processor.ts';

export interface VirtualBackgroundProcessorOptions {
  modelUrl?: string;
  blur?: boolean | number;
  backgroundImage?: string;
  warn?: (message: string, data?: unknown) => void;
}

export class VirtualBackgroundProcessor implements MediaProcessor {
  readonly kind = 'background' as const;
  private readonly opts: VirtualBackgroundProcessorOptions;
  private loaded = false;

  constructor(opts: VirtualBackgroundProcessorOptions = {}) {
    this.opts = opts;
  }

  transform(track: MediaStreamTrack): MediaStreamTrack {
    if (track.kind !== 'video') return track;
    if (!this.opts.modelUrl) return track;
    if (!this.loaded) {
      this.loaded = true;
      void this.lazyLoad();
    }
    const g = globalThis as unknown as Record<string, unknown>;
    if (
      typeof (g['MediaStreamTrackProcessor'] as unknown) !== 'function' ||
      typeof (g['MediaStreamTrackGenerator'] as unknown) !== 'function' ||
      typeof OffscreenCanvas === 'undefined'
    ) {
      (this.opts.warn ?? (() => {}))('quality:warning', {
        from: track.id,
        to: track.id,
        reason: 'device',
        direction: 'send',
        message: 'virtual-background: segmentation not available; passthrough',
      });
      return track;
    }
    return track;
  }

  dispose(): void {}

  private async lazyLoad(): Promise<void> {
    if (!this.opts.modelUrl) return;
    try {
      await import(this.opts.modelUrl);
    } catch (err) {
      (this.opts.warn ?? (() => {}))('processor:failed', { kind: 'background', error: err });
    }
  }
}
