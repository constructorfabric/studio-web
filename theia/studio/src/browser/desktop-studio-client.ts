// The desktop backend's routes, as the one module the desktop's views call
// (ADR-0027): the Studio view (desktop-studio-widget.tsx), the landing page
// (desktop-landing-widget.tsx) and the contributions next to them. Read the
// sign-in, sign in and out, pick a Studio, list the member's projects, clone
// one and follow its progress. The backend decides everything; these only ask
// it. And one event, so that what one view did is news to the other.

import { Emitter, Event } from '@theia/core/lib/common/event';
import { Endpoint } from '@theia/core/lib/browser/endpoint';
import { StudioApi } from './studio-api';
import { DesktopEnvironmentChoice } from '../common/desktop-environments';
import { Organization, projectsOf } from './desktop-projects';
import { SourcesState, sourcesStateOf } from './desktop-studio-tree';
import { OrganizationOnboarding, OwnOrganizationRequest, creationOf } from './desktop-landing-state';
import type { OpenProgress } from '../common/desktop-open-progress';

export interface DesktopStatus extends DesktopEnvironmentChoice {
    enabled: boolean;
    studioUrl?: string;
    state: 'signed-out' | 'signing-in' | 'signed-in' | 'failed';
    error?: string;
    user?: { sub: string; name?: string; email?: string; tenantId?: string };
}

export function desktopUrl(path: string): string {
    return new Endpoint({ path: `studio-desktop/${path}` }).getRestUrl().toString();
}

/** The sign-in state, or `undefined` when this IDE has no desktop backend (a session) or it cannot be reached. */
export async function desktopStatus(): Promise<DesktopStatus | undefined> {
    try {
        const answer = await fetch(desktopUrl('status'));
        return answer.ok ? await answer.json() as DesktopStatus : undefined;
    } catch {
        return undefined;
    }
}

/** POST to a route; `undefined` when done, else why not: the backend's reason, its status, or the network's. */
async function post(path: string, body?: unknown): Promise<string | undefined> {
    try {
        const answer = await fetch(desktopUrl(path), body === undefined ? { method: 'POST' } : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (answer.ok) {
            return undefined;
        }
        return ((await answer.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${answer.status}`;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

/** Start the sign-in: the backend opens the Constructor ID page in the browser. The error, if refused. */
export function startSignIn(): Promise<string | undefined> {
    return post('sign-in');
}

/** Sign out of this Studio; the error, if refused. */
export function signOut(): Promise<string | undefined> {
    return post('sign-out');
}

/** Connect to another Studio (the backend signs out of this one first); the error, if refused. */
export function switchStudio(target: { id: string } | { studioUrl: string; issuer?: string }): Promise<string | undefined> {
    return post('environment', target);
}

/** The member's organizations, workspaces and projects, through the backend's Studio proxy. */
export function loadProjects(): Promise<Organization[]> {
    return projectsOf(async path => {
        const answer = await StudioApi.fetch(path);
        if (!answer.ok) {
            throw new Error(`HTTP ${answer.status}`);
        }
        return answer.json();
    });
}

/**
 * How a member with no organization gets one on this Studio (ADR-0051 §5): the
 * setting, and their own newest request where the setting is `request`.
 * `undefined` when the Studio could not say -- the landing then keeps to
 * invitations, which every setting allows.
 */
export async function organizationOnboarding(): Promise<OrganizationOnboarding | undefined> {
    try {
        const capabilities = await StudioApi.fetch('/studio-organizations/v1/capabilities');
        if (!capabilities.ok) {
            return undefined;
        }
        const creation = creationOf(await capabilities.json());
        if (creation !== 'request') {
            return { creation };
        }
        const mine = await StudioApi.fetch('/studio-organizations/v1/organization-requests?scope=mine&limit=1');
        const page = mine.ok ? await mine.json() as { items?: OwnOrganizationRequest[] } : undefined;
        const request = page?.items?.[0];
        return request ? { creation, request } : { creation };
    } catch {
        return undefined;
    }
}

/** What a project's sources listing says: the listing the open itself starts with. */
export async function sourcesOf(id: string): Promise<SourcesState> {
    try {
        const answer = await StudioApi.fetch(`/studio-git/v1/sources?project_id=${encodeURIComponent(id)}`);
        return sourcesStateOf(answer.status, await answer.json().catch(() => undefined));
    } catch {
        return { state: 'unknown' };
    }
}

/** Which Studio project the folder `root` is the clone of, if Studio opened it. */
export async function openedProject(root: string): Promise<string | undefined> {
    try {
        const answer = await fetch(`${desktopUrl('opened')}?root=${encodeURIComponent(root)}`);
        return answer.ok ? (await answer.json() as { tenantId?: string }).tenantId : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Clone a project's sources through Studio into `folder` (the backend picks one
 * when there is none) and answer the local path to open, calling `onProgress` while the backend reports it and never
 * after. Throws with the backend's reason.
 */
export async function openStudioProject(
    workspaceId: string, folder: string | undefined, onProgress: (progress: OpenProgress) => void, pollMs = 400,
): Promise<string> {
    let done = false;
    const poll = setInterval(async () => {
        try {
            const progress = await (await fetch(desktopUrl('open-progress'))).json() as OpenProgress | null;
            if (!done && progress?.workspaceId === workspaceId) {
                onProgress(progress);
            }
        } catch {
            // A backend from before this route: no progress, only the spinner.
        }
    }, pollMs);
    try {
        const answer = await fetch(desktopUrl('open'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId, name: folder }),
        });
        const body = await answer.json().catch(() => ({})) as { path?: string; error?: string };
        if (!answer.ok || !body.path) {
            throw new Error(body.error ?? `HTTP ${answer.status}`);
        }
        return body.path;
    } finally {
        done = true;
        clearInterval(poll);
    }
}

/** What a view did that the other views should read again. */
export type DesktopChangeKind = 'signed-in' | 'signed-out' | 'switched' | 'opened';

export interface DesktopChange {
    readonly kind: DesktopChangeKind;
    /** The view that did it: it has read the new state already, and ignores its own news. */
    readonly origin: object;
}

const changes = new Emitter<DesktopChange>();

/**
 * Fired when a view saw a sign-in finish, signed out, switched the Studio or
 * opened a project. Each view reads the sign-in when it is shown and polls
 * only while it has reason to, so without this a sign-in finished in the
 * landing page would be news to the Studio view, and the other way round.
 */
export const onDesktopChange: Event<DesktopChange> = changes.event;

export function announceDesktopChange(origin: object, kind: DesktopChangeKind): void {
    changes.fire({ kind, origin });
}
