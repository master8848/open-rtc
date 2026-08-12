/**
 * vidcall React example — `Room` wired to the Supabase backend.
 *
 * The vidcall packages are consumed through the monorepo workspace (file:
 * deps in package.json), exactly the "unpublished" install path from the root
 * README. Everything vidcall does is reflected in React state:
 *
 *  - join/leave lifecycle,
 *  - mute/camera toggles (`MediaStreamTrack.enabled`, the track stays
 *    published so peers keep a black/silent stream),
 *  - `quality-warning` events (tier changes + warnings from the wire) shown
 *    as a list,
 *  - remote tracks attached to per-participant <video> elements.
 *
 * Run: cp .env.example .env (fill Supabase URL + anon key), then
 * `npm install && npm run dev` in this folder.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Room, type RemoteParticipant, type TrackPublication } from '@vidcall/core';
import { SupabaseBackend } from '@vidcall/backend-supabase';

interface QualityEvent {
  id: number;
  from: string;
  to: string;
  reason: string;
  direction: string;
  at: string;
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const hasSupabase = Boolean(url && anonKey);

let nextQualityId = 0;

export function App(): JSX.Element {
  const roomRef = useRef<Room | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const cameraPubRef = useRef<TrackPublication | null>(null);
  const remoteVideosRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const selfVideoRef = useRef<HTMLVideoElement | null>(null);

  const [joined, setJoined] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [participants, setParticipants] = useState<RemoteParticipant[]>([]);
  const [qualityEvents, setQualityEvents] = useState<QualityEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const pushQualityEvent = useCallback(
    (from: string, to: string, reason: string, direction: string) => {
      setQualityEvents((prev) =>
        [
          { id: nextQualityId++, from, to, reason, direction, at: new Date().toLocaleTimeString() },
          ...prev,
        ].slice(0, 20),
      );
    },
    [],
  );

  // Create the Room once (per peer id) and wire all events.
  useEffect(() => {
    if (!hasSupabase) {
      setError('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in examples/react/.env');
      return;
    }
    const supabase = createClient(url!, anonKey!);
    const backend = new SupabaseBackend({ client: supabase });
    const selfId = `user-${Math.random().toString(36).slice(2, 8)}`;
    const room = new Room({
      roomId: new URLSearchParams(location.search).get('room') ?? 'demo-room',
      selfId,
      displayName: `Guest-${selfId.slice(-4)}`,
      transport: backend,
    });
    roomRef.current = room;

    room.on('participant-joined', (p) => setParticipants(room.getParticipants()));
    room.on('participant-left', () => setParticipants(room.getParticipants()));
    room.on('track', ({ participant, track }) => {
      const video = remoteVideosRef.current.get(participant.id);
      if (!video) return; // the tile renders on participant-joined; stream fills in below
      const stream = (video.srcObject as MediaStream | null) ?? new MediaStream();
      if (!stream.getTracks().includes(track)) stream.addTrack(track);
      video.srcObject = stream;
    });
    room.on('quality-warning', (e) => pushQualityEvent(e.from, e.to, e.reason, e.direction));
    room.on('error', (err) => setError(err.message));

    room
      .join()
      .then(() => setJoined(true))
      .catch((err) => setError(err.message));
    return () => {
      void room.leave();
      roomRef.current = null;
    };
  }, [pushQualityEvent]);

  const toggleCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    if (cameraPubRef.current) {
      await room.unpublish(cameraPubRef.current);
      cameraPubRef.current = null;
      if (selfVideoRef.current) selfVideoRef.current.srcObject = null;
      setCameraOn(false);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStreamRef.current = stream;
    if (selfVideoRef.current) selfVideoRef.current.srcObject = stream;
    cameraPubRef.current = await room.publish(stream.getVideoTracks()[0]!, {
      source: 'camera',
    });
    setCameraOn(true);
  }, []);

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    setMicMuted((muted) => {
      const next = !muted;
      for (const track of stream.getAudioTracks()) track.enabled = !next;
      return next;
    });
  }, []);

  const leave = useCallback(async () => {
    await roomRef.current?.leave();
    setJoined(false);
  }, []);

  const videoRefFor = (participant: RemoteParticipant) => (el: HTMLVideoElement | null) => {
    if (el) remoteVideosRef.current.set(participant.id, el);
    else remoteVideosRef.current.delete(participant.id);
  };

  return (
    <main style={{ maxWidth: 900, margin: '2rem auto', fontFamily: 'system-ui, sans-serif' }}>
      <h1>vidcall · React example</h1>
      {!hasSupabase && <p style={{ color: '#b00' }}>{error}</p>}
      <p>
        Room: <code>demo-room</code> — open this app in two browser tabs (or two devices) with the
        same Supabase project to make a call.
      </p>
      <div style={{ marginBottom: '0.5rem' }}>
        <button onClick={() => void roomRef.current?.join()} disabled={joined}>
          Join
        </button>
        <button onClick={() => void toggleCamera()} disabled={!joined}>
          {cameraOn ? 'Camera off' : 'Camera on'}
        </button>
        <button onClick={toggleMic} disabled={!joined}>
          {micMuted ? 'Unmute' : 'Mute'}
        </button>
        <button onClick={() => void leave()} disabled={!joined}>
          Leave
        </button>
      </div>
      {error && joined && <p style={{ color: '#b00' }}>{error}</p>}

      <section style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', margin: '1rem 0' }}>
        <video ref={selfVideoRef} autoPlay playsInline muted style={videoStyle} />
        {participants.map((p) => (
          <video key={p.id} ref={videoRefFor(p)} autoPlay playsInline style={videoStyle} />
        ))}
      </section>

      <h2>Quality events</h2>
      <ul>
        {qualityEvents.length === 0 && (
          <li>No quality changes yet — quality warnings from the wire land here.</li>
        )}
        {qualityEvents.map((e) => (
          <li key={e.id}>
            {e.at} · {e.from} → {e.to} · {e.reason} · {e.direction}
          </li>
        ))}
      </ul>

      <h2>Participants ({participants.length})</h2>
      <ul>
        {participants.map((p) => (
          <li key={p.id}>
            {p.displayName ?? p.id} — {p.presence} ({p.connectionState})
          </li>
        ))}
      </ul>
    </main>
  );
}

const videoStyle: CSSProperties = {
  width: 200,
  aspectRatio: '16 / 9',
  background: '#000',
  borderRadius: 8,
};
