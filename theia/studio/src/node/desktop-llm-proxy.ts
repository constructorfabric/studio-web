import * as crypto from 'crypto';
import * as http from 'http';
import { Readable } from 'stream';

/**
 * Claude Code and Codex on the desktop, on the member's own key -- the desktop
 * form of what a session does with `STUDIO_LLM_AUTH=bearer` (ADR-0030).
 *
 * The assistants call their providers at ANTHROPIC_BASE_URL / OPENAI_BASE_URL,
 * which point here: a loopback server, because the IDE backend's own routes
 * answer only requests carrying the window's security cookie, and a `claude`
 * started by the extension carries none. Each call is passed on, streamed, to
 * Studio's provider proxy (`/studio-llm/v1/providers/<provider>/...`) with the
 * member's Studio token, fresh every time, and the proxy answers with the
 * member's key: their profile key, else an AI connection they reach
 * (studio-backend `llm_proxy/keys.rs`). No provider key is on this machine.
 *
 * What the assistants carry where a key would be is a random secret, worthless
 * once this process exits; anything that does not present it gets a 401.
 */
export interface LlmProxy {
    /** The environment that points Claude Code and Codex here. */
    readonly env: Readonly<Record<string, string>>;
    /** What to take out of the environment for them (see `assistantEnvironment`). */
    readonly unset: readonly string[];
    close(): Promise<void>;
}

/** The providers Studio's proxy serves, by the path segment it names them with. */
const PROVIDERS = ['anthropic', 'openai'];

/** Hop-by-hop headers, and the caller's credentials, which are this proxy's to set. */
const DROPPED_REQUEST_HEADERS = new Set([
    'host', 'connection', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
    'content-length', 'expect', 'accept-encoding', 'authorization', 'x-api-key', 'cookie',
]);

/** Hop-by-hop headers, and what `fetch` already undid (it decompresses). */
const DROPPED_RESPONSE_HEADERS = new Set([
    'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding',
]);

/** The request's headers as the provider proxy should see them: the agent's own, without its credentials. */
export function forwardedRequestHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) {
            continue;
        }
        out[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    return out;
}

/** The answer's headers as the agent should see them. */
export function forwardedResponseHeaders(headers: Headers): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    headers.forEach((value, name) => {
        if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
            out.push([name, value]);
        }
    });
    return out;
}

/**
 * The environment for the assistants. A provider the member already points
 * somewhere else themselves (its BASE_URL set) is left to them. Otherwise
 * ANTHROPIC_API_KEY is dropped, since Claude Code prefers it to the token and
 * would send that key here instead of the secret.
 */
export function assistantEnvironment(base: string, secret: string, env: NodeJS.ProcessEnv): { set: Record<string, string>; unset: string[] } {
    const set: Record<string, string> = {};
    const unset: string[] = [];
    if (!env.ANTHROPIC_BASE_URL) {
        set.ANTHROPIC_BASE_URL = `${base}/anthropic`;
        set.ANTHROPIC_AUTH_TOKEN = secret;
        unset.push('ANTHROPIC_API_KEY');
    }
    if (!env.OPENAI_BASE_URL) {
        set.OPENAI_BASE_URL = `${base}/openai`;
        set.OPENAI_API_KEY = secret;
    }
    return { set, unset };
}

/** The whole request body. By events: the build's Node types give `IncomingMessage` no async iterator. */
export function readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function refuse(res: http.ServerResponse, status: number, message: string): void {
    // The shape both providers answer errors in, so the assistant shows the message.
    res.writeHead(status, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'api_error', message } }));
}

/**
 * Serve the assistants. `studio` is the gateway's address of the Studio
 * signed in to (`<studio URL><gateway prefix>`), asked on every call since
 * the member may switch Studios; `undefined` while there is none.
 */
export async function startLlmProxy(studio: () => string | undefined, token: () => Promise<string>, env: NodeJS.ProcessEnv = process.env): Promise<LlmProxy> {
    const secret = crypto.randomBytes(32).toString('hex');
    const server = http.createServer(async (req, res) => {
        const presented = req.headers.authorization === `Bearer ${secret}` || req.headers['x-api-key'] === secret;
        const provider = (req.url ?? '').split('/')[1];
        if (!presented || !PROVIDERS.includes(provider)) {
            refuse(res, 401, 'This address answers only the assistants Constructor Studio started.');
            return;
        }
        const target = studio();
        let bearer: string;
        try {
            if (!target) {
                throw new Error('no Studio');
            }
            bearer = await token();
        } catch {
            refuse(res, 401, 'Sign in to Constructor Studio: the assistants use the key from your Studio profile.');
            return;
        }
        try {
            const received = await readBody(req);
            const hasBody = !['GET', 'HEAD'].includes(req.method ?? 'GET');
            const answer = await fetch(`${target}/studio-llm/v1/providers${req.url}`, {
                method: req.method,
                headers: { ...forwardedRequestHeaders(req.headers), Authorization: `Bearer ${bearer}` },
                body: hasBody ? received : undefined,
            });
            res.writeHead(answer.status, forwardedResponseHeaders(answer.headers));
            if (!answer.body) {
                res.end();
                return;
            }
            // Streamed as it comes: the agents read server-sent events.
            Readable.fromWeb(answer.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
        } catch (error) {
            if (res.headersSent) {
                res.end();
            } else {
                refuse(res, 502, `Constructor Studio could not be reached: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    const { set, unset } = assistantEnvironment(`http://127.0.0.1:${port}`, secret, env);
    return {
        env: set,
        unset,
        close: () => new Promise<void>(resolve => server.close(() => resolve())),
    };
}
