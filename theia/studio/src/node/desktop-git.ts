import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { DesktopGitBrought, DesktopGitPush, DesktopGitRepository, DesktopGitSync } from '../common/desktop-git';

/*
 * Git on the desktop: what Sync, Push and the Sources view do with the clones
 * of an opened project (ADR-0027).
 *
 * A session has a canonical workspace config, and its Sync reconciles the
 * checkouts with it; its pushes go through the operations queue. A desktop
 * project has neither. It is a folder of clones, one per source the project's
 * settings in Studio list (`workspace.settings` repos[], served by studio-git's
 * `/sources`), made by `DesktopStudioContribution.cloneSources`. So the desktop
 * does what a member would do in a terminal, and says what happened:
 *
 * - Sync is `git fetch` and then a fast-forward only: a branch that has
 *   commits of its own is never merged or rebased behind the member's back.
 * - Push pushes the current branch, setting its upstream the first time, and
 *   hands on the pull-request link the remote prints, when it prints one.
 *
 * Credentials are git's own business here: a clone's config names the token
 * broker's helper (never a token), and the backend's environment carries the
 * broker's address once signed in.
 */

/** One git run: its exit code and what it printed. */
export interface GitResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitResult>;

/** `git` itself, never asking on a terminal nobody sees. */
export const runGit: GitRunner = (cwd, args) => new Promise(resolve => {
    const child = spawn('git', [...args], {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8000); });
    child.on('error', error => resolve({ code: -1, stdout, stderr: error.message }));
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
});

const SKIPPED = new Set(['node_modules', '.git', '.theia', '.cf-studio']);

/**
 * The git repositories of a folder: the folder itself when it is one, else
 * those at most two levels below it — a source's `target` may be `libs/x`.
 * A repository's own subfolders are not searched: a clone is one source.
 */
export function repositoriesUnder(root: string, depth = 2): string[] {
    const found: string[] = [];
    const visit = (dir: string, left: number) => {
        if (fs.existsSync(path.join(dir, '.git'))) {
            found.push(dir);
            return;
        }
        if (left === 0) {
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isDirectory() && !SKIPPED.has(entry.name)) {
                visit(path.join(dir, entry.name), left - 1);
            }
        }
    };
    visit(path.resolve(root), depth);
    return found;
}

/** What git said last, in one line: the reason, not the whole transcript. */
export function reasonOf(result: GitResult): string {
    const lines = `${result.stderr}\n${result.stdout}`
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !/^hint:/i.test(line));
    return lines.slice(-2).join(' ') || `git exited with ${result.code}`;
}

/**
 * The pull-request link a push printed, if the host printed one: GitHub's
 * "Create a pull request … by visiting:", GitLab's "To create a merge
 * request …", Bitbucket's and Gitea's alike. Only `remote:` lines are read —
 * that is the host speaking, not git.
 */
export function pullRequestLinkOf(stderr: string): string | undefined {
    const lines = stderr.split(/\r?\n/).filter(line => /^remote:/i.test(line.trim()));
    for (const [index, line] of lines.entries()) {
        const url = /(https?:\/\/\S+)/.exec(line)?.[1];
        if (!url) {
            continue;
        }
        const context = `${lines[index - 1] ?? ''} ${line}`;
        if (/pull[/-]new|merge_requests\/new|pull-requests\/new|compare\/|pull request|merge request/i.test(context)) {
            return url;
        }
    }
    return undefined;
}

async function text(git: GitRunner, dir: string, args: readonly string[]): Promise<string | undefined> {
    const result = await git(dir, args);
    return result.code === 0 ? result.stdout.trim() : undefined;
}

/** How far the branch is from its upstream, as git counts it; `undefined` when there is no upstream. */
async function distance(git: GitRunner, dir: string): Promise<{ ahead: number; behind: number } | undefined> {
    const counted = await text(git, dir, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
    const [ahead, behind] = (counted ?? '').split(/\s+/).map(Number);
    return counted !== undefined && Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : undefined;
}

/** A repository as the Sources view lists it: where, which branch, how far from its remote. */
export async function describeRepository(git: GitRunner, root: string, dir: string): Promise<DesktopGitRepository> {
    const name = path.relative(root, dir).replace(/\\/g, '/') || path.basename(dir);
    const branch = await text(git, dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const upstream = branch ? await text(git, dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) : undefined;
    const remote = await text(git, dir, ['config', '--get', `remote.${upstream?.split('/')[0] ?? 'origin'}.url`]);
    const status = await text(git, dir, ['status', '--porcelain']);
    const counted = upstream ? await distance(git, dir) : undefined;
    return {
        name,
        path: dir,
        ...(branch ? { branch } : {}),
        ...(upstream ? { upstream } : {}),
        // What a member recognises: the host and path, never credentials.
        ...(remote ? { remote: remote.replace(/\/\/[^/@]*@/, '//') } : {}),
        ...(counted ? counted : {}),
        changed: status ? status.split('\n').filter(Boolean).length : 0,
    };
}

/**
 * Fetch, then fast-forward when that is all it takes. A branch that has
 * commits of its own and is behind is left as it is, and said so: merging or
 * rebasing is the member's decision, taken in Source Control.
 */
export async function syncRepository(git: GitRunner, root: string, dir: string): Promise<DesktopGitSync> {
    const name = path.relative(root, dir).replace(/\\/g, '/') || path.basename(dir);
    const fetched = await git(dir, ['fetch', '--prune']);
    if (fetched.code !== 0) {
        return { name, path: dir, outcome: 'failed', message: `fetch failed: ${reasonOf(fetched)}` };
    }
    const branch = await text(git, dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch) {
        return { name, path: dir, outcome: 'skipped', message: 'fetched; no branch is checked out, so nothing to bring up to date' };
    }
    const upstream = await text(git, dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    if (!upstream) {
        return { name, path: dir, outcome: 'skipped', message: `fetched; ${branch} tracks no remote branch yet — push it once to publish it` };
    }
    const counted = await distance(git, dir);
    if (!counted || counted.behind === 0) {
        const toPush = counted?.ahead ? ` (${counted.ahead} ${counted.ahead === 1 ? 'commit' : 'commits'} to push)` : '';
        return { name, path: dir, outcome: 'up-to-date', message: `${branch} is up to date with ${upstream}${toPush}` };
    }
    if (counted.ahead > 0) {
        return {
            name, path: dir, outcome: 'diverged',
            message: `${branch} and ${upstream} have both moved (${counted.ahead} ahead, ${counted.behind} behind); left as it is — merge or rebase it in Source Control`,
        };
    }
    const from = await text(git, dir, ['rev-parse', 'HEAD']);
    const merged = await git(dir, ['merge', '--ff-only', '@{upstream}']);
    if (merged.code !== 0) {
        return { name, path: dir, outcome: 'failed', message: `${branch} could not be fast-forwarded: ${reasonOf(merged)}` };
    }
    const to = await text(git, dir, ['rev-parse', 'HEAD']);
    const brought = from && to ? await documentsBetween(git, dir, from, to) : undefined;
    return {
        name, path: dir, outcome: 'updated',
        message: `${branch} fast-forwarded by ${counted.behind} ${counted.behind === 1 ? 'commit' : 'commits'} from ${upstream}`,
        ...(brought ? { brought } : {}),
    };
}

/** Past this many, the list is a repository's worth of churn, not documents to read. */
const BROUGHT_DOCUMENTS_LIMIT = 200;

/** The markdown files added or modified between two commits; deleted ones have nothing to read. */
async function documentsBetween(git: GitRunner, dir: string, from: string, to: string): Promise<DesktopGitBrought | undefined> {
    const listed = await text(git, dir, ['diff', '--name-only', '--diff-filter=AM', '-z', from, to, '--', '*.md', '*.markdown']);
    if (listed === undefined) {
        return undefined;
    }
    const documents = listed.split('\0').map(file => file.trim()).filter(Boolean).slice(0, BROUGHT_DOCUMENTS_LIMIT);
    return { from, to, documents };
}

/**
 * Push the current branch. The first push of a branch sets its upstream on the
 * remote the branch already tracks, else `origin`, else the only remote.
 */
export async function pushRepository(git: GitRunner, root: string, dir: string): Promise<DesktopGitPush> {
    const name = path.relative(root, dir).replace(/\\/g, '/') || path.basename(dir);
    const branch = await text(git, dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch) {
        return { name, path: dir, outcome: 'failed', message: 'no branch is checked out (a detached HEAD); check out a branch in Source Control first' };
    }
    const upstream = await text(git, dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    let args: string[];
    let target: string;
    if (upstream) {
        args = ['push'];
        target = upstream;
    } else {
        const remotes = (await text(git, dir, ['remote']) ?? '').split(/\s+/).filter(Boolean);
        const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined;
        if (!remote) {
            return {
                name, path: dir, outcome: 'failed', branch,
                message: remotes.length === 0 ? 'this repository has no remote to push to' : `${branch} tracks no remote branch, and there is no origin among ${remotes.join(', ')}`,
            };
        }
        args = ['push', '--set-upstream', remote, branch];
        target = `${remote}/${branch}`;
    }
    const pushed = await git(dir, args);
    if (pushed.code !== 0) {
        const reason = reasonOf(pushed);
        const hint = /rejected|non-fast-forward|fetch first/i.test(pushed.stderr)
            ? ' — the remote has commits this branch does not; Sync, then merge or rebase, then push again'
            : /authentication|403|401|could not read username|credential/i.test(pushed.stderr)
                ? ' — sign in to Constructor Studio (the Studio view) and push again'
                : '';
        return { name, path: dir, outcome: 'failed', branch, message: `push to ${target} failed: ${reason}${hint}` };
    }
    const link = pullRequestLinkOf(pushed.stderr);
    const upToDate = /Everything up-to-date/i.test(pushed.stderr);
    return {
        name, path: dir, outcome: upToDate ? 'up-to-date' : 'pushed', branch,
        message: upToDate ? `${branch}: nothing to push, ${target} already has it` : `pushed ${branch} to ${target}`,
        ...(link ? { pullRequestUrl: link } : {}),
    };
}
