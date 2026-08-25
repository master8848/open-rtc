/**
 * vidcall vanilla example — a single-file browser app, no framework.
 *
 * Wires a `Room` (from @mbsks/core) to the sqlite BroadcastChannel backend
 * (from @mbsks/backend-sqlite): open this page in TWO tabs of the same
 * browser, join both, turn the camera on — you get a 1:1 mesh call with no
 * server, no signaling infra, and no build tooling beyond one esbuild step.
 *
 * It also demonstrates:
 *  - mute/camera via `MediaStreamTrack.enabled` toggles (peers keep the
 *    stream, just muted),
 *  - local adaptive-quality monitoring with `AdaptiveQualityController`
 *    (@mbsks/quality) fed from `RTCPeerConnection.getStats()` — every tier
 *    change and warning lands in the event log,
 *  - start-recording wiring: `room.recording.startRecording()` composites the
 *    local + remote streams and emits `recording:blob-chunk` events.
 *
 * Build: `node examples/vanilla/build.mjs` (uses the repo's esbuild), then
 * serve this folder (`npx serve examples/vanilla` or
 * `python3 -m http.server 8000` from `examples/vanilla`).
 */
import { Room, type TrackPublication } from '@mbsks/core';
import type { RTCStatsSnapshot } from '@mbsks/quality';
import { AdaptiveQualityController, DeviceCapability, statsSnapshot } from '@mbsks/quality';
import { SqliteBackend, type SqliteBackendOptions } from '@mbsks/backend-sqlite';
import type { Client } from '@libsql/client';

// ------------------------------------------------------------------- setup

const params = new URLSearchParams(location.search);
const roomId = params.get('room') ?? 'demo-room';
const selfId = params.get('self') ?? `user-${Math.random().toString(36).slice(2, 8)}`;
const displayName = params.get('name') ?? selfId;

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const logEl = $('log') as HTMLDivElement;
const statusEl = $('status') as HTMLDivElement;
const gridEl = $('grid') as HTMLDivElement;
const selfVideo = $('self') as HTMLVideoElement;
const joinBtn = $('join') as HTMLButtonElement;
const cameraBtn = $('camera') as HTMLButtonElement;
const micBtn = $('mic') as HTMLButtonElement;
const recordBtn = $('record') as HTMLButtonElement;
const leaveBtn = $('leave') as HTMLButtonElement;
$('room-name').textContent = roomId;

function log(message: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
  console.log(line);
}

/**
 * In-browser stand-in for the libsql `Client` that keeps the adapter's
 * best-effort signal log in localStorage. The sqlite adapter treats the log
 * as purely durable side-channel — signaling rides the BroadcastChannel and
 * never depends on it. In a Node app you would pass a real client instead:
 * `createClient({ url: 'file:local.db' })` from '@libsql/client'.
 */
function createBrowserLogClient(): Client {
  const append = (entry: unknown): void => {
    try {
      const key = 'vidcall-example:signal-log';
      const log = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[];
      log.push({ at: Date.now(), entry });
      localStorage.setItem(key, JSON.stringify(log.slice(-200)));
    } catch {
      /* best-effort, exactly like the adapter's logIgnore */
    }
  };
  return {
    async execute(sql: string, args?: unknown[]) {
      append({ sql, args });
      return { rows: [] as unknown[] };
    },
    async batch(statements: (string | { sql: string; args?: unknown[] })[]) {
      for (const s of statements) append(s);
      return [];
    },
    async close() {},
  } as unknown as Client;
}

// The BroadcastChannel carries envelopes between tabs of this origin with
// ~ms latency and FIFO ordering — see packages/backend-sqlite.
const backend = new SqliteBackend({
  client: createBrowserLogClient(),
  channelPrefix: 'vidcall-example',
  heartbeatMs: 5000,
  presenceTimeoutMs: 15_000,
} satisfies SqliteBackendOptions);

const room = new Room({
  roomId,
  selfId,
  displayName,
  transport: backend,
  // STUN is only needed when the two peers are on different networks;
  // two tabs on one machine connect via host candidates with no servers.
  // iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  debug: (message, data) => console.debug('[room]', message, data ?? ''),
});

// ------------------------------------------------------------- room events

room.on('participant-joined', (p) => log(`👋 ${p.displayName ?? p.id} joined (${p.id})`));
room.on('participant-left', (p) => log(`🚪 ${p.displayName ?? p.id} left`));
room.on('presence', (p) => log(`presence: ${p.id} → ${p.state}`));
room.on('connection-state', ({ participantId, state }) =>
  log(`peer ${participantId} connection → ${state}`),
);
room.on('quality-warning', (e) =>
  log(`⚠️ quality (remote): ${e.from} → ${e.to} · ${e.reason} · ${e.direction}`),
);
room.on('error', (err) => log(`❌ ${err.message}`));

// Remote media: attach each incoming track to a per-participant <video>.
const remoteVideos = new Map<string, HTMLVideoElement>();
room.on('track', ({ participant, track }) => {
  let video = remoteVideos.get(participant.id);
  if (!video) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    const label = document.createElement('span');
    label.textContent = participant.displayName ?? participant.id;
    tile.append(video, label);
    gridEl.append(tile);
    remoteVideos.set(participant.id, video);
  }
  const stream = (video.srcObject as MediaStream | null) ?? new MediaStream();
  if (!stream.getTracks().includes(track)) stream.addTrack(track);
  video.srcObject = stream;
});

room.on('recording:started', () => {
  recordBtn.textContent = 'Stop recording';
  log('⏺ recording started (compositing local + remote streams)');
});
room.on('recording:stopped', (event) => {
  recordBtn.textContent = 'Start recording';
  log(
    `⏹ recording stopped — ${event.chunkCount} chunks, ${event.bytes} bytes` +
      (event.objectUrl ? ` → ${event.objectUrl}` : ''),
  );
});
room.on('recording:blob-chunk', (chunk) =>
  log(`⏺ chunk ${chunk.index} (${chunk.blob.size} bytes)`),
);
room.on('recording:error', ({ error }) => log(`⏺ recording error: ${error.message}`));

// ------------------------------------------- local adaptive-quality monitor

/**
 * Poll every peer's `getStats()` and feed the pure policy engine from
 * @mbsks/quality. Tier changes/warnings are logged; applying the tier
 * (setParameters / applyConstraints) is the app's job — see
 * packages/quality/README.md.
 */
const quality = new AdaptiveQualityController({
  direction: 'send',
  maxTierId: DeviceCapability.detect().initialTier().id,
});
quality.on('quality:changed', (e) =>
  log(`📉 quality: ${e.from} → ${e.to} · ${e.reason} · ${e.direction}`),
);
quality.on('quality:warning', (e) => log(`⚠️ ${e.level}: ${e.message}`));

function snapshotFor(pc: RTCPeerConnection): Promise<RTCStatsSnapshot> {
  return pc.getStats().then((stats) => {
    let rttMs: number | undefined;
    let availableOutgoingBitrateBps: number | undefined;
    let qualityLimitationReason: RTCStatsSnapshot['qualityLimitationReason'];
    let lossRate: number | undefined;
    let sentPackets = 0;
    let lostPackets = 0;
    stats.forEach((report) => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        if (typeof report.currentRoundTripTime === 'number')
          rttMs = report.currentRoundTripTime * 1000;
        if (typeof report.availableOutgoingBitrate === 'number')
          availableOutgoingBitrateBps = report.availableOutgoingBitrate;
      }
      if (report.type === 'outbound-rtp') {
        if (typeof report.qualityLimitationReason === 'string')
          qualityLimitationReason =
            report.qualityLimitationReason as RTCStatsSnapshot['qualityLimitationReason'];
        if (typeof report.packetsSent === 'number') sentPackets = report.packetsSent;
      }
      if (report.type === 'inbound-rtp') {
        if (typeof report.packetsLost === 'number') lostPackets = report.packetsLost;
      }
    });
    if (sentPackets + lostPackets > 0) lossRate = lostPackets / (sentPackets + lostPackets);
    return statsSnapshot({
      ts: Date.now(),
      direction: 'send',
      rttMs,
      availableOutgoingBitrateBps,
      lossRate,
      qualityLimitationReason,
    });
  });
}

setInterval(() => {
  for (const participant of room.getParticipants()) {
    const pc = room.getPeerConnection(participant.id);
    if (!pc) continue;
    snapshotFor(pc)
      .then((snapshot) => quality.tick(snapshot))
      .catch(() => {});
  }
}, 2000);

// ------------------------------------------------------------------- media

let localStream: MediaStream | null = null;
let cameraPublication: TrackPublication | null = null;
let micMuted = false;

async function toggleCamera(): Promise<void> {
  if (cameraPublication) {
    await room.unpublish(cameraPublication);
    cameraPublication = null;
    selfVideo.srcObject = null;
    cameraBtn.textContent = 'Camera on';
    micBtn.disabled = true;
    log('📷 camera unpublished');
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  localStream = stream;
  selfVideo.srcObject = stream;
  cameraPublication = await room.publish(stream.getVideoTracks()[0]!, {
    source: 'camera',
  });
  micBtn.disabled = false;
  cameraBtn.textContent = 'Camera off';
  log('📷 camera published');
}

function toggleMic(): void {
  if (!localStream) return;
  micMuted = !micMuted;
  for (const track of localStream.getAudioTracks()) track.enabled = !micMuted;
  micBtn.textContent = micMuted ? 'Mic unmute' : 'Mic muted';
  log(micMuted ? '🎙 mic muted (track still published)' : '🎙 mic unmuted');
}

async function toggleRecording(): Promise<void> {
  if (room.recording.getState() === 'recording') {
    await room.recording.stopRecording();
    return;
  }
  const remoteStreams = [...remoteVideos.entries()].flatMap(([participantId, video]) => {
    const stream = video.srcObject as MediaStream | null;
    return stream ? [{ participantId, stream }] : [];
  });
  await room.recording.startRecording({
    localStream: localStream ?? undefined,
    remoteStreams,
    createObjectUrl: true,
    timesliceMs: 1000,
  });
}

// --------------------------------------------------------------- lifecycle

joinBtn.addEventListener('click', async () => {
  joinBtn.disabled = true;
  try {
    await room.join();
    statusEl.textContent = `Joined ${roomId} as ${displayName} (${selfId}) — open a second tab to call it.`;
    cameraBtn.disabled = false;
    leaveBtn.disabled = false;
    recordBtn.disabled = false;
    log(`✅ joined room "${roomId}" as ${displayName}`);
  } catch (err) {
    log(`❌ join failed: ${err instanceof Error ? err.message : String(err)}`);
    joinBtn.disabled = false;
  }
});

cameraBtn.addEventListener('click', () => {
  toggleCamera().catch((err) => log(`❌ camera: ${err.message}`));
});
micBtn.addEventListener('click', toggleMic);
recordBtn.addEventListener('click', () => {
  toggleRecording().catch((err) => log(`❌ recording: ${err.message}`));
});
leaveBtn.addEventListener('click', async () => {
  await room.leave();
  statusEl.textContent = 'Left the room.';
  cameraBtn.disabled = micBtn.disabled = recordBtn.disabled = leaveBtn.disabled = true;
  joinBtn.disabled = false;
  log('👋 left the room');
});

// Join automatically so a fresh tab is immediately in the room (a second
// tab = the other end of the call).
void joinBtn.click();
