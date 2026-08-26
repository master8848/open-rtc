import { useEffect, useState, useCallback } from 'react';
import type { Room } from '@mbsks/openrtc-core';
import type { RecordingChunk, RecordingState } from '@mbsks/openrtc-core';

/**
 * Recording state over `room.recording` + `recording-*` events.
 * Kept in the React layer so core stays zero-dep.
 */
export function useRecording(room: Room): {
  state: RecordingState;
  status: 'idle' | 'recording' | 'finalizing';
  chunks: readonly RecordingChunk[];
  start: typeof room.recording.startRecording;
  stop: typeof room.recording.stopRecording;
} {
  const [state, setState] = useState<RecordingState>(() => room.recording.getState());
  const [status, setStatus] = useState(() => room.recording.getStatus());
  const [chunks, setChunks] = useState<RecordingChunk[]>([]);

  const refresh = useCallback(() => {
    setState(room.recording.getState());
    setStatus(room.recording.getStatus());
  }, [room]);

  useEffect(() => {
    const offStarted = room.on('recording-started' as never, refresh as never);
    const offStopped = room.on('recording-stopped' as never, () => {
      refresh();
    });
    const offError = room.on('recording-error' as never, refresh as never);
    const offChunk = room.on('recording-blob-chunk' as never, ((c: RecordingChunk) => {
      setChunks((prev) => [...prev, c]);
    }) as never);
    // Also refresh on alias colon events for compat (Room canonicalizes, but keep both)
    const offStartedAlias = room.on('recording:started' as never, refresh as never);
    const offStoppedAlias = room.on('recording:stopped' as never, refresh as never);
    return () => {
      offStarted(); offStopped(); offError(); offChunk(); offStartedAlias(); offStoppedAlias();
    };
  }, [room, refresh]);

  return {
    state,
    status,
    chunks,
    start: room.recording.startRecording.bind(room.recording),
    stop: room.recording.stopRecording.bind(room.recording),
  };
}
