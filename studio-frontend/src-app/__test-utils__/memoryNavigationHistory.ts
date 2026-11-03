/**
 * An in-memory navigation history for tests, with the library's semantics: the
 * location already reflects a navigation when its subscribers run, `push` and
 * `replace` notify at once, `go` lands later as a `'history'` round, every entry
 * keeps its position, and a round started from inside another waits for it.
 * `@gears-frontx/routing` 0.4 builds its own only over `window`;
 * `memoryNavigationHistory.test.ts` walks both through the same steps.
 */
import type {
  HistoryNotification,
  HistorySubscriber,
  Location,
  NavigationHistory,
  NavigationKind,
} from '@gears-frontx/routing';

export interface MemoryHistoryAdapter {
  /** Every write goes through these two, so a test can count them. */
  pushState(url: string): void;
  replaceState(url: string): void;
  /** The current entry's path, query and fragment, as pushed. */
  url(): string;
  /** How many entries the stack holds. */
  length(): number;
  /** Resolves once the rounds queued by `go` have run. */
  settle(): Promise<void>;
}

interface Entry {
  url: string;
  position: number;
}

/** The library abandons a queue that refills itself this many times in a row. */
const ROUND_LIMIT = 100;

function locationOf(entry: Entry): Location {
  const url = new URL(entry.url, 'http://memory.test');
  return {
    path: url.pathname,
    search: url.search.startsWith('?') ? url.search.slice(1) : url.search,
    hash: url.hash.startsWith('#') ? url.hash.slice(1) : url.hash,
    position: entry.position,
  };
}

export function freshNavigationHistory(initialUrl = '/'): {
  history: NavigationHistory;
  adapter: MemoryHistoryAdapter;
} {
  const stack: Entry[] = [{ url: initialUrl, position: 0 }];
  let index = 0;
  const subscribers = new Set<HistorySubscriber>();
  const pending: HistoryNotification[] = [];
  let dispatching = false;

  const runRound = (notification: HistoryNotification): void => {
    for (const subscriber of [...subscribers]) {
      if (!subscribers.has(subscriber)) continue;
      try {
        subscriber(notification);
      } catch (error) {
        console.error('[memoryNavigationHistory] a subscriber threw during a round', error);
      }
    }
  };

  const notify = (kind: NavigationKind): void => {
    pending.push({ location: locationOf(stack[index]), kind });
    if (dispatching) return;
    dispatching = true;
    try {
      for (let rounds = 0; pending.length > 0; rounds += 1) {
        if (rounds > ROUND_LIMIT) {
          pending.length = 0;
          throw new Error(`[memoryNavigationHistory] ${ROUND_LIMIT} rounds without the queue emptying`);
        }
        runRound(pending.shift()!);
      }
    } finally {
      dispatching = false;
    }
  };

  const adapter: MemoryHistoryAdapter = {
    pushState(url) {
      const position = stack[index].position + 1;
      stack.splice(index + 1, stack.length, { url, position });
      index += 1;
    },
    replaceState(url) {
      stack[index] = { url, position: stack[index].position };
    },
    url: () => stack[index].url,
    length: () => stack.length,
    settle: () => new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve))),
  };

  const history: NavigationHistory = {
    get location() {
      return locationOf(stack[index]);
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    push(url) {
      adapter.pushState(url);
      notify('push');
    },
    replace(url) {
      adapter.replaceState(url);
      notify('replace');
    },
    go(delta) {
      // The browser lands a `go` later, as a popstate, counting from the entry
      // it is on by then; so does this.
      queueMicrotask(() => {
        const next = index + delta;
        if (next < 0 || next >= stack.length) return;
        index = next;
        notify('history');
      });
    },
  };

  return { history, adapter };
}
