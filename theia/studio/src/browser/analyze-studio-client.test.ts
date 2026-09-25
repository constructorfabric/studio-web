import 'reflect-metadata';
import { StudioApi } from './studio-api';
import { AnalyzeStudioClient, DocumentBinding, matchBindingByPath, pathCandidates, toFinding } from './analyze-studio-client';

const PROJECT_TYPE = 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.project.v1~';
const WORKSPACE_TYPE = 'gts.cf.core.am.tenant_type.v1~cf.studio.tenant.workspace.v1~';

type Route = (url: URL, init: RequestInit | undefined) => { status?: number; body?: unknown } | undefined;

/** A `fetch` that answers from routes, and remembers what it was asked. */
function stubFetch(route: Route): jest.Mock {
    const mock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost/');
        const answer = route(url, init) ?? { status: 404, body: { detail: 'no route' } };
        const status = answer.status ?? 200;
        const text = answer.body === undefined ? '' : JSON.stringify(answer.body);
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => JSON.parse(text),
            text: async () => text,
        } as Response;
    });
    (globalThis as { fetch: unknown }).fetch = mock;
    return mock;
}

function binding(id: string, path: string, extra: Partial<DocumentBinding> = {}): DocumentBinding {
    return { id, node_id: `node-${id}`, path, state: 'confirmed', type_key: 'prd', updated_at: '2026-09-20T00:00:00Z', ...extra };
}

describe('AnalyzeStudioClient', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
        StudioApi.scope = '';
        StudioApi.token = 'portal-token';
    });

    afterEach(() => {
        (globalThis as { fetch: unknown }).fetch = realFetch;
        StudioApi.scope = '';
        StudioApi.token = '';
    });

    it('takes a project session\'s project from the handshake and its workspace from the tenant\'s parent', async () => {
        StudioApi.scope = 'project-1';
        const fetchMock = stubFetch(url => url.pathname === '/studio-api/account-management/v1/tenants/project-1'
            ? { body: { id: 'project-1', tenant_type: PROJECT_TYPE, parent_id: 'ws-1' } }
            : undefined);

        const client = new AnalyzeStudioClient();
        await expect(client.scope([])).resolves.toEqual({ kind: 'project', workspaceId: 'ws-1', projectId: 'project-1' });
        // With the portal's token, through the session gate.
        const [, init] = fetchMock.mock.calls[0];
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer portal-token');
        // Asked once: the tenant does not change under a session.
        await client.scope([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('lists a workspace session\'s projects, since a file belongs to whichever has its binding', async () => {
        StudioApi.scope = 'ws-1';
        stubFetch(url => {
            if (url.pathname === '/studio-api/account-management/v1/tenants/ws-1') {
                return { body: { id: 'ws-1', tenant_type: WORKSPACE_TYPE, parent_id: 'org-1' } };
            }
            if (url.pathname === '/studio-api/account-management/v1/tenants/ws-1/children') {
                return { body: { items: [{ id: 'p-1', tenant_type: PROJECT_TYPE }, { id: 'other', tenant_type: 'something.else' }, { id: 'p-2', tenant_type: PROJECT_TYPE }] } };
            }
            return undefined;
        });
        await expect(new AnalyzeStudioClient().scope([])).resolves.toEqual({ kind: 'workspace', workspaceId: 'ws-1', projectIds: ['p-1', 'p-2'] });
    });

    it('asks the desktop backend which tenant a folder was opened for when there is no handshake', async () => {
        const fetchMock = stubFetch(url => {
            if (url.pathname === '/studio-desktop/opened') {
                return url.searchParams.get('root') === 'C:\\Users\\me\\ConstructorStudio\\workspaces\\Web'
                    ? { body: { tenantId: 'project-9' } }
                    : { status: 404, body: { error: 'this folder was not opened from Studio' } };
            }
            if (url.pathname === '/studio-api/account-management/v1/tenants/project-9') {
                return { body: { id: 'project-9', tenant_type: PROJECT_TYPE, parent_id: 'ws-9' } };
            }
            return undefined;
        });
        const scope = await new AnalyzeStudioClient().scope(['C:\\elsewhere', 'C:\\Users\\me\\ConstructorStudio\\workspaces\\Web']);
        expect(scope).toEqual({ kind: 'project', workspaceId: 'ws-9', projectId: 'project-9' });
        expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('studio-desktop/opened'))).toHaveLength(2);
    });

    it('knows no scope when nothing names one, and does not remember a refusal', async () => {
        stubFetch(() => undefined);
        const client = new AnalyzeStudioClient();
        await expect(client.scope(['/workspace'])).resolves.toBeUndefined();

        StudioApi.scope = 'project-1';
        let allowed = false;
        stubFetch(url => url.pathname.endsWith('/tenants/project-1')
            ? allowed ? { body: { id: 'project-1', tenant_type: PROJECT_TYPE, parent_id: 'ws-1' } } : { status: 401, body: {} }
            : undefined);
        await expect(client.scope([])).resolves.toBeUndefined();
        allowed = true;
        await expect(client.scope([])).resolves.toMatchObject({ projectId: 'project-1' });
    });

    it('reads every binding of the project, page by page to total', async () => {
        const all = Array.from({ length: 450 }, (_, i) => binding(`b${i}`, `docs/${i}.md`));
        const fetchMock = stubFetch(url => {
            if (url.pathname !== '/studio-api/studio-documents/v1/workspaces/ws-1/projects/p-1/document-bindings') {
                return undefined;
            }
            const offset = Number(url.searchParams.get('offset'));
            const limit = Number(url.searchParams.get('limit'));
            return { body: { items: all.slice(offset, offset + limit), total: all.length } };
        });
        const client = new AnalyzeStudioClient();
        const items = await client.bindings('ws-1', 'p-1');
        expect(items).toHaveLength(450);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        // Held briefly, so switching tabs does not re-read thousands of rows.
        await client.bindings('ws-1', 'p-1');
        expect(fetchMock).toHaveBeenCalledTimes(3);
        client.invalidate('ws-1', 'p-1');
        await client.bindings('ws-1', 'p-1');
        expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it('reads the findings of one subject out of the project\'s spec_finding nodes', async () => {
        stubFetch(url => {
            if (url.pathname !== '/studio-api/studio-artifact-ingest/v1/nodes') {
                return undefined;
            }
            expect(url.searchParams.get('type')).toBe('spec_finding');
            expect(url.searchParams.get('scope')).toBe('p-1');
            return {
                body: {
                    total: 3,
                    nodes: [
                        { value: { detector: 'purpose', subject: 'studio-doc:d-1', score: 0.9, severity: 'gate-passed', recorded_at: '2026-09-24T08:00:00Z' } },
                        { value: { detector: 'leak', subject: 'node-other', score: 0.4 } },
                        { value: { title: 'not a finding' } },
                    ],
                },
            };
        });
        const found = await new AnalyzeStudioClient().findings('p-1', 'studio-doc:d-1');
        expect(found).toEqual([{
            detector: 'purpose', subject: 'studio-doc:d-1', score: 0.9, severity: 'gate-passed', recordedAt: '2026-09-24T08:00:00Z',
            path: undefined, summary: undefined, details: undefined,
        }]);
    });

    it('starts a detector with the text on screen, and reports Studio\'s reason when it refuses', async () => {
        const fetchMock = stubFetch((url, init) => {
            if (url.pathname === '/studio-api/studio-documents/v1/workspaces/ws-1/projects/p-1/quality/purpose') {
                return { body: { run_id: 'run-1', poll: '/studio-tasks/v1/runs/run-1', documents: 1 } };
            }
            if (url.pathname.endsWith('/quality/leak')) {
                expect(init?.method).toBe('POST');
                return { status: 400, body: { detail: '`big.md` is 300000 bytes; an inline document is at most 262144' } };
            }
            return undefined;
        });
        const client = new AnalyzeStudioClient();
        const body = { binding_ids: [], documents: [{ path: 'docs/prd.md', text: '# PRD\nunsaved', type_key: 'prd' }] };
        await expect(client.startRun('ws-1', 'p-1', 'purpose', body)).resolves.toMatchObject({ run_id: 'run-1' });
        expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual(body);
        await expect(client.startRun('ws-1', 'p-1', 'leak', body)).rejects.toThrow('an inline document is at most 262144');
    });

    it('asks for a set detector\'s verdict with every path of the set', async () => {
        const fetchMock = stubFetch(url => url.pathname === '/studio-api/studio-spec-quality/v1/verdicts'
            ? { body: { detector: 'bloat', task_id: 't-1', by_path: {} } }
            : undefined);
        await new AnalyzeStudioClient().verdict('t-1', 'bloat', ['a.md', 'b.md']);
        const url = new URL(String(fetchMock.mock.calls[0][0]));
        expect(url.searchParams.get('task_id')).toBe('t-1');
        expect(url.searchParams.getAll('path')).toEqual(['a.md', 'b.md']);
    });
});

describe('finding a file among the bindings by path', () => {
    it('tries the whole relative path first, then drops one leading folder at a time', () => {
        expect(pathCandidates('api/docs/prd.md')).toEqual(['api/docs/prd.md', 'docs/prd.md', 'prd.md']);
        expect(pathCandidates('README.md')).toEqual(['README.md']);
    });

    it('finds a file cloned into a source folder under its repository path', () => {
        const bindings = [binding('1', 'docs/prd.md'), binding('2', 'docs/adr.md')];
        const match = matchBindingByPath(bindings, pathCandidates('api/docs/prd.md'));
        expect(match).toEqual({ kind: 'found', binding: bindings[0] });
    });

    it('prefers the most specific path any binding answers to', () => {
        const bindings = [binding('root', 'api/docs/prd.md'), binding('nested', 'docs/prd.md')];
        expect(matchBindingByPath(bindings, pathCandidates('api/docs/prd.md'))).toMatchObject({ kind: 'found', binding: { id: 'root' } });
    });

    it('refuses to guess between two repositories\' files at one path', () => {
        const bindings = [binding('1', 'README.md'), binding('2', 'README.md')];
        expect(matchBindingByPath(bindings, pathCandidates('web/README.md'))).toEqual({ kind: 'ambiguous', path: 'README.md', count: 2 });
    });

    it('finds nothing for a file Studio has no binding for', () => {
        expect(matchBindingByPath([binding('1', 'docs/prd.md')], pathCandidates('notes/todo.md'))).toEqual({ kind: 'none' });
    });

    it('reads a finding node and ignores a node that is not one', () => {
        expect(toFinding({ detector: 'bloat', subject: 's', score: 2, details: { repeats: ['a.md'] } })).toMatchObject({ score: 2, details: { repeats: ['a.md'] } });
        expect(toFinding({ subject: 's' })).toBeUndefined();
        expect(toFinding(undefined)).toBeUndefined();
    });
});
