import { useEffect, useState } from 'react';
import type { Room } from '@mbsks/openrtc-core';

/**
 * Active speaker list from `room.on('active-speaker')`.
 */
export function useActiveSpeaker(room: Room): readonly string[] {
  const [speakers, setSpeakers] = useState<readonly string[]>([]);
  useEffect(() => {
    const off = room.on('active-speaker', (ids) => setSpeakers([...ids]));
    return () => { off(); };
  }, [room]);
  return speakers;
}
