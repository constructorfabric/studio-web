// Projects opened in the desktop Studio, and the member's own Orca (#497).
//
// Two rules, both decided here as plain functions so they are tested without
// Orca, a window or a file system:
//
// 1. When the open project has repositories Orca does not know, Studio asks
//    once — always / not now / never — and remembers the answer in the
//    `studio.orca.addOpenedProjects` preference. "Always" adds them from then
//    on without asking; "not now" leaves them for this project until the
//    window reloads; "never" stops asking. The Agents panel's button stays.
// 2. When a project closes, Studio unregisters from Orca the repositories it
//    added itself, and only those: it keeps a record of what it added, per
//    repository. A repository with agents still running or changes not yet
//    committed in any of its worktrees stays, and the panel says why.
//
// Off a member's machine (a portal session) none of this runs: the session's
// runtime starts empty with the container and the panel registers the
// workspace on its own, as before.

/** The preference that holds the member's answer. */
export const ORCA_ADD_PROJECTS_PREFERENCE = 'studio.orca.addOpenedProjects';

/** `ask` until the member answers; then what they chose. */
export type OrcaAddProjectsPreference = 'ask' | 'always' | 'never';

/** The three answers to the question, as the member reads them. */
export const ORCA_ADD_ANSWERS = {
    always: 'Always add',
    notNow: 'Not now',
    never: 'Never'
} as const;
export type OrcaAddAnswer = keyof typeof ORCA_ADD_ANSWERS;

/** What to do about an open project's unknown repositories. */
export type OrcaOpenDecision = 'add' | 'ask' | 'nothing';

export function readAddProjectsPreference(value: unknown): OrcaAddProjectsPreference {
    return value === 'always' || value === 'never' ? value : 'ask';
}

/**
 * On opening a project (or on the first check after the window starts).
 *
 * @param unknown the project's repositories Orca does not know yet
 * @param dismissed whether the member said "not now" for this project already
 */
export function decideOnOpen(
    preference: OrcaAddProjectsPreference,
    unknown: readonly string[],
    dismissed: boolean
): OrcaOpenDecision {
    if (unknown.length === 0 || preference === 'never') {
        return 'nothing';
    }
    if (preference === 'always') {
        return 'add';
    }
    return dismissed ? 'nothing' : 'ask';
}

/**
 * What an answer does: the preference to store (undefined keeps it — "not
 * now" is not a lasting answer) and whether to add the repositories now.
 * A closed prompt counts as "not now".
 */
export function applyAnswer(answer: OrcaAddAnswer | undefined): {
    readonly preference?: OrcaAddProjectsPreference;
    readonly add: boolean;
    readonly dismiss: boolean;
} {
    switch (answer) {
        case 'always':
            return { preference: 'always', add: true, dismiss: false };
        case 'never':
            return { preference: 'never', add: false, dismiss: true };
        default:
            return { add: false, dismiss: true };
    }
}

/** The question, naming what would be added. */
export function addProjectQuestion(unknown: readonly string[]): string {
    const what = unknown.length === 1 ? `its repository ${baseName(unknown[0])}` : `its ${unknown.length} repositories`;
    return (
        `Orca does not know the project open here yet. Add ${what} to Orca, so agents can work on it? ` +
        'Studio removes what it added when the project closes. You can change this later in Settings ' +
        `(${ORCA_ADD_PROJECTS_PREFERENCE}).`
    );
}

/** A repository Studio added to Orca that it left there on purpose. */
export interface OrcaKeptRepository {
    readonly path: string;
    /** Why it stays, for the panel: agents running, or changes not committed. */
    readonly reason: string;
}

/** What `trackProject` answers the window with. */
export interface OrcaProjectSync {
    /** False in a portal session, or when Orca does not answer: nothing was done. */
    readonly enabled: boolean;
    /** The open project's repositories Orca does not know. */
    readonly unknown: readonly string[];
    /** Repositories of closed projects Studio just unregistered from Orca. */
    readonly removed: readonly string[];
    /** Repositories of closed projects Studio added but left in Orca, and why. */
    readonly kept: readonly OrcaKeptRepository[];
}

export const NO_PROJECT_SYNC: OrcaProjectSync = { enabled: false, unknown: [], removed: [], kept: [] };

/** The panel's sentence for a kept repository. */
export function keptMessage(kept: OrcaKeptRepository): string {
    return `Studio added ${baseName(kept.path)} to Orca for a project that is closed now, and left it there: ` +
        `${kept.reason}. It is removed once that is done and a project opens or closes again.`;
}

function baseName(value: string): string {
    const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] ?? value;
}
