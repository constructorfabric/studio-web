import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KeycloakOidcProvider,
  decodeJwtClaims,
  type StudioAuthStateEvent,
} from './keycloakOidcProvider';

const fetchMock = vi.fn();

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      access_token: 'at-1',
      expires_in: 300,
      refresh_token: 'rt-1',
      id_token: 'idt-1',
      ...overrides,
    }),
  } as Response;
}

/** A 200 whose body is not JSON (issuer misconfigured to an HTML page). */
function htmlResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;
}

function makeJwt(claims: Record<string, unknown>): string {
  // UTF-8-safe base64url: btoa alone throws on non-ASCII claim values.
  const enc = (o: unknown) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
}

describe('KeycloakOidcProvider', () => {
  let provider: KeycloakOidcProvider;

  beforeEach(() => {
    provider = new KeycloakOidcProvider();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    provider.destroy();
    sessionStorage.clear();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('login (oauth)', () => {
    it('returns a redirect with PKCE S256, state, and stores the one-shot values', async () => {
      const transition = await provider.login({ type: 'oauth', payload: {} });

      expect(transition.type).toBe('redirect');
      const url = new URL((transition as { redirectUrl: string }).redirectUrl);
      expect(url.pathname).toContain('/protocol/openid-connect/auth');
      expect(url.searchParams.get('client_id')).toBe('studio-portal');
      expect(url.searchParams.get('redirect_uri')).toBe(`${window.location.origin}/`);
      expect(url.searchParams.get('response_type')).toBe('code');
      // profile+email explicitly: the header depends on their claims.
      expect(url.searchParams.get('scope')).toBe('openid profile email');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      expect(url.searchParams.get('state')).toBe(sessionStorage.getItem('studio.oidc.state'));
      expect(sessionStorage.getItem('studio.oidc.verifier')).toBeTruthy();
    });

    it('passes the IdP hint through as kc_idp_hint', async () => {
      const transition = await provider.login({ type: 'oauth', payload: { idpHint: 'github' } });
      const url = new URL((transition as { redirectUrl: string }).redirectUrl);
      expect(url.searchParams.get('kc_idp_hint')).toBe('github');
    });

    it('fails with a readable message outside a secure context (no crypto.subtle)', async () => {
      vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
      await expect(provider.login({ type: 'oauth', payload: {} })).rejects.toThrow(
        'secure context'
      );
    });
  });

  describe('login (static-token)', () => {
    it('establishes an in-memory bearer session without expiry or refresh', async () => {
      const transition = await provider.login({ type: 'static-token', payload: { token: 'dev-token' } });
      expect(transition).toEqual({ type: 'none' });

      const session = await provider.getSession();
      expect(session).toEqual({ kind: 'bearer', token: 'dev-token' });
      expect(sessionStorage.getItem('studio.oidc.refresh')).toBeNull();
    });

    it('logout after a static-token session ends locally with no redirect', async () => {
      await provider.login({ type: 'static-token', payload: { token: 'dev-token' } });
      expect(await provider.logout()).toEqual({ type: 'none' });
      expect(await provider.getSession()).toBeNull();
    });

    it('is rejected outside dev builds', async () => {
      vi.stubEnv('DEV', false);
      await expect(
        provider.login({ type: 'static-token', payload: { token: 'dev-token' } })
      ).rejects.toThrow('only in dev builds');
      expect(await provider.getSession()).toBeNull();
    });
  });

  describe('handleCallback', () => {
    async function startAndCallback(params: Record<string, string>) {
      const t = await provider.login({ type: 'oauth', payload: {} });
      const state = new URL((t as { redirectUrl: string }).redirectUrl).searchParams.get('state')!;
      return provider.handleCallback({ params: { state, ...params } });
    }

    it('exchanges the code and establishes the session', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());

      const transition = await startAndCallback({ code: 'auth-code' });
      expect(transition).toEqual({ type: 'none' });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/protocol/openid-connect/token');
      const body = String(init.body);
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code=auth-code');
      expect(body).toContain('code_verifier=');

      expect(await provider.getSession()).toMatchObject({ kind: 'bearer', token: 'at-1' });
      expect(sessionStorage.getItem('studio.oidc.refresh')).toBe('rt-1');
      expect(sessionStorage.getItem('studio.oidc.id')).toBe('idt-1');
      // One-shot values are gone.
      expect(sessionStorage.getItem('studio.oidc.verifier')).toBeNull();
      expect(sessionStorage.getItem('studio.oidc.state')).toBeNull();
    });

    it('rejects a state mismatch without calling the token endpoint', async () => {
      await provider.login({ type: 'oauth', payload: {} });
      await expect(
        provider.handleCallback({ params: { code: 'auth-code', state: 'forged' } })
      ).rejects.toThrow('state mismatch');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails closed when a verifier exists but no state was stored', async () => {
      await provider.login({ type: 'oauth', payload: {} });
      sessionStorage.removeItem('studio.oidc.state'); // e.g. leftover prototype verifier
      await expect(
        provider.handleCallback({ params: { code: 'auth-code', state: 'anything' } })
      ).rejects.toThrow('state mismatch');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is a no-op when re-entered (StrictMode double invoke)', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await startAndCallback({ code: 'auth-code' });

      const second = await provider.handleCallback({ params: { code: 'auth-code' } });
      expect(second).toEqual({ type: 'none' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('surfaces a failed exchange as an error', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 400 } as Response);
      await expect(startAndCallback({ code: 'bad' })).rejects.toThrow('HTTP 400');
    });

    it('surfaces a non-JSON 200 exchange response as a readable error', async () => {
      fetchMock.mockResolvedValueOnce(htmlResponse());
      await expect(startAndCallback({ code: 'auth-code' })).rejects.toThrow('non-JSON');
    });

    it('caps the token exchange with a timeout signal', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await startAndCallback({ code: 'auth-code' });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('refresh', () => {
    beforeEach(() => {
      sessionStorage.setItem('studio.oidc.refresh', 'rt-0');
    });

    it('rotates the session on success', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: 'at-2', refresh_token: 'rt-2' }));
      const session = await provider.refresh();
      expect(session).toMatchObject({ kind: 'bearer', token: 'at-2' });
      expect(sessionStorage.getItem('studio.oidc.refresh')).toBe('rt-2');
    });

    it('clears the session and notifies on a rejected refresh', async () => {
      const events: string[] = [];
      provider.subscribe((e) => events.push(e.state));
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401 } as Response);

      expect(await provider.refresh()).toBeNull();
      expect(sessionStorage.getItem('studio.oidc.refresh')).toBeNull();
      expect(events).toContain('unauthenticated');
    });

    it('treats a non-JSON 200 as a rejected refresh instead of throwing', async () => {
      const events: string[] = [];
      provider.subscribe((e) => events.push(e.state));
      fetchMock.mockResolvedValueOnce(htmlResponse());

      // Must resolve null (not reject): a throw here escapes through
      // getSession → checkAuth and strands the gate on "Restoring session…".
      expect(await provider.refresh()).toBeNull();
      expect(sessionStorage.getItem('studio.oidc.refresh')).toBeNull();
      expect(events).toContain('unauthenticated');
    });

    it('keeps the refresh token on a network failure', async () => {
      fetchMock.mockRejectedValueOnce(new Error('offline'));
      expect(await provider.refresh()).toBeNull();
      expect(sessionStorage.getItem('studio.oidc.refresh')).toBe('rt-0');
    });

    it('caps the refresh with a timeout signal', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse());
      await provider.refresh();

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('treats an aborted (timed out) refresh like a network failure', async () => {
      // A hung IdP: the timeout signal fires and fetch rejects with
      // AbortError — the refresh token must survive for the next attempt.
      fetchMock.mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'));
      expect(await provider.refresh()).toBeNull();
      expect(sessionStorage.getItem('studio.oidc.refresh')).toBe('rt-0');
    });

    it('dedups concurrent refresh calls into one token request', async () => {
      let release!: (r: Response) => void;
      fetchMock.mockReturnValueOnce(new Promise((res) => (release = res)));

      const [a, b] = [provider.refresh(), provider.refresh()];
      release(tokenResponse({ access_token: 'at-3' }));
      expect(await a).toMatchObject({ token: 'at-3' });
      expect(await b).toMatchObject({ token: 'at-3' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('getSession refreshes an expired session transparently', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: 'at-old', expires_in: 1 }));
      await provider.refresh(); // establishes an already-nearly-expired session
      fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: 'at-new' }));

      expect(await provider.getSession()).toMatchObject({ token: 'at-new' });
    });

    it('discards a refresh that resolves after logout', async () => {
      const events: StudioAuthStateEvent[] = [];
      provider.subscribe((e) => events.push(e as StudioAuthStateEvent));
      let release!: (r: Response) => void;
      fetchMock.mockReturnValueOnce(new Promise((res) => (release = res)));

      const pending = provider.refresh();
      await provider.logout();
      release(tokenResponse({ access_token: 'at-zombie', refresh_token: 'rt-zombie' }));

      expect(await pending).toBeNull();
      // The zombie result must not resurrect the session or its storage.
      expect(await provider.getSession()).toBeNull();
      expect(sessionStorage.getItem('studio.oidc.refresh')).toBeNull();
      expect(events.filter((e) => e.state === 'authenticated')).toHaveLength(0);
    });
  });

  describe('proactive renewal', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      sessionStorage.setItem('studio.oidc.refresh', 'rt-0');
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('refreshes ahead of expiry and re-arms itself after a network blip', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse({ expires_in: 300 }));
      await provider.refresh(); // arms the timer at 300s - 60s skew = 240s

      // First proactive renewal hits a network blip: token kept, retry armed.
      fetchMock.mockRejectedValueOnce(new Error('offline'));
      await vi.advanceTimersByTimeAsync(240_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sessionStorage.getItem('studio.oidc.refresh')).toBe('rt-1');

      // The retry (MIN_RENEW_DELAY) succeeds — the loop survived the blip.
      fetchMock.mockResolvedValueOnce(tokenResponse({ access_token: 'at-2', refresh_token: 'rt-2' }));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sessionStorage.getItem('studio.oidc.refresh')).toBe('rt-2');
    });

    it('stops the loop after a rejected refresh cleared the token', async () => {
      fetchMock.mockResolvedValueOnce(tokenResponse({ expires_in: 300 }));
      await provider.refresh();

      fetchMock.mockResolvedValueOnce({ ok: false, status: 401 } as Response);
      await vi.advanceTimersByTimeAsync(240_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(600_000); // no further attempts
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('logout after SSO', () => {
    it('clears storage and redirects to the RP-initiated logout endpoint', async () => {
      sessionStorage.setItem('studio.oidc.refresh', 'rt-0');
      sessionStorage.setItem('studio.oidc.id', 'idt-0');

      const transition = await provider.logout();
      expect(transition.type).toBe('redirect');
      const url = new URL((transition as { redirectUrl: string }).redirectUrl);
      expect(url.pathname).toContain('/protocol/openid-connect/logout');
      expect(url.searchParams.get('id_token_hint')).toBe('idt-0');
      expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${window.location.origin}/`);
      expect(sessionStorage.getItem('studio.oidc.refresh')).toBeNull();
      expect(sessionStorage.getItem('studio.oidc.id')).toBeNull();
    });

    it('marks the transition as signed-out so the UI never says "expired"', async () => {
      const events: StudioAuthStateEvent[] = [];
      provider.subscribe((e) => events.push(e as StudioAuthStateEvent));
      sessionStorage.setItem('studio.oidc.refresh', 'rt-0');

      await provider.logout();
      const event = events.find((e) => e.state === 'unauthenticated');
      expect(event?.reason).toBe('signed-out');
    });

    it('also clears leftover one-shot PKCE values', async () => {
      sessionStorage.setItem('studio.oidc.verifier', 'v');
      sessionStorage.setItem('studio.oidc.state', 's');
      await provider.logout();
      expect(sessionStorage.getItem('studio.oidc.verifier')).toBeNull();
      expect(sessionStorage.getItem('studio.oidc.state')).toBeNull();
    });
  });

  describe('getIdentity', () => {
    it('decodes display claims from a JWT static token', async () => {
      const jwt = makeJwt({ sub: 'uuid-1', name: 'Ada L', email: 'ada@example.com' });
      await provider.login({ type: 'static-token', payload: { token: jwt } });

      const identity = await provider.getIdentity();
      expect(identity?.sub).toBe('uuid-1');
      expect(identity?.claims).toMatchObject({ name: 'Ada L', email: 'ada@example.com' });
    });

    it('prefers the ID token over access-token claims', async () => {
      sessionStorage.setItem('studio.oidc.id', makeJwt({ sub: 'id-sub', name: 'From IdToken' }));
      await provider.login({
        type: 'static-token',
        payload: { token: makeJwt({ sub: 'at-sub', name: 'From Access' }) },
      });

      const identity = await provider.getIdentity();
      expect(identity?.sub).toBe('id-sub');
      expect(identity?.claims).toMatchObject({ name: 'From IdToken' });
    });

    it('yields null for opaque (non-JWT) tokens', async () => {
      await provider.login({ type: 'static-token', payload: { token: 'studio-admin-token' } });
      expect(await provider.getIdentity()).toBeNull();
    });

    it('is display-only: never triggers a network refresh', async () => {
      sessionStorage.setItem('studio.oidc.refresh', 'rt-0');
      sessionStorage.setItem('studio.oidc.id', makeJwt({ sub: 's-1' }));

      expect((await provider.getIdentity())?.sub).toBe('s-1');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('decodeJwtClaims', () => {
  it('returns null for garbage', () => {
    expect(decodeJwtClaims('not-a-jwt')).toBeNull();
    expect(decodeJwtClaims('a.%%%.c')).toBeNull();
  });

  it('decodes non-ASCII claims as UTF-8, not Latin-1', () => {
    const enc = (o: unknown) =>
      btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/=+$/, '');
    const jwt = `${enc({ alg: 'none' })}.${enc({ name: 'Zoë Müller' })}.sig`;
    expect(decodeJwtClaims(jwt)?.name).toBe('Zoë Müller');
  });
});
