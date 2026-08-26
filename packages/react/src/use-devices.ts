import { useEffect, useState, useCallback } from 'react';
import type { Room } from '@mbsks/openrtc-core';
import type { DeviceInfo } from '@mbsks/openrtc-core';

export interface UseDevicesReturn {
  devices: readonly DeviceInfo[];
  refresh: () => Promise<readonly DeviceInfo[]>;
  switchCamera: () => Promise<boolean>;
  setFacingMode: (mode: 'user' | 'environment' | 'left' | 'right') => Promise<boolean>;
}

/**
 * Devices facade: enumerate + react to `devices-changed` (alias `devices:changed`).
 */
export function useDevices(room: Room): UseDevicesReturn {
  const [devices, setDevices] = useState<readonly DeviceInfo[]>([]);

  const refresh = useCallback(async () => {
    const list = await room.devices.listDevices();
    setDevices(list);
    return list;
  }, [room]);

  useEffect(() => {
    void refresh();
    const off = room.on('devices-changed' as never, (() => { void refresh(); }) as never);
    const offAlias = room.on('devices:changed' as never, (() => { void refresh(); }) as never);
    return () => { off(); offAlias(); };
  }, [room, refresh]);

  return {
    devices,
    refresh,
    switchCamera: () => room.devices.switchCamera(),
    setFacingMode: (mode) => room.devices.setFacingMode(mode),
  };
}
