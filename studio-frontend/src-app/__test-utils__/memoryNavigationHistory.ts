/**
 * An in-memory navigation history for tests.
 *
 * `@gears-frontx/routing` keeps ONE `NavigationHistory` per realm under a
 * well-known symbol and hands the same instance to every caller. Tests need a
 * fresh one each, over an adapter they control instead of `window`, so this
 * helper deletes the realm-global before resolving again. The key literal is
 * the package's own (`history/singleton.ts`), marked @internal there; if a
 * future version renames it, the "fresh instance per call" test fails first.
 */
import {
  resolveNavigationHistory,
  type AdapterLocation,
  type HistoryAdapter,
  type NavigationHistory,
} from '@gears-frontx/routing';

const NAVIGATION_HISTORY_KEY = Symbol.for('@gears-frontx/routing/navigation-history/v1');

export interface MemoryHistoryAdapter extends HistoryAdapter {
  /** The current entry's path, query and fragment, as pushed. */
  url(): string;
  /** How many entries the stack holds. */
  length(): number;
  /** Resolves once the pop listeners queued by `go` have run. */
  settle(): Promise<void>;
}

interface StackEntry {
  path: string;
  state: unknown;
}

function split(path: string): AdapterLocation {
  const url = new URL(path, 'http://memory.test');
  return {
    path: url.pathname,
    search: url.search.startsWith('?') ? url.search.slice(1) : url.search,
    hash: url.hash.startsWith('#') ? url.hash.slice(1) : url.hash,
  };
}

export function createMemoryHistoryAdapter(initialUrl = '/'): MemoryHistoryAdapter {
  const stack: StackEntry[] = [{ path: initialUrl, state: undefined }];
  let index = 0;
  const pops = new Set<() => void>();
  return {
    getLocation: () => split(stack[index].path),
    pushState(path, state) {
      stack.splice(index + 1);
      stack.push({ path, state });
      index = stack.length - 1;
    },
    replaceState(path, state) {
      stack[index] = { path, state };
    },
    getState: () => stack[index].state,
    go(delta) {
      const next = index + delta;
      if (next < 0 || next >= stack.length) return;
      index = next;
      // The browser delivers popstate asynchronously; so does this.
      queueMicrotask(() => pops.forEach((listener) => listener()));
    },
    onPop(listener) {
      pops.add(listener);
      return () => pops.delete(listener);
    },
    url: () => stack[index].path,
    length: () => stack.length,
    settle: () => new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve))),
  };
}

export function freshNavigationHistory(initialUrl = '/'): {
  history: NavigationHistory;
  adapter: MemoryHistoryAdapter;
} {
  delete (globalThis as unknown as Record<symbol, unknown>)[NAVIGATION_HISTORY_KEY];
  const adapter = createMemoryHistoryAdapter(initialUrl);
  return { history: resolveNavigationHistory(() => adapter), adapter };
}
