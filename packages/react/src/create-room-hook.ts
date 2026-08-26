/**
 * createRoomHook — TanStack createFormHook analogue for app-wide defaults.
 *
 * ```ts
 * const { RoomProvider, useRoom, useRoomState, useParticipants } = createRoomHook({ publishDefaults: { simulcast: true } });
 *
 * function App() {
 *   const room = useMemo(() => new Room({ roomId, selfId, transport, publishDefaults }), []);
 *   return (
 *     <RoomProvider room={room}>
 *       <Call />
 *     </RoomProvider>
 *   );
 * }
 *
 * function Call() {
 *   const participants = useParticipants(); // no room arg — from context
 *   const status = useRoomState((s) => s.status); // selector for perf
 * }
 * ```
 *
 * When a `room` is passed explicitly to the returned hooks, the context is
 * not used — the hooks remain compatible with the direct `useRoomState(room)`
 * API.
 */

import { createContext, createElement, useContext, type ReactNode } from 'react';
import { Room } from '@mbsks/openrtc-core';
import type { RoomConfig, RoomSnapshot } from '@mbsks/openrtc-core';
import { useRoomState as useRoomStateCore } from './use-room-state.ts';
import { useParticipants as useParticipantsCore, useParticipant as useParticipantCore } from './use-room-state.ts';
import { useActiveSpeaker } from './use-active-speaker.ts';
import { useConnectionState } from './use-connection-state.ts';
import { useRemoteTrack, useRemoteTracks } from './use-remote-track.ts';
import { useDevices } from './use-devices.ts';
import { useQuality } from './use-quality.ts';
import { useRecording } from './use-recording.ts';
import { useTranscription } from './use-transcription.ts';

export interface CreateRoomHookOptions {
  /** Default publish options injected when `createRoom` is used (optional). */
  publishDefaults?: RoomConfig['publishDefaults'];
  /** Optional defaults merged into `new Room(config)` via `createRoom`. */
  defaults?: Partial<RoomConfig>;
}

export interface RoomHookReturn {
  RoomContext: React.Context<Room | null>;
  RoomProvider: (props: { room: Room; children: ReactNode }) => ReactNode;
  useRoom: () => Room;
  /** Create a Room merging factory defaults (app-wide publishDefaults etc). */
  createRoom: (config: RoomConfig) => Room;
  useRoomState: {
    (room: Room): RoomSnapshot;
    <T>(room: Room, selector: (s: RoomSnapshot) => T): T;
    (): RoomSnapshot;
    <T>(selector: (s: RoomSnapshot) => T): T;
  };
  useParticipants: (room?: Room) => ReturnType<typeof useParticipantsCore>;
  useParticipant: (id: string, room?: Room) => ReturnType<typeof useParticipantCore>;
  useActiveSpeaker: (room?: Room) => ReturnType<typeof useActiveSpeaker>;
  useConnectionState: (participantId: string, room?: Room) => ReturnType<typeof useConnectionState>;
  useRemoteTrack: (participantId: string, kind?: 'audio' | 'video', room?: Room) => ReturnType<typeof useRemoteTrack>;
  useRemoteTracks: (participantId: string, kind?: 'audio' | 'video', room?: Room) => ReturnType<typeof useRemoteTracks>;
  useDevices: (room?: Room) => ReturnType<typeof useDevices>;
  useQuality: (room?: Room) => ReturnType<typeof useQuality>;
  useRecording: (room?: Room) => ReturnType<typeof useRecording>;
  useTranscription: (room?: Room) => ReturnType<typeof useTranscription>;
}

export function createRoomHook(options: CreateRoomHookOptions = {}): RoomHookReturn {
  const RoomContext = createContext<Room | null>(null);

  function RoomProvider({ room, children }: { room: Room; children: ReactNode }): ReactNode {
    return createElement(RoomContext.Provider, { value: room }, children);
  }

  function useRoom(): Room {
    const ctx = useContext(RoomContext);
    if (!ctx) throw new Error('createRoomHook: useRoom() must be used within <RoomProvider>');
    return ctx;
  }

  function createRoom(config: RoomConfig): Room {
    // Merge factory defaults (publishDefaults etc) — explicit config wins.
    const merged: RoomConfig = {
      ...options.defaults,
      ...config,
      publishDefaults: { ...(options.defaults?.publishDefaults ?? {}), ...(options.publishDefaults ?? {}), ...(config.publishDefaults ?? {}) },
    };
    return new Room(merged);
  }

  // Overloaded useRoomState that supports (room, selector), (selector), (room), ()
  function useRoomState(): RoomSnapshot;
  function useRoomState<T>(selector: (s: RoomSnapshot) => T): T;
  function useRoomState(room: Room): RoomSnapshot;
  function useRoomState<T>(room: Room, selector: (s: RoomSnapshot) => T): T;
  function useRoomState<T>(roomOrSelector?: Room | ((s: RoomSnapshot) => T), maybeSelector?: (s: RoomSnapshot) => T): RoomSnapshot | T {
    let room: Room | null = null;
    let selector: ((s: RoomSnapshot) => T) | undefined;
    if (typeof roomOrSelector === 'function') {
      selector = roomOrSelector as (s: RoomSnapshot) => T;
      room = useRoom();
    } else if (roomOrSelector && typeof (roomOrSelector as Room).getSnapshot === 'function') {
      room = roomOrSelector as Room;
      selector = maybeSelector;
    } else if (roomOrSelector === undefined && maybeSelector === undefined) {
      room = useRoom();
    } else if (roomOrSelector === undefined) {
      room = useRoom();
      selector = maybeSelector;
    }
    // At this point room is non-null
    const r = room as Room;
    if (selector) return useRoomStateCore(r, selector) as T;
    return useRoomStateCore(r) as unknown as RoomSnapshot;
  }

  function useParticipants(room?: Room) {
    const r = room ?? useRoom();
    return useParticipantsCore(r);
  }
  function useParticipant(id: string, room?: Room) {
    const r = room ?? useRoom();
    return useParticipantCore(r, id);
  }
  function useActiveSpeakerCtx(room?: Room) {
    const r = room ?? useRoom();
    return useActiveSpeaker(r);
  }
  function useConnectionStateCtx(participantId: string, room?: Room) {
    const r = room ?? useRoom();
    return useConnectionState(r, participantId);
  }
  function useRemoteTrackCtx(participantId: string, kind?: 'audio' | 'video', room?: Room) {
    const r = room ?? useRoom();
    return useRemoteTrack(r, participantId, kind);
  }
  function useRemoteTracksCtx(participantId: string, kind?: 'audio' | 'video', room?: Room) {
    const r = room ?? useRoom();
    return useRemoteTracks(r, participantId, kind);
  }
  function useDevicesCtx(room?: Room) {
    const r = room ?? useRoom();
    return useDevices(r);
  }
  function useQualityCtx(room?: Room) {
    const r = room ?? useRoom();
    return useQuality(r);
  }
  function useRecordingCtx(room?: Room) {
    const r = room ?? useRoom();
    return useRecording(r);
  }
  function useTranscriptionCtx(room?: Room) {
    const r = room ?? useRoom();
    return useTranscription(r);
  }

  return {
    RoomContext,
    RoomProvider: RoomProvider as unknown as (props: { room: Room; children: ReactNode }) => ReactNode,
    useRoom,
    createRoom,
    useRoomState: useRoomState as unknown as RoomHookReturn['useRoomState'],
    useParticipants: useParticipants as unknown as RoomHookReturn['useParticipants'],
    useParticipant: useParticipant as unknown as RoomHookReturn['useParticipant'],
    useActiveSpeaker: useActiveSpeakerCtx as unknown as RoomHookReturn['useActiveSpeaker'],
    useConnectionState: useConnectionStateCtx as unknown as RoomHookReturn['useConnectionState'],
    useRemoteTrack: useRemoteTrackCtx as unknown as RoomHookReturn['useRemoteTrack'],
    useRemoteTracks: useRemoteTracksCtx as unknown as RoomHookReturn['useRemoteTracks'],
    useDevices: useDevicesCtx as unknown as RoomHookReturn['useDevices'],
    useQuality: useQualityCtx as unknown as RoomHookReturn['useQuality'],
    useRecording: useRecordingCtx as unknown as RoomHookReturn['useRecording'],
    useTranscription: useTranscriptionCtx as unknown as RoomHookReturn['useTranscription'],
  };
}
