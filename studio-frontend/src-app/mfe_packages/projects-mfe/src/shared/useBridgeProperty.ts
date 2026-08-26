/**
 * One shared property of the host, read and kept current.
 */

import { useEffect, useState } from 'react';
import type { ChildMfeBridge } from '@gears-frontx/react';

function read<T>(bridge: ChildMfeBridge | null, propertyId: string): T | null | undefined {
  if (!bridge) return undefined;
  const property = bridge.getProperty(propertyId);
  return property ? (property.value as T | null) : undefined;
}

export function useBridgeProperty<T>(
  bridge: ChildMfeBridge | null,
  propertyId: string
): T | null | undefined {
  const [value, setValue] = useState<T | null | undefined>(() => read<T>(bridge, propertyId));

  const [prevBridge, setPrevBridge] = useState(bridge);
  if (prevBridge !== bridge) {
    setPrevBridge(bridge);
    setValue(read<T>(bridge, propertyId));
  }

  useEffect(() => {
    if (!bridge) return;
    return bridge.subscribeToProperty(propertyId, (property) => {
      setValue((property.value ?? null) as T | null);
    });
  }, [bridge, propertyId]);

  return value;
}
