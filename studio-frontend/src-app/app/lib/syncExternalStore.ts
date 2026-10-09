/**
 * ESM stand-ins for `use-sync-external-store/shim` and its `with-selector`
 * entries, wired in by `resolve.alias` in `vite.config.ts` for the shell build.
 *
 * Why the shell does not bundle the real package: it is CommonJS, and its
 * `require('react')` goes through module federation's commonjs proxy for the
 * shared React. @module-federation/vite 1.20.1 renames that proxy's import
 * and leaves the old name at some use sites, depending on the shape of the
 * module graph. When it happens the bundle throws `ReferenceError: $g is not
 * defined` at load and the portal is a blank page (main 5e2576a0, E2E "a user
 * signs in through Keycloak"). Newer plugin versions fix it, but they put a
 * preload helper first in `exposeAssets.js.sync`, which FrontX's MFE handler
 * loads as the expose chunk.
 *
 * React 19 has `useSyncExternalStore`, so the shim is a re-export. The
 * selector hook is React's own `useSyncExternalStoreWithSelector`
 * (packages/use-sync-external-store, MIT), unchanged in behaviour.
 */

/* eslint-disable react-hooks/refs, react-hooks/immutability -- React's own
   algorithm, kept as written: the last rendered selection lives in a ref read
   during render, and the memo lives in a closure that outlives the render. */

import { useDebugValue, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

export { useSyncExternalStore };

export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot: undefined | null | (() => Snapshot),
  selector: (snapshot: Snapshot) => Selection,
  isEqual?: (a: Selection, b: Selection) => boolean
): Selection {
  // The last selection React rendered, so an equal new one keeps its identity.
  const instRef = useRef<{ hasValue: boolean; value: Selection | null } | null>(null);
  if (instRef.current === null) instRef.current = { hasValue: false, value: null };
  const inst = instRef.current;

  const [getSelection, getServerSelection] = useMemo(() => {
    let hasMemo = false;
    let memoizedSnapshot: Snapshot;
    let memoizedSelection: Selection;
    const memoizedSelector = (nextSnapshot: Snapshot): Selection => {
      if (!hasMemo) {
        hasMemo = true;
        memoizedSnapshot = nextSnapshot;
        const nextSelection = selector(nextSnapshot);
        if (isEqual !== undefined && inst.hasValue) {
          const currentSelection = inst.value as Selection;
          if (isEqual(currentSelection, nextSelection)) {
            memoizedSelection = currentSelection;
            return currentSelection;
          }
        }
        memoizedSelection = nextSelection;
        return nextSelection;
      }
      const prevSelection = memoizedSelection;
      if (Object.is(memoizedSnapshot, nextSnapshot)) return prevSelection;
      const nextSelection = selector(nextSnapshot);
      if (isEqual !== undefined && isEqual(prevSelection, nextSelection)) {
        memoizedSnapshot = nextSnapshot;
        return prevSelection;
      }
      memoizedSnapshot = nextSnapshot;
      memoizedSelection = nextSelection;
      return nextSelection;
    };
    const serverSnapshot = getServerSnapshot ?? null;
    return [
      () => memoizedSelector(getSnapshot()),
      serverSnapshot === null ? undefined : () => memoizedSelector(serverSnapshot()),
    ] as const;
  }, [getSnapshot, getServerSnapshot, selector, isEqual, inst]);

  const value = useSyncExternalStore(subscribe, getSelection, getServerSelection);
  useEffect(() => {
    inst.hasValue = true;
    inst.value = value;
  }, [inst, value]);
  useDebugValue(value);
  return value;
}
