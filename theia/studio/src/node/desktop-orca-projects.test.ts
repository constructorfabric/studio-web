// What Studio removes from the member's Orca when a project closes, and what
// it keeps (#497). Orca and git are a fake port; the record is a real file in
// a temporary folder. Nothing here runs Orca.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { OrcaRepository, OrcaTerminal, OrcaWorktree } from '../common/orca-protocol';
import {
    DesktopOrcaProjects,
    keepReason,
    newlyAdded,
    orcaProjectsFile,
    planRelease,
    readRecord,
    recordAdded,
    unknownRepositories,
    writeRecord,
    type OrcaProjectsPort,
    type OrcaProjectsRecord,
    type OrcaProjectsStore
} from './desktop-orca-projects';

const repo = (id: string, p: string): OrcaRepository => ({ id, path: p, displayName: path.basename(p) });
const entry = (repoId: string, p: string, projectRoot = path.dirname(p)) => ({ repoId, path: p, projectRoot, addedAt: 1 });
const record = (...rows: ReturnType<typeof entry>[]): OrcaProjectsRecord => ({ version: 1, repositories: rows });
const terminal = (agent?: string): OrcaTerminal => ({
    handle: 't1', title: 't', agent, connected: true, worktreePath: '/x', preview: ''
});

describe('the record of what Studio added', () => {
    let dir: string;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-projects-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('lives beside the desktop\'s other state', () => {
        expect(orcaProjectsFile('/home/m')).toBe(path.join('/home/m', 'ConstructorStudio', 'orca-projects.json'));
    });

    it('round-trips, and reads a missing or broken file as empty', () => {
        const file = path.join(dir, 'ConstructorStudio', 'orca-projects.json');
        expect(readRecord(file).repositories).toEqual([]);
        writeRecord(file, record(entry('r1', '/p/web')));
        expect(readRecord(file).repositories).toEqual([entry('r1', '/p/web')]);
        fs.writeFileSync(file, '{ not json');
        expect(readRecord(file).repositories).toEqual([]);
    });

    it('drops rows without an id or a path', () => {
        const read = () => JSON.stringify({ version: 1, repositories: [{ repoId: '', path: '/a' }, { repoId: 'r', path: '/b', projectRoot: '/', addedAt: 1 }] });
        expect(readRecord('x', read).repositories.map(r => r.repoId)).toEqual(['r']);
    });

    it('keeps one entry per repository', () => {
        const next = recordAdded(record(entry('r1', '/old')), [entry('r1', '/new')]);
        expect(next.repositories).toEqual([entry('r1', '/new')]);
    });
});

describe('what counts as added by Studio', () => {

    it('only repositories Orca did not know before the registration', () => {
        const before = [repo('mine', 'C:/Repos/web')];
        const after = [repo('mine', 'C:/Repos/web'), repo('new', 'C:/p/api')];
        const added = newlyAdded(before, after, ['c:\\Repos\\web', 'C:\\p\\api'], 'C:\\p', 5);
        expect(added).toEqual([{ repoId: 'new', path: 'C:/p/api', projectRoot: 'C:\\p', addedAt: 5 }]);
    });

    it('lists the project\'s repositories Orca does not know, however the path is spelled', () => {
        expect(unknownRepositories(['C:\\p\\web', 'C:\\p\\api'], [repo('r', 'c:/p/web')])).toEqual(['C:\\p\\api']);
    });
});

describe('planning a release', () => {
    const known = [repo('r1', '/p1/web'), repo('r2', '/p2/api')];

    it('keeps what an open project holds and releases the rest', () => {
        const plan = planRelease(record(entry('r1', '/p1/web'), entry('r2', '/p2/api')), ['/p1'], known);
        expect(plan.candidates.map(c => c.repoId)).toEqual(['r2']);
        expect(plan.forget).toEqual([]);
    });

    it('releases nothing another window still has open', () => {
        const plan = planRelease(record(entry('r1', '/p1/web'), entry('r2', '/p2/api')), ['/p1', '/p2'], known);
        expect(plan.candidates).toEqual([]);
    });

    it('forgets an entry Orca no longer has, without removing anything', () => {
        const plan = planRelease(record(entry('gone', '/p3/x')), [], known);
        expect(plan.forget.map(f => f.repoId)).toEqual(['gone']);
        expect(plan.candidates).toEqual([]);
    });

    it('forgets an entry whose path Orca has under another id: the member added it back themselves', () => {
        const plan = planRelease(record(entry('r1', '/p2/api')), [], known);
        expect(plan.forget).toHaveLength(1);
        expect(plan.candidates).toEqual([]);
    });
});

describe('why a repository stays', () => {

    it('an agent running in any of its worktrees', () => {
        expect(keepReason([
            { label: 'main', terminals: [], changes: 0 },
            { label: 'fix/x', terminals: [terminal('claude')], changes: 0 }
        ])).toBe('claude is still running in fix/x');
        expect(keepReason([{ label: 'main', terminals: [terminal()], changes: 0 }])).toBe('a terminal is still running in main');
    });

    it('uncommitted changes, or changes that could not be read', () => {
        expect(keepReason([{ label: 'main', terminals: [], changes: 3 }])).toBe('main has 3 uncommitted changes');
        expect(keepReason([{ label: 'main', terminals: [], changes: 1 }])).toBe('main has 1 uncommitted change');
        expect(keepReason([{ label: 'main', terminals: [], changes: undefined }])).toMatch(/could not be read/);
    });

    it('nothing, when every worktree is idle and clean', () => {
        expect(keepReason([{ label: 'main', terminals: [], changes: 0 }])).toBeUndefined();
        expect(keepReason([])).toBeUndefined();
    });
});

describe('DesktopOrcaProjects', () => {

    function setup(opts: {
        repos: OrcaRepository[];
        worktrees?: OrcaWorktree[];
        terminals?: Record<string, OrcaTerminal[]>;
        changes?: Record<string, number>;
        projectRepos?: Record<string, string[]>;
        stored?: OrcaProjectsRecord;
    }) {
        let repos = [...opts.repos];
        let stored = opts.stored ?? record();
        const removed: string[] = [];
        const added: string[] = [];
        const port: OrcaProjectsPort = {
            listRepositories: async () => repos,
            listWorktrees: async () => opts.worktrees ?? [],
            listTerminals: async selector => opts.terminals?.[selector.replace(/^path:/, '')] ?? [],
            uncommitted: async p => opts.changes?.[p] ?? 0,
            repositoriesAt: async root => opts.projectRepos?.[root] ?? [],
            addRepository: async p => {
                added.push(p);
                if (!repos.some(r => r.path === p)) {
                    repos = [...repos, repo(`id-${path.basename(p)}`, p)];
                }
            },
            removeRepository: async id => {
                removed.push(id);
                repos = repos.filter(r => r.id !== id);
            }
        };
        const store: OrcaProjectsStore = { read: () => stored, write: r => (stored = r) };
        return { projects: new DesktopOrcaProjects(port, store, () => 7), removed, added, stored: () => stored };
    }

    const wt = (repoId: string, p: string, branch = 'main'): OrcaWorktree => ({
        id: `${repoId}::${p}`, repoId, path: p, branch, displayName: branch, comment: '', status: 'in-progress', isMain: branch === 'main'
    });

    it('records only what it added, then removes it when the project closes', async () => {
        const s = setup({ repos: [repo('mine', '/own/tool')], projectRepos: { '/p': ['/p/web', '/own/tool'] } });
        await s.projects.add('/p');
        expect(s.stored().repositories.map(r => r.repoId)).toEqual(['id-web']);

        const sync = await s.projects.track('w1', undefined);
        expect(s.removed).toEqual(['id-web']);
        expect(sync.removed).toEqual(['/p/web']);
        expect(s.stored().repositories).toEqual([]);
    });

    it('never removes a repository the member registered themselves', async () => {
        const s = setup({ repos: [repo('mine', '/own/tool')] });
        await s.projects.track('w1', undefined);
        expect(s.removed).toEqual([]);
    });

    it('keeps a repository while an agent runs in one of its worktrees, and says so', async () => {
        const s = setup({
            repos: [repo('r1', '/p/web')],
            worktrees: [wt('r1', '/p/web'), wt('r1', '/orca/web/fix', 'fix/x')],
            terminals: { '/orca/web/fix': [terminal('codex')] },
            stored: record(entry('r1', '/p/web', '/p'))
        });
        const sync = await s.projects.track('w1', '/q');
        expect(s.removed).toEqual([]);
        expect(sync.kept).toEqual([{ path: '/p/web', reason: 'codex is still running in fix/x' }]);
        // Still Studio's to remove later.
        expect(s.stored().repositories).toHaveLength(1);
    });

    it('keeps a repository with uncommitted changes', async () => {
        const s = setup({
            repos: [repo('r1', '/p/web')],
            worktrees: [wt('r1', '/p/web')],
            changes: { '/p/web': 2 },
            stored: record(entry('r1', '/p/web', '/p'))
        });
        const sync = await s.projects.track('w1', undefined);
        expect(sync.kept[0].reason).toBe('main has 2 uncommitted changes');
        expect(s.removed).toEqual([]);
    });

    it('does not release a project another window still has open', async () => {
        const s = setup({ repos: [repo('r1', '/p/web')], stored: record(entry('r1', '/p/web', '/p')) });
        await s.projects.track('w1', '/p');
        await s.projects.track('w2', '/q');
        expect(s.removed).toEqual([]);
        await s.projects.track('w1', undefined);
        expect(s.removed).toEqual(['r1']);
    });

    it('releases what the app left registered when it last closed, on the first report', async () => {
        const s = setup({ repos: [repo('r1', '/old/web')], stored: record(entry('r1', '/old/web', '/old')) });
        const sync = await s.projects.track('w1', '/new');
        expect(sync.removed).toEqual(['/old/web']);
    });

    it('answers which of the open project\'s repositories Orca does not know', async () => {
        const s = setup({ repos: [repo('r1', '/p/web')], projectRepos: { '/p': ['/p/web', '/p/api'] } });
        expect((await s.projects.track('w1', '/p')).unknown).toEqual(['/p/api']);
    });

    it('keeps the entry, with the reason, when Orca refuses to remove it', async () => {
        const s = setup({ repos: [repo('r1', '/p/web')], stored: record(entry('r1', '/p/web', '/p')) });
        (s.projects as unknown as { port: OrcaProjectsPort }).port.removeRepository = async () => {
            throw new Error('runtime busy');
        };
        const sync = await s.projects.track('w1', undefined);
        expect(sync.kept[0].reason).toContain('runtime busy');
        expect(s.stored().repositories).toHaveLength(1);
    });
});
