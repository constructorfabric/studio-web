import 'reflect-metadata';
import { StudioApi } from './studio-api';
import { DesktopDomainModelClient, DomainModelError, failureText } from './desktop-domain-model-client';

type Answer = { status?: number; body?: unknown };

/** A `fetch` answering every call with `answer`, remembering what it was asked. */
function stubFetch(answer: (url: URL, init?: RequestInit) => Answer): jest.Mock {
    const mock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const { status = 200, body } = answer(new URL(String(input), 'http://localhost/'), init);
        const text = body === undefined ? '' : JSON.stringify(body);
        return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text } as Response;
    });
    (globalThis as { fetch: unknown }).fetch = mock;
    return mock;
}

describe('DesktopDomainModelClient', () => {
    const realFetch = globalThis.fetch;
    const client = new DesktopDomainModelClient();

    beforeEach(() => {
        StudioApi.token = 'member-token';
    });

    afterEach(() => {
        (globalThis as { fetch: unknown }).fetch = realFetch;
    });

    it('reads the model, its findings and its glossary from the documents gear, for the project', async () => {
        const fetch = stubFetch(() => ({ body: { items: [{ fingerprint: 'f' }], build: { running: false } } }));
        await client.model('p 1');
        expect((await client.findings('p 1')).map(f => f.fingerprint)).toEqual(['f']);
        await client.glossary('p 1');
        const urls = fetch.mock.calls.map(([url]) => new URL(String(url), 'http://localhost/'));
        expect(urls.map(u => u.pathname.replace(/^.*\/studio-api/, ''))).toEqual([
            '/studio-documents/v1/spec-model',
            '/studio-documents/v1/spec-model/findings',
            '/studio-documents/v1/spec-model/glossary',
        ]);
        expect(urls.every(u => u.searchParams.get('project_id') === 'p 1')).toBe(true);
        expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer member-token');
    });

    it('starts a build for the project, or for one document again', async () => {
        const fetch = stubFetch(() => ({ body: { running: true } }));
        await client.startBuild('p');
        await client.startBuild('p', 'docs/a.md');
        expect(fetch.mock.calls.map(([, init]) => [init.method, JSON.parse(init.body)])).toEqual([
            ['POST', { project_id: 'p' }],
            ['POST', { project_id: 'p', path: 'docs/a.md' }],
        ]);
    });

    it('sends a decision on a finding by its fingerprint', async () => {
        const fetch = stubFetch(() => ({ body: {} }));
        await client.decide('p', '9f86d081884c7d65', 'dismissed');
        expect(String(fetch.mock.calls[0][0])).toMatch(/\/studio-documents\/v1\/spec-model\/findings\/9f86d081884c7d65\/decision$/);
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ project_id: 'p', decision: 'dismissed' });
    });

    it('reads a server with no glossary as an empty one', async () => {
        stubFetch(() => ({ status: 404 }));
        await expect(client.glossary('p')).resolves.toEqual([]);
        await expect(client.model('p')).rejects.toBeInstanceOf(DomainModelError);
    });

    it('says the gear\'s own words when a call fails, and why when it gave none', async () => {
        stubFetch(() => ({ status: 409, body: { detail: 'No model key: add one in your profile.' } }));
        const refused = await client.startBuild('p').catch(e => e);
        expect(failureText(refused)).toBe('No model key: add one in your profile.');
        expect(failureText(new DomainModelError(503, 'signed-out'))).toMatch(/^Sign in to Constructor Studio/);
        expect(failureText(new DomainModelError(403))).toMatch(/not a member/);
        expect(failureText(new DomainModelError(500, 'bad-gateway'))).toBe('Studio answered 500 (bad-gateway).');
        expect(failureText(new Error('offline'))).toBe('offline');
    });
});
