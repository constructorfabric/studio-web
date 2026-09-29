// The Agents panel's worktrees, grouped by the repository they belong to.
//
// An Orca runtime on a member's machine knows every repository they ever
// added to Orca, not just the project open in Studio. Listed flat, that read
// as seven worktrees of "this" project, two of them called `main` — one per
// repository, since every repository has a main worktree. Grouped, the open
// project's repositories come first and the rest are named as what they are.
//
// Pure, and in common, so it is tested without a widget or a runtime.

import type { OrcaRepository, OrcaWorktree } from './orca-protocol';

export interface OrcaWorktreeGroup {
    /** The Orca repository id; empty for worktrees whose repository Orca did not name. */
    readonly repoId: string;
    /** What the heading says: the repository's name in Orca, or its folder. */
    readonly name: string;
    readonly path: string;
    /** True when the repository is (in) the project open in Studio. */
    readonly inProject: boolean;
    /** The main worktree first, then the rest by name. */
    readonly worktrees: readonly OrcaWorktree[];
}

/**
 * A path in one comparable spelling: forward slashes, no trailing slash, and
 * case-folded when it is a Windows drive path. Orca answers `C:/Repos/x`
 * where the IDE says `c:\Repos\x`, and both are the same folder.
 */
export function normalizePath(value: string): string {
    let out = value.trim().replace(/\\/g, '/');
    while (out.length > 1 && out.endsWith('/') && !/^[A-Za-z]:\/$/.test(out)) {
        out = out.slice(0, -1);
    }
    return /^[A-Za-z]:/.test(out) ? out.toLowerCase() : out;
}

/** Whether `inner` is `outer` or somewhere below it. */
export function isWithin(inner: string, outer: string): boolean {
    const a = normalizePath(inner);
    const b = normalizePath(outer);
    return a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`);
}

/**
 * Whether a repository belongs to the open project: it sits in the project's
 * folder (a Studio project is a folder of source checkouts), or the project's
 * folder is inside it (the IDE was opened on a subfolder of one checkout).
 */
export function repositoryInProject(repositoryPath: string, projectRoot: string | undefined): boolean {
    if (!projectRoot || !repositoryPath) {
        return false;
    }
    return isWithin(repositoryPath, projectRoot) || isWithin(projectRoot, repositoryPath);
}

export function groupWorktrees(
    worktrees: readonly OrcaWorktree[],
    repositories: readonly OrcaRepository[],
    projectRoot: string | undefined
): OrcaWorktreeGroup[] {
    const byId = new Map(repositories.map(repo => [repo.id, repo] as const));
    const groups = new Map<string, { repoId: string; name: string; path: string; worktrees: OrcaWorktree[] }>();
    for (const worktree of worktrees) {
        const repoId = worktree.repoId ?? '';
        let group = groups.get(repoId);
        if (!group) {
            const repo = byId.get(repoId);
            // With no repository record, the main worktree's folder is the
            // repository's; any worktree's is better than nothing.
            const fallbackPath = repo?.path ?? '';
            group = { repoId, name: repo?.displayName ?? '', path: fallbackPath, worktrees: [] };
            groups.set(repoId, group);
        }
        group.worktrees.push(worktree);
    }
    const out: OrcaWorktreeGroup[] = [];
    for (const group of groups.values()) {
        const main = group.worktrees.find(w => w.isMain);
        const path = group.path || main?.path || group.worktrees[0]?.path || '';
        const name = group.name || baseName(path) || 'Unknown repository';
        const inProject = repositoryInProject(path, projectRoot)
            || group.worktrees.some(w => repositoryInProject(w.path, projectRoot));
        const sorted = [...group.worktrees].sort((a, b) =>
            a.isMain !== b.isMain ? (a.isMain ? -1 : 1) : worktreeLabel(a).localeCompare(worktreeLabel(b))
        );
        out.push({ repoId: group.repoId, name, path, inProject, worktrees: sorted });
    }
    return out.sort((a, b) => (a.inProject !== b.inProject ? (a.inProject ? -1 : 1) : a.name.localeCompare(b.name)));
}

/** What a worktree row is called: its branch, or its name when it has none (a detached HEAD). */
export function worktreeLabel(worktree: OrcaWorktree): string {
    return worktree.branch || worktree.displayName || worktree.path;
}

/** The worktree the panel should act on when none is chosen yet. */
export function defaultWorktree(
    groups: readonly OrcaWorktreeGroup[],
    current: OrcaWorktree | undefined,
    projectRoot: string | undefined
): OrcaWorktree | undefined {
    if (current) {
        return current;
    }
    const project = groups.filter(group => group.inProject);
    // A worktree the IDE is open in beats the repository's main one.
    for (const group of project) {
        const here = group.worktrees.find(w => projectRoot && isWithin(projectRoot, w.path));
        if (here) {
            return here;
        }
    }
    if (project.length) {
        return project[0].worktrees[0];
    }
    // No project open: nothing is "this" project's, so pick nothing rather
    // than another repository's checkout the member did not ask about.
    return projectRoot ? undefined : groups[0]?.worktrees[0];
}

function baseName(value: string): string {
    const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] ?? '';
}
