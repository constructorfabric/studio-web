// What the Constructor Studio view's "Open in this window" card says about the
// project beyond its name: each checkout's branch and how far it is from its
// remote, as the SCM view knows it, and how the project's last deploy went,
// as Studio recorded it. Rules only, no I/O: the widget reads, this words.

/** A checkout as the card shows it. */
export interface RepoLine {
    readonly name: string;
    /** `main`, without the `*` the status bar adds for uncommitted changes. */
    readonly branch?: string;
    /** Files changed and not committed. */
    readonly changes: number;
    /** Commits to pull and to push, when the SCM says. */
    readonly behind?: number;
    readonly ahead?: number;
}

/** The parts of an SCM provider the card reads. */
export interface ScmLike {
    readonly rootUri: string;
    readonly groups: readonly { readonly resources: readonly unknown[] }[];
    readonly statusBarCommands?: readonly { readonly title: string }[];
}

/** `$(git-branch) main*` → `main*`: a status bar title without its icons. */
function plain(title: string): string {
    return title.replace(/\$\([^)]*\)/g, '').trim();
}

/** A checkout's line, from its SCM provider. */
export function repoLine(provider: ScmLike): RepoLine {
    const name = decodeURIComponent(provider.rootUri.replace(/\/+$/, '').split('/').pop() ?? provider.rootUri);
    const changes = provider.groups.reduce((n, g) => n + g.resources.length, 0);
    const titles = (provider.statusBarCommands ?? []).map(c => c.title);
    // The git extension's first command is the branch (`$(git-branch) main*`),
    // its second the sync (`$(sync) 2↓ 0↑`, or `$(cloud-upload)` with no upstream).
    const branchTitle = titles.find(t => /\$\(git-branch\)/.test(t)) ?? titles[0];
    const branch = branchTitle !== undefined ? plain(branchTitle).replace(/\*$/, '') || undefined : undefined;
    const sync = titles.map(plain).find(t => /\d+\s*↓/.test(t) || /\d+\s*↑/.test(t));
    const behind = sync?.match(/(\d+)\s*↓/)?.[1];
    const ahead = sync?.match(/(\d+)\s*↑/)?.[1];
    return {
        name,
        branch,
        changes,
        ...(behind !== undefined ? { behind: Number(behind) } : {}),
        ...(ahead !== undefined ? { ahead: Number(ahead) } : {}),
    };
}

/** A deploy as Studio's history lists it, as far as the card reads it. */
export interface DeployRecord {
    readonly state?: string;
    readonly environment_name?: string;
    readonly chart_version?: string | null;
    readonly requested_at?: string;
    readonly outcome?: string | null;
    readonly preview?: unknown;
}

const STATE_WORDS: Record<string, string> = {
    succeeded: 'Runs',
    failed: 'Failed',
    running: 'Deploying',
    queued: 'Queued',
    awaiting_approval: 'Waiting for approval',
    declined: 'Declined',
    cancelled: 'Cancelled',
};

/** "3 min ago", "5 h ago", "2 d ago". */
export function ago(at: string | undefined, now: number = Date.now()): string {
    const t = at ? Date.parse(at) : NaN;
    if (!Number.isFinite(t)) {
        return '';
    }
    const minutes = Math.max(0, Math.round((now - t) / 60_000));
    if (minutes < 60) {
        return `${Math.max(1, minutes)} min ago`;
    }
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** The project's last deploy in one line, and whether it went wrong; `undefined` for none. */
export function lastDeployLine(items: readonly DeployRecord[], now: number = Date.now()): { readonly text: string; readonly failed: boolean } | undefined {
    // A preview is not what runs there (ADR-0055).
    const d = items.find(i => !i.preview);
    if (!d) {
        return undefined;
    }
    const state = d.state ?? 'unknown';
    const parts = [
        `${STATE_WORDS[state] ?? state} in ${d.environment_name ?? 'an environment'}`,
        d.chart_version ?? undefined,
        ago(d.requested_at, now) || undefined,
    ].filter(Boolean);
    return { text: parts.join(' · '), failed: state === 'failed' || state === 'declined' };
}
