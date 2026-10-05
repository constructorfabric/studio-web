/**
 * @jest-environment node
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import {
    commitMessage, companionOf, DocumentShareServiceImpl, editorsSince, failureOf, parseStatus, reviewBranchName, titleOf,
} from './document-share-service';

// Real git against a bare remote, as desktop-git.test.ts: what sharing does is
// git's behaviour, and a fake runner would only test the fake.

let scratch: string;

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

function write(dir: string, file: string, body: string): void {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body);
}

function commitAll(dir: string, message: string): void {
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-q', '-m', message);
}

/** A bare remote with docs/spec.md on main, and two clones: mine and a colleague's. */
function project(): { remote: string; mine: string; theirs: string } {
    const remote = path.join(scratch, 'remote.git');
    git(scratch, 'init', '-q', '--bare', '-b', 'main', remote);
    const mine = path.join(scratch, 'mine');
    git(scratch, 'clone', '-q', remote, mine);
    git(mine, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    write(mine, 'docs/spec.md', '# Spec findings\n\nThe first paragraph.\n\nThe second paragraph.\n');
    write(mine, 'README.md', '# Readme\n');
    commitAll(mine, 'base');
    git(mine, 'push', '-q', '-u', 'origin', 'main');
    const theirs = path.join(scratch, 'theirs');
    git(scratch, 'clone', '-q', remote, theirs);
    return { remote, mine, theirs };
}

const ALICE = { name: 'Alice Example', email: 'alice@example.com' };

beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'share-'));
});

afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
});

describe('reading git for a person', () => {
    it('ties .studio files to their document', () => {
        expect(companionOf('.studio/comments/docs/spec.md.json')).toBe('docs/spec.md');
        expect(companionOf('.studio/comments/docs/spec.md/local-bob.jsonl')).toBe('docs/spec.md');
        expect(companionOf('.studio/changes/docs/spec.md/local-bob.json')).toBe('docs/spec.md');
        expect(companionOf('.studio/history/docs/spec.md.json')).toBe('docs/spec.md');
        expect(companionOf('.studio/changes/index.json')).toBeUndefined();
        expect(companionOf('docs/spec.md')).toBeUndefined();
    });

    it('reads porcelain status, renames included', () => {
        const output = [' M docs/a.md', '?? docs/new.md', ' D docs/gone.md', 'R  docs/to.md', 'docs/from.md', ''].join('\0');
        expect(parseStatus(output)).toEqual([
            { path: 'docs/a.md', state: 'modified' },
            { path: 'docs/new.md', state: 'added' },
            { path: 'docs/gone.md', state: 'deleted' },
            { path: 'docs/to.md', state: 'added' },
        ]);
    });

    it('names a document by its first heading, past front matter', () => {
        expect(titleOf('---\ntitle: x\n---\n\nIntro\n\n## Spec findings ##\n', 'spec.md')).toBe('Spec findings');
        expect(titleOf('no heading', 'spec.md')).toBe('spec.md');
    });

    it('says who edited since the document was last shared, not assistants and not "you"', () => {
        const history = { entries: [
            { kind: 'edit', author: 'Alice', at: '2026-10-05T09:00:00Z' },
            { kind: 'edit', author: 'Bob', at: '2026-10-05T11:00:00Z' },
            { kind: 'proposal', author: 'assistant', at: '2026-10-05T11:30:00Z' },
            { kind: 'remote-edit', author: 'Carol', at: '2026-10-05T12:00:00Z' },
            { kind: 'edit', author: 'you', at: '2026-10-05T12:30:00Z' },
            { kind: 'comment', author: 'Dan', at: '2026-10-05T12:40:00Z' },
        ] };
        expect(editorsSince(history, '2026-10-05T10:00:00Z')).toEqual(['Bob', 'Carol']);
        expect(editorsSince(undefined, undefined)).toEqual([]);
    });

    it('writes the person\'s words, and whoever else edited as co-authors', () => {
        expect(commitMessage('Update the spec\n\nWhy it changed.', ALICE, [ALICE, { name: 'Bob', email: 'bob@example.com' }, { name: 'Carol' }]))
            .toBe('Update the spec\n\nWhy it changed.\n\nCo-authored-by: Bob <bob@example.com>\nAlso-edited-by: Carol\n');
        expect(commitMessage('   ', undefined)).toBe('Update documents\n');
    });

    it('tells what a failure means, from what git printed', () => {
        const result = (stderr: string) => ({ code: 1, stdout: '', stderr });
        expect(failureOf(result('remote: error: GH006: Protected branch update failed'))).toBe('protected');
        expect(failureOf(result('fatal: Authentication failed for \'https://x\''))).toBe('sign-in');
        expect(failureOf(result('fatal: unable to access \'https://x\': Could not resolve host: x'))).toBe('offline');
        expect(failureOf(result(' ! [rejected]        main -> main (fetch first)'))).toBe('rejected');
        expect(failureOf(result('something else'))).toBe('failed');
    });

    it('names a review branch after the person and the minute', () => {
        expect(reviewBranchName(ALICE, new Date('2026-10-05T12:34:56Z'))).toBe('studio/alice-example/202610051234');
        expect(reviewBranchName(undefined, new Date('2026-10-05T12:34:56Z'))).toBe('studio/studio/202610051234');
    });
});

describe('DocumentShareServiceImpl', () => {
    it('lists the documents not shared yet, with their .studio files and their editors', async () => {
        const { mine } = project();
        write(mine, 'docs/spec.md', '# Spec findings\n\nThe first paragraph, edited.\n\nThe second paragraph.\n');
        write(mine, '.studio/history/docs/spec.md.json', JSON.stringify({ version: 1, entries: [
            { kind: 'edit', author: 'Alice Example', at: new Date(Date.now() + 1000).toISOString() },
        ] }));
        write(mine, '.studio/comments/docs/notes.md.json', '{}');
        write(mine, 'src/code.ts', 'export {};\n');
        const service = new DocumentShareServiceImpl();

        const { repositories } = await service.status([FileUri.create(scratch).toString()]);
        const repo = repositories.find(r => r.name === 'mine')!;
        expect(repo).toMatchObject({ branch: 'main', upstream: 'origin/main', unsent: 0 });
        expect(repo.documents.map(d => [d.path, d.state, d.title, d.editors, d.companions])).toEqual([
            // A comment on a document whose text did not change is still something to share.
            ['docs/notes.md', 'modified', 'notes.md', [], ['.studio/comments/docs/notes.md.json']],
            ['docs/spec.md', 'modified', 'Spec findings', ['Alice Example'], ['.studio/history/docs/spec.md.json']],
        ]);
    });

    it('shares only the chosen documents, as the person, and pushes them', async () => {
        const { remote, mine } = project();
        write(mine, 'docs/spec.md', '# Spec findings\n\nThe first paragraph, edited.\n\nThe second paragraph.\n');
        write(mine, '.studio/history/docs/spec.md.json', '{"version":1,"entries":[]}');
        write(mine, 'README.md', '# Readme, edited by someone else\n');
        const service = new DocumentShareServiceImpl();

        const outcome = await service.share({
            root: FileUri.create(mine).toString(), documents: ['docs/spec.md'], message: 'Tighten the first paragraph', author: ALICE,
        });
        expect(outcome).toEqual({ kind: 'shared', branch: 'main' });
        expect(git(remote, 'log', '-1', '--format=%an <%ae>|%s', 'main')).toBe('Alice Example <alice@example.com>|Tighten the first paragraph');
        expect(git(remote, 'show', '--name-only', '--format=', 'main').split('\n').sort()).toEqual(['.studio/history/docs/spec.md.json', 'docs/spec.md']);
        // The colleague's unshared README stays theirs, unstaged and uncommitted.
        expect(git(mine, 'status', '--porcelain')).toBe('M README.md');
    });

    it('runs git only in the folders the session opened', async () => {
        const { remote, mine } = project();
        write(mine, 'docs/spec.md', '# Spec findings\n\nEdited.\n');
        const elsewhere = path.join(scratch, 'elsewhere');
        fs.mkdirSync(elsewhere);
        const before = git(remote, 'rev-parse', 'main');
        const confined = (opened: string) => Object.assign(new DocumentShareServiceImpl(), {
            workspaceServer: { getMostRecentlyUsedWorkspace: async () => FileUri.create(opened).toString() },
        });

        // Another folder is open: the repository is neither listed nor shared.
        const outside = confined(elsewhere);
        expect((await outside.status([FileUri.create(mine).toString()])).repositories).toEqual([]);
        expect(await outside.share({ root: FileUri.create(mine).toString(), documents: ['docs/spec.md'], message: 'x', author: ALICE }))
            .toEqual({ kind: 'failed', detail: 'not a folder of this workspace' });
        expect(git(remote, 'rev-parse', 'main')).toBe(before);

        // A desktop workspace file listing the folder lets it through.
        const workspaceFile = path.join(scratch, 'project.theia-workspace');
        fs.writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: 'mine' }] }));
        expect((await confined(workspaceFile).status([FileUri.create(mine).toString()])).repositories.map(r => r.name)).toEqual(['mine']);
    });

    it('leaves everything else in the working tree untouched when the team has not moved', async () => {
        const { mine } = project();
        write(mine, 'docs/spec.md', '# Spec findings\n\nMine.\n');
        write(mine, 'README.md', '# A colleague\'s draft\n');
        const draft = path.join(mine, 'README.md');
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(draft, old, old);
        const before = fs.statSync(draft).mtimeMs;
        const outcome = await new DocumentShareServiceImpl().share({ root: FileUri.create(mine).toString(), documents: ['docs/spec.md'], message: 'Mine', author: ALICE });
        expect(outcome.kind).toBe('shared');
        // An open editor would read a rewrite as somebody's unclaimed write.
        expect(fs.statSync(draft).mtimeMs).toBe(before);
    });

    it('brings in what the team pushed meanwhile, and shares on top of it', async () => {
        const { remote, mine, theirs } = project();
        write(theirs, 'README.md', '# Readme, theirs\n');
        commitAll(theirs, 'their readme');
        git(theirs, 'push', '-q');
        write(mine, 'docs/spec.md', '# Spec findings\n\nThe first paragraph, mine.\n\nThe second paragraph.\n');
        const outcome = await new DocumentShareServiceImpl().share({ root: FileUri.create(mine).toString(), documents: ['docs/spec.md'], message: 'Mine', author: ALICE });
        expect(outcome.kind).toBe('shared');
        expect(git(remote, 'log', '--format=%s', 'main').split('\n')).toEqual(['Mine', 'their readme', 'base']);
    });

    it('stops at a conflict without sending anything, then shares with whichever wording the person keeps', async () => {
        const { remote, mine, theirs } = project();
        write(theirs, 'docs/spec.md', '# Spec findings\n\nThe first paragraph, as Bob put it.\n\nThe second paragraph.\n');
        commitAll(theirs, 'bob');
        git(theirs, 'push', '-q');
        write(mine, 'docs/spec.md', '# Spec findings\n\nThe first paragraph, as Alice put it.\n\nThe second paragraph, also Alice.\n');
        const service = new DocumentShareServiceImpl();
        const root = FileUri.create(mine).toString();

        const conflict = await service.share({ root, documents: ['docs/spec.md'], message: 'Alice', author: ALICE });
        expect(conflict.kind).toBe('conflict');
        expect(conflict.conflicts).toEqual(['docs/spec.md']);
        expect(conflict.theirs).toBe(git(remote, 'rev-parse', 'main'));
        expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('bob');
        expect(fs.existsSync(path.join(mine, '.git', 'rebase-merge'))).toBe(false);

        // Their wording where both wrote; my other change survives.
        const shared = await service.share({ root, documents: [], message: '', author: ALICE, prefer: 'theirs' });
        expect(shared.kind).toBe('shared');
        const text = git(remote, 'show', 'main:docs/spec.md');
        expect(text).toContain('as Bob put it');
        expect(text).toContain('also Alice');
    });

    it('keeps my wording when the person says so', async () => {
        const { remote, mine, theirs } = project();
        write(theirs, 'docs/spec.md', '# Spec findings\n\nThe first paragraph, as Bob put it.\n\nThe second paragraph.\n');
        commitAll(theirs, 'bob');
        git(theirs, 'push', '-q');
        write(mine, 'docs/spec.md', '# Spec findings\n\nThe first paragraph, as Alice put it.\n\nThe second paragraph.\n');
        const service = new DocumentShareServiceImpl();
        const root = FileUri.create(mine).toString();
        expect((await service.share({ root, documents: ['docs/spec.md'], message: 'Alice', author: ALICE })).kind).toBe('conflict');
        expect((await service.share({ root, documents: [], message: '', author: ALICE, prefer: 'mine' })).kind).toBe('shared');
        expect(git(remote, 'show', 'main:docs/spec.md')).toContain('as Alice put it');
    });

    it('sends to a branch for review when the project\'s branch refuses direct changes', async () => {
        const { remote, mine } = project();
        const hook = path.join(remote, 'hooks', 'pre-receive');
        fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/main" ]; then echo "protected branch: main" >&2; exit 1; fi\ndone\n');
        fs.chmodSync(hook, 0o755);
        write(mine, 'docs/spec.md', '# Spec findings\n\nEdited.\n');
        const outcome = await new DocumentShareServiceImpl().share({ root: FileUri.create(mine).toString(), documents: ['docs/spec.md'], message: 'Edit', author: ALICE });
        expect(outcome.kind).toBe('review');
        expect(outcome.branch).toMatch(/^studio\/alice-example\/\d{12}$/);
        expect(git(remote, 'log', '-1', '--format=%s', outcome.branch!)).toBe('Edit');
        expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('base');
    });

    it('says there is nothing to share', async () => {
        const { mine } = project();
        expect(await new DocumentShareServiceImpl().share({ root: FileUri.create(mine).toString(), documents: [], message: '' }))
            .toEqual({ kind: 'nothing', branch: 'main' });
    });
});
