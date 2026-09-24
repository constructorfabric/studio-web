import { describe, expect, it } from 'vitest';
import { freshNavigationHistory } from '@frontx-test-utils/memoryNavigationHistory';
import { createShellNavigation } from './navigation';

describe('createShellNavigation', () => {
  it('reads no route from an empty address', () => {
    const { history } = freshNavigationHistory('/');
    expect(createShellNavigation(history).currentRoute()).toBeNull();
  });

  it('adds the entry when the address has none, with the verb it is given', () => {
    const { history, adapter } = freshNavigationHistory('/');
    const nav = createShellNavigation(history);
    nav.navigate({ token: 'people', org: 'o1' }, 'replace');
    expect(adapter.url()).toBe('/?screen=people;org=o1');
    expect(adapter.length()).toBe(1);
  });

  it('replaces the entry when the token changes, and pushes', () => {
    const { history, adapter } = freshNavigationHistory('/?screen=people;org=o1');
    const nav = createShellNavigation(history);
    nav.navigate({ token: 'projects', org: 'o1', workspace: 'w1' }, 'push');
    expect(adapter.url()).toBe('/?screen=projects;org=o1;workspace=w1');
    expect(adapter.length()).toBe(2);
    expect(nav.currentRoute()).toEqual({ token: 'projects', org: 'o1', workspace: 'w1' });
  });

  it('changes only the payload when the token stays', () => {
    const { history, adapter } = freshNavigationHistory('/?screen=projects;org=o1;workspace=w1');
    createShellNavigation(history).navigate(
      { token: 'projects', org: 'o1', workspace: 'w1', project: 'p1', section: 'overview' },
      'push'
    );
    expect(adapter.url()).toBe('/?screen=projects;org=o1;workspace=w1;project=p1;section=overview');
  });

  it('writes nothing when the route is already what the address says', () => {
    const { history, adapter } = freshNavigationHistory('/?screen=people;org=o1');
    createShellNavigation(history).navigate({ token: 'people', org: 'o1' }, 'push');
    expect(adapter.length()).toBe(1);
  });

  it('keeps a foreign query segment and the hash across its own write', () => {
    const { history, adapter } = freshNavigationHistory('/?utm_source=mail&screen=people;org=o1#top');
    createShellNavigation(history).navigate({ token: 'kits', org: 'o1' }, 'push');
    expect(adapter.url()).toContain('screen=kits;org=o1');
    expect(adapter.url()).toContain('utm_source=mail');
    expect(adapter.url()).toContain('#top');
  });

  it('reads a route even when the address names a screen nobody registered', () => {
    const { history } = freshNavigationHistory('/?screen=nowhere;org=o1');
    expect(createShellNavigation(history).currentRoute()).toEqual({ token: 'nowhere', org: 'o1' });
  });
});
