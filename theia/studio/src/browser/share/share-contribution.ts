// Where "Share with the team" lives: a command, a line in the status bar that
// says how much is not shared yet (and opens the window), the Doc editing
// ribbon's first Git action with the same number on it, and — in a portal
// session — a button in Source Control beside its own, for whoever commits
// there: the project's way to the team (straight, or through review) is
// Share's, and Source Control's push knows nothing of it. Source Control's own
// actions are left exactly as they are. See share-dialog.tsx for the window
// and node/document-share-service.ts for what it does in git.

import { inject, injectable, optional } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, codicon } from '@theia/core/lib/browser';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar-types';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { Command, CommandContribution, CommandRegistry, Disposable, DisposableCollection, Emitter, MenuContribution, MenuModelRegistry, MessageService } from '@theia/core';
import { TabBarToolbarContribution, TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { ScmService } from '@theia/scm/lib/browser/scm-service';
import { ScmWidget } from '@theia/scm/lib/browser/scm-widget';
import { SCM_REPOSITORY_MENU, SCM_SOURCE_CONTROL_MENU } from '@theia/scm/lib/browser/scm-repositories-widget';
import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { DocumentShareService, shareBranchOf, type ShareDocument, type ShareRepository } from '../../common/document-share-protocol';
import { MarkdownDiffService } from '../markdown-diff/markdown-diff-service';
import { toGitUri } from '../markdown-diff/markdown-diff-uri';
import { isDesktopHost } from '../desktop-git-contribution';
import { RibbonBadges } from '../ribbon-badges';
import { ShareDialog } from './share-dialog';
import { Person, repositoryRootOf, sameFolder, unsharedCount } from './share-model';
import { RepositorySharing, ShareSharingClient } from './share-sharing-client';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out')), ms);
        promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
}

export const SHARE_COMMAND: Command = Command.toDefaultLocalizedCommand({
    id: 'studio.share.open',
    label: 'Share with the Team',
    iconClass: codicon('cloud-upload'),
});

/**
 * Share from Source Control: the window for one repository — the one a row's
 * menu was opened on, or the one the view shows. Visible in a portal session
 * only; the desktop pushes its own way (desktop-git-contribution.ts).
 */
export const SHARE_REPOSITORY_COMMAND: Command = {
    id: 'studio.share.openRepository',
    label: 'Share with the Team',
    iconClass: codicon('cloud-upload'),
};

/**
 * Who is sharing, as product-ext's identity knows them (name and, in a portal
 * session, the address the identity provider gave). A command rather than an
 * import, so this package does not depend on that one; without it, git's own
 * configuration names the author.
 */
export const IDENTITY_COMMAND = 'studio.identity.current';

/**
 * Write every editor's pending edits before counting or sharing: Theia's own
 * editors (core.saveAll) and product-ext's documents, which autosave on their
 * own clock and are not Theia Saveables. Measured: a share taken a few seconds
 * after typing sent the file without the sentence just typed.
 */
export const SAVE_COMMANDS = ['core.saveAll', 'studio.documents.saveAll'];

const STATUS_ID = 'studio.share';
/**
 * How long a count may take. A request made while the session's connection is
 * still being set up can be lost and never answered — measured on a fresh
 * session: the first count hung for good while the same call a minute later
 * answered at once — so a count that takes longer is given up and tried again.
 */
const STATUS_TIMEOUT_MS = 10_000;
/** How long a burst of saves settles before the status line counts again. */
const RECOUNT_DELAY_MS = 1500;

@injectable()
export class ShareContribution implements CommandContribution, MenuContribution, TabBarToolbarContribution, FrontendApplicationContribution {
    @inject(DocumentShareService) protected readonly service: DocumentShareService;
    @inject(WorkspaceService) protected readonly workspace: WorkspaceService;
    @inject(StatusBar) protected readonly statusBar: StatusBar;
    @inject(CommandRegistry) protected readonly commands: CommandRegistry;
    @inject(MessageService) protected readonly messages: MessageService;
    @inject(MarkdownDiffService) protected readonly diffs: MarkdownDiffService;
    @inject(WindowService) protected readonly windows: WindowService;
    @inject(FileService) @optional() protected readonly files: FileService | undefined;
    @inject(ShareSharingClient) @optional() protected readonly sharingClient: ShareSharingClient | undefined;
    @inject(RibbonBadges) @optional() protected readonly badges: RibbonBadges | undefined;
    @inject(ScmService) @optional() protected readonly scm: ScmService | undefined;

    protected readonly toDispose = new DisposableCollection();
    protected recountTimer: ReturnType<typeof setTimeout> | undefined;
    protected opening = false;
    /** A portal session, as far as known: Source Control's Share shows only once the backend said so. */
    protected portal = false;
    protected readonly onDidChangePortalEmitter = new Emitter<void>();

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(SHARE_COMMAND, {
            execute: () => this.open(),
            isEnabled: () => !this.opening,
        });
        commands.registerCommand(SHARE_REPOSITORY_COMMAND, {
            execute: (arg?: unknown) => this.open(repositoryRootOf(arg, this.scm?.selectedRepository?.provider.rootUri)),
            isEnabled: () => !this.opening,
            isVisible: () => this.portal,
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        // A repository's row: its "..." menu, and the menu a right-click opens.
        menus.registerMenuAction([...SCM_REPOSITORY_MENU, '1_studio'], { commandId: SHARE_REPOSITORY_COMMAND.id, label: SHARE_REPOSITORY_COMMAND.label, order: '0' });
        menus.registerMenuAction([...SCM_SOURCE_CONTROL_MENU, '1_studio'], { commandId: SHARE_REPOSITORY_COMMAND.id, label: SHARE_REPOSITORY_COMMAND.label, order: '0' });
    }

    registerToolbarItems(registry: TabBarToolbarRegistry): void {
        // Source Control's title bar, beside its own Commit and Refresh.
        registry.registerItem({
            id: SHARE_REPOSITORY_COMMAND.id,
            command: SHARE_REPOSITORY_COMMAND.id,
            tooltip: 'Share with the team: send what you edited or committed, the way this project takes changes',
            priority: -1,
            isVisible: widget => this.portal && widget instanceof ScmWidget && !!this.scm?.selectedRepository,
            onDidChange: this.onDidChangePortalEmitter.event,
        });
    }

    onStart(): void {
        if (this.files) {
            this.toDispose.push(this.files.onDidFilesChange(event => {
                // git's own churn says nothing about documents.
                if (event.changes.every(change => change.resource.path.toString().includes('/.git/'))) {
                    return;
                }
                this.scheduleRecount();
            }));
        }
        this.toDispose.push(this.workspace.onWorkspaceChanged(() => this.scheduleRecount()));
        // A commit from Source Control changes no file outside .git, so the
        // file events above miss it; Source Control's own state is the event.
        if (this.scm) {
            const scm = this.scm;
            const watched = new DisposableCollection();
            const watch = (): void => {
                watched.dispose();
                for (const repository of scm.repositories) {
                    if (repository.provider.onDidChange) {
                        watched.push(repository.provider.onDidChange(() => this.scheduleRecount()));
                    }
                }
                this.scheduleRecount();
            };
            this.toDispose.push(watched);
            this.toDispose.push(scm.onDidAddRepository(watch));
            this.toDispose.push(scm.onDidRemoveRepository(watch));
            watch();
        }
        void isDesktopHost().then(desktop => {
            this.portal = !desktop;
            this.onDidChangePortalEmitter.fire();
        });
        const onFocus = (): void => this.scheduleRecount();
        window.addEventListener('focus', onFocus);
        this.toDispose.push(Disposable.create(() => window.removeEventListener('focus', onFocus)));
        this.toDispose.push(Disposable.create(() => clearTimeout(this.recountTimer)));
        void this.workspace.ready.then(() => this.scheduleRecount());
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    protected roots(): string[] {
        return this.workspace.tryGetRoots().map(root => root.resource.toString());
    }

    protected scheduleRecount(): void {
        clearTimeout(this.recountTimer);
        this.recountTimer = setTimeout(() => void this.recount(), RECOUNT_DELAY_MS);
    }

    /** Early in startup the roots or the backend may not be there yet: a few more tries, then quiet. */
    protected retries = 0;

    protected counting = false;

    protected async recount(): Promise<void> {
        if (this.counting) {
            this.scheduleRecount();
            return;
        }
        this.counting = true;
        try {
            await this.doRecount();
        } finally {
            this.counting = false;
        }
    }

    protected async doRecount(): Promise<void> {
        const roots = this.roots();
        if (!roots.length) {
            this.retryLater();
            return;
        }
        try {
            const { repositories } = await withTimeout(this.service.status(roots, await this.me()), STATUS_TIMEOUT_MS);
            this.retries = 0;
            this.showCount(unsharedCount(repositories));
        } catch {
            // No repository, a backend still starting: say nothing rather than something wrong.
            void this.statusBar.removeElement(STATUS_ID);
            this.badges?.set(SHARE_COMMAND.id, 0);
            this.retryLater();
        }
    }

    protected retryLater(): void {
        if (this.retries++ < 5) {
            clearTimeout(this.recountTimer);
            this.recountTimer = setTimeout(() => void this.recount(), 4000);
        }
    }

    protected showCount(count: number): void {
        this.badges?.set(SHARE_COMMAND.id, count);
        if (!count) {
            void this.statusBar.removeElement(STATUS_ID);
            return;
        }
        void this.statusBar.setElement(STATUS_ID, {
            text: `$(cloud-upload) ${count === 1 ? '1 document not shared' : `${count} documents not shared`}`,
            tooltip: 'Your edits are saved here but the team does not have them yet. Click to share them.',
            alignment: StatusBarAlignment.RIGHT,
            priority: 250,
            command: SHARE_COMMAND.id,
            className: 'studio-share-status',
        });
    }

    protected async me(): Promise<Person | undefined> {
        if (!this.commands.getCommand(IDENTITY_COMMAND)) {
            return undefined;
        }
        try {
            const person = await this.commands.executeCommand<{ name?: string; email?: string }>(IDENTITY_COMMAND);
            return person?.name ? { name: person.name, ...(person.email ? { email: person.email } : {}) } : undefined;
        } catch {
            return undefined;
        }
    }

    /** The window, for every repository with something to share, or for the one at `only` (a folder uri). */
    async open(only?: string): Promise<void> {
        if (this.opening) {
            return;
        }
        this.opening = true;
        try {
            const roots = this.roots();
            if (!roots.length) {
                this.messages.info('Open a project first.');
                return;
            }
            await this.flush();
            const me = await this.me();
            const listed = (await withTimeout(this.service.status(roots, me), STATUS_TIMEOUT_MS)).repositories;
            const repositories = only ? listed.filter(repository => sameFolder(repository.root, only)) : listed;
            if (!repositories.length) {
                this.messages.info('This project has no repository to share to.');
                return;
            }
            if (!unsharedCount(repositories)) {
                this.messages.info('Everything is already shared.');
                return;
            }
            const dialog = new ShareDialog({
                service: this.service,
                repositories,
                me,
                sharing: await this.sharingOf(repositories, me),
                openPullRequest: (sharing, head, title, body) => this.sharingClient!.openPullRequest(sharing, head, title, body),
                showChanges: (document, against) => void this.showChanges(document, against),
                showConflict: (repository, path, theirs) => void this.showConflict(repository, path, theirs),
                openLink: url => this.windows.openNewWindow(url, { external: true }),
                report: said => {
                    if (said.level === 'error') { this.messages.error(said.text); }
                    else if (said.level === 'warn') { this.messages.warn(said.text); }
                    else { this.messages.info(said.text); }
                },
            });
            await dialog.open();
        } catch (error) {
            this.messages.error(error instanceof Error && error.message === 'timed out'
                ? 'The project’s repository did not answer. Try again in a moment.'
                : `Share: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            this.opening = false;
            this.scheduleRecount();
        }
    }

    /**
     * How each repository is shared, as its project decided. A repository
     * Studio says nothing about — or does not answer for in time — shares
     * straight to its branch, as it always did.
     */
    protected async sharingOf(repositories: readonly ShareRepository[], me: Person | undefined): Promise<Map<string, RepositorySharing>> {
        const found = new Map<string, RepositorySharing>();
        const client = this.sharingClient;
        if (!client) {
            return found;
        }
        const rootFsPaths = this.workspace.tryGetRoots().map(root => root.resource.path.fsPath());
        await Promise.all(repositories.map(async repository => {
            try {
                const sharing = await withTimeout(client.sharing(rootFsPaths, repository.name, shareBranchOf(me)), STATUS_TIMEOUT_MS);
                if (sharing) {
                    found.set(repository.root, sharing);
                }
            } catch {
                // Unknown: straight to the branch.
            }
        }));
        return found;
    }

    protected async flush(): Promise<void> {
        for (const id of SAVE_COMMANDS) {
            if (this.commands.getCommand(id)) {
                try {
                    await this.commands.executeCommand(id);
                } catch {
                    // A document that cannot save now (a conflict) shares what is on disk.
                }
            }
        }
    }

    /**
     * A document's changes: against its last commit, or — when commits made
     * here are not sent yet — against the team's version, so what was
     * committed and not sent shows too.
     */
    protected async showChanges(document: ShareDocument, against: string | undefined): Promise<void> {
        const file = new URI(document.uri);
        if (!against) {
            await this.diffs.compareWithHead(file);
            return;
        }
        await this.diffs.open({
            left: { uri: toGitUri(file, against), label: 'The team’s version' },
            right: { uri: file, label: 'Yours' },
            base: file,
        });
    }

    /** The team's version beside mine — what the conflict is about. */
    protected async showConflict(repository: ShareRepository, path: string, theirs: string | undefined): Promise<void> {
        const file = new URI(repository.root).resolve(path);
        await this.diffs.open({
            title: `${file.path.base} (the team's version and yours)`,
            left: { uri: toGitUri(file, theirs ?? '@{upstream}'), label: 'The team’s version' },
            right: { uri: toGitUri(file, 'HEAD'), label: 'Yours' },
            base: file,
        });
    }
}
