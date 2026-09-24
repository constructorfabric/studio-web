/**
 * Lives here, not next to the helper in `src-app/__test-utils__/`: vitest's
 * shared exclude list (`DEFAULT_TEST_EXCLUDE` in `vitest.shared.ts`) drops
 * `**\/__test-utils__/**`, so a test placed there is never collected. The
 * routing folder is the helper's only consumer.
 */
import { describe, expect, it } from 'vitest';
import { freshNavigationHistory } from '@frontx-test-utils/memoryNavigationHistory';

describe('freshNavigationHistory', () => {
  it('starts at the given url and reports it as path, search and hash', () => {
    const { history } = freshNavigationHistory('/?screen=people;org=o1#top');
    expect(history.location.path).toBe('/');
    expect(history.location.search).toBe('screen=people;org=o1');
    expect(history.location.hash).toBe('top');
  });

  it('is a fresh instance per call, not the realm singleton of the previous test', () => {
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
});
