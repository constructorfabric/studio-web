import { describe, expect, it } from 'vitest';
import { parseGrammar, validateName } from '@gears-frontx/routing';
import { freshNavigationHistory } from '@frontx-test-utils/memoryNavigationHistory';
import { createShellNavigation } from './navigation';
import { SCREEN_DOMAIN_KEY, routeFromEntry, routeToParams, routesEqual } from './route';

describe('the screen route codec', () => {
  it('uses a root key the library accepts', () => {
    expect(validateName(SCREEN_DOMAIN_KEY)).toBe(true);
  });

  it('writes parameters in the fixed order and skips what is absent', () => {
    expect(
      routeToParams({ token: 'projects', section: 'artifacts', project: 'p1', org: 'o1', workspace: 'w1' })
    ).toEqual([
      { name: 'org', value: 'o1' },
      { name: 'workspace', value: 'w1' },
      { name: 'project', value: 'p1' },
      { name: 'section', value: 'artifacts' },
    ]);
    expect(routeToParams({ token: 'people', org: 'o1' })).toEqual([{ name: 'org', value: 'o1' }]);
    expect(routeToParams({ token: 'people', org: '' })).toEqual([]);
  });

  it('writes the artifact after the level context, in its own fixed order', () => {
    expect(
      routeToParams({
        token: 'space',
        kind: 'file',
        path: 'docs/a.md',
        repository: 'group/repo',
        artifact: 'n-1',
        project: 'p1',
        workspace: 'w1',
        org: 'o1',
      }).map((param) => param.name)
    ).toEqual(['org', 'workspace', 'project', 'artifact', 'repository', 'path', 'kind']);
  });

  it('carries a path through the address unchanged, whatever it contains', () => {
    const { history } = freshNavigationHistory('/');
    const navigation = createShellNavigation(history);
    const route = {
      token: 'space',
      org: 'o1',
      workspace: 'w1',
      project: 'p1',
      artifact: 'n-1',
      repository: 'group/repo',
      path: 'docs/a b;c=d&e%f#g.md',
      kind: 'file',
    };
    navigation.navigate(route, 'push');
    expect(navigation.currentRoute()).toEqual(route);
  });

  it('reads a route back from an entry', () => {
    expect(
      routeFromEntry({
        extension: 'projects',
        params: [
          { name: 'org', value: 'o1' },
          { name: 'workspace', value: 'w1' },
          { name: 'project', value: 'p1' },
          { name: 'section', value: 'team' },
        ],
      })
    ).toEqual({ token: 'projects', org: 'o1', workspace: 'w1', project: 'p1', section: 'team' });
  });

  // Review Focus 3 — through the real parser, not hand-built params: the
  // library keeps the LAST value of a duplicated parameter, and a malformed
  // escape drops the whole entry (it survives only as a foreign segment).
  it('reads what the library parses: last value of a duplicate wins, unknown names are ignored', () => {
    const { entries } = parseGrammar({ shellSubroute: '/', search: 'screen=projects;org=o1;org=o2;colour=a1;section=' });
    expect(entries).toHaveLength(1);
    expect(routeFromEntry(entries[0])).toEqual({ token: 'projects', org: 'o2' });
  });

  it('yields no route, and does not throw, when the screen segment is malformed', () => {
    const parsed = parseGrammar({ shellSubroute: '/', search: 'screen=projects;org=o1;%ZZ=1' });
    expect(parsed.entries.find((entry) => entry.domainKey === SCREEN_DOMAIN_KEY)).toBeUndefined();
    expect(parsed.foreignSegments.some((segment) => segment.startsWith('screen='))).toBe(true);
  });

  it('compares routes by value, treating absent and empty alike', () => {
    expect(routesEqual({ token: 'people', org: 'o1' }, { token: 'people', org: 'o1', section: '' })).toBe(true);
    expect(routesEqual({ token: 'people', org: 'o1' }, { token: 'people', org: 'o2' })).toBe(false);
    expect(routesEqual(null, { token: 'people' })).toBe(false);
    expect(routesEqual(null, undefined)).toBe(true);
  });
});
