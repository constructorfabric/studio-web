// The backend half of #497: which repositories Studio added to the member's
// own Orca, and taking them out again when their project closes.
//
// The record is `~/ConstructorStudio/orca-projects.json`, one entry per
// repository Studio registered with `orca repo add` that Orca did not know
// before. A repository the member added to Orca themselves never gets an
// entry, so it is never removed. Removal is Orca's own "remove project"
// (`orca project setup-delete`, which ends in the runtime's
// `removeProjectForHost`): it forgets the repository and touches no file, no
// branch and no worktree on disk — read off Orca 1.4.211. The CLI has no
// `repo rm`.
//
// A window says which project it has open (`track`); a repository is released
// only when no window has a project it belongs to. A window that went away
// without saying so keeps its project's repositories registered until the
// app restarts: the safe direction.
//
// Everything that decides is a plain function below; `DesktopOrcaProjects`
// only sequences them against Orca, through the narrow `OrcaProjectsPort`.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { OrcaRepository, OrcaTerminal, OrcaWorktree } from '../common/orca-protocol';
import { type OrcaKeptRepository, type OrcaProjectSync } from '../common/desktop-orca-projects';
import { normalizePath, repositoryInProject, worktreeLabel } from '../common/orca-worktree-groups';

/** One repository Studio added to Orca. */
export interface OrcaAddedRepository {
    readonly repoId: string;
    readonly path: string;
    /** The project folder it was added for; for the record, not for decisions. */
    readonly projectRoot: string;
    readonly addedAt: number;
}

export interface OrcaProjectsRecord {
    readonly version: 1;
    readonly repositories: readonly OrcaAddedRepository[];
}

const EMPTY: OrcaProjectsRecord = { version: 1, repositories: [] };

/** Where the record lives: beside the desktop's other state. */
export function orcaProjectsFile(home: string = os.homedir()): string {
    return path.join(home, 'ConstructorStudio', 'orca-projects.json');
}

/** Read the record; a missing or unreadable one is empty, never an error. */
export function readRecord(file: string, read: (f: string) => string = f => fs.readFileSync(f, 'utf8')): OrcaProjectsRecord {
    try {
        const parsed = JSON.parse(read(file)) as Partial<OrcaProjectsRecord>;
        const rows = Array.isArray(parsed.repositories) ? parsed.repositories : [];
        return {
            version: 1,
            repositories: rows.filter(
                (r): r is OrcaAddedRepository =>
                    !!r && typeof r.repoId === 'string' && !!r.repoId && typeof r.path === 'string' && !!r.path
            )
        };
    } catch {
        return EMPTY;
    }
}

/** Write it whole, through a temporary file, so a crash never leaves half of one. */
export function writeRecord(file: string, record: OrcaProjectsRecord): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const partial = `${file}.partial`;
    fs.writeFileSync(partial, `${JSON.stringify(record, undefined, 2)}\n`, 'utf8');
    fs.renameSync(partial, file);
}

/** The project's repositories Orca does not know, by path. */
export function unknownRepositories(projectRepositories: readonly string[], known: readonly OrcaRepository[]): string[] {
    const knownPaths = new Set(known.map(repo => normalizePath(repo.path)));
    return projectRepositories.filter(repo => !knownPaths.has(normalizePath(repo)));
}

/**
 * The entries to add for a registration: the repositories Orca did not know
 * before it and knows after it. One it knew before is the member's own.
 */
export function newlyAdded(
    before: readonly OrcaRepository[],
    after: readonly OrcaRepository[],
    registered: readonly string[],
    projectRoot: string,
    now: number
): OrcaAddedRepository[] {
    const knownBefore = new Set(before.map(repo => normalizePath(repo.path)));
    const out: OrcaAddedRepository[] = [];
    for (const repoPath of registered) {
        const key = normalizePath(repoPath);
        if (knownBefore.has(key)) {
            continue;
        }
        const repo = after.find(r => normalizePath(r.path) === key);
        if (repo?.id) {
            out.push({ repoId: repo.id, path: repo.path, projectRoot, addedAt: now });
        }
    }
    return out;
}

/** Add entries, one per repository id; a newer entry replaces an older one. */
export function recordAdded(record: OrcaProjectsRecord, added: readonly OrcaAddedRepository[]): OrcaProjectsRecord {
    const ids = new Set(added.map(a => a.repoId));
    return { version: 1, repositories: [...record.repositories.filter(r => !ids.has(r.repoId)), ...added] };
}

export interface ReleasePlan {
    /** Belong to no open project, still in Orca as Studio added them: check, then remove. */
    readonly candidates: readonly OrcaAddedRepository[];
    /**
     * No longer Studio's to remove: Orca has forgotten them, or has the path
     * under another id — the member removed it and added it back themselves.
     */
    readonly forget: readonly OrcaAddedRepository[];
}

export function planRelease(
    record: OrcaProjectsRecord,
    openRoots: readonly string[],
    known: readonly OrcaRepository[]
): ReleasePlan {
    const candidates: OrcaAddedRepository[] = [];
    const forget: OrcaAddedRepository[] = [];
    for (const entry of record.repositories) {
        const inOrca = known.find(repo => repo.id === entry.repoId);
        if (!inOrca || normalizePath(inOrca.path) !== normalizePath(entry.path)) {
            forget.push(entry);
            continue;
        }
        if (openRoots.some(root => repositoryInProject(entry.path, root))) {
            continue;
        }
        candidates.push(entry);
    }
    return { candidates, forget };
}

/** What was found in one worktree of a repository about to be removed. */
export interface WorktreeFindings {
    readonly label: string;
    readonly terminals: readonly OrcaTerminal[];
    /** Uncommitted changes; undefined when they could not be read. */
    readonly changes: number | undefined;
}

/**
 * Why a repository must stay in Orca, or undefined when it may go: an agent
 * (or any terminal) still running in one of its worktrees, changes not
 * committed, or changes that could not be read — which is not the same as
 * none.
 */
export function keepReason(worktrees: readonly WorktreeFindings[]): string | undefined {
    for (const w of worktrees) {
        if (w.terminals.length > 0) {
            const agent = w.terminals.find(t => t.agent)?.agent;
            return agent ? `${agent} is still running in ${w.label}` : `a terminal is still running in ${w.label}`;
        }
    }
    for (const w of worktrees) {
        if (w.changes === undefined) {
            return `the changes in ${w.label} could not be read`;
        }
        if (w.changes > 0) {
            return `${w.label} has ${w.changes} uncommitted change${w.changes === 1 ? '' : 's'}`;
        }
    }
    return undefined;
}

/** What `DesktopOrcaProjects` needs from Orca and git; a seam for tests. */
export interface OrcaProjectsPort {
    listRepositories(): Promise<OrcaRepository[]>;
    listWorktrees(): Promise<OrcaWorktree[]>;
    listTerminals(worktreeSelector: string): Promise<OrcaTerminal[]>;
    /** Uncommitted changes in a checkout; 0 when the folder is gone; throws when unreadable. */
    uncommitted(checkout: string): Promise<number>;
    /** The git repositories a project folder holds. */
    repositoriesAt(root: string): Promise<string[]>;
    /** `orca repo add --path`. */
    addRepository(repoPath: string): Promise<void>;
    /** Forget a repository in Orca; files stay. */
    removeRepository(repoId: string): Promise<void>;
}

export interface OrcaProjectsStore {
    read(): OrcaProjectsRecord;
    write(record: OrcaProjectsRecord): void;
}

export function fileStore(file: string = orcaProjectsFile()): OrcaProjectsStore {
    return { read: () => readRecord(file), write: record => writeRecord(file, record) };
}

export class DesktopOrcaProjects {

    /** Which project each window has open. */
    protected readonly open = new Map<string, string>();
    /** One operation at a time: two windows reporting at once must not race on the record. */
    protected queue: Promise<unknown> = Promise.resolve();

    constructor(
        protected readonly port: OrcaProjectsPort,
        protected readonly store: OrcaProjectsStore,
        protected readonly now: () => number = Date.now
    ) {}

    /**
     * A window has `root` open (undefined: none). Releases what no open
     * project needs any more, and answers which of `root`'s repositories Orca
     * does not know.
     */
    track(windowId: string, root: string | undefined): Promise<OrcaProjectSync> {
        return this.serial(async () => {
            if (root?.trim()) {
                this.open.set(windowId, root);
            } else {
                this.open.delete(windowId);
            }
            const known = await this.port.listRepositories();
            const { removed, kept } = await this.release(known);
            const after = removed.length ? await this.port.listRepositories() : known;
            const unknown = root?.trim() ? unknownRepositories(await this.port.repositoriesAt(root), after) : [];
            return { enabled: true, unknown, removed, kept };
        });
    }

    /** Register a project's repositories with Orca, recording the ones that are Studio's. */
    add(root: string): Promise<string[]> {
        return this.serial(async () => {
            const repositories = await this.port.repositoriesAt(root);
            const before = await this.port.listRepositories();
            for (const repository of repositories) {
                await this.port.addRepository(repository);
            }
            const after = await this.port.listRepositories();
            const added = newlyAdded(before, after, repositories, root, this.now());
            if (added.length) {
                this.store.write(recordAdded(this.store.read(), added));
            }
            return repositories;
        });
    }

    protected async release(known: OrcaRepository[]): Promise<{ removed: string[]; kept: OrcaKeptRepository[] }> {
        const record = this.store.read();
        const plan = planRelease(record, [...this.open.values()], known);
        if (plan.candidates.length === 0 && plan.forget.length === 0) {
            return { removed: [], kept: [] };
        }
        const drop = new Set(plan.forget.map(e => e.repoId));
        const removed: string[] = [];
        const kept: OrcaKeptRepository[] = [];
        const worktrees = plan.candidates.length ? await this.port.listWorktrees() : [];
        for (const entry of plan.candidates) {
            const findings: WorktreeFindings[] = [];
            for (const worktree of worktrees.filter(w => w.repoId === entry.repoId)) {
                findings.push({
                    label: worktreeLabel(worktree),
                    terminals: await this.port.listTerminals(`path:${worktree.path}`).catch(() => []),
                    changes: await this.port.uncommitted(worktree.path).catch(() => undefined)
                });
            }
            const reason = keepReason(findings);
            if (reason) {
                kept.push({ path: entry.path, reason });
                continue;
            }
            try {
                await this.port.removeRepository(entry.repoId);
                removed.push(entry.path);
                drop.add(entry.repoId);
            } catch (error) {
                kept.push({
                    path: entry.path,
                    reason: `Orca refused to remove it (${error instanceof Error ? error.message : String(error)})`
                });
            }
        }
        if (drop.size) {
            this.store.write({ version: 1, repositories: record.repositories.filter(r => !drop.has(r.repoId)) });
        }
        return { removed, kept };
    }

    protected serial<T>(work: () => Promise<T>): Promise<T> {
        const next = this.queue.then(work, work);
        this.queue = next.catch(() => undefined);
        return next;
    }
}
