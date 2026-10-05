// Git on the desktop: the ribbon's Push, and Sync as a git sync (ADR-0027).
//
// In a session, Sync reconciles the checkouts with the canonical workspace
// config, and pushes go through the operations queue. A desktop project has
// neither: it is a folder of clones of the sources its settings in Studio list.
// There Sync used to fail with the session's "Workspace sync is unavailable
// until a valid canonical config is active", and the ribbon's "Pushes & PRs"
// named a command nobody registered, so the desktop had no push at all but
// Source Control's own menu.
//
// Bound only by the desktop's frontend module
// (electron-browser/studio-electron-frontend-module.ts), and even there only
// acting when the backend says a Studio is configured (`studio-desktop/status`
// answering `enabled`), so a session's Sync and ribbon are untouched.

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { CommandContribution, CommandRegistry, type Command } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { QuickInputService } from '@theia/core/lib/common/quick-pick-service';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { ScmService } from '@theia/scm/lib/browser/scm-service';
import { broughtDocuments, describePush, describeSync, pushTargetOf, type DesktopGitPush, type DesktopGitRepository, type DesktopGitSync } from '../common/desktop-git';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { MarkdownDiffService } from './markdown-diff/markdown-diff-service';
import { toGitUri } from './markdown-diff/markdown-diff-uri';
import { desktopPush, desktopRepositories, desktopSync } from './desktop-git-client';
import { desktopStatus } from './desktop-studio-client';
import { WorkspaceSourcesFrontendController } from './workspace-sources-controller';

/** The ribbon's Push (studio-mode-bar.tsx, `GIT_OPS`). */
export const DesktopGitPushCommand: Command = {
    id: 'studio.desktop.git:push',
    category: 'Constructor Studio',
    label: 'Push',
};

const OPEN_PULL_REQUEST = 'Open pull request';

let desktopHost: Promise<boolean> | undefined;

/** Whether this IDE's backend is a desktop's with a Studio configured; asked once. */
export function isDesktopHost(): Promise<boolean> {
    desktopHost ??= desktopStatus().then(status => !!status?.enabled, () => false);
    return desktopHost;
}

/** The folders open in the window, as paths on this machine. */
export function openFolders(workspace: WorkspaceService): string[] {
    return workspace.tryGetRoots().map(root => root.resource.path.fsPath());
}

/**
 * Tell the member how a push went, with the pull-request link when the host
 * gave one. Not awaited: the notification's answer comes when it is closed,
 * and Push must not stay disabled until then.
 */
export function reportPush(messages: MessageService, windows: WindowService, result: DesktopGitPush): void {
    const { level, text } = describePush(result);
    if (level === 'error') {
        messages.error(text);
        return;
    }
    const url = result.pullRequestUrl;
    if (!url) {
        messages.info(text);
        return;
    }
    void messages.info(text, OPEN_PULL_REQUEST).then(action => {
        if (action === OPEN_PULL_REQUEST) {
            windows.openNewWindow(url, { external: true });
        }
    });
}

@injectable()
export class DesktopGitContribution implements CommandContribution, FrontendApplicationContribution {
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(QuickInputService) protected readonly quickInput!: QuickInputService;
    @inject(WindowService) protected readonly windows!: WindowService;
    @inject(ScmService) protected readonly scm!: ScmService;

    /** `undefined` until the backend answered. */
    protected desktop: boolean | undefined;
    protected pushing = false;

    async onStart(): Promise<void> {
        this.desktop = await isDesktopHost();
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(DesktopGitPushCommand, {
            isEnabled: () => this.desktop === true && !this.pushing && openFolders(this.workspace).length > 0,
            // Read by the ribbon (`ribbonAction`) to say why it is disabled.
            disabledReason: () => this.desktop === false
                ? 'this app is not connected to a Constructor Studio'
                : this.pushing ? 'a push is running' : 'open a project first',
            execute: () => this.push(),
        } as Parameters<CommandRegistry['registerCommand']>[1]);
    }

    /** Push the clone Source Control has selected, or the only one, or the one the member picks. */
    async push(): Promise<void> {
        this.pushing = true;
        try {
            for (const root of openFolders(this.workspace)) {
                const repositories = await desktopRepositories(root);
                const selected = this.scm.selectedRepository?.provider.rootUri;
                const target = pushTargetOf(repositories, selected ? new URI(selected).path.fsPath() : undefined);
                if (!target) {
                    continue;
                }
                const repository = 'repository' in target ? target.repository : await this.choose(target.choose);
                if (!repository) {
                    return;
                }
                reportPush(this.messages, this.windows, await desktopPush(root, repository.path));
                return;
            }
            this.messages.warn('Push: this folder holds no git repository. Open a project from the Constructor Studio view to clone its sources.');
        } catch (error) {
            // Said here, once; the ribbon reports a rejection too.
            this.messages.error(`Push: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.pushing = false;
        }
    }

    protected async choose(repositories: readonly DesktopGitRepository[]): Promise<DesktopGitRepository | undefined> {
        const picked = await this.quickInput.showQuickPick(
            repositories.map(repository => ({ label: repository.name, description: repository.branch, repository })),
            { placeholder: 'Which repository to push' },
        );
        return picked?.repository;
    }
}

/**
 * The Sources controller, with Sync done as git on the desktop: fetch, then
 * fast-forward, in every clone of the open folders, reported in one
 * notification. A session's Sync is the parent's.
 */
@injectable()
export class DesktopWorkspaceSourcesController extends WorkspaceSourcesFrontendController {
    @inject(WindowService) protected readonly windows!: WindowService;
    @inject(MarkdownDiffService) protected readonly markdownDiffs!: MarkdownDiffService;
    @inject(QuickInputService) protected readonly quickInput!: QuickInputService;

    protected syncing = false;

    protected override async startSyncPreview(): Promise<void> {
        if (!(await isDesktopHost())) {
            return super.startSyncPreview();
        }
        await this.syncClones();
    }

    /** Git-sync every open folder; never rejects, so the member reads one message, not two. */
    async syncClones(): Promise<void> {
        if (this.syncing) {
            this.messageService.info('Sync is already running.');
            return;
        }
        this.syncing = true;
        this.emitChange();
        try {
            const results: DesktopGitSync[] = [];
            for (const root of openFolders(this.workspaceService)) {
                results.push(...await desktopSync(root));
            }
            const { level, text } = describeSync(results);
            // On the desktop each member has their own clone, so Sync is how a
            // colleague's edits arrive; say which documents they touched, and
            // let them be read rather than only counted.
            const documents = broughtDocuments(results);
            const show = documents.length ? (documents.length === 1 ? 'Show the changed document' : `Show ${documents.length} changed documents`) : undefined;
            const shown = level === 'warn'
                ? this.messageService.warn(text, ...(show ? [show] : []))
                : this.messageService.info(text, ...(show ? [show] : []));
            void shown.then(choice => {
                if (show && choice === show) {
                    void this.showBroughtDocuments(results);
                }
            });
        } catch (error) {
            this.messageService.error(`Sync: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.syncing = false;
            this.emitChange();
        }
    }

    /** Pick one of the documents a Sync brought, and read it before beside after. */
    protected async showBroughtDocuments(results: readonly DesktopGitSync[]): Promise<void> {
        const documents = broughtDocuments(results);
        const open = (entry: typeof documents[number]): Promise<unknown> => {
            const file = FileUri.create(entry.repository.path).resolve(entry.document);
            const short = (sha: string): string => sha.slice(0, 7);
            return this.markdownDiffs.open({
                title: `${file.path.base} (what Sync brought)`,
                left: { uri: toGitUri(file, entry.brought.from), label: `Before Sync \u00b7 ${short(entry.brought.from)}` },
                right: { uri: toGitUri(file, entry.brought.to), label: `After Sync \u00b7 ${short(entry.brought.to)}` },
                base: file,
            });
        };
        if (documents.length === 1) {
            await open(documents[0]);
            return;
        }
        const picked = await this.quickInput.pick(documents.map(entry => ({
            label: entry.document,
            description: entry.repository.name,
            entry,
        })), { placeHolder: 'Which document to read, as it was before Sync and as it is now' });
        if (picked) {
            await open(picked.entry);
        }
    }

    /** Push one clone, for the Sources view's own button. */
    async pushClone(root: string, repository: string): Promise<void> {
        try {
            reportPush(this.messageService, this.windows, await desktopPush(root, repository));
        } catch (error) {
            this.messageService.error(`Push: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.emitChange();
        }
    }

    isSyncing(): boolean {
        return this.syncing;
    }
}
