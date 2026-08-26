import { useEffect, useState } from 'react';
import type { Room } from '@mbsks/openrtc-core';

/**
 * Aggregate connection state for one peer.
 * Falls back to the snapshot's connectionState so initial render is correct.
 */
export function useConnectionState(room: Room, participantId: string): RTCPeerConnectionState | 'new' {
  const initial = room.getParticipant(participantId)?.connectionState ?? room.getSnapshot().participants.find((p) => p.id === participantId)?.connectionState ?? 'new';
  const [state, setState] = useState<RTCPeerConnectionState | 'new'>(initial as RTCPeerConnectionState | 'new');

  useEffect(() => {
    // Keep in sync if participant appears.
    const snap = room.getSnapshot().participants.find((p) => p.id === participantId);
    if (snap) setState(snap.connectionState as RTCPeerConnectionState | 'new');
    const off = room.on('connection-state', (e) => {
      if (e.participantId === participantId) setState(e.state);
    });
    // Also watch snapshot for connectionState changes (store path).
    const offStore = room.store.subscribe(() => {
      const p = room.getSnapshot().participants.find((pp) => pp.id === participantId);
      if (p) setState(p.connectionState as RTCPeerConnectionState | 'new');
    });
    return () => { off(); offStore(); };
  }, [room, participantId]);

  return state;
}
