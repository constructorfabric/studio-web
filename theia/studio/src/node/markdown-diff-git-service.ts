// The node side of markdown-diff-git-protocol.ts: git, run in the directory of
// the document asked about, so it answers for whichever repository holds it —
// a portal session's checkout or one of a desktop project's clones.

import { injectable } from '@theia/core/shared/inversify';
import { FileUri } from '@theia/core/lib/common/file-uri';
import * as path from 'path';
import { GitRunner, runGit } from './desktop-git';
import type { MarkdownDiffGitService, MarkdownDiffRef, MarkdownDiffRefs } from '../common/markdown-diff-git-protocol';

/** More than anyone scrolls through in a picker; a repository with thousands of tags still answers fast. */
export const REF_LIMIT = 100;

const FIELD = '\u001f';

export function parseRefs(output: string): MarkdownDiffRef[] {
    const refs: MarkdownDiffRef[] = [];
    for (const line of output.split('\n')) {
        const [full, name, sha, date, author] = line.split(FIELD);
        if (!full || !name || !sha) {
            continue;
        }
        // `origin/HEAD` is a pointer to another remote branch, not one of its own.
        if (full.startsWith('refs/remotes/') && full.endsWith('/HEAD')) {
            continue;
        }
        const kind = full.startsWith('refs/heads/') ? 'branch' : full.startsWith('refs/tags/') ? 'tag' : 'remote';
        refs.push({ name, kind, sha, date: date ?? '', author: author ?? '' });
    }
    return refs.slice(0, REF_LIMIT);
}

/** A ref the member picked is passed to git as an argument; anything that could read as an option is refused. */
export function isSafeRef(ref: string): boolean {
    return /^[A-Za-z0-9._\/@{}^~-]+$/.test(ref) && !ref.startsWith('-');
}

@injectable()
export class MarkdownDiffGitServiceImpl implements MarkdownDiffGitService {
    protected readonly git: GitRunner = runGit;

    protected directoryOf(file: string): string {
        return path.dirname(FileUri.fsPath(file));
    }

    async listRefs(file: string): Promise<MarkdownDiffRefs> {
        const dir = this.directoryOf(file);
        const listed = await this.git(dir, [
            'for-each-ref', '--sort=-committerdate', `--count=${REF_LIMIT + 10}`,
            `--format=%(refname)${FIELD}%(refname:short)${FIELD}%(objectname)${FIELD}%(committerdate:iso-strict)${FIELD}%(authorname)`,
            'refs/heads', 'refs/remotes', 'refs/tags',
        ]);
        if (listed.code !== 0) {
            return { refs: [] };
        }
        const current = await this.git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        return {
            ...(current.code === 0 && current.stdout.trim() ? { current: current.stdout.trim() } : {}),
            refs: parseRefs(listed.stdout),
        };
    }

    async mergeBase(file: string, ref: string): Promise<string | undefined> {
        if (!isSafeRef(ref)) {
            return undefined;
        }
        const based = await this.git(this.directoryOf(file), ['merge-base', 'HEAD', ref]);
        const sha = based.stdout.trim();
        return based.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
    }
}
