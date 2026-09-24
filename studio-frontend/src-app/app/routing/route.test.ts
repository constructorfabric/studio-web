import { describe, expect, it } from 'vitest';
import { validateName } from '@gears-frontx/routing';
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

  // Review Focus 3
  it('takes the first of a duplicated parameter and ignores what it does not know', () => {
    expect(
      routeFromEntry({
        extension: 'projects',
        params: [
          { name: 'org', value: 'o1' },
          { name: 'org', value: 'o2' },
          { name: 'artifact', value: 'a1' },
          { name: 'section', value: '' },
        ],
      })
    ).toEqual({ token: 'projects', org: 'o1' });
  });

  it('compares routes by value, treating absent and empty alike', () => {
    expect(routesEqual({ token: 'people', org: 'o1' }, { token: 'people', org: 'o1', section: '' })).toBe(true);
    expect(routesEqual({ token: 'people', org: 'o1' }, { token: 'people', org: 'o2' })).toBe(false);
    expect(routesEqual(null, { token: 'people' })).toBe(false);
    expect(routesEqual(null, undefined)).toBe(true);
  });
});
