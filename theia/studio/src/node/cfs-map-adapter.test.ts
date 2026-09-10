import 'reflect-metadata';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CFS_MAP_SCHEMA_VERSION } from '../common/graph-model';
import {
    adaptCfsMap,
    CFS_MAP_RUNTIME_SCHEMA_PATH,
    CfsMapAdapterError,
    type CfsMapRegisteredRepository
} from './cfs-map-adapter';

describe('cfs map adapter', () => {
    let tempDir: string;
    let payload: Record<string, unknown>;
    let repositories: CfsMapRegisteredRepository[];

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-cfs-map-adapter-'));
        const docsRoot = path.join(tempDir, 'docs');
        const codeRoot = path.join(tempDir, 'code');
        await fs.mkdir(path.join(docsRoot, 'docs'), { recursive: true });
        await fs.mkdir(path.join(codeRoot, 'src'), { recursive: true });
        const canonicalDocsRoot = await fs.realpath(docsRoot);
        const canonicalCodeRoot = await fs.realpath(codeRoot);
        payload = await readFixture('cfs-map-v1.json');
        const workspace = payload.workspace as { sources: Array<{ name: string; path: string }> };
        workspace.sources.find(source => source.name === 'docs')!.path = canonicalDocsRoot;
        workspace.sources.find(source => source.name === 'code')!.path = canonicalCodeRoot;
        repositories = [
            repository('repo-docs', 'Docs', canonicalDocsRoot),
            repository('repo-code', 'Code', canonicalCodeRoot)
        ];
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('maps the canonical cfs node, edge, category, layout, and dangling-use contract', async () => {
        const snapshot = await adaptCfsMap(payload, {
            workspaceId: 'workspace',
            revision: 'revision-1',
            repositories,
            indexedAt: '2026-07-30T01:00:00Z',
            engine: { command: 'cfs', version: '1.7.0' }
        });

        expect(snapshot).toMatchObject({
            schemaVersion: 2,
            mapVersion: '1.0',
            workspaceId: 'workspace',
            revision: 'revision-1',
            primarySource: 'docs',
            indexedAt: '2026-07-30T01:00:00Z',
            stale: false
        });
        expect(snapshot.sources).toEqual([
            { name: 'docs', path: repositories[0].canonicalRoot, reachable: true, role: 'artifacts' },
            { name: 'code', path: repositories[1].canonicalRoot, reachable: true, role: 'codebase' }
        ]);
        expect(snapshot.nodes).toEqual([
            expect.objectContaining({
                id: 'docs:docs/spec.md',
                relPath: 'docs/spec.md',
                source: 'docs',
                kind: 'markdown',
                cptDefs: ['cpt-auth-login'],
                cptUses: [],
                position: { x: 10, y: 20 },
                location: {
                    workspaceId: 'workspace',
                    repositoryId: 'repo-docs',
                    repositoryRelativePath: 'docs/spec.md'
                }
            }),
            expect.objectContaining({
                id: 'code:src/login.ts',
                kind: 'source',
                cptUses: [
                    expect.objectContaining({
                        cptId: 'cpt-auth-login',
                        markerKind: 'scope'
                    }),
                    expect.objectContaining({
                        cptId: 'cpt-auth-missing',
                        markerKind: 'block-begin'
                    })
                ],
                position: { x: 210, y: 120 }
            }),
            expect.objectContaining({
                id: 'phantom:cpt-auth-missing',
                relPath: null,
                source: null,
                kind: 'phantom-cpt',
                position: { x: 410, y: 220 },
                location: {
                    workspaceId: 'workspace',
                    repositoryId: 'repo-docs',
                    repositoryRelativePath: '.'
                }
            })
        ]);
        expect(snapshot.edges).toEqual([
            expect.objectContaining({
                type: 'file-link',
                from: 'docs:docs/spec.md',
                to: 'code:src/login.ts',
                refs: [
                    {
                        cptId: null,
                        line: 6,
                        snippet: '[implementation](../../code/src/login.ts)',
                        defLine: null,
                        defSnippet: null
                    }
                ]
            }),
            expect.objectContaining({
                type: 'cpt-impl',
                refs: [expect.objectContaining({ cptId: 'cpt-auth-login', defLine: 3 })]
            }),
            expect.objectContaining({
                type: 'cpt-doc',
                dangling: true,
                refs: [expect.objectContaining({ cptId: 'cpt-auth-missing', defLine: null })]
            })
        ]);
        expect(snapshot.danglingCptUses).toEqual([
            {
                cptId: 'cpt-auth-missing',
                nodeId: 'code:src/login.ts',
                line: 9,
                snippet: '// @cpt-auth-missing'
            }
        ]);
        expect(snapshot.categories).toMatchObject({
            requirements: {
                nodeCount: 1,
                originCounts: { registry: 1 },
                style: { color: '#123456', background: '#eef3f8' }
            }
        });
        expect(snapshot.bucketRects).toEqual({
            docs: {
                id: 'docs',
                x: 0,
                y: 0,
                w: 180,
                h: 100,
                label: 'Docs'
            }
        });
        expect(snapshot.categoryBands).toEqual({
            requirements: {
                x: 0,
                y: 0,
                w: 190,
                h: 110,
                label: 'Requirements',
                fill: '#eef3f8',
                stroke: '#123456',
                titleColor: '#123456'
            },
            implementation: {
                x: 200,
                y: 100,
                w: 190,
                h: 110,
                label: 'Implementation'
            }
        });
    });

    it('rejects sources outside the server repository registry instead of publishing a truncated snapshot', async () => {
        const error = await expectFailure(adaptCfsMap(payload, {
            workspaceId: 'workspace',
            revision: 'revision-1',
            repositories: [repositories[0]],
            engine: { command: 'cfs', version: '1.7.0' }
        }));

        expect(error).toBeInstanceOf(CfsMapAdapterError);
        expect(error.path).toBe('$.workspace.sources[1].path');
        expect(error.message).toContain('register the source');
        expect(error.message).not.toContain(tempDir);
    });

    it('validates required canonical schema fields before adaptation', async () => {
        const categories = payload.categories as Record<string, {
            style: { background?: string };
        }>;
        delete categories.requirements.style.background;

        const error = await expectFailure(adaptCfsMap(payload, {
            workspaceId: 'workspace',
            revision: 'revision-1',
            repositories,
            engine: { command: 'cfs', version: '1.7.0' }
        }));

        expect(error).toBeInstanceOf(CfsMapAdapterError);
        expect(error.path).toBe('$.categories.requirements.style.background');
        expect(error.message).toBe(
            '$.categories.requirements.style.background: expected a required property'
        );
    });

    it('preserves the absence of canonical layout positions', async () => {
        const layout = payload.layout as { vis_nodes?: unknown[] };
        delete layout.vis_nodes;

        const snapshot = await adaptCfsMap(payload, {
            workspaceId: 'workspace',
            revision: 'revision-1',
            repositories,
            engine: { command: 'cfs', version: '1.7.0' }
        });

        expect(snapshot.nodes).toHaveLength(3);
        expect(snapshot.nodes.every(node => node.position === undefined)).toBe(true);
        expect(snapshot.nodes.every(node => !Object.prototype.hasOwnProperty.call(node, 'position'))).toBe(true);
    });

    it('rejects duplicate canonical layout node ids', async () => {
        const layout = payload.layout as { vis_nodes: unknown[] };
        layout.vis_nodes.push(layout.vis_nodes[0]);

        const error = await expectFailure(adaptCfsMap(payload, {
            workspaceId: 'workspace',
            revision: 'revision-1',
            repositories,
            engine: { command: 'cfs', version: '1.7.0' }
        }));

        expect(error).toBeInstanceOf(CfsMapAdapterError);
        expect(error.path).toBe('$.layout.vis_nodes[3].id');
        expect(error.message).toContain('duplicate layout node id');
    });

    it('rejects layout node ids that do not reference canonical nodes', async () => {
        const layout = payload.layout as { vis_nodes: Array<{ id: string }> };
        layout.vis_nodes[0].id = 'docs:docs/orphan.md';

        const error = await expectFailure(adaptCfsMap(payload, {
            workspaceId: 'workspace',
            revision: 'revision-1',
            repositories,
            engine: { command: 'cfs', version: '1.7.0' }
        }));

        expect(error).toBeInstanceOf(CfsMapAdapterError);
        expect(error.path).toBe('$.layout.vis_nodes[0].id');
        expect(error.message).toContain('does not reference a canonical node');
    });

    it('rejects duplicate canonical edge ids before publishing a live snapshot', async () => {
        const edges = payload.edges as Array<Record<string, unknown>>;
        edges[1].id = edges[0].id;

        const error = await expectFailure(adaptCfsMap(payload, {
            workspaceId: 'workspace',
            revision: 'revision-1',
            repositories,
            engine: { command: 'cfs', version: '1.7.0' }
        }));

        expect(error).toBeInstanceOf(CfsMapAdapterError);
        expect(error.path).toBe('$.edges[1].id');
        expect(error.message).toContain('duplicate edge id');
    });

    // This used to reject the whole map, which meant one repeated relation —
    // two files under a kit's examples/ referencing each other was enough —
    // left the graph unavailable over content nobody was looking at.
    it('merges a relation the map reported twice, keeping the first id', async () => {
        const edges = payload.edges as Array<Record<string, unknown>>;
        const first = edges[0] as Record<string, unknown>;
        edges.push({
            ...first,
            id: 'different-id-for-the-same-relation',
            refs: [{ cpt_id: null, line: 99, snippet: 'a second sighting', def_line: null, def_snippet: null }]
        });

        const graph = await adaptCfsMap(payload, {
            workspaceId: 'workspace',
            revision: 'revision-1',
            repositories,
            engine: { command: 'cfs', version: '1.7.0' }
        });

        const merged = graph.edges.filter(e => e.from === first.from && e.to === first.to && e.type === first.type);
        expect(merged).toHaveLength(1);
        expect(merged[0].id).toBe(first.id);
        // Both sightings survive as evidence of the one relation.
        expect(merged[0].refs.map(r => r.line)).toContain(99);
        expect(merged[0].refs.length).toBeGreaterThan(1);
    });

    it('does not list the same ref twice when the map repeats it verbatim', async () => {
        const edges = payload.edges as Array<Record<string, unknown>>;
        const first = edges[0] as Record<string, unknown>;
        const before = (first.refs as unknown[]).length;
        edges.push({ ...first, id: 'verbatim-copy' });

        const graph = await adaptCfsMap(payload, {
            workspaceId: 'workspace',
            revision: 'revision-1',
            repositories,
            engine: { command: 'cfs', version: '1.7.0' }
        });

        const merged = graph.edges.find(e => e.id === first.id);
        expect(merged?.refs).toHaveLength(before);
    });

    // A relation that resolved once is not dangling, and one that crossed a
    // repository boundary once does cross it.
    it('takes the resolving side of dangling and the crossing side of cross-repo', async () => {
        const edges = payload.edges as Array<Record<string, unknown>>;
        const first = edges[0] as Record<string, unknown>;
        edges[0] = { ...first, dangling: true, cross_repo: false };
        edges.push({ ...first, id: 'the-resolved-sighting', dangling: false, cross_repo: true });

        const graph = await adaptCfsMap(payload, {
            workspaceId: 'workspace',
            revision: 'revision-1',
            repositories,
            engine: { command: 'cfs', version: '1.7.0' }
        });

        const merged = graph.edges.find(e => e.id === first.id);
        expect(merged?.dangling).toBe(false);
        expect(merged?.crossRepo).toBe(true);
    });

    it.each([
        ['phantom file path', 2, 'rel_path', 'ghost.md', '$.nodes[2].rel_path', 'must not reference a file path'],
        ['phantom source', 2, 'source', 'docs', '$.nodes[2].source', 'must not reference a source'],
        ['markdown without path', 0, 'rel_path', null, '$.nodes[0].rel_path', 'must reference a file path'],
        ['source without source', 1, 'source', null, '$.nodes[1].source', 'must reference a source']
    ])('rejects a kind-inconsistent %s', async (
        _case,
        nodeIndex,
        property,
        value,
        expectedPath,
        expectedMessage
    ) => {
        const nodes = payload.nodes as Array<Record<string, unknown>>;
        nodes[nodeIndex][property] = value;

        const error = await expectFailure(adaptCfsMap(payload, {
            workspaceId: 'workspace',
            revision: 'revision-1',
            repositories,
            engine: { command: 'cfs', version: '1.7.0' }
        }));

        expect(error.path).toBe(expectedPath);
        expect(error.message).toContain(expectedMessage);
    });

    it('rejects an undeclared primary source with a stable canonical path', async () => {
        (payload.workspace as { primary: string }).primary = 'missing';

        const error = await expectFailure(adaptCfsMap(payload, {
            workspaceId: 'workspace',
            revision: 'revision-1',
            repositories,
            engine: { command: 'cfs', version: '1.7.0' }
        }));

        expect(error.path).toBe('$.workspace.primary');
        expect(error.message).toContain('is not declared');
    });

    it('validates and ignores schema-permitted category origin extensions', async () => {
        const categories = payload.categories as Record<string, {
            origin_counts: Record<string, number>;
        }>;
        categories.requirements.origin_counts['uncategorized-bucket'] = 2;

        const snapshot = await adaptCfsMap(payload, {
            workspaceId: 'workspace',
            revision: 'revision-1',
            repositories,
            engine: { command: 'cfs', version: '1.7.0' }
        });

        expect(snapshot.categories.requirements.originCounts).toEqual({ registry: 1 });
    });

    it('keeps the runtime map schema byte-matched with the authoritative project copy', async () => {
        // The project's own copy, which theia/Dockerfile installs at the
        // runtime path. This used to resolve five levels up — OUTSIDE the
        // repository — so it only ever passed in a checkout that happened to
        // sit inside a CFS-managed workspace, and failed everywhere else.
        const canonicalSchemaPath = path.resolve(
            __dirname,
            '../../../docker/cfs-map.schema.json'
        );
        const [runtimeBytes, canonicalBytes] = await Promise.all([
            fs.readFile(CFS_MAP_RUNTIME_SCHEMA_PATH),
            fs.readFile(canonicalSchemaPath)
        ]);

        expect(CFS_MAP_RUNTIME_SCHEMA_PATH).toBe(path.resolve(
            __dirname,
            '../../../.cf-studio/.core/schemas/map.schema.json'
        ));
        expect(runtimeBytes.equals(canonicalBytes)).toBe(true);

        const schema = JSON.parse(runtimeBytes.toString('utf8')) as {
            $schema?: string;
            $id?: string;
            properties?: { version?: { const?: string } };
        };
        expect(schema).toMatchObject({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            $id: 'https://constructor-studio.dev/schemas/map.schema.json',
            properties: {
                version: { const: CFS_MAP_SCHEMA_VERSION }
            }
        });
    });

    it('rejects an incompatible canonical payload version with a stable JSON path', async () => {
        const incompatible = await readFixture('cfs-map-incompatible.json');

        const error = await expectFailure(adaptCfsMap(incompatible, {
            workspaceId: 'workspace',
            revision: 'revision-1',
            repositories,
            engine: { command: 'cfs', version: '1.7.0' }
        }));

        expect(error).toBeInstanceOf(CfsMapAdapterError);
        expect(error.path).toBe('$.version');
        expect(error.message).toBe('$.version: expected "1.0"');
    });

    it('rejects repository-relative paths that escape their registered source', async () => {
        const nodes = payload.nodes as Array<{ rel_path: string | null }>;
        nodes[0].rel_path = '../outside.md';

        const error = await expectFailure(adaptCfsMap(payload, {
            workspaceId: 'workspace',
            revision: 'revision-1',
            repositories,
            engine: { command: 'cfs', version: '1.7.0' }
        }));

        expect(error).toBeInstanceOf(CfsMapAdapterError);
        expect(error.path).toBe('$.nodes[0].rel_path');
        expect(error.message).not.toContain(tempDir);
    });
});

function repository(repositoryId: string, label: string, canonicalRoot: string): CfsMapRegisteredRepository {
    return {
        canonicalRoot,
        descriptor: { repositoryId, label }
    };
}

async function readFixture(name: string): Promise<Record<string, unknown>> {
    const raw = await fs.readFile(path.join(__dirname, 'test-fixtures', name), 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
}

async function expectFailure(promise: Promise<unknown>): Promise<CfsMapAdapterError> {
    try {
        await promise;
    } catch (error) {
        if (error instanceof CfsMapAdapterError) {
            return error;
        }
        throw error;
    }
    throw new Error('Expected adapter to reject the payload');
}
