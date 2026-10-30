import * as crypto from 'crypto';
import * as http from 'http';

/**
 * Signing a desktop Studio in (ADR-0027 §2): the authorization code flow with
 * PKCE, through the system browser, to a loopback redirect (RFC 8252).
 *
 * The desktop is a public client, so it holds no secret; what proves the code
 * is ours is the verifier only this process knows. Keycloak ignores the port
 * of a `http://127.0.0.1` redirect, so the listener takes any free port and
 * the realm registers `http://127.0.0.1/*` once.
 *
 * Nothing here depends on Theia: the module is plain Node, so the same code
 * signs in from the IDE's backend and from a script.
 */

export interface DesktopTokens {
    readonly accessToken: string;
    readonly refreshToken?: string;
    /** Epoch milliseconds at which the access token stops being accepted. */
    readonly expiresAt: number;
}

export interface SignInOptions {
    /** The realm's issuer, e.g. `https://studio.example.com/realms/studio`. */
    readonly issuer: string;
    readonly clientId: string;
    /** Opens the system browser. Injected so a test can follow the redirect itself. */
    readonly openBrowser: (url: string) => void | Promise<void>;
    /** How long to wait for the person to finish in the browser. */
    readonly timeoutMs?: number;
    /** Talks to the token endpoint; `fetch` unless a test says otherwise. */
    readonly fetchImpl?: typeof fetch;
}

interface Endpoints {
    readonly authorization: string;
    readonly token: string;
}

function base64Url(bytes: Buffer): string {
    return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A PKCE verifier and its S256 challenge (RFC 7636 §4.1–4.2). */
export function pkcePair(): { verifier: string; challenge: string } {
    const verifier = base64Url(crypto.randomBytes(32));
    const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

/**
 * Keycloak's endpoints, from the issuer alone. Discovery would be one more
 * request that can fail before the browser opens, and a Keycloak realm's
 * endpoints are fixed by its issuer.
 */
export function keycloakEndpoints(issuer: string): Endpoints {
    const base = issuer.replace(/\/+$/, '');
    return {
        authorization: `${base}/protocol/openid-connect/auth`,
        token: `${base}/protocol/openid-connect/token`,
    };
}

export function authorizationUrl(
    endpoints: Endpoints, clientId: string, redirectUri: string, state: string, challenge: string
): string {
    const query = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'openid',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    });
    return `${endpoints.authorization}?${query}`;
}

function tokensFrom(body: Record<string, unknown>, now: number): DesktopTokens {
    const accessToken = body.access_token;
    if (typeof accessToken !== 'string' || !accessToken) {
        throw new Error('the token endpoint answered without an access token');
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 60;
    return {
        accessToken,
        refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
        expiresAt: now + expiresIn * 1000,
    };
}

/** The token endpoint answered, and said no: `status` is its HTTP status. */
export class TokenRefused extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

/**
 * The sign-in cannot be renewed: there is no refresh token, or the identity
 * provider no longer knows its session ("Token is not active" after a day).
 * Only signing in again helps, so whoever catches it signs the member out
 * rather than keep failing every call.
 */
export class SignInExpired extends Error { }

async function tokenRequest(
    endpoint: string, form: Record<string, string>, fetchImpl: typeof fetch
): Promise<DesktopTokens> {
    const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
        const reason = typeof body.error_description === 'string' ? body.error_description : body.error;
        throw new TokenRefused(`the token endpoint refused the request (${response.status}${reason ? `: ${reason}` : ''})`, response.status);
    }
    return tokensFrom(body, Date.now());
}

const DONE_PAGE = '<!doctype html><meta charset="utf-8"><title>Constructor Studio</title>'
    + '<body style="font-family:system-ui;padding:3rem">'
    + '<h1>Signed in</h1><p>You can close this tab and return to Constructor Studio.</p>';

/**
 * Run the whole flow once: listen on a loopback port, open the browser at the
 * realm's login, wait for the redirect, check `state`, and trade the code and
 * verifier for tokens. Resolves with the member's tokens or rejects with a
 * reason a person can read.
 */
export async function signIn(options: SignInOptions): Promise<DesktopTokens> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const endpoints = keycloakEndpoints(options.issuer);
    const { verifier, challenge } = pkcePair();
    const state = base64Url(crypto.randomBytes(16));

    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    try {
        const code = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error('sign-in was not finished in the browser in time')),
                options.timeoutMs ?? 5 * 60_000
            );
            server.on('request', (req, res) => {
                const url = new URL(req.url ?? '/', redirectUri);
                if (url.pathname !== '/callback') {
                    res.writeHead(404).end();
                    return;
                }
                const finish = (status: number, page: string, outcome: () => void): void => {
                    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
                    clearTimeout(timer);
                    outcome();
                };
                if (url.searchParams.get('state') !== state) {
                    // Not our flow: another tab, or somebody else's redirect.
                    // Refuse it without ending ours.
                    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('This sign-in link is not the one Studio started.');
                    return;
                }
                const error = url.searchParams.get('error');
                if (error) {
                    const detail = url.searchParams.get('error_description') ?? error;
                    finish(400, `<p>Sign-in failed: ${detail.replace(/[<>&]/g, '')}</p>`,
                        () => reject(new Error(`sign-in failed: ${detail}`)));
                    return;
                }
                const received = url.searchParams.get('code');
                if (!received) {
                    finish(400, '<p>Sign-in failed: no code.</p>', () => reject(new Error('the redirect carried no code')));
                    return;
                }
                finish(200, DONE_PAGE, () => resolve(received));
            });
            Promise.resolve(options.openBrowser(authorizationUrl(endpoints, options.clientId, redirectUri, state, challenge)))
                .catch(reject);
        });
        return await tokenRequest(endpoints.token, {
            grant_type: 'authorization_code',
            client_id: options.clientId,
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
        }, fetchImpl);
    } finally {
        server.close();
    }
}

/**
 * The signed-in member, kept current. `accessToken()` is what every caller
 * asks — the Git credential helper, the Studio API client — and it refreshes
 * shortly before expiry, so nobody holds a token that is about to be refused.
 */
export class DesktopSession {
    private pending: Promise<DesktopTokens> | undefined;

    constructor(
        private readonly issuer: string,
        private readonly clientId: string,
        private tokens: DesktopTokens,
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly now: () => number = Date.now,
    ) { }

    async accessToken(): Promise<string> {
        if (this.tokens.expiresAt - this.now() > 30_000) {
            return this.tokens.accessToken;
        }
        const refreshToken = this.tokens.refreshToken;
        if (!refreshToken) {
            throw new SignInExpired('the Studio sign-in has expired; sign in again');
        }
        // One refresh at a time: a push asks for credentials twice in a row,
        // and a refresh token may only be used once.
        this.pending ??= tokenRequest(keycloakEndpoints(this.issuer).token, {
            grant_type: 'refresh_token',
            client_id: this.clientId,
            refresh_token: refreshToken,
        }, this.fetchImpl);
        try {
            this.tokens = await this.pending;
        } catch (error) {
            // 400/401 from the token endpoint is a refresh token it will never
            // take again (invalid_grant); anything else may pass.
            if (error instanceof TokenRefused && (error.status === 400 || error.status === 401)) {
                throw new SignInExpired(`the Studio sign-in has expired; sign in again (${error.message})`);
            }
            throw error;
        } finally {
            this.pending = undefined;
        }
        return this.tokens.accessToken;
    }
}
