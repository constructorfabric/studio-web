// Opening a project on the desktop Studio: what the Studio view shows while
// the IDE backend lists the project's sources and clones them (ADR-0027).
//
// A first open can be a large clone through the studio-git proxy, and the
// view used to show one spinner for all of it. The backend keeps this record
// while it works (`GET /studio-desktop/open-progress`) and the view draws it.

/** One source of the project, as far as the open has got with it. */
export interface SourceProgress {
    readonly name: string;
    /** `present`: already on disk, left alone. */
    readonly state: 'waiting' | 'present' | 'cloning' | 'done' | 'failed';
    /** What git says it is doing, e.g. "Receiving objects". */
    readonly stage?: string;
    /** 0–100 across the whole clone of this source, not the current stage. */
    readonly percent?: number;
}

export interface OpenProgress {
    readonly workspaceId: string;
    readonly name: string;
    readonly phase: 'listing' | 'cloning' | 'done' | 'failed';
    readonly sources: readonly SourceProgress[];
    readonly error?: string;
}

/**
 * One line of `git clone --progress` output: the stage and its percentage.
 * Undefined for a line that reports no progress.
 *
 *   "remote: Counting objects:  45% (9/20)"
 *   "Receiving objects:  45% (123/456), 1.20 MiB | 3.00 MiB/s"
 *   "Resolving deltas: 100% (80/80), done."
 */
export function parseGitProgress(line: string): { stage: string; percent: number } | undefined {
    const match = line.replace(/^remote:\s*/, '').trim().match(/^([A-Za-z][A-Za-z ]*?):\s+(\d{1,3})%/);
    if (!match) {
        return undefined;
    }
    return { stage: match[1], percent: Math.min(100, Number(match[2])) };
}

/**
 * Where one stage's percentage puts the whole clone. The download dominates,
 * so it takes most of the bar; the server's counting and compressing, the
 * local delta resolution and the checkout share the rest. A stage git adds
 * later moves nothing rather than jumping the bar.
 */
export function clonePercent(stage: string, percent: number): number | undefined {
    const span = (from: number, width: number) => Math.round(from + (percent * width) / 100);
    if (/counting|enumerating|compressing/i.test(stage)) {
        return span(0, 5);
    }
    if (/receiving/i.test(stage)) {
        return span(5, 75);
    }
    if (/resolving/i.test(stage)) {
        return span(80, 15);
    }
    if (/updating files|checking out/i.test(stage)) {
        return span(95, 5);
    }
    return undefined;
}

/** The sentence under the project while it opens. */
export function describeOpenProgress(progress: OpenProgress): string {
    if (progress.phase === 'listing') {
        return 'Finding its sources…';
    }
    const toClone = progress.sources.filter(s => s.state !== 'present');
    const current = progress.sources.find(s => s.state === 'cloning');
    if (!current) {
        return toClone.length === 0 ? 'Everything is on disk already; opening…' : 'Opening…';
    }
    const n = toClone.indexOf(current) + 1;
    const step = toClone.length > 1 ? `Cloning ${n} of ${toClone.length}: ` : 'Cloning ';
    return `${step}${current.name}${current.stage ? ` · ${current.stage}` : ''}`;
}
