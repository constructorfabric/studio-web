/**
 * @jest-environment node
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describeRepository, pullRequestLinkOf, pushRepository, repositoriesUnder, runGit, syncRepository } from './desktop-git';
import { broughtDocuments } from '../common/desktop-git';

// Real git against a bare repository standing in for the remote: what Sync and
// Push do is git's behaviour, and a fake runner would only test the fake.

let scratch: string;

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

function commit(dir: string, file: string, body: string): void {
    fs.writeFileSync(path.join(dir, file), body);
    git(dir, 'add', file);
    git(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', `edit ${file}`);
}

/** A bare remote with one commit on main, and a project folder with a clone of it as `app`. */
function project(): { remote: string; root: string; clone: string } {
    const remote = path.join(scratch, 'remote.git');
    git(scratch, 'init', '-q', '--bare', '-b', 'main', remote);
    const seed = path.join(scratch, 'seed');
    git(scratch, 'clone', '-q', remote, seed);
    git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    commit(seed, 'README.md', 'one\n');
    git(seed, 'push', '-q', 'origin', 'main');
    const root = path.join(scratch, 'project');
    fs.mkdirSync(root);
    const clone = path.join(root, 'app');
    git(root, 'clone', '-q', remote, clone);
    return { remote, root, clone };
}

beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-git-'));
});

afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
});

describe('the clones of a desktop project', () => {
    it('are the folder itself, or the repositories up to two levels below it', () => {
        const root = path.join(scratch, 'p');
        for (const dir of ['a', 'libs/b', 'libs/b/nested', 'x/y/too-deep']) {
            fs.mkdirSync(path.join(root, dir, '.git'), { recursive: true });
        }
        expect(repositoriesUnder(root).map(dir => path.relative(root, dir).replace(/\\/g, '/'))).toEqual(['a', 'libs/b']);
        fs.mkdirSync(path.join(root, '.git'));
        expect(repositoriesUnder(root)).toEqual([path.resolve(root)]);
    });

    it('are described by branch, upstream and distance, without credentials', async () => {
        const { root, clone } = project();
        git(clone, 'remote', 'set-url', 'origin', 'https://member:secret@git.example.com/a/app.git');
        commit(clone, 'a.txt', 'a\n');
        fs.writeFileSync(path.join(clone, 'dirty.txt'), 'x');
        const described = await describeRepository(runGit, root, clone);
        expect(described).toMatchObject({ name: 'app', branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, changed: 1 });
        expect(described.remote).toBe('https://git.example.com/a/app.git');
    });
});

describe('Sync on the desktop', () => {
    it('fast-forwards a branch that is only behind', async () => {
        const { remote, root, clone } = project();
        const other = path.join(scratch, 'other');
        git(scratch, 'clone', '-q', remote, other);
        commit(other, 'b.txt', 'b\n');
        git(other, 'push', '-q');
        const result = await syncRepository(runGit, root, clone);
        expect(result.outcome).toBe('updated');
        expect(result.message).toContain('fast-forwarded by 1 commit');
        expect(fs.existsSync(path.join(clone, 'b.txt'))).toBe(true);
    });

    it('says which documents a fast-forward brought, and between which commits', async () => {
        const { remote, root, clone } = project();
        const before = git(clone, 'rev-parse', 'HEAD');
        const other = path.join(scratch, 'other');
        git(scratch, 'clone', '-q', remote, other);
        fs.mkdirSync(path.join(other, 'docs'));
        commit(other, 'docs/spec.md', '# Spec\n');
        commit(other, 'README.md', 'one, edited\n');
        commit(other, 'code.ts', 'export {};\n');
        git(other, 'push', '-q');
        const after = git(other, 'rev-parse', 'HEAD');

        const result = await syncRepository(runGit, root, clone);
        expect(result.outcome).toBe('updated');
        expect(result.brought).toEqual({ from: before, to: after, documents: ['README.md', 'docs/spec.md'] });
        expect(broughtDocuments([result]).map(entry => entry.document)).toEqual(['README.md', 'docs/spec.md']);
    });

    it('brings no documents when only code changed, and says nothing of the kind when up to date', async () => {
        const { remote, root, clone } = project();
        const other = path.join(scratch, 'other');
        git(scratch, 'clone', '-q', remote, other);
        commit(other, 'code.ts', 'export {};\n');
        git(other, 'push', '-q');
        const updated = await syncRepository(runGit, root, clone);
        expect(updated.brought?.documents).toEqual([]);
        const again = await syncRepository(runGit, root, clone);
        expect(again.outcome).toBe('up-to-date');
        expect(again.brought).toBeUndefined();
        expect(broughtDocuments([updated, again])).toEqual([]);
    });

    it('says a branch is up to date, and what it has to push', async () => {
        const { root, clone } = project();
        commit(clone, 'mine.txt', 'm\n');
        const result = await syncRepository(runGit, root, clone);
        expect(result.outcome).toBe('up-to-date');
        expect(result.message).toContain('1 commit to push');
    });

    it('leaves a diverged branch alone rather than merging behind the member\'s back', async () => {
        const { remote, root, clone } = project();
        const other = path.join(scratch, 'other');
        git(scratch, 'clone', '-q', remote, other);
        commit(other, 'b.txt', 'b\n');
        git(other, 'push', '-q');
        commit(clone, 'mine.txt', 'm\n');
        const head = git(clone, 'rev-parse', 'HEAD');
        const result = await syncRepository(runGit, root, clone);
        expect(result.outcome).toBe('diverged');
        expect(git(clone, 'rev-parse', 'HEAD')).toBe(head);
    });

    it('reports a fetch that fails, with git\'s reason', async () => {
        const { root, clone } = project();
        git(clone, 'remote', 'set-url', 'origin', path.join(scratch, 'gone.git'));
        const result = await syncRepository(runGit, root, clone);
        expect(result.outcome).toBe('failed');
        expect(result.message).toMatch(/^fetch failed: /);
    });
});

describe('Push on the desktop', () => {
    it('pushes the current branch to its upstream', async () => {
        const { remote, root, clone } = project();
        commit(clone, 'mine.txt', 'm\n');
        const result = await pushRepository(runGit, root, clone);
        expect(result).toMatchObject({ outcome: 'pushed', branch: 'main', message: 'pushed main to origin/main' });
        expect(git(remote, 'rev-parse', 'main')).toBe(git(clone, 'rev-parse', 'HEAD'));
    });

    it('publishes a new branch, setting its upstream', async () => {
        const { remote, root, clone } = project();
        git(clone, 'checkout', '-q', '-b', 'feature/x');
        commit(clone, 'x.txt', 'x\n');
        const result = await pushRepository(runGit, root, clone);
        expect(result).toMatchObject({ outcome: 'pushed', message: 'pushed feature/x to origin/feature/x' });
        expect(git(clone, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/feature/x');
        expect(git(remote, 'rev-parse', 'feature/x')).toBe(git(clone, 'rev-parse', 'HEAD'));
    });

    it('says there was nothing to push', async () => {
        const { root, clone } = project();
        expect((await pushRepository(runGit, root, clone)).outcome).toBe('up-to-date');
    });

    it('explains a rejected push', async () => {
        const { remote, root, clone } = project();
        const other = path.join(scratch, 'other');
        git(scratch, 'clone', '-q', remote, other);
        commit(other, 'b.txt', 'b\n');
        git(other, 'push', '-q');
        commit(clone, 'mine.txt', 'm\n');
        const result = await pushRepository(runGit, root, clone);
        expect(result.outcome).toBe('failed');
        expect(result.message).toContain('Sync, then merge or rebase');
    });

    it('refuses a detached HEAD with what to do', async () => {
        const { root, clone } = project();
        git(clone, 'checkout', '-q', '--detach');
        const result = await pushRepository(runGit, root, clone);
        expect(result.outcome).toBe('failed');
        expect(result.message).toContain('check out a branch');
    });
});

describe('the pull-request link a push prints', () => {
    it('is GitHub\'s', () => {
        expect(pullRequestLinkOf([
            'remote: ',
            'remote: Create a pull request for \'feature/x\' on GitHub by visiting:',
            'remote:      https://github.com/acme/app/pull/new/feature/x',
            'remote: ',
            'To https://github.com/acme/app.git',
        ].join('\n'))).toBe('https://github.com/acme/app/pull/new/feature/x');
    });

    it('is GitLab\'s', () => {
        expect(pullRequestLinkOf([
            'remote: To create a merge request for feature/x, visit:',
            'remote:   https://gitlab.example.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fx',
        ].join('\n'))).toBe('https://gitlab.example.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fx');
    });

    it('is not any address git itself printed', () => {
        expect(pullRequestLinkOf('To https://github.com/acme/app.git\n   abc..def  main -> main')).toBeUndefined();
    });
});
