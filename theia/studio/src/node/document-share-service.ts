// The node side of document-share-protocol.ts: what "Share with the team"
// does in git, for a person who should never have to see git.
//
// One share is: stage the chosen documents and the `.studio` files that belong
// to them (their comments, suggestions and history), commit only those, as
// the person, bring in what the team pushed meanwhile (a rebase, so the
// project's history stays a line), and push to the branch the project works on.
// Git runs in each repository's own folder through the same runner as the
// desktop's Sync and Push, so credentials are what they already are: the
// session's helper in a portal session, the token broker's on the desktop.

import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { WorkspaceServer } from '@theia/workspace/lib/common/workspace-protocol';
import { FileUri } from '@theia/core/lib/common/file-uri';
import * as fs from 'fs';
import * as path from 'path';
import { GitResult, GitRunner, pullRequestLinkOf, repositoriesUnder, runGit } from './desktop-git';
import type {
    DocumentShareService, ShareDocument, ShareOutcome, SharePerson, ShareRepository, ShareRequest, ShareStatus,
} from '../common/document-share-protocol';

const STUDIO_DIR = '.studio';
/** The `.studio` folders whose files are about one document, named after it. */
const COMPANION_DIRS = ['comments', 'changes', 'history'];

export function isDocumentPath(file: string): boolean {
    return /\.(md|markdown)$/i.test(file) && !file.startsWith(`${STUDIO_DIR}/`);
}

/**
 * The document a `.studio` file belongs to: `.studio/comments/docs/spec.md.json`,
 * `.studio/changes/docs/spec.md/<author>.json` and `.studio/history/docs/spec.md.json`
 * all belong to `docs/spec.md`. Undefined for a `.studio` file about nothing in particular.
 */
export function companionOf(file: string): string | undefined {
    for (const dir of COMPANION_DIRS) {
        const prefix = `${STUDIO_DIR}/${dir}/`;
        if (!file.startsWith(prefix)) {
            continue;
        }
        const rest = file.slice(prefix.length);
        const match = /^(.+?\.(?:md|markdown))(?:\.json|\.jsonl|\/.*)$/i.exec(rest);
        return match ? match[1] : undefined;
    }
    return undefined;
}

export interface StatusEntry {
    readonly path: string;
    readonly state: 'modified' | 'added' | 'deleted';
}

/** `git status --porcelain=v1 -z -uall`, read: renames count as an added file. */
export function parseStatus(output: string): StatusEntry[] {
    const entries: StatusEntry[] = [];
    const fields = output.split('\0');
    for (let index = 0; index < fields.length; index++) {
        const field = fields[index];
        if (field.length < 4) {
            continue;
        }
        const code = field.slice(0, 2);
        const file = field.slice(3);
        if (code[0] === 'R' || code[0] === 'C') {
            index++; // the original path follows
        }
        const state = code.includes('D') ? 'deleted' : (code === '??' || code.includes('A') || code[0] === 'R') ? 'added' : 'modified';
        entries.push({ path: file, state });
    }
    return entries;
}

/** A document's first heading, for a list a person reads. */
export function titleOf(markdown: string, fallback: string): string {
    const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(body);
    return heading ? heading[1].trim() : fallback;
}

/** Who the document's history says edited it after `since` (ISO); names, in order of first appearance. */
export function editorsSince(history: unknown, since: string | undefined): string[] {
    const entries = (history as { entries?: Array<{ at?: string; author?: string; kind?: string }> } | undefined)?.entries;
    if (!Array.isArray(entries)) {
        return [];
    }
    const after = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
    const names: string[] = [];
    for (const entry of entries) {
        if (!entry || typeof entry.author !== 'string' || entry.author === 'you' || /^(assistant|claude|codex)$/i.test(entry.author)) {
            continue;
        }
        if (!['edit', 'remote-edit', 'restore', 'accept', 'reject'].includes(entry.kind ?? '')) {
            continue;
        }
        if (entry.at && Date.parse(entry.at) <= after) {
            continue;
        }
        if (!names.includes(entry.author)) {
            names.push(entry.author);
        }
    }
    return names;
}

/** The commit message: the person's words, and everybody else whose edits went along. */
export function commitMessage(message: string, author: SharePerson | undefined, coAuthors: readonly SharePerson[] = []): string {
    const subject = message.trim().split('\n')[0].slice(0, 200) || 'Update documents';
    const rest = message.trim().split('\n').slice(1).join('\n').trim();
    const others = coAuthors.filter(person => person.name && person.name !== author?.name);
    const trailers = others.map(person => person.email
        ? `Co-authored-by: ${person.name} <${person.email}>`
        : `Also-edited-by: ${person.name}`);
    return [subject, rest, trailers.join('\n')].filter(Boolean).join('\n\n') + '\n';
}

export type Failure = 'sign-in' | 'offline' | 'rejected' | 'protected' | 'failed';

/** What a failed fetch, pull or push means, from what git printed. */
export function failureOf(result: GitResult): Failure {
    const text = `${result.stderr}\n${result.stdout}`;
    if (/protected branch|GH006|pre-receive hook declined|not allowed to (push|force push)|You are not allowed to push code to protected branches/i.test(text)) {
        return 'protected';
    }
    if (/Authentication failed|could not read Username|Permission denied|access denied|HTTP Basic: Access denied|returned error: 40[13]|Invalid username or password/i.test(text)) {
        return 'sign-in';
    }
    if (/Could not resolve host|unable to access|Connection (timed out|refused)|Network is unreachable|Operation timed out|Failed to connect/i.test(text)) {
        return 'offline';
    }
    if (/\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(text)) {
        return 'rejected';
    }
    return 'failed';
}

/** A branch for review, when the project's branch refuses direct changes. */
export function reviewBranchName(author: SharePerson | undefined, now: Date): string {
    const who = (author?.name ?? 'studio').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'studio';
    const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
    return `studio/${who}/${stamp}`;
}

/** Whether `target` is `folder` or inside it. */
export function isWithin(folder: string, target: string): boolean {
    const relative = path.relative(path.resolve(folder), path.resolve(target));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The folders a workspace opens: the folder itself, or for a workspace file
 * (the desktop's `<project>.theia-workspace`) the folders it lists, relative
 * to the file. Theia writes those files as plain JSON.
 */
export function workspaceFolders(workspace: string): string[] {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(workspace);
    } catch {
        return [];
    }
    if (stat.isDirectory()) {
        return [path.resolve(workspace)];
    }
    try {
        const folders = (JSON.parse(fs.readFileSync(workspace, 'utf8')) as { folders?: Array<{ path?: unknown }> }).folders ?? [];
        return folders
            .map(folder => folder.path)
            .filter((folder): folder is string => typeof folder === 'string')
            .map(folder => folder.startsWith('file:') ? FileUri.fsPath(folder) : path.resolve(path.dirname(workspace), folder));
    } catch {
        return [];
    }
}

@injectable()
export class DocumentShareServiceImpl implements DocumentShareService {
    protected git: GitRunner = runGit;
    protected now: () => Date = () => new Date();

    /** Which folders this session opened; absent only where nothing is bound (unit tests). */
    @inject(WorkspaceServer) @optional()
    protected readonly workspaceServer?: WorkspaceServer;

    /**
     * The folders git may run in: what the session opened. The roots come
     * from the client, and git here commits and pushes with the session's
     * credentials, so a root outside the workspace is refused, not trusted.
     */
    protected async allowedFolders(): Promise<string[] | undefined> {
        if (!this.workspaceServer) {
            return undefined;
        }
        const opened = await this.workspaceServer.getMostRecentlyUsedWorkspace();
        return opened ? workspaceFolders(FileUri.fsPath(opened)) : [];
    }

    protected async isAllowed(dir: string): Promise<boolean> {
        const allowed = await this.allowedFolders();
        return !allowed || allowed.some(folder => isWithin(folder, dir));
    }

    async status(roots: readonly string[]): Promise<ShareStatus> {
        const repositories: ShareRepository[] = [];
        const seen = new Set<string>();
        for (const root of roots) {
            if (!await this.isAllowed(FileUri.fsPath(root))) {
                continue;
            }
            for (const dir of this.repositoriesOf(FileUri.fsPath(root))) {
                if (seen.has(dir)) {
                    continue;
                }
                seen.add(dir);
                const described = await this.describe(dir);
                if (described) {
                    repositories.push(described);
                }
            }
        }
        return { repositories };
    }

    protected repositoriesOf(folder: string): string[] {
        return fs.existsSync(path.join(folder, '.git')) ? [path.resolve(folder)] : repositoriesUnder(folder);
    }

    protected async text(dir: string, args: readonly string[]): Promise<string | undefined> {
        const result = await this.git(dir, args);
        return result.code === 0 ? result.stdout.trim() : undefined;
    }

    protected async describe(dir: string): Promise<ShareRepository | undefined> {
        const listed = await this.git(dir, ['status', '--porcelain=v1', '-z', '-uall']);
        if (listed.code !== 0) {
            return undefined;
        }
        const entries = parseStatus(listed.stdout);
        const branch = await this.text(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        const upstream = branch ? await this.text(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) : undefined;
        const unsentText = upstream ? await this.text(dir, ['rev-list', '--count', '@{upstream}..HEAD']) : undefined;
        const documents: ShareDocument[] = [];
        for (const entry of entries.filter(e => isDocumentPath(e.path))) {
            const companions = entries.filter(e => companionOf(e.path) === entry.path).map(e => e.path);
            documents.push(await this.document(dir, entry, companions));
        }
        // A document whose own text did not change but whose comments or
        // suggestions did is something to share too: a reply is work.
        for (const entry of entries) {
            const owner = companionOf(entry.path);
            if (owner && !documents.some(document => document.path === owner)) {
                const companions = entries.filter(e => companionOf(e.path) === owner).map(e => e.path);
                documents.push(await this.document(dir, { path: owner, state: 'modified' }, companions, true));
            }
        }
        return {
            root: FileUri.create(dir).toString(),
            name: path.basename(dir),
            ...(branch ? { branch } : {}),
            ...(upstream ? { upstream } : {}),
            unsent: Number(unsentText ?? 0) || 0,
            documents: documents.sort((a, b) => a.path.localeCompare(b.path)),
        };
    }

    protected async document(dir: string, entry: StatusEntry, companions: string[], onlyCompanions = false): Promise<ShareDocument> {
        const file = path.join(dir, ...entry.path.split('/'));
        let markdown = '';
        try {
            markdown = fs.readFileSync(file, 'utf8');
        } catch {
            // deleted: its title is its name
        }
        let history: unknown;
        try {
            history = JSON.parse(fs.readFileSync(path.join(dir, STUDIO_DIR, 'history', ...`${entry.path}.json`.split('/')), 'utf8'));
        } catch {
            history = undefined;
        }
        const lastShared = await this.text(dir, ['log', '-1', '--format=%cI', '--', entry.path]);
        return {
            path: entry.path,
            uri: FileUri.create(file).toString(),
            state: onlyCompanions ? 'modified' : entry.state,
            title: titleOf(markdown, path.basename(entry.path)),
            editors: editorsSince(history, lastShared || undefined),
            companions,
        };
    }

    async share(request: ShareRequest): Promise<ShareOutcome> {
        const dir = FileUri.fsPath(request.root);
        if (!await this.isAllowed(dir)) {
            return { kind: 'failed', detail: 'not a folder of this workspace' };
        }
        const described = await this.describe(dir);
        if (!described) {
            return { kind: 'failed', detail: 'not a git repository' };
        }
        const chosen = described.documents.filter(document => request.documents.includes(document.path));
        const paths = chosen.flatMap(document => [document.path, ...document.companions]);
        // A document listed only for its comments has no change of its own to stage.
        const changed = new Set(parseStatus((await this.git(dir, ['status', '--porcelain=v1', '-z', '-uall'])).stdout).map(e => e.path));
        const toCommit = paths.filter(file => changed.has(file));

        if (toCommit.length === 0 && described.unsent === 0 && !request.prefer) {
            return { kind: 'nothing', branch: described.branch };
        }
        if (toCommit.length) {
            const added = await this.git(dir, ['add', '-A', '--', ...toCommit]);
            if (added.code !== 0) {
                return { kind: 'failed', detail: added.stderr.trim() };
            }
            const author = request.author;
            // The person, not the container: their name always, their address
            // when the identity has one (else the repository's own).
            const env = author?.name
                ? ['-c', `user.name=${author.name}`, ...(author.email ? ['-c', `user.email=${author.email}`] : [])]
                : [];
            // Only these paths, whatever else anybody staged in a shared checkout.
            const committed = await this.git(dir, [...env, 'commit', '--no-verify', '-m', commitMessage(request.message, author, request.coAuthors), '--', ...toCommit]);
            if (committed.code !== 0) {
                return { kind: 'failed', detail: (committed.stderr || committed.stdout).trim() };
            }
        }
        if (!described.upstream) {
            const published = await this.push(dir, described.branch, request.author, true);
            return published === 'rejected' ? { kind: 'failed', detail: 'rejected' } : published;
        }
        const brought = await this.bringIn(dir, request.prefer);
        if (brought) {
            return brought;
        }
        const pushed = await this.push(dir, described.branch, request.author, false);
        if (pushed !== 'rejected') {
            return pushed;
        }
        // The team pushed between our pull and our push: once more.
        const again = await this.bringIn(dir, request.prefer);
        if (again) {
            return again;
        }
        const retried = await this.push(dir, described.branch, request.author, false);
        return retried === 'rejected' ? { kind: 'failed', detail: 'the remote kept moving; try again' } : retried;
    }

    /** Rebase onto what the team pushed; undefined when that went through. */
    protected async bringIn(dir: string, prefer: ShareRequest['prefer']): Promise<ShareOutcome | undefined> {
        // Fetch first, and touch the working tree only when the team has moved:
        // a pull with --autostash rewrites every uncommitted file (a colleague's
        // draft, the .studio logs) on the way out and back, and an open
        // Documents editor reads that as somebody's unclaimed write — held for
        // review, the file put back. Measured on a stand: the sentence just
        // typed was taken off the page by the person's own share.
        const fetched = await this.git(dir, ['fetch', '--quiet']);
        if (fetched.code !== 0) {
            const failure = failureOf(fetched);
            return failure === 'sign-in' || failure === 'offline'
                ? { kind: failure, detail: fetched.stderr.trim() }
                : { kind: 'failed', detail: (fetched.stderr || fetched.stdout).trim() };
        }
        const behind = Number(await this.text(dir, ['rev-list', '--count', 'HEAD..@{upstream}']) ?? 0);
        if (!behind) {
            return undefined;
        }
        // During a rebase "theirs" is the commit being replayed — mine.
        const strategy = prefer === 'mine' ? ['-X', 'theirs'] : prefer === 'theirs' ? ['-X', 'ours'] : [];
        const pulled = await this.git(dir, ['pull', '--rebase', '--autostash', ...strategy]);
        if (pulled.code === 0) {
            return undefined;
        }
        const conflicted = await this.text(dir, ['diff', '--name-only', '--diff-filter=U']);
        if (conflicted) {
            await this.git(dir, ['rebase', '--abort']);
            // After the abort: mid-rebase HEAD is detached and has no upstream.
            const theirs = await this.text(dir, ['rev-parse', '@{upstream}']);
            return {
                kind: 'conflict',
                conflicts: conflicted.split('\n').filter(Boolean),
                ...(theirs ? { theirs } : {}),
            };
        }
        const failure = failureOf(pulled);
        return failure === 'sign-in' || failure === 'offline'
            ? { kind: failure, detail: pulled.stderr.trim() }
            : { kind: 'failed', detail: (pulled.stderr || pulled.stdout).trim() };
    }

    /** 'rejected': the remote has commits this branch does not — bring them in and push again. */
    protected async push(dir: string, branch: string | undefined, author: SharePerson | undefined, first: boolean): Promise<ShareOutcome | 'rejected'> {
        if (!branch) {
            return { kind: 'failed', detail: 'no branch is checked out' };
        }
        const pushed = await this.git(dir, first ? ['push', '--set-upstream', 'origin', branch] : ['push']);
        if (pushed.code === 0) {
            return { kind: 'shared', branch };
        }
        const failure = failureOf(pushed);
        if (failure === 'protected') {
            const review = reviewBranchName(author, this.now());
            const sent = await this.git(dir, ['push', 'origin', `HEAD:refs/heads/${review}`]);
            if (sent.code === 0) {
                const reviewUrl = pullRequestLinkOf(sent.stderr);
                return { kind: 'review', branch: review, ...(reviewUrl ? { reviewUrl } : {}) };
            }
            return { kind: 'failed', detail: sent.stderr.trim() };
        }
        if (failure === 'rejected') {
            return 'rejected';
        }
        return failure === 'sign-in' || failure === 'offline'
            ? { kind: failure, detail: pushed.stderr.trim() }
            : { kind: 'failed', detail: (pushed.stderr || pushed.stdout).trim() };
    }
}
