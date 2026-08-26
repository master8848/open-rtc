import { useEffect, useState } from 'react';
import type { Room, RoomTranscriptEvent } from '@mbsks/openrtc-core';

/**
 * Live transcript feed from `room.on('transcript')`.
 * Returns the ordered list of received transcripts.
 */
export function useTranscription(room: Room): readonly RoomTranscriptEvent[] {
  const [events, setEvents] = useState<readonly RoomTranscriptEvent[]>([]);
  useEffect(() => {
    const off = room.on('transcript', (e) => {
      setEvents((prev) => [...prev, e]);
    });
    return () => { off(); };
  }, [room]);
  return events;
}

/**
 * Latest transcript event or undefined.
 */
export function useLatestTranscript(room: Room): RoomTranscriptEvent | undefined {
  const all = useTranscription(room);
  return all[all.length - 1];
}
