// Opens a project from the portal's "Open in desktop" link (ADR-0027 §6).
//
// Theia already turns the operating system's `cfstudio://` link into an open
// request in the window: `electron.uriScheme` registers the scheme, and the
// link arrives from a cold start and from a second launch alike. This is the
// handler it is offered to. It does what a member would do in the Studio view
// -- connect to the Studio the link names, sign in if they have to, clone the
// project's sources through Studio and open the folder -- so the link grants
// nothing a click would not.
//
// Every call goes through desktop-studio-client.ts, as the two views' do, and
// what the link changed -- the Studio, the sign-in, the open project -- is
// announced to them, so they redraw now rather than on their next poll.

import { inject, injectable } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common/message-service';
import { OpenHandler } from '@theia/core/lib/browser/opener-service';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { CommandService } from '@theia/core/lib/common/command';
import { OpenerService, open as openUri } from '@theia/core/lib/browser/opener-service';
import { openProjectInPlace } from './desktop-open-project';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { DESKTOP_LINK_OPEN, DESKTOP_LINK_SCHEME, DesktopLink, environmentFor, isCurrent, parseDesktopLink } from '../common/desktop-link';
import { customEnvironment } from '../common/desktop-environments';
import { describeOpenProgress } from '../common/desktop-open-progress';
import {
    DesktopStatus, announceDesktopChange, desktopStatus, openStudioProject, startSignIn, switchStudio,
} from './desktop-studio-client';

/** gearbox-studio's product command, by id -- the one `studio.openProduct`
 *  runs (portal-bridge-contribution.ts), without depending on either package. */
const GEARBOX_OPEN_PRODUCT_COMMAND_ID = 'gearbox.product.openAt';
/** gearbox-studio's Generate-then-Build, by id for the same reason. */
const GEARBOX_GENERATE_AND_BUILD_COMMAND_ID = 'gearbox.product.generateAndBuild';

/** How long a link waits for the member to finish signing in, in the browser. */
const SIGN_IN_BUDGET_MS = 5 * 60_000;

@injectable()
export class DesktopLinkHandler implements OpenHandler {
    readonly id = 'studio.desktop-link';

    @inject(MessageService)
    protected readonly messages: MessageService;

    @inject(WindowService)
    protected readonly windows: WindowService;

    @inject(WorkspaceService)
    protected readonly workspaces: WorkspaceService;

    @inject(CommandService)
    protected readonly commands: CommandService;

    @inject(OpenerService)
    protected readonly openers: OpenerService;

    canHandle(uri: URI): number {
        return uri.scheme === DESKTOP_LINK_SCHEME && uri.authority === DESKTOP_LINK_OPEN ? 500 : 0;
    }

    async open(uri: URI): Promise<object | undefined> {
        this.windows.focus();
        const link = parseDesktopLink(uri.toString(true));
        if (!link) {
            this.messages.error('Studio: this link does not name a project to open.');
            return undefined;
        }
        try {
            await this.follow(link);
        } catch (error) {
            this.messages.error(`Studio: ${link.name ?? 'the project'} could not be opened — ${error instanceof Error ? error.message : error}`);
        }
        return {};
    }

    protected async follow(link: DesktopLink): Promise<void> {
        const found = await desktopStatus();
        if (!found?.enabled) {
            throw new Error('this IDE is not a desktop Studio');
        }
        let status: DesktopStatus = found;
        if (!isCurrent(link, status.current)) {
            status = await this.connect(link, status);
        }
        if (status.state !== 'signed-in') {
            status = await this.signIn();
        }
        const title = link.name ?? link.project;
        const progress = await this.messages.showProgress({ text: `Opening ${title}…` });
        let path: string;
        try {
            path = await openStudioProject(link.project, link.name, update => {
                progress.report({ message: describeOpenProgress(update) });
            });
            // In place, not `open(…, { preserveWindow })`: that reloads the whole window.
            await openProjectInPlace(this.workspaces, URI.fromFilePath(path));
            announceDesktopChange(this, 'opened');
        } finally {
            progress.cancel();
        }
        if (link.product) {
            const inGearbox = await this.openProduct(path, link.product, link.branch);
            if (link.build) {
                await this.build(inGearbox, link.product);
            }
        }
    }

    /**
     * The Builds tab's "On my machine": generate the product and press its
     * Build, which reports itself to the portal. Only once Gearbox has it
     * open -- a description opened as a file has no Build to press.
     */
    protected async build(inGearbox: boolean, product: string): Promise<void> {
        if (!inGearbox) {
            this.messages.warn(`Studio: ${product} is not open in Gearbox, so it was not built. Open it there and press Build.`);
            return;
        }
        try {
            await this.commands.executeCommand(GEARBOX_GENERATE_AND_BUILD_COMMAND_ID);
        } catch (error) {
            this.messages.error(`Studio: ${product} could not be built — ${error instanceof Error ? error.message : error}`);
        }
    }

    /**
     * The product the portal composed, in the Gearbox perspective: the
     * command a portal session runs for `studio.openProduct`, which finds the
     * path under the project's checkouts and brings `branch` in beside the
     * checkout when the description was saved there. Without Gearbox the
     * description opens as a file -- under the project folder or one of its
     * checkouts -- and failing that the person is told where it is. True
     * when Gearbox has it.
     */
    protected async openProduct(projectPath: string, product: string, branch: string | undefined): Promise<boolean> {
        try {
            const opened = await this.commands.executeCommand<boolean>(GEARBOX_OPEN_PRODUCT_COMMAND_ID, product, branch);
            return opened === true;
        } catch (error) {
            console.warn('[studio] desktop link: Gearbox could not open the product', error);
        }
        try {
            await openUri(this.openers, URI.fromFilePath(projectPath).resolve(product));
        } catch {
            this.messages.info(
                `Studio: the project is open. Its product description is ${product}${branch ? ` on the branch ${branch}` : ''}.`,
            );
        }
        return false;
    }

    /** Connect to the Studio the link names: one this build offers without a
     *  question, any other only once the member says so. */
    protected async connect(link: DesktopLink, status: DesktopStatus): Promise<DesktopStatus> {
        if (!status.switchable) {
            throw new Error(`the link is for ${link.studioUrl ?? link.issuer}, and this run is pinned to ${status.current?.studioUrl ?? 'another Studio'}`);
        }
        const known = environmentFor(link, status.environments);
        let target: { id: string } | { studioUrl: string; issuer?: string };
        if (known) {
            target = { id: known.id };
        } else {
            if (!link.studioUrl) {
                throw new Error('the link names a Studio this build does not offer, and no address to reach it at');
            }
            const custom = customEnvironment(link.studioUrl, link.issuer);
            const ok = await new ConfirmDialog({
                title: 'Connect to another Studio?',
                msg: `The link opens a project on ${custom.label}, which this app is not set up for. Connect to it and sign in there?`,
                ok: 'Connect',
            }).open();
            if (!ok) {
                throw new Error('not connected');
            }
            target = { studioUrl: custom.studioUrl, issuer: custom.issuer };
        }
        const refused = await switchStudio(target);
        if (refused) {
            throw new Error(refused);
        }
        announceDesktopChange(this, 'switched');
        const switched = await desktopStatus();
        if (!switched) {
            throw new Error('the desktop backend did not answer after connecting');
        }
        return switched;
    }

    /** Start the member's sign-in in the system browser and wait for it. */
    protected async signIn(): Promise<DesktopStatus> {
        const refused = await startSignIn();
        if (refused) {
            throw new Error(`sign-in could not start: ${refused}`);
        }
        const progress = await this.messages.showProgress({ text: 'Sign in to Studio in the browser that just opened…' });
        try {
            const deadline = Date.now() + SIGN_IN_BUDGET_MS;
            while (Date.now() < deadline) {
                const status = await desktopStatus();
                if (status?.state === 'signed-in') {
                    announceDesktopChange(this, 'signed-in');
                    return status;
                }
                if (status?.state === 'failed') {
                    throw new Error(status.error ?? 'sign-in failed');
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            throw new Error('sign-in took too long');
        } finally {
            progress.cancel();
        }
    }
}
