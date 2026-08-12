# @vidcall/quality

Adaptive-quality **policy engine** for vidcall: watches `getStats()` polls and
decides when a peer's video should step down (network congestion, CPU
pressure) or step back up (stable for 10 s with headroom).

**Pure by design** — consumes `RTCStatsSnapshot`s, never touches WebRTC
objects, **zero runtime dependencies**. Works in browsers, Node, and tests;
the engine (`@vidcall/core`) and your own monitors both feed it.

## Install

```sh
npm i @vidcall/quality             # once published
# today (workspace): npm i file:../vidcall/packages/quality
```

## Usage

```ts
import { AdaptiveQualityController, detectDeviceCapability } from '@vidcall/quality';

const controller = new AdaptiveQualityController({
  direction: 'send', // or 'receive'
  maxTierId: '720p@30', // device/plan cap — from detectDeviceCapability()
});

controller.on('quality:warning', (e) => console.log(`${e.from} -> ${e.to} (${e.reason})`));

// Drive it from your own getStats() loop:
controller.start(() => snapshotFrom(room.getStats()), 1000);

// ...or apply individual decisions yourself:
const decision = controller.tick(snapshot);
if (decision.changed) {
  await sender.setParameters({ encodings: [{ maxBitrate: decision.tier.maxBitrateKbps * 1000 }] });
}
```

The policy ladder is ordered high → low (`1080p@30` → `720p@30` → `480p@30` →
… → `audio-only`). The controller:

- **downgrades instantly** on congestion (RTT/loss/bitrate-headroom) or CPU
  encode pressure — degraded calls should not linger;
- **upgrades after 10 s stable** (configurable `upgradeStableMs`), at most
  `maxUpgradeSteps` per change;
- never exceeds the device/plan cap (`DeviceCapability`, D5a);
- emits `quality:changed` and `quality:warning` events (the latter becomes
  the room-level `quality-warning` event in `@vidcall/core`).

## API surface

| Export                                          | What it is                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdaptiveQualityController`                     | the policy state machine: `tick(snapshot) -> QualityDecision`, `start(getSnapshot, intervalMs)`, `stop()`, `setTier(id, reason)`, `reset()` |
| `RTCStatsSnapshot`                              | the pure input contract — aggregated, sanitized `getStats()` view (`ts`, round-trip RTT, loss rate, bitrates, encode times, …)              |
| `QualityTier` / `DEFAULT_QUALITY_TIERS`         | the quality ladder (`id`, `label`, `width/height`, `maxFramerate`, `maxBitrateKbps`, required capacity)                                     |
| `detectDeviceCapability()` / `DeviceCapability` | initial caps from `hardwareConcurrency`/`deviceMemory`/screen size + a 0..1 device score                                                    |
| `QualityDecision` / `QualityWarningEvent`       | per-tick outcomes and user-facing warnings                                                                                                  |

## Tuning knobs (`AdaptiveQualityConfig`)

| Option                                                                   | Default        | Meaning                                                    |
| ------------------------------------------------------------------------ | -------------- | ---------------------------------------------------------- |
| `downgradeRttMs`                                                         | 300            | round-trip threshold (ms) for a congestion tick            |
| `downgradeLossRate`                                                      | 0.05           | loss-rate threshold (fraction)                             |
| `downgradeBitrateHeadroom`                                               | 1.25           | downgrade when send bitrate < `tier.maxBitrate / headroom` |
| `instantDowngradeTicks`                                                  | 2              | consecutive bad ticks before an instant downgrade          |
| `severeRttMs` / `severeBitrateKbps`                                      | 800 / 200      | jump straight to audio-only                                |
| `cpuTicksToDowngrade` / `cpuEncodeDutyThreshold` / `cpuDurationFraction` | 2 / 0.9 / 0.25 | CPU encode-pressure downgrade                              |
| `upgradeStableMs`                                                        | 10 000         | how long to stay healthy before upgrading                  |
| `upgradeBitrateHeadroom`                                                 | 1.5            | required headroom to attempt an upgrade                    |
| `maxUpgradeSteps`                                                        | 1              | tiers per upgrade                                          |

See `packages/quality/test/` for the policy test suite and
`examples/vanilla/main.ts` for a working `getStats()` → controller loop in a
browser.
