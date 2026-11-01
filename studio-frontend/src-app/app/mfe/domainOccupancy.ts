/**
 * What each domain has mounted, as its container hooks report it: an extension
 * counts from the creation of its container until its destruction. The runtime
 * no longer exposes mounted state (mfes 0.4.0); this only records, and decides
 * nothing.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useFrontX, type Extension, type MfeRegistry } from '@gears-frontx/react';

export interface DomainOccupancy {
  mounted(domainId: string): readonly string[];
  subscribe(listener: () => void): () => void;
}

export interface DomainOccupancyRecorder {
  created(domainId: string, extensionId: string): void;
  destroyed(domainId: string, extensionId: string): void;
}

type Occupancy = DomainOccupancy & DomainOccupancyRecorder;

const NONE: readonly string[] = [];
const stores = new WeakMap<MfeRegistry, Occupancy>();

function createOccupancy(): Occupancy {
  const domains = new Map<string, readonly string[]>();
  const listeners = new Set<() => void>();
  const update = (domainId: string, ids: readonly string[]): void => {
    domains.set(domainId, ids);
    for (const listener of [...listeners]) listener();
  };
  return {
    mounted: (domainId) => domains.get(domainId) ?? NONE,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    created(domainId, extensionId) {
      const ids = domains.get(domainId) ?? NONE;
      if (!ids.includes(extensionId)) update(domainId, [...ids, extensionId]);
    },
    destroyed(domainId, extensionId) {
      const ids = domains.get(domainId) ?? NONE;
      if (ids.includes(extensionId)) update(domainId, ids.filter((id) => id !== extensionId));
    },
  };
}

export function occupancyOf(registry: MfeRegistry): Occupancy {
  let occupancy = stores.get(registry);
  if (occupancy === undefined) {
    occupancy = createOccupancy();
    stores.set(registry, occupancy);
  }
  return occupancy;
}

export function useMountedExtensions(domainId: string): Extension[] {
  const registry = useFrontX().mfeRegistry;
  if (!registry) {
    throw new Error('useMountedExtensions requires the microfrontends plugin');
  }
  const occupancy = occupancyOf(registry);
  const last = useRef<{ ids: readonly string[]; extensions: Extension[] }>({ ids: NONE, extensions: [] });
  const snapshot = useCallback(() => {
    const ids = occupancy.mounted(domainId);
    if (ids !== last.current.ids) {
      const extensions = ids
        .map((id) => registry.getExtension(id))
        .filter((extension): extension is Extension => extension !== undefined);
      last.current = { ids, extensions };
    }
    return last.current.extensions;
  }, [occupancy, registry, domainId]);
  return useSyncExternalStore(occupancy.subscribe, snapshot, snapshot);
}
