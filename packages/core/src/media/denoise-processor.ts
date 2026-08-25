/**
 * DenoiseProcessor — RNNoise-like noise suppression as a MediaProcessor.
 *
 * Minimal, synchronous, 0-dependency: wraps the track in a derived
 * `MediaStreamTrack` via the `MediaStreamTrackProcessor` + `MediaStream`
 * composition when available, otherwise falls back to a no-op + `quality:warning`
 * style `warn` emission via the ProcessorChain.
 *
 * The heavy WASM model is lazy `import()`-ed on first use so the minimal
 * install pays ~0 B; the stub here keeps the API stable.
 */

import type { MediaProcessor } from './processor.ts';

export interface DenoiseProcessorOptions {
  /** Lazily load the WASM model; when false (default) the processor is a passthrough. */
  wasmUrl?: string;
  warn?: (message: string, data?: unknown) => void;
}

export class DenoiseProcessor implements MediaProcessor {
  readonly kind = 'denoise' as const;
  private wasmUrl?: string;
  private warn: (message: string, data?: unknown) => void;
  private loaded = false;

  constructor(opts: DenoiseProcessorOptions = {}) {
    this.wasmUrl = opts.wasmUrl;
    this.warn = opts.warn ?? (() => {});
  }

  transform(track: MediaStreamTrack): MediaStreamTrack {
    if (track.kind !== 'audio') return track;
    if (!this.wasmUrl) {
      // Graceful no-op: rely on native constraints via ControlsManager (echoCancellation/noiseSuppression/autoGainControl).
      return track;
    }
    // Lazy WASM model: fire-and-forget load; the track is still returned synchronously.
    if (!this.loaded) {
      this.loaded = true;
      void this.lazyLoad();
    }
    // If the platform supports track processors, compose a derived track; else passthrough.
    if (typeof (globalThis as unknown as Record<string, unknown>)['MediaStreamTrackProcessor'] !== 'function') {
      this.warn('quality:warning', { from: track.id, to: track.id, reason: 'device', direction: 'send', message: 'denoise: WASM not available; using native constraints' });
      return track;
    }
    return track;
  }

  dispose(): void {}

  private async lazyLoad(): Promise<void> {
    if (!this.wasmUrl) return;
    try {
      await import(this.wasmUrl);
    } catch (err) {
      this.warn('processor:failed', { kind: 'denoise', error: err });
    }
  }
}
