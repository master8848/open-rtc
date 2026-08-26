import { useEffect, useState } from 'react';
import type { Room } from '@mbsks/openrtc-core';
import type { LocalQualityChangedEvent, LocalQualityWarningEvent } from '@mbsks/openrtc-core';

export interface UseQualityReturn {
  /** Current tier id (from snapshot or controller). */
  tierId: string | undefined;
  /** Whether adaptive quality is available in this environment. */
  available: boolean;
  /** Last changed event. */
  lastChanged: LocalQualityChangedEvent | undefined;
  /** Last warning event. */
  lastWarning: LocalQualityWarningEvent | undefined;
}

/**
 * Adaptive quality state: tier + last events from `quality-changed` /
 * `local-quality-warning` (aliases `quality:changed` / `quality:warning`).
 */
export function useQuality(room: Room): UseQualityReturn {
  const [tierId, setTierId] = useState<string | undefined>(() => room.getSnapshot().qualityTierId ?? room.quality.currentTierId);
  const [lastChanged, setLastChanged] = useState<LocalQualityChangedEvent | undefined>(undefined);
  const [lastWarning, setLastWarning] = useState<LocalQualityWarningEvent | undefined>(undefined);

  useEffect(() => {
    const offChanged = room.on('quality-changed' as never, ((e: LocalQualityChangedEvent) => {
      setTierId(e.to);
      setLastChanged(e);
    }) as never);
    const offChangedAlias = room.on('quality:changed' as never, ((e: LocalQualityChangedEvent) => {
      setTierId(e.to);
      setLastChanged(e);
    }) as never);
    const offWarning = room.on('local-quality-warning' as never, ((e: LocalQualityWarningEvent) => setLastWarning(e)) as never);
    const offWarningAlias = room.on('quality:warning' as never, ((e: LocalQualityWarningEvent) => setLastWarning(e)) as never);
    const offWarningLocalAlias = room.on('quality-warning-local' as never, ((e: LocalQualityWarningEvent) => setLastWarning(e)) as never);
    // Keep snapshot tier in sync if quality changes without event (e.g. initial tier)
    const offSnapshot = room.store.subscribe(() => {
      const snapTier = room.getSnapshot().qualityTierId;
      if (snapTier !== undefined) setTierId(snapTier);
    });
    return () => {
      offChanged(); offChangedAlias(); offWarning(); offWarningAlias(); offWarningLocalAlias(); offSnapshot();
    };
  }, [room]);

  return { tierId, available: room.quality.available, lastChanged, lastWarning };
}
