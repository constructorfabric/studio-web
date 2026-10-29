/**
 * @jest-environment node
 */
import * as http from 'http';
import { LlmProxy, assistantEnvironment, readBody, startLlmProxy } from './desktop-llm-proxy';

interface Seen {
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    body: string;
}

/** A stand-in for Studio's gateway: records the call, answers in two chunks. */
async function fakeStudio(seen: Seen[]): Promise<{ url: string; close(): Promise<void> }> {
    const server = http.createServer(async (req, res) => {
        const body = (await readBody(req)).toString('utf8');
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'request-id': 'req-1' });
        res.write('event: one\n\n');
        setTimeout(() => res.end('event: two\n\n'), 10);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/cf`, close: () => new Promise(resolve => server.close(() => resolve())) };
}

describe('desktop LLM proxy', () => {
    let proxy: LlmProxy;
    let studio: { url: string; close(): Promise<void> };
    let seen: Seen[];
    let signedIn: boolean;

    beforeEach(async () => {
        seen = [];
        signedIn = true;
        studio = await fakeStudio(seen);
        proxy = await startLlmProxy(
            () => studio.url,
            async () => { if (!signedIn) { throw new Error('not signed in'); } return 'studio-token'; },
            {},
        );
    });
    afterEach(async () => {
        await proxy.close();
        await studio.close();
    });

    it('passes a call on to Studio\'s provider proxy as the member, with the agent\'s own headers, streamed', async () => {
        const res = await fetch(`${proxy.env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
            method: 'POST',
            headers: { 'x-api-key': proxy.env.ANTHROPIC_AUTH_TOKEN, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
            body: '{"model":"m"}',
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('request-id')).toBe('req-1');
        expect(await res.text()).toBe('event: one\n\nevent: two\n\n');
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ method: 'POST', url: '/cf/studio-llm/v1/providers/anthropic/v1/messages?beta=true', body: '{"model":"m"}' });
        expect(seen[0].headers.authorization).toBe('Bearer studio-token');
        expect(seen[0].headers['anthropic-version']).toBe('2023-06-01');
        // The secret never leaves this machine.
        expect(seen[0].headers['x-api-key']).toBeUndefined();
    });

    it('takes the secret as a bearer too, the way the OpenAI client sends it', async () => {
        const res = await fetch(`${proxy.env.OPENAI_BASE_URL}/responses`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${proxy.env.OPENAI_API_KEY}` },
            body: '{}',
        });
        expect(res.status).toBe(200);
        expect(seen[0].url).toBe('/cf/studio-llm/v1/providers/openai/responses');
    });

    it('refuses whoever does not hold the secret, and asks nothing of Studio', async () => {
        const res = await fetch(`${proxy.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'sk-ant-guess' }, body: '{}' });
        expect(res.status).toBe(401);
        expect(seen).toHaveLength(0);
    });

    it('says to sign in when nobody is', async () => {
        signedIn = false;
        const res = await fetch(`${proxy.env.ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', headers: { 'x-api-key': proxy.env.ANTHROPIC_AUTH_TOKEN }, body: '{}' });
        expect(res.status).toBe(401);
        expect(JSON.stringify(await res.json())).toContain('Sign in to Constructor Studio');
        expect(seen).toHaveLength(0);
    });
});

describe('the assistants\' environment', () => {
    it('points both providers here, and drops a key Claude Code would send instead of the secret', () => {
        expect(assistantEnvironment('http://127.0.0.1:1', 's', { ANTHROPIC_API_KEY: 'sk-ant' })).toEqual({
            set: {
                ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/anthropic', ANTHROPIC_AUTH_TOKEN: 's',
                OPENAI_BASE_URL: 'http://127.0.0.1:1/openai', OPENAI_API_KEY: 's',
            },
            unset: ['ANTHROPIC_API_KEY'],
        });
    });

    it('leaves a provider the member points elsewhere themselves', () => {
        expect(assistantEnvironment('http://127.0.0.1:1', 's', { ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_API_KEY: 'k' })).toEqual({
            set: { OPENAI_BASE_URL: 'http://127.0.0.1:1/openai', OPENAI_API_KEY: 's' },
            unset: [],
        });
    });
});
