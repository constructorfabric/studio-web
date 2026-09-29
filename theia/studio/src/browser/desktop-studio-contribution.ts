// Opens the desktop Studio view on start — only in a desktop Studio, where the
// IDE backend says it is connected to one (ADR-0027). A session never shows it.
//
// And keeps Studio told that this window has its workspace open (ADR-0027 §4):
// a heartbeat to the desktop backend, which renews the workspace's desktop
// session, and a last word when the window closes. The window drives it
// because only the window knows whether it is still showing the workspace.

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { DESKTOP_STUDIO_WIDGET_ID, DesktopStudioWidget, desktopStatus, desktopUrl } from './desktop-studio-widget';
import { remoteGearCatalogueRefused, remoteGearCatalogueSignedIn } from './gearbox-remote-catalogue';

/** How often a window renews; the server's `heartbeat_secs`, and a third of its lease. */
export const DESKTOP_HEARTBEAT_MS = 30_000;

@injectable()
export class DesktopStudioContribution extends AbstractViewContribution<DesktopStudioWidget> implements FrontendApplicationContribution {
    @inject(FrontendApplicationStateService)
    protected readonly appState: FrontendApplicationStateService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    protected heartbeat: ReturnType<typeof setInterval> | undefined;

    constructor() {
        super({
            widgetId: DESKTOP_STUDIO_WIDGET_ID,
            widgetName: 'Constructor Studio',
            defaultWidgetOptions: { area: 'left', rank: 50 },
            toggleCommandId: 'studio.desktop.toggle',
        });
    }

    onStart(): void {
        // Not onDidInitializeLayout: that runs only for a fresh layout, and
        // every later start restores the last one, where some other view may
        // be in front. The member's Studio is what a desktop opens on.
        void this.appState.reachedState('ready').then(async () => {
            if ((await desktopStatus())?.enabled) {
                await this.openView({ activate: true, reveal: true });
                this.startHeartbeat();
            }
        });
    }

    onStop(): void {
        // Only a desktop beats. A web session never started one, and must not
        // send anything on its way out (docs/desktop-contributing.md, rule 1).
        if (this.heartbeat === undefined) {
            return;
        }
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
        const root = this.root();
        if (root) {
            // The page is going away: a beacon is the one request it still sends.
            navigator.sendBeacon(desktopUrl('closed'), new Blob([JSON.stringify({ root })], { type: 'application/json' }));
        }
    }

    protected startHeartbeat(): void {
        if (this.heartbeat !== undefined) {
            return;
        }
        void this.beat();
        this.heartbeat = setInterval(() => void this.beat(), DESKTOP_HEARTBEAT_MS);
    }

    /** One renewal. Not signed in, or a folder Studio did not open, is an
     *  answer the backend gives and the next beat asks again. */
    protected async beat(): Promise<void> {
        // The gear catalogue was refused while signed out, and the Studio view
        // may be closed or may not have watched the sign-in: this is the
        // backstop that asks again once the member is signed in.
        if (remoteGearCatalogueRefused() && (await desktopStatus())?.state === 'signed-in') {
            remoteGearCatalogueSignedIn();
        }
        const root = this.root();
        if (!root) {
            return;
        }
        try {
            await fetch(desktopUrl('heartbeat'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ root }),
            });
        } catch {
            // The backend is restarting; the next beat will find it.
        }
    }

    /** The folder this window shows. */
    protected root(): string | undefined {
        const roots = this.workspaceService.tryGetRoots();
        return roots.length ? roots[0].resource.path.fsPath() : undefined;
    }
}
