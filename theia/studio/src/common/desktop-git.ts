// What the desktop backend's git routes answer (`/studio-desktop/git/*`,
// node/desktop-git.ts), and how the frontend puts it into one message.

/** A clone in the opened project's folder. */
export interface DesktopGitRepository {
    /** Its folder, relative to the project's folder. */
    readonly name: string;
    readonly path: string;
    /** The checked-out branch; absent on a detached HEAD. */
    readonly branch?: string;
    /** The branch it tracks, e.g. `origin/main`. */
    readonly upstream?: string;
    /** The remote's address, without credentials. */
    readonly remote?: string;
    readonly ahead?: number;
    readonly behind?: number;
    /** Files changed and not committed. */
    readonly changed: number;
}

export interface DesktopGitSync {
    readonly name: string;
    readonly path: string;
    readonly outcome: 'updated' | 'up-to-date' | 'diverged' | 'skipped' | 'failed';
    readonly message: string;
    /** What an `updated` Sync brought: the commits it moved between, and the documents that changed. */
    readonly brought?: DesktopGitBrought;
}

/**
 * The documents a fast-forward changed, so the member can read what came in
 * rather than only how many commits did. On the desktop every member has their
 * own clone, and Sync is how a colleague's edits arrive.
 */
export interface DesktopGitBrought {
    /** HEAD before the fast-forward. */
    readonly from: string;
    /** HEAD after it. */
    readonly to: string;
    /** Markdown files added or modified between the two, relative to the clone. */
    readonly documents: readonly string[];
}

/** The documents a set of Sync results brought, one entry per document. */
export function broughtDocuments(results: readonly DesktopGitSync[]): Array<{ repository: DesktopGitSync; brought: DesktopGitBrought; document: string }> {
    return results.flatMap(repository => repository.brought
        ? repository.brought.documents.map(document => ({ repository, brought: repository.brought!, document }))
        : []);
}

export interface DesktopGitPush {
    readonly name: string;
    readonly path: string;
    readonly outcome: 'pushed' | 'up-to-date' | 'failed';
    readonly branch?: string;
    readonly message: string;
    /** The link the host printed to open a pull (merge) request for the branch. */
    readonly pullRequestUrl?: string;
}

/** One notification for a whole Sync: its level and its text. */
export function describeSync(results: readonly DesktopGitSync[]): { level: 'info' | 'warn'; text: string } {
    if (results.length === 0) {
        return { level: 'warn', text: 'Sync: this folder holds no git repository. Open a project from the Constructor Studio view to clone its sources.' };
    }
    const level = results.some(r => r.outcome === 'failed' || r.outcome === 'diverged') ? 'warn' : 'info';
    if (results.length === 1) {
        return { level, text: `Sync ${results[0].name}: ${results[0].message}.` };
    }
    const updated = results.filter(r => r.outcome === 'updated').length;
    const head = updated > 0
        ? `Sync: ${updated} of ${results.length} repositories updated.`
        : `Sync: ${results.length} repositories fetched, none needed updating.`;
    return { level, text: `${head} ${results.map(r => `${r.name}: ${r.message}.`).join(' ')}` };
}

/** Folders compared the way Windows does: slashes either way, case ignored, no trailing slash. */
export function samePath(a: string, b: string): boolean {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return norm(a) === norm(b);
}

/**
 * Which clone a Push pushes: the one Source Control has selected, else the
 * only one, else the member chooses. `undefined` when there is none.
 */
export function pushTargetOf(
    repositories: readonly DesktopGitRepository[], selected: string | undefined,
): { repository: DesktopGitRepository } | { choose: readonly DesktopGitRepository[] } | undefined {
    const chosen = selected ? repositories.find(r => samePath(r.path, selected)) : undefined;
    if (chosen) {
        return { repository: chosen };
    }
    if (repositories.length === 1) {
        return { repository: repositories[0] };
    }
    return repositories.length > 1 ? { choose: repositories } : undefined;
}

/** A line under a clone's name: its branch, how far from its remote, what is not committed. */
export function repositoryLine(repository: DesktopGitRepository): string {
    const parts: string[] = [];
    if (!repository.branch) {
        parts.push('detached HEAD');
    } else if (!repository.upstream) {
        parts.push(`${repository.branch}, not pushed yet`);
    } else {
        const ahead = repository.ahead ?? 0;
        const behind = repository.behind ?? 0;
        const where = ahead === 0 && behind === 0 ? 'up to date with' : [
            ahead > 0 ? `${ahead} to push` : '',
            behind > 0 ? `${behind} to pull` : '',
        ].filter(Boolean).join(', ') + ' against';
        parts.push(`${repository.branch}: ${where} ${repository.upstream}`);
    }
    if (repository.changed > 0) {
        parts.push(`${repository.changed} ${repository.changed === 1 ? 'file' : 'files'} changed, not committed`);
    }
    return parts.join(' · ');
}

/** One notification for a push. */
export function describePush(result: DesktopGitPush): { level: 'info' | 'error'; text: string } {
    return result.outcome === 'failed'
        ? { level: 'error', text: `Push ${result.name}: ${result.message}.` }
        : { level: 'info', text: `Push ${result.name}: ${result.message}.` };
}
