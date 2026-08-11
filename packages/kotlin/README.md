# vidcall — Kotlin / Android binding

Kotlin (JVM + Android) client for the **vidcall** signaling protocol
(`protocol/schema.json` is the wire contract). One versioned JSON envelope,
shared by the JS / Kotlin / Swift / Dart bindings, carried over any pluggable
backend (WebSocket, REST relay, Supabase/Convex/Firebase pub/sub, ...).

| Module | Artifact (`io.vidcall`) | Type | What it provides |
|---|---|---|---|
| `vidcall-protocol` | `vidcall-protocol` | JVM jar | Data classes mirroring `schema.json` (Envelope + payloads), shared JSON codec, sample envelopes |
| `vidcall-client` | `vidcall-client` | JVM jar | `VidcallClient`: backend-agnostic signaling, WebSocket + REST transports, typed event callbacks, join/leave/reaction/chat/screenShare/presence |
| `vidcall-android` | `vidcall-android` | AAR | WebRTC wiring (`org.webrtc` via pinned `io.getstream:stream-webrtc-android`): peer connections, offer/answer/ICE exchange wired to `VidcallClient`, camera/screen media helpers |

The JVM modules can be used standalone for signaling-only features (chat,
reactions, presence) or server-side relays; the Android module adds the full
mesh video call.

---

## Requirements

- JDK 17+ (build tested with Temurin 21)
- Gradle 8.14.5 (wrapper included) — or any Gradle ≥ 8.13
- Android SDK with `platforms;android-36` and `build-tools;36.x` (Android module only)
- Android `minSdk 21` (matching the pinned WebRTC artifact; lint-clean)

## Adding to your project

All artifacts publish to Maven Central under `io.vidcall` (see
[Publishing](#publishing-to-maven-central)). Until the first release, depend
on the modules via git or `mavenLocal()`:

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
```

```kotlin
// build.gradle.kts
dependencies {
    implementation("io.vidcall:vidcall-android:0.1.0") // brings protocol + client transitively
    // or, signaling only:
    // implementation("io.vidcall:vidcall-client:0.1.0")
}
```

## Quick start — signaling only (chat / reactions / presence)

```kotlin
val transport = WebSocketTransport(
    baseUrl = "wss://signaling.example.com/ws", // relay URL (see "Transports")
    roomId = "room-42",
    sessionId = "sess-<uuid>",
)
val client = VidcallClient(
    config = VidcallConfig(roomId = "room-42", clientId = "user-ada", sessionId = "sess-<uuid>"),
    transport = transport,
    listener = object : VidcallEventListener {
        override fun onChat(senderId: String, payload: ChatPayload, envelope: Envelope) {
            println("$senderId: ${payload.text}")
        }
        override fun onReaction(senderId: String, payload: ReactionPayload, envelope: Envelope) {
            println("$senderId reacted ${payload.emoji}")
        }
    },
)

client.connect()
client.join(displayName = "Ada")
client.sendChat("hello room!")
client.sendReaction("\uD83D\uDE00", targetSenderId = "user-bob")
client.sendPresence(PresenceState.BUSY)
// ...
client.leave(reason = "bye")
client.disconnect()
```

## Full mesh video call (Android)

```kotlin
val transport = WebSocketTransport("wss://signaling.example.com/ws", roomId, sessionId)
val rtc = VidcallRtcClient(
    context = applicationContext,
    roomId = roomId,
    clientId = "user-ada",
    sessionId = "sess-<uuid>",
    transport = transport,
    rtcConfig = RtcConfig(
        iceServers = listOf(
            IceServerConfig(listOf("stun:stun.l.google.com:19302")),
            IceServerConfig(listOf("turn:turn.example.com:3478"), username = "u", credential = "p"),
        ),
    ),
    listener = object : VidcallRtcListener {
        override fun onPeerJoined(peerId: String) = log("peer joined: $peerId")
        override fun onRemoteVideoTrack(peerId: String, track: VideoTrack) { /* attach to SurfaceViewRenderer */ }
        override fun onRemoteAudioTrack(peerId: String, track: AudioTrack) { /* play out */ }
        override fun onIceConnectionState(peerId: String, state: PeerConnection.IceConnectionState) = Unit
    },
)

// local mic + camera (needs app-side CAMERA/RECORD_AUDIO runtime permissions)
rtc.setLocalMedia(rtc.createLocalMedia(audioEnabled = true, videoEnabled = true))

rtc.connect(displayName = "Ada")

// screen sharing (capturer is app-owned, e.g. MediaProjection):
val source = WebRtcFactory.createScreenVideoSource(rtc.peerConnectionFactory)
val track = WebRtcFactory.createScreenTrack(rtc.peerConnectionFactory, source)
WebRtcFactory.attachCapturer(context, source, myScreenCapturer)
rtc.startScreenShare(track, label = "screen")
// later:
rtc.stopScreenShare()
```

### Mesh wiring & glare

- One `PeerConnection` per remote client, created when a remote `join` envelope
  arrives (or on the first `offer`/`ice` from an unknown peer).
- **Deterministic initiator**: the client with the lexicographically smaller
  `senderId` creates the first offer; the other side is polite and answers
  ([`shouldInitiate`](vidcall-android/src/main/kotlin/io/vidcall/android/Mapping.kt)).
- Perfect negotiation: on simultaneous offers the polite side rolls back its
  local offer and accepts the remote one.
- Trickle ICE: candidates received before the remote description are queued and
  applied once the description lands.

## Transports (backend-agnostic)

`SignalingTransport` implementations ship with `vidcall-client`; the envelope
JSON is always the raw wire format (the contract). Any backend that can route
JSON frames can implement `SignalingTransport` (Supabase/Convex/Firebase/
Appwrite adapters are app-side or future modules).

**WebSocket** — frames are bare envelope JSON. Relay URL convention:

```
wss://<base>/ws?room=<roomId>&session=<sessionId>            # broadcast (room channel)
wss://<base>/ws?room=<roomId>&session=<sessionId>&to=<target> # unicast (per-peer channel)
```

**REST relay** — documented mapping for relays without WebSocket:

```
POST {base}/v1/rooms/{roomId}/messages                # broadcast
POST {base}/v1/rooms/{roomId}/messages/{target}       # unicast to a session
GET  {base}/v1/rooms/{roomId}/messages?afterSeq=<n>   # poll; {"messages":[{"id":12,"envelope":{...}}]}
```

**Targeting**: `targetSessionId` on `sendOffer`/`sendAnswer`/`sendIce` is a
transport-level routing hint (unicast), **not** part of the envelope — mirroring
the JS engine's `SignalingBackend.send(msg)` ("unicast or broadcast per
msg.target", docs/research/webrtc-js.md). The schema has no envelope-level
target field; backends stay dumb and the engine owns routing.

## Protocol conformance (L0)

The binding ships the **canonical L0 fixture set** — three sample envelopes
derived 1:1 from `protocol/schema.json`:

- `vidcall-protocol/src/test/resources/envelopes/sample-join.json`
- `vidcall-protocol/src/test/resources/envelopes/sample-offer.json`
- `vidcall-protocol/src/test/resources/envelopes/sample-ice.json`

Every language binding runs the shared conformance suite against the same
fixtures (docs/research/mobile-bindings.md §4). The Kotlin L0 tests
(`EnvelopeSerializationTest`) assert:

1. each fixture decodes to a valid `Envelope`;
2. re-encoding a decoded envelope reproduces the fixture JSON exactly;
3. typed payload decoding matches the schema (`JoinPayload`, `OfferPayload`, `IcePayload`);
4. required-field and enum violations fail to decode;
5. unknown payload fields are ignored (additive schema evolution);
6. nullable payload fields are omitted from the wire.

Run offline (no network, no Android runtime):

```
./gradlew :vidcall-protocol:test :vidcall-client:test :vidcall-android:testDebugUnitTest
```

### Test matrix

| Level | Scope | Runs where | Offline |
|---|---|---|---|
| L0 | Protocol serialization round-trip (3 sample envelopes + edge cases) | JVM unit test (`vidcall-protocol`) | ✅ |
| L1 | Client dispatch/send, seq, dedupe, pong, validation | JVM unit test (`vidcall-client`, fake transport) | ✅ |
| L1 | SDP/ICE ↔ payload mapping, initiator rule | JVM unit test (`vidcall-android`, org.webrtc value objects) | ✅ |
| L2 | End-to-end mesh (2+ devices/emulators) | Android instrumentation / CI emulators | ❌ (needs devices) |

L2 is not implemented yet; the L0/L1 suite is the CI gate.

## Dependencies (supply-chain audit)

Policy: exact pins only; every artifact published ≥ 14 days before adoption
(docs/research/mobile-bindings.md §7). Adoption date: **2026-08-11**.

| Dependency | Pin | Published | Why |
|---|---|---|---|
| `io.getstream:stream-webrtc-android` | 1.3.10 | 2025-09-11 | maintained prebuilt WebRTC (Google's JCenter artifact is dead); Apache-2.0; minSdk 21 |
| `org.jetbrains.kotlin` (KGP, serialization plugin) | 2.4.10 | 2026-07-14 | Kotlin toolchain |
| `org.jetbrains.kotlinx:kotlinx-serialization-json` | 1.11.0 | 2026-04-09 | envelope/payload codec |
| `com.squareup.okhttp3:okhttp` | 5.4.0 | 2026-06-08 | WebSocket + REST transports |
| `com.android.tools.build:gradle` (AGP) | 8.13.2 | 2025-12-11 | Android build |
| `junit:junit` | 4.13.2 | 2021-02-13 | unit tests |

Publish dates verified via `repo1.maven.org` `Last-Modified` on each POM and the
Maven search API
(`https://search.maven.org/solrsearch/select?q=g:io.getstream+AND+a:stream-webrtc-android&rows=1&wt=json`,
plus the authoritative
[repo1 metadata](https://repo1.maven.org/maven2/io/getstream/stream-webrtc-android/maven-metadata.xml)
— `lastUpdated 20250911112714`). Exact pins live in
[`gradle/libs.versions.toml`](gradle/libs.versions.toml) and committed
`gradle.lockfile` files (regenerate with `./gradlew build --write-locks`).

## Building

```
cd packages/kotlin
./gradlew build            # compile + test + lint (Android SDK required)
./gradlew :vidcall-protocol:test :vidcall-client:test   # JVM-only, offline
```

## Publishing to Maven Central

Follows docs/research/mobile-bindings.md §6.1 (Central Portal,
central.sonatype.com):

1. **Namespace**: register at <https://central.sonatype.com/>, verify the
   `io.vidcall` namespace (DNS TXT for your domain or GitHub-org verification).
2. **GPG**: generate a keypair, upload the public key to a keyserver. The
   `signing` block activates when `signing.gnupg.keyName` (+ passphrase) is set
   or `VIDCALL_GPG_KEY_ID` is exported.
3. **Credentials**: portal username + token via
   `-Pvidcall.central.username=... -Pvidcall.central.token=...` or the
   `VIDCALL_CENTRAL_USERNAME` / `VIDCALL_CENTRAL_TOKEN` env vars.
4. **Publish** (from a tag, per §6.4 — CI only):

   ```
   ./gradlew :vidcall-protocol:publish              :vidcall-client:publish              :vidcall-android:publish              -Pvidcall.central.username=$USER -Pvidcall.central.token=$TOKEN              -Psigning.gnupg.keyName=$KEYID -Psigning.gnupg.passphrase=$PASSPHRASE
   ```

5. **POM metadata** (license MIT, SCM, developers) is generated by
   `gradle/publishing-convention.gradle.kts`; the Android module publishes the
   `release` AAR with sources + javadoc jars.
6. Verify propagation on <https://repo1.maven.org/maven2/io/vidcall/>.

`./gradlew publishToMavenLocal` validates the publications locally without
credentials.

## Known gaps / roadmap

- **DataChannel bus** (reactions/chat over SCTP, RFC 8831/8832) — currently
  chat/reactions go over the signaling channel; `onDataChannel` is surfaced but
  unhandled.
- **Reorder buffer** — the client dedupes by `(senderId, seq)` but does not yet
  reorder out-of-order envelopes; the engine contract says ordering is the
  engine's job, so a reorder buffer is planned.
- **Screen capture** — the binding provides the source/track/capturer wiring;
  the `MediaProjection` permission flow stays app-side.
- **Adaptive quality** (`quality-warning`, simulcast layers) — payloads are
  modeled and relayed; the policy engine is future work (mirrors the JS core's
  `AdaptiveQualityController`).
- **KMP** — milestone 2 decision: add iOS targets (docs §8.5).
