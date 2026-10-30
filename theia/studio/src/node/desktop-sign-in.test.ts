/**
 * @jest-environment node
 */
import * as crypto from 'crypto';
import { DesktopSession, SignInExpired, authorizationUrl, keycloakEndpoints, pkcePair, signIn } from './desktop-sign-in';

const ISSUER = 'https://sso.example.com/realms/studio';

function tokenAnswer(body: Record<string, unknown>, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A browser that follows the login straight back to the redirect it was given. */
function browserReturning(params: (authorize: URL) => Record<string, string>): (url: string) => Promise<void> {
    return async url => {
        const authorize = new URL(url);
        const back = new URL(authorize.searchParams.get('redirect_uri')!);
        for (const [key, value] of Object.entries(params(authorize))) {
            back.searchParams.set(key, value);
        }
        await fetch(back.toString());
    };
}

describe('desktop sign-in', () => {
    it('pairs a verifier with its S256 challenge', () => {
        const { verifier, challenge } = pkcePair();
        const expected = crypto.createHash('sha256').update(verifier).digest('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        expect(challenge).toBe(expected);
        expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('asks the realm for a code with PKCE, never for a token', () => {
        const url = new URL(authorizationUrl(keycloakEndpoints(ISSUER), 'studio-desktop', 'http://127.0.0.1:5555/callback', 's1', 'c1'));
        expect(url.origin + url.pathname).toBe(`${ISSUER}/protocol/openid-connect/auth`);
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('code_challenge')).toBe('c1');
        expect(url.searchParams.get('state')).toBe('s1');
    });

    it('trades the returned code and its verifier for tokens', async () => {
        let challenge = '';
        const fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
            const form = new URLSearchParams(init.body as string);
            const verifier = form.get('code_verifier')!;
            const derived = crypto.createHash('sha256').update(verifier).digest('base64')
                .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            expect(derived).toBe(challenge);
            expect(form.get('code')).toBe('the-code');
            expect(form.get('grant_type')).toBe('authorization_code');
            return tokenAnswer({ access_token: 'at', refresh_token: 'rt', expires_in: 300 });
        });
        const tokens = await signIn({
            issuer: ISSUER,
            clientId: 'studio-desktop',
            fetchImpl: fetchImpl as unknown as typeof fetch,
            openBrowser: browserReturning(authorize => {
                challenge = authorize.searchParams.get('code_challenge')!;
                return { code: 'the-code', state: authorize.searchParams.get('state')! };
            }),
        });
        expect(tokens.accessToken).toBe('at');
        expect(tokens.refreshToken).toBe('rt');
        expect(fetchImpl).toHaveBeenCalledWith(`${ISSUER}/protocol/openid-connect/token`, expect.anything());
    });

    it('does not accept a redirect for a flow it did not start', async () => {
        const run = signIn({
            issuer: ISSUER,
            clientId: 'studio-desktop',
            timeoutMs: 1_500,
            fetchImpl: (async () => tokenAnswer({ access_token: 'never' })) as unknown as typeof fetch,
            openBrowser: browserReturning(() => ({ code: 'stolen', state: 'someone-else' })),
        });
        await expect(run).rejects.toThrow('not finished in the browser in time');
    });

    it('reports what the realm said when the person refused', async () => {
        const run = signIn({
            issuer: ISSUER,
            clientId: 'studio-desktop',
            openBrowser: browserReturning(authorize => ({
                state: authorize.searchParams.get('state')!, error: 'access_denied', error_description: 'User denied',
            })),
        });
        await expect(run).rejects.toThrow('sign-in failed: User denied');
    });
});

describe('desktop session', () => {
    it('hands out the token it has while it is fresh', async () => {
        const fetchImpl = jest.fn();
        const session = new DesktopSession(ISSUER, 'studio-desktop',
            { accessToken: 'a1', refreshToken: 'r1', expiresAt: 1_000_000 }, fetchImpl as unknown as typeof fetch, () => 0);
        await expect(session.accessToken()).resolves.toBe('a1');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('refreshes once for callers that ask together near expiry', async () => {
        const fetchImpl = jest.fn(async () => tokenAnswer({ access_token: 'a2', refresh_token: 'r2', expires_in: 300 }));
        const session = new DesktopSession(ISSUER, 'studio-desktop',
            { accessToken: 'a1', refreshToken: 'r1', expiresAt: 10_000 }, fetchImpl as unknown as typeof fetch, () => 0);
        const [first, second] = await Promise.all([session.accessToken(), session.accessToken()]);
        expect([first, second]).toEqual(['a2', 'a2']);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('says to sign in again when there is nothing to refresh with', async () => {
        const session = new DesktopSession(ISSUER, 'studio-desktop',
            { accessToken: 'a1', expiresAt: 0 }, jest.fn() as unknown as typeof fetch, () => 0);
        await expect(session.accessToken()).rejects.toThrow('sign in again');
    });

    it('says the sign-in expired when the identity provider will not renew it, and not for an outage', async () => {
        const refused = new DesktopSession(ISSUER, 'studio-desktop', { accessToken: 'a1', refreshToken: 'r1', expiresAt: 0 },
            (async () => tokenAnswer({ error: 'invalid_grant', error_description: 'Token is not active' }, 400)) as unknown as typeof fetch, () => 0);
        await expect(refused.accessToken()).rejects.toBeInstanceOf(SignInExpired);
        const down = new DesktopSession(ISSUER, 'studio-desktop', { accessToken: 'a1', refreshToken: 'r1', expiresAt: 0 },
            (async () => tokenAnswer({ error: 'temporarily_unavailable' }, 503)) as unknown as typeof fetch, () => 0);
        const error = await down.accessToken().catch(e => e);
        expect(error).not.toBeInstanceOf(SignInExpired);
        expect(String(error)).toMatch(/503/);
    });
});
