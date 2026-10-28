// One fake of desktop-studio-client.ts for every desktop view's tests: the
// Studio view's, the landing page's, and the two together. A test swaps the
// module for this one,
//
//     jest.mock('./desktop-studio-client', () => jest.requireActual('./desktop-studio-client.fake'));
//
// and sets what the backend would answer on `fakeStudio`. The change event is
// the real one, so what one view announces reaches the other as it would.

import type * as Client from './desktop-studio-client';
import type { DesktopStatus } from './desktop-studio-client';
import type { Organization } from './desktop-projects';
import type { SourcesState } from './desktop-studio-tree';
import type { OrganizationOnboarding } from './desktop-landing-state';
import type { OpenProgress } from '../common/desktop-open-progress';

const actual = jest.requireActual<typeof Client>('./desktop-studio-client');

export type { DesktopStatus, DesktopChange, DesktopChangeKind } from './desktop-studio-client';
export const desktopUrl = actual.desktopUrl;
export const onDesktopChange = actual.onDesktopChange;
export const announceDesktopChange = actual.announceDesktopChange;

/** What the fake backend answers; `reset()` before each test. */
export class FakeDesktopStudio {
    /** `undefined`: no desktop backend (a session), or out of reach. */
    status: (DesktopStatus & Record<string, unknown>) | undefined;
    /** The member's projects, or why they could not be loaded. */
    projects: Organization[] | Error = [];
    /** Each project's sources listing; a project not named here is `unknown`. */
    sources: Record<string, SourcesState> = {};
    /** How a member with no organization gets one; `undefined`, the Studio could not say. */
    onboarding: OrganizationOnboarding | undefined = undefined;
    /** The project a folder is the clone of, by folder. */
    opened: Record<string, string> = {};
    /** What each route was asked, in order: `sign-in`, `open p-web Gears workspace - Studio-web`, `sources p-2`, … */
    calls: string[] = [];
    /** A refusal the next sign-in / sign-out / switch answers with. */
    refuse: Partial<Record<'sign-in' | 'sign-out' | 'switch', string>> = {};
    /** What starting a sign-in does to the status; by default, it is under way. */
    onSignIn: () => void = () => this.setState('signing-in');
    /** What a switch does to the status; by default, signed out, on the Studio switched to. */
    onSwitch: (target: { id: string } | { studioUrl: string; issuer?: string }) => void = target => this.switchedTo(target);
    /** How an open ends: the folder to open, or a rejection with the backend's reason. */
    open: (id: string, folder: string | undefined) => Promise<string> = async () => { throw new Error('no open in this test'); };
    /** The progress callback of the open under way, to report progress through. */
    progress: ((progress: OpenProgress) => void) | undefined;

    reset(): void {
        Object.assign(this, new FakeDesktopStudio());
        this.onSignIn = () => this.setState('signing-in');
        this.onSwitch = target => this.switchedTo(target);
    }

    protected switchedTo(target: { id: string } | { studioUrl: string; issuer?: string }): void {
        const env = 'id' in target ? this.status?.environments.find(e => e.id === target.id) : undefined;
        this.setState('signed-out', { user: undefined, ...(env ? { studioUrl: env.studioUrl, current: env } : {}) });
    }

    setState(state: DesktopStatus['state'], extra: Partial<DesktopStatus> = {}): void {
        if (this.status) {
            this.status = { ...this.status, state, ...extra };
        }
    }
}

export const fakeStudio = new FakeDesktopStudio();

export async function desktopStatus(): Promise<DesktopStatus | undefined> {
    return fakeStudio.status && JSON.parse(JSON.stringify(fakeStudio.status));
}

export async function startSignIn(): Promise<string | undefined> {
    fakeStudio.calls.push('sign-in');
    if (fakeStudio.refuse['sign-in']) {
        return fakeStudio.refuse['sign-in'];
    }
    fakeStudio.onSignIn();
    return undefined;
}

export async function signOut(): Promise<string | undefined> {
    fakeStudio.calls.push('sign-out');
    if (fakeStudio.refuse['sign-out']) {
        return fakeStudio.refuse['sign-out'];
    }
    fakeStudio.setState('signed-out', { user: undefined });
    return undefined;
}

export async function switchStudio(target: { id: string } | { studioUrl: string; issuer?: string }): Promise<string | undefined> {
    fakeStudio.calls.push(`switch ${'id' in target ? target.id : target.studioUrl}`);
    if (fakeStudio.refuse.switch) {
        return fakeStudio.refuse.switch;
    }
    fakeStudio.onSwitch(target);
    return undefined;
}

export async function loadProjects(): Promise<Organization[]> {
    fakeStudio.calls.push('projects');
    if (fakeStudio.projects instanceof Error) {
        throw fakeStudio.projects;
    }
    return JSON.parse(JSON.stringify(fakeStudio.projects));
}

export async function sourcesOf(id: string): Promise<SourcesState> {
    fakeStudio.calls.push(`sources ${id}`);
    return fakeStudio.sources[id] ?? { state: 'unknown' };
}

export async function organizationOnboarding(): Promise<OrganizationOnboarding | undefined> {
    fakeStudio.calls.push('onboarding');
    return fakeStudio.onboarding && JSON.parse(JSON.stringify(fakeStudio.onboarding));
}

export async function openedProject(root: string): Promise<string | undefined> {
    return fakeStudio.opened[root];
}

export async function openStudioProject(workspaceId: string, folder: string | undefined, onProgress: (progress: OpenProgress) => void): Promise<string> {
    fakeStudio.calls.push(`open ${workspaceId} ${folder}`);
    fakeStudio.progress = onProgress;
    try {
        return await fakeStudio.open(workspaceId, folder);
    } finally {
        fakeStudio.progress = undefined;
    }
}

// The fake answers every name the real module exports.
const _complete: typeof Client = {
    desktopUrl, desktopStatus, startSignIn, signOut, switchStudio, loadProjects, organizationOnboarding, sourcesOf, openedProject,
    openStudioProject,
    onDesktopChange, announceDesktopChange,
};
void _complete;
