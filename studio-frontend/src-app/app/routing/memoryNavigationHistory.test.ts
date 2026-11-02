/**
 * Lives here, not next to the helper in `src-app/__test-utils__/`: vitest's
 * shared exclude list (`DEFAULT_TEST_EXCLUDE` in `vitest.shared.ts`) drops
 * `**\/__test-utils__/**`, so a test placed there is never collected. The
 * routing folder is the helper's only consumer.
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveNavigationHistory, type NavigationHistory } from '@gears-frontx/routing';
import { freshNavigationHistory } from '@frontx-test-utils/memoryNavigationHistory';

/**
 * The same steps on a history, and what a subscriber saw: the kind, the address
 * and the entry's position counted from where the walk started. A navigation
 * made inside a round, a replace, and two steps back taken one after another.
 */
async function walk(history: NavigationHistory): Promise<string[]> {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const start = history.location.position;
  const seen: string[] = [];
  const unsubscribe = history.subscribe(({ kind, location }) => {
    seen.push(`${kind} ${location.path}${location.search ? `?${location.search}` : ''} @${location.position - start}`);
    if (kind === 'replace') history.push('/c?from=round');
  });
  history.push('/a');
  history.replace('/b');
  history.go(-1);
  await settle();
  history.go(-1);
  await settle();
  unsubscribe();
  return seen;
}

describe('freshNavigationHistory', () => {
  it('starts at the given url and reports it as path, search and hash', () => {
    const { history } = freshNavigationHistory('/?screen=people;org=o1#top');
    expect(history.location.path).toBe('/');
    expect(history.location.search).toBe('screen=people;org=o1');
    expect(history.location.hash).toBe('top');
  });

  it('is a fresh instance per call, so one test never sees the last one', () => {
    const first = freshNavigationHistory('/?screen=a');
    const second = freshNavigationHistory('/?screen=b');
    expect(first.history).not.toBe(second.history);
    expect(second.history.location.search).toBe('screen=b');
  });

  it('pushes, replaces and walks back with a popped notification', async () => {
    const { history, adapter } = freshNavigationHistory('/');
    const seen: string[] = [];
    history.subscribe(() => seen.push(history.location.search));
    history.push('/?screen=people;org=o1');
    history.replace('/?screen=people;org=o2');
    expect(adapter.length()).toBe(2);
    history.go(-1);
    await adapter.settle();
    expect(history.location.search).toBe('');
    expect(seen).toEqual(['screen=people;org=o1', 'screen=people;org=o2', '']);
  });

  // The library's semantics the routing tests lean on (@gears-frontx/routing 0.4's
  // FanOutDispatcher and position tracking); each case fails if the fake drifts.

  it('delivers a push made inside a subscriber after the current round, in order', () => {
    const { history } = freshNavigationHistory('/');
    const seen: string[] = [];
    history.subscribe((notification) => {
      seen.push(`a:${notification.location.search}`);
      if (notification.location.search === 'x=1') history.push('/?x=2');
    });
    history.subscribe((notification) => seen.push(`b:${notification.location.search}`));

    history.push('/?x=1');

    expect(seen).toEqual(['a:x=1', 'b:x=1', 'a:x=2', 'b:x=2']);
  });

  it('keeps the entry position on replace and adds one on push', () => {
    const { history } = freshNavigationHistory('/');
    expect(history.location.position).toBe(0);
    history.push('/?a');
    expect(history.location.position).toBe(1);
    history.replace('/?b');
    expect(history.location.position).toBe(1);
    history.push('/?c');
    expect(history.location.position).toBe(2);
  });

  it('lands go later, as a history round whose location has already moved', async () => {
    const { history, adapter } = freshNavigationHistory('/');
    history.push('/?a');
    const seen: Array<[string, string, string]> = [];
    history.subscribe((notification) => seen.push([notification.kind, notification.location.search, history.location.search]));

    history.go(-1);
    expect(seen).toEqual([]);
    await adapter.settle();

    expect(seen).toEqual([['history', '', '']]);
  });

  it('does nothing for a go past either end', async () => {
    const { history, adapter } = freshNavigationHistory('/?a');
    const seen = vi.fn();
    history.subscribe(seen);

    history.go(-1);
    history.go(1);
    await adapter.settle();

    expect(seen).not.toHaveBeenCalled();
    expect(history.location.search).toBe('a');
  });

  it('walks two steps back for two go(-1) in a row, as a browser does', async () => {
    const { history, adapter } = freshNavigationHistory('/');
    history.push('/?a');
    history.push('/?b');
    const seen: string[] = [];
    history.subscribe((notification) => seen.push(notification.location.search));

    history.go(-1);
    history.go(-1);
    await adapter.settle();

    expect(history.location.search).toBe('');
    expect(seen).toEqual(['a', '']);
  });

  it('skips a subscriber removed during a round', () => {
    const { history } = freshNavigationHistory('/');
    const seen: string[] = [];
    let unsubscribeSecond = (): void => {};
    history.subscribe(() => {
      seen.push('first');
      unsubscribeSecond();
    });
    unsubscribeSecond = history.subscribe(() => seen.push('second'));

    history.push('/?x');

    expect(seen).toEqual(['first']);
  });

  it('logs a subscriber that throws and still runs the rest of the round', () => {
    const { history } = freshNavigationHistory('/');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    history.subscribe(() => {
      throw new Error('boom');
    });
    history.subscribe(() => seen.push('after'));

    history.push('/?x');

    expect(seen).toEqual(['after']);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('abandons a queue that refills itself from every round, and starts the next one empty', () => {
    const { history } = freshNavigationHistory('/');
    const unsubscribe = history.subscribe(() => history.push('/?again'));

    expect(() => history.push('/?start')).toThrow(/rounds without the queue emptying/);

    unsubscribe();
    const seen: string[] = [];
    history.subscribe(({ location }) => seen.push(location.search));
    history.push('/?after');
    expect(seen).toEqual(['after']);
  });

  // The double is held to the library: the library's own history, over jsdom's
  // window, takes the same steps and must be seen the same way.
  it('is seen as the library over a real window is, for the same steps', async () => {
    window.history.replaceState(null, '', '/start');

    const library = await walk(resolveNavigationHistory());
    const double = await walk(freshNavigationHistory('/start').history);

    expect(library).toEqual([
      'push /a @1',
      'replace /b @1',
      'push /c?from=round @2',
      'history /b @1',
      'history /start @0',
    ]);
    expect(double).toEqual(library);
  });
});
