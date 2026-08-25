/**
 * Local media controls module (docs/features/controls.md).
 *
 * `ControlsManager` is the "Zoom-clone" control surface for the local
 * participant: mic mute/unmute, camera on/off, screen share, raise hand,
 * reactions, and device selection. It is attached to a `Room` as
 * `room.controls` (wired by `@mbsks/core`'s index). Zero runtime
 * dependencies — everything media-related is injected via
 * `ControlsMediaProvider` so it is fully testable in Node.
 */
export * from './ControlsManager.ts';
