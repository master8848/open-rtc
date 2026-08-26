/**
 * @mbsks/openrtc-react — React bindings over the @mbsks/openrtc-core snapshot layer.
 *
 * Thin `useSyncExternalStore` adapters: all caching and equality checks live
 * in core (`Room.getSnapshot()` / `Room.subscribe()`); these hooks never
 * build state themselves, so referential stability is guaranteed by the
 * engine, not the adapter.
 */
export { useRoomState, useParticipants, useParticipant } from './use-room-state.ts';
export { useJoin, type UseJoinOptions } from './use-join.ts';
export { useRecording } from './use-recording.ts';
export { useTranscription, useLatestTranscript } from './use-transcription.ts';
export { useQuality, type UseQualityReturn } from './use-quality.ts';
export { useDevices, type UseDevicesReturn } from './use-devices.ts';
export { useActiveSpeaker } from './use-active-speaker.ts';
export { useConnectionState } from './use-connection-state.ts';
export { useRemoteTrack, useRemoteTracks } from './use-remote-track.ts';
export { createRoomHook, type CreateRoomHookOptions, type RoomHookReturn } from './create-room-hook.ts';
