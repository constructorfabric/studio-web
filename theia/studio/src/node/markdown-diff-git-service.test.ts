/**
 * @jest-environment node
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { blobId, isSafeRef, MarkdownDiffGitServiceImpl, parseRefs } from './markdown-diff-git-service';

// Real git, like desktop-git.test.ts: which refs a repository has and where a
// branch left is git's answer, and a fake runner would only test the fake.

let scratch: string;

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

function commit(dir: string, file: string, body: string, author = 'T'): string {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body);
    git(dir, 'add', file);
    git(dir, '-c', `user.name=${author}`, '-c', 'user.email=t@example.com', 'commit', '-q', '-m', `edit ${file}`);
    return git(dir, 'rev-parse', 'HEAD');
}

beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'md-diff-git-'));
});

afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
});

describe('parseRefs', () => {
    const F = '\u001f';
    it('reads branches, remote branches and tags, and drops origin/HEAD', () => {
        const output = [
            ['refs/heads/main', 'main', 'a'.repeat(40), '2026-10-05T10:00:00+00:00', 'Alice'],
            ['refs/remotes/origin/HEAD', 'origin', 'a'.repeat(40), '', ''],
            ['refs/remotes/origin/bob/spec', 'origin/bob/spec', 'b'.repeat(40), '2026-10-04T10:00:00+00:00', 'Bob'],
            ['refs/tags/v1', 'v1', 'c'.repeat(40), '2026-10-01T10:00:00+00:00', 'Alice'],
        ].map(fields => fields.join(F)).join('\n');
        expect(parseRefs(output).map(ref => [ref.name, ref.kind, ref.author])).toEqual([
            ['main', 'branch', 'Alice'],
            ['origin/bob/spec', 'remote', 'Bob'],
            ['v1', 'tag', 'Alice'],
        ]);
    });
});

describe('isSafeRef', () => {
    it('takes ref names and refuses anything git could read as an option', () => {
        expect(isSafeRef('origin/alice/spec-v2')).toBe(true);
        expect(isSafeRef('v1.2')).toBe(true);
        expect(isSafeRef('--upload-pack=x')).toBe(false);
        expect(isSafeRef('-x')).toBe(false);
        expect(isSafeRef('a b')).toBe(false);
        expect(isSafeRef('a;rm')).toBe(false);
    });
});

describe('MarkdownDiffGitServiceImpl', () => {
    it('lists the refs of the repository a document is in, newest first, and says which is checked out', async () => {
        const repo = path.join(scratch, 'repo');
        git(scratch, 'init', '-q', '-b', 'main', repo);
        commit(repo, 'docs/spec.md', '# Spec\n');
        // Lightweight, and never signed: a local tag.gpgSign or forceSignAnnotated would otherwise ask for a message.
        git(repo, '-c', 'tag.gpgSign=false', '-c', 'tag.forceSignAnnotated=false', 'tag', '--no-sign', 'v1');
        git(repo, 'checkout', '-q', '-b', 'bob/spec');
        commit(repo, 'docs/spec.md', '# Spec\n\nBob\'s paragraph.\n', 'Bob');
        git(repo, 'checkout', '-q', 'main');

        const service = new MarkdownDiffGitServiceImpl();
        const file = FileUri.create(path.join(repo, 'docs', 'spec.md')).toString();
        const { current, refs } = await service.listRefs(file);
        expect(current).toBe('main');
        expect(refs.map(ref => ref.name).sort()).toEqual(['bob/spec', 'main', 'v1']);
        expect(refs.find(ref => ref.name === 'bob/spec')).toMatchObject({ kind: 'branch', author: 'Bob' });
    });

    it('finds where a branch left the checked-out one', async () => {
        const repo = path.join(scratch, 'repo');
        git(scratch, 'init', '-q', '-b', 'main', repo);
        const fork = commit(repo, 'docs/spec.md', '# Spec\n');
        git(repo, 'checkout', '-q', '-b', 'bob/spec');
        commit(repo, 'docs/spec.md', '# Spec\n\nBob.\n', 'Bob');
        git(repo, 'checkout', '-q', 'main');
        commit(repo, 'docs/spec.md', '# Spec\n\nAlice.\n', 'Alice');

        const service = new MarkdownDiffGitServiceImpl();
        const file = FileUri.create(path.join(repo, 'docs', 'spec.md')).toString();
        expect(await service.mergeBase(file, 'bob/spec')).toBe(fork);
        expect(await service.mergeBase(file, '--help')).toBeUndefined();
        expect(await service.mergeBase(file, 'no-such-branch')).toBeUndefined();
    });

    it('recognises the content a commit has, and names who committed it', async () => {
        const repo = path.join(scratch, 'repo');
        git(scratch, 'init', '-q', '-b', 'main', repo);
        commit(repo, 'docs/spec.md', '# Spec\n');
        const bobs = commit(repo, 'docs/spec.md', '# Spec\n\nBob.\n', 'Bob');
        commit(repo, 'docs/other.md', 'Other.\n', 'Carol');

        const service = new (class extends MarkdownDiffGitServiceImpl { protected override retryMs = 0; })();
        const file = FileUri.create(path.join(repo, 'docs', 'spec.md')).toString();
        expect(await service.committedVersion(file, '# Spec\n\nBob.\n')).toEqual({ commit: bobs, author: 'Bob' });
        // Checked out with CRLF (core.autocrlf), it is still the commit's.
        expect(await service.committedVersion(file, '# Spec\r\n\r\nBob.\r\n')).toEqual({ commit: bobs, author: 'Bob' });
        // An earlier version, or one nobody committed, is not.
        expect(await service.committedVersion(file, '# Spec\n')).toBeUndefined();
        expect(await service.committedVersion(file, '# Spec\n\nAn agent.\n')).toBeUndefined();
    });

    it('recognises what a pull is bringing from the branch it follows', async () => {
        const remote = path.join(scratch, 'remote');
        git(scratch, 'init', '-q', '-b', 'main', remote);
        commit(remote, 'spec.md', 'One.\n');
        const local = path.join(scratch, 'local');
        git(scratch, 'clone', '-q', remote, local);
        const alices = commit(remote, 'spec.md', 'One.\n\nAlice.\n', 'Alice');
        git(local, 'fetch', '-q');

        const service = new (class extends MarkdownDiffGitServiceImpl { protected override retryMs = 0; })();
        const file = FileUri.create(path.join(local, 'spec.md')).toString();
        expect(await service.committedVersion(file, 'One.\n\nAlice.\n')).toEqual({ commit: alices, author: 'Alice' });
    });

    it('hashes a file the way git does', () => {
        expect(blobId('', 'sha1')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
        expect(blobId('hello\n', 'sha1')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    });

    it('answers nothing for a document outside any repository', async () => {
        const loose = path.join(scratch, 'loose');
        fs.mkdirSync(loose);
        const service = new MarkdownDiffGitServiceImpl();
        // GIT_CEILING_DIRECTORIES keeps git from finding a repository above the scratch folder.
        process.env.GIT_CEILING_DIRECTORIES = scratch;
        try {
            expect(await service.listRefs(FileUri.create(path.join(loose, 'a.md')).toString())).toEqual({ refs: [] });
        } finally {
            delete process.env.GIT_CEILING_DIRECTORIES;
        }
    });
});
