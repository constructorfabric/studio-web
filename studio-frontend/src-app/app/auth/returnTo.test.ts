import { afterEach, describe, expect, it } from 'vitest';
import { rememberReturnTo, takeReturnTo, withoutCallbackParams } from './returnTo';

describe('returnTo', () => {
  afterEach(() => sessionStorage.clear());

  it('remembers the query and fragment, and gives them back once', () => {
    rememberReturnTo({ search: '?screen=projects;org=o1', hash: '#top' });
    expect(takeReturnTo()).toBe('?screen=projects;org=o1#top');
    expect(takeReturnTo()).toBeNull();
  });

  it('remembers nothing for a bare root, and clears what was there', () => {
    sessionStorage.setItem('studio.oidc.return_to', '?screen=people');
    rememberReturnTo({ search: '', hash: '' });
    expect(takeReturnTo()).toBeNull();
  });

  it('refuses anything that is not a relative query or fragment', () => {
    sessionStorage.setItem('studio.oidc.return_to', 'https://evil.example/');
    expect(takeReturnTo()).toBeNull();
    sessionStorage.setItem('studio.oidc.return_to', '/somewhere');
    expect(takeReturnTo()).toBeNull();
  });
});

describe('withoutCallbackParams', () => {
  const OIDC = ['code', 'state', 'session_state', 'iss', 'error', 'error_description'];

  it('drops the callback parameters and leaves every other segment byte-for-byte', () => {
    expect(withoutCallbackParams('?screen=people;org=o1&code=abc&state=xyz&iss=https%3A%2F%2Fidp', OIDC)).toBe(
      '?screen=people;org=o1'
    );
  });

  it('touches nothing when no callback parameter is present', () => {
    expect(withoutCallbackParams('?screen=projects;org=o1;workspace=w1', OIDC)).toBe('?screen=projects;org=o1;workspace=w1');
    expect(withoutCallbackParams('', OIDC)).toBe('');
  });

  it('returns an empty string when only callback parameters were there', () => {
    expect(withoutCallbackParams('?code=abc&state=xyz', OIDC)).toBe('');
  });
});
