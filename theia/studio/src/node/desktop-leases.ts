/**
 * The workspaces this desktop has open, as Studio sees them (ADR-0027 §4).
 *
 * A container session is found by asking its runtime; nobody can ask a
 * laptop, so the desktop says so itself: a lease per open workspace at
 * `/studio-session/v1/desktop-sessions`, renewed while a window shows the
 * workspace and ended when it closes. A lease the desktop stops renewing —
 * the app was killed, the laptop slept — ends on its own on the server.
 *
 * The window drives the heartbeat, not this process: one backend serves every
 * window, and only a window knows whether it is still showing a workspace.
 * Nothing here limits anything; Studio holds as many leases as there are
 * windows, devices and members.
 */

export const DESKTOP_SESSIONS_PATH = '/studio-session/v1/desktop-sessions';

/** Where to renew, and as whom. */
export interface LeaseTarget {
    readonly studioUrl: string;
    readonly gatewayPrefix: string;
    readonly accessToken: () => Promise<string>;
    readonly deviceId: string;
    readonly deviceName?: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class DesktopLeases {
    /** The lease id Studio answered with, per workspace tenant. */
    protected readonly held = new Map<string, string>();

    constructor(protected readonly doFetch: Fetch = (input, init) => fetch(input, init)) { }

    /** The tenants this desktop holds a lease for. */
    get open(): string[] {
        return [...this.held.keys()];
    }

    /** Open or renew the lease for a workspace. `false` when Studio refused it. */
    async renew(target: LeaseTarget, workspaceId: string): Promise<boolean> {
        const answer = await this.doFetch(`${target.studioUrl}${target.gatewayPrefix}${DESKTOP_SESSIONS_PATH}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${await target.accessToken()}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ workspace_id: workspaceId, device_id: target.deviceId, device_name: target.deviceName }),
        });
        if (!answer.ok) {
            // A Studio without desktop sessions (404 from the gateway), or a
            // workspace the member lost: nothing to hold.
            this.held.delete(workspaceId);
            return false;
        }
        const lease = await answer.json() as { id?: string };
        if (lease.id) {
            this.held.set(workspaceId, lease.id);
        }
        return true;
    }

    /** End the lease for a workspace, if this desktop holds one. */
    async end(target: LeaseTarget, workspaceId: string): Promise<void> {
        const id = this.held.get(workspaceId);
        if (!id) {
            return;
        }
        this.held.delete(workspaceId);
        await this.doFetch(`${target.studioUrl}${target.gatewayPrefix}${DESKTOP_SESSIONS_PATH}/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${await target.accessToken()}` },
        }).catch(() => undefined);
    }

    /** End every lease: signing out, switching Studios, quitting. */
    async endAll(target: LeaseTarget): Promise<void> {
        await Promise.all(this.open.map(workspaceId => this.end(target, workspaceId)));
    }

    /** Forget the leases without telling Studio — they expire there. */
    forget(): void {
        this.held.clear();
    }
}
