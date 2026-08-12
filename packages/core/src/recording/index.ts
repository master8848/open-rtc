/**
 * Recording module (docs/architecture.md D6): hook interfaces, the default
 * MediaRecorder implementation, the composite (local + remote) hook, and the
 * server-upload integration. Zero runtime dependencies.
 */
export * from './recording-hook.ts';
export * from './media-recorder-recording-hook.ts';
export * from './composite-recording-hook.ts';
export * from './recording-uploader.ts';
export * from './room-recording-facade.ts';
