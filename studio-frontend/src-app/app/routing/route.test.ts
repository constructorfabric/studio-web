import { describe, expect, it } from 'vitest';
import { parseGrammar, validateName } from '@gears-frontx/routing';
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
    const { entries } = parseGrammar({ shellSubroute: '/', search: 'screen=projects;org=o1;org=o2;artifact=a1;section=' });
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
