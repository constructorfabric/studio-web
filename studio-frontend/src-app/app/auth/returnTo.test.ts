import { afterEach, describe, expect, it } from 'vitest';
import { rememberReturnTo, takeReturnTo } from './returnTo';

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
