// What the desktop landing page shows, decided without a DOM (ADR-0027).
//
// The desktop app opens a placeholder folder when the member has chosen none
// (`~/ConstructorStudio/workspace`). The product's start page would read that
// folder as a project -- "PROJECT workspace", recent documents, proposed
// changes -- and none of it is true. So while that folder (or no folder) is
// open, the main area shows the landing page instead: connect and choose a
// project, or keep working offline. Every decision about it lives here, next
// to its tests: whether it shows at all, which of its states it is in, which
// recent folders it lists, and what the onboarding cards say.

import type { Organization } from './desktop-projects';

/** The part of the desktop status the landing reads (`/studio-desktop/status`). */
export interface LandingStatus {
    enabled: boolean;
    studioUrl?: string;
    state: 'signed-out' | 'signing-in' | 'signed-in' | 'failed';
    error?: string;
    /** The folder the app opens when the member chose none; absent from an older backend. */
    startFolder?: string;
}

/**
 * Two folders compared the way the file system does: separators and a
 * trailing slash do not matter, and case matters nowhere on a Windows drive.
 */
export function sameFolder(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) {
        return false;
    }
    const norm = (p: string) => {
        let s = p.replace(/\\/g, '/').replace(/\/+$/, '');
        // `file:///c%3A/...` and `/c:/...` both name `c:/...`.
        s = s.replace(/^\/(?=[a-zA-Z]:)/, '');
        return /^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s;
    };
    return norm(a) === norm(b);
}

/**
 * Whether the landing takes the main area. Only a desktop connected to a
 * Studio can tell the placeholder apart; without one, only a window with no
 * folder at all shows it. Any other folder -- a Studio project's clone, or one
 * the member opened themselves -- keeps the product's start page.
 */
export function landingWanted(status: LandingStatus | undefined, root: string | undefined): boolean {
    if (!root) {
        return true;
    }
    return !!status?.enabled && sameFolder(root, status.startFolder);
}

/** Words that mean the Studio could not be reached at all, rather than refused. */
const UNREACHABLE = /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network|timed? ?out|HTTP 50[234]\b|Failed to fetch/i;

/** Whether an error says the Studio is out of reach (offline, down, a proxy in the way). */
export function unreachable(error: string | undefined): boolean {
    return !!error && UNREACHABLE.test(error);
}

/** What the member's projects are, as far as the landing has loaded them. */
export interface ProjectsLoad {
    organizations?: Organization[];
    loading?: boolean;
    error?: string;
}

export type LandingView =
    /** The first status read has not answered yet. */
    | { kind: 'checking' }
    /** This app is not set up for any Studio: offline is all there is. */
    | { kind: 'no-studio' }
    | { kind: 'connect'; error?: string; unreachable: boolean }
    | { kind: 'signing-in' }
    | { kind: 'projects-loading' }
    | { kind: 'projects-error'; error: string; unreachable: boolean }
    | { kind: 'no-organizations' }
    | { kind: 'projects'; organizations: Organization[] };

/**
 * Which of its states the landing is in. `status` is `undefined` both before
 * the first read (`known` false) and when the backend has no Studio routes.
 */
export function landingView(status: LandingStatus | undefined, known: boolean, projects: ProjectsLoad = {}): LandingView {
    if (!known) {
        return { kind: 'checking' };
    }
    if (!status?.enabled) {
        return { kind: 'no-studio' };
    }
    switch (status.state) {
        case 'signing-in':
            return { kind: 'signing-in' };
        case 'signed-out':
            return { kind: 'connect', unreachable: false };
        case 'failed':
            return { kind: 'connect', error: status.error, unreachable: unreachable(status.error) };
    }
    if (projects.organizations) {
        return projects.organizations.length === 0
            ? { kind: 'no-organizations' }
            : { kind: 'projects', organizations: projects.organizations };
    }
    if (projects.error && !projects.loading) {
        return { kind: 'projects-error', error: projects.error, unreachable: unreachable(projects.error) };
    }
    return { kind: 'projects-loading' };
}

/** A recently opened folder, ready to draw. */
export interface RecentFolder {
    /** The workspace URI, as Theia's recent list keeps it. */
    uri: string;
    name: string;
    /** Where it is, for the tooltip and the second line. */
    path: string;
}

/** How many recent folders the landing lists. */
export const MAX_RECENT = 6;

function fsPathOf(uri: string): string {
    let path = uri;
    try {
        path = decodeURIComponent(new URL(uri).pathname);
    } catch {
        // Not a URI: a path already.
    }
    path = path.replace(/^\/(?=[a-zA-Z]:)/, '');
    return /^[a-zA-Z]:/.test(path) ? path.replace(/\//g, '\\') : path;
}

/**
 * Theia's recent workspaces as the landing lists them: local folders only,
 * the placeholder left out (it is where the member already is), no
 * duplicates, the newest first as Theia keeps them.
 */
export function recentFolders(recent: readonly string[], startFolder: string | undefined, max = MAX_RECENT): RecentFolder[] {
    const seen = new Set<string>();
    const folders: RecentFolder[] = [];
    for (const uri of recent) {
        if (!uri.startsWith('file:')) {
            continue;
        }
        const path = fsPathOf(uri);
        const key = path.replace(/\\/g, '/').toLowerCase();
        if (seen.has(key) || sameFolder(path, startFolder)) {
            continue;
        }
        seen.add(key);
        const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
        folders.push({ uri, name, path });
        if (folders.length >= max) {
            break;
        }
    }
    return folders;
}

/** A mode, as the mode picker defines it (`MODES` in studio-mode-bar.tsx). */
export interface ModeLike {
    readonly role: string;
    readonly label: string;
    readonly icon: string;
    readonly title: string;
    readonly perspective: string;
}

/** One onboarding card: the mode's own words, so the two cannot drift. */
export interface ModeCard {
    readonly role: string;
    readonly label: string;
    readonly icon: string;
    readonly line: string;
    readonly perspective: string;
    readonly current: boolean;
}

/**
 * The onboarding cards: one per mode, in the picker's order, its label, icon
 * and title as the picker has them. A mode whose perspective this build does
 * not register (Building without Gearbox) is left out when the registered list
 * is known, so no card switches to nothing.
 */
export function modeCards(modes: readonly ModeLike[], registered: readonly string[] | undefined, active: string | undefined): ModeCard[] {
    return modes
        .filter(m => !registered || registered.includes(m.perspective))
        .map(m => ({ role: m.role, label: m.label, icon: m.icon, line: m.title, perspective: m.perspective, current: m.perspective === active }));
}

/** Where the member's "Got it" is kept: the machine's storage, not the project's. */
export const ONBOARDING_STORAGE_KEY = 'studio.desktop.landing.onboarding-dismissed';

export function onboardingDismissed(stored: unknown): boolean {
    return stored === true;
}

/** What the Studio lets a person without an organization do (ADR-0051 §2). */
export type OrganizationCreation = 'open' | 'request' | 'off';

/** The member's newest organization request, as much of it as the landing shows. */
export interface OwnOrganizationRequest {
    name: string;
    status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
    reason?: string | null;
    created_at_ms: number;
}

/** What the landing knows about getting an organization, read only when the member has none. */
export interface OrganizationOnboarding {
    creation: OrganizationCreation;
    /** The newest request, where creation is `request` and they have asked. */
    request?: OwnOrganizationRequest;
}

/**
 * The Studio's setting from `GET /studio-organizations/v1/capabilities`. A
 * backend older than ADR-0051 answers only `self_service`, whose `true` and
 * `false` meant what `open` and `off` mean now; anything unreadable is `off`.
 */
export function creationOf(capabilities: unknown): OrganizationCreation {
    const answer = (capabilities ?? {}) as { organization_creation?: unknown; self_service?: unknown };
    const creation = answer.organization_creation;
    if (creation === 'open' || creation === 'request' || creation === 'off') {
        return creation;
    }
    return answer.self_service === true ? 'open' : 'off';
}

/**
 * What the "no organization" state tells the member to do. The landing never
 * creates or asks itself -- the portal holds the forms, as it holds the
 * invitations -- so this only names the way in the Studio allows, and the
 * member's own request when there is one. `undefined` onboarding (not read
 * yet, or unreadable) is today's wording: an invitation.
 */
export type NoOrganizationHint =
    | { kind: 'invitation' }
    | { kind: 'create' }
    | { kind: 'ask' }
    | { kind: 'pending'; name: string; askedAt: number }
    | { kind: 'rejected'; name: string; reason?: string };

export function noOrganizationHint(onboarding: OrganizationOnboarding | undefined): NoOrganizationHint {
    switch (onboarding?.creation) {
        case 'open':
            return { kind: 'create' };
        case 'request': {
            const request = onboarding.request;
            if (request?.status === 'pending') {
                return { kind: 'pending', name: request.name, askedAt: request.created_at_ms };
            }
            if (request?.status === 'rejected') {
                return { kind: 'rejected', name: request.name, ...(request.reason ? { reason: request.reason } : {}) };
            }
            return { kind: 'ask' };
        }
        default:
            return { kind: 'invitation' };
    }
}
