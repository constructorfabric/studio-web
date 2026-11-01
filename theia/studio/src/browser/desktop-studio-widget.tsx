// The desktop Studio's own view (ADR-0027): who is signed in, and what they can
// open. In a session the portal hands the IDE its token; on the desktop there
// is no portal, so this view is where the member signs in. The token never
// reaches it — the IDE backend holds it and attaches it on the way to Studio.
//
// Top to bottom: the account (which Studio, who, switch, sign out), the project
// this window has open as a card, the member's organizations → workspaces →
// projects as a tree with a filter. What decides anything about the tree is in
// desktop-studio-tree.ts, with its tests; the routes it calls, and the Studio
// picker, are desktop-studio-client.ts and desktop-studio-picker.tsx, the same
// ones the landing page uses. The app's own settings -- which updates it
// takes -- are in Settings (studio.desktop.updateChannel), and Help → Check
// for Updates checks now: electron-browser/, desktop app only.

import * as React from '@theia/core/shared/react';
import { inject, injectable } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { openProjectInPlace } from './desktop-open-project';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { CommandService } from '@theia/core/lib/common/command';
import { IDENTITY_VIEWER_COMMAND_ID } from './portal-bridge-contribution';
import { Organization, Tenant } from './desktop-projects';
import {
    SourcesState, TreeRow, collapsedStorageKey, filteredOutEverything, locate, openableIds, organizationHints,
    parseCollapsed, portalUrl, pruneCollapsed, studioLabel, toggleCollapsed, treeKey, treeRows,
} from './desktop-studio-tree';
import { describeOpenProgress, type OpenProgress } from '../common/desktop-open-progress';
import { remoteGearCatalogueChanged, remoteGearCatalogueSignedIn } from './gearbox-remote-catalogue';
import {
    DesktopChange, DesktopStatus, announceDesktopChange, desktopStatus, loadProjects, onDesktopChange, openStudioProject,
    openedProject, signOut, sourcesOf, startSignIn,
} from './desktop-studio-client';
import { StudioPicker } from './desktop-studio-picker';
import { memberPhoto, organizationLogo, photoKey } from './desktop-account-avatar';
import { lastDeployLine, repoLine, type DeployRecord, type RepoLine } from './desktop-open-card';
import { ScmService } from '@theia/scm/lib/browser/scm-service';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { StudioApi } from './studio-api';

export const DESKTOP_STUDIO_WIDGET_ID = 'studio.desktop';

/** How many sources listings are asked at once after the tree loads. */
const SOURCES_CONCURRENCY = 4;

/** Who is signed in to which Studio; `undefined` while no one is. */
const accountOf = (status: DesktopStatus | undefined) =>
    status?.state === 'signed-in' ? `${status.studioUrl}|${status.user?.sub}` : undefined;

/**
 * Tell the product who is signed in, as the portal does in a session
 * (portal-bridge-contribution's adoptPortalViewer): comments, change proposals
 * and the Project page's "You" then carry the member's verified name instead
 * of a self-declared one, or "You". Idempotent on the product's side, so it is
 * safe on every status read; a build without the product extension answers an
 * unknown command by throwing, which is caught.
 */
export function adoptDesktopUser(commands: CommandService, status: DesktopStatus | undefined): void {
    const user = status?.state === 'signed-in' ? status.user : undefined;
    if (!user?.sub) {
        return;
    }
    commands.executeCommand(IDENTITY_VIEWER_COMMAND_ID, { sub: user.sub, name: user.name, email: user.email, kind: 'person' })
        .catch(e => console.warn('[studio-desktop] signed-in member not adopted', e));
}

const ICONS: Record<TreeRow['kind'], string> = {
    organization: 'codicon-organization',
    workspace: 'codicon-folder-library',
    project: 'codicon-project',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

@injectable()
export class DesktopStudioWidget extends ReactWidget {
    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(CommandService)
    protected readonly commands: CommandService;

    @inject(StorageService)
    protected readonly storage: StorageService;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    /** The checkouts' branches and changes, for the open project's card. */
    @inject(ScmService)
    protected readonly scm: ScmService;
    protected readonly scmWatch = new DisposableCollection();
    /** The open project's last deploy, read from Studio: per project, with when it was read. */
    protected lastDeploy: { project: string; at: number; line?: { text: string; failed: boolean } } | undefined;

    protected status: DesktopStatus | undefined;
    /** The workspace being cloned and opened. */
    protected opening: string | undefined;
    /** Why an open failed, per row, shown on that row. */
    protected openErrors = new Map<string, string>();
    /** How far the open is, as the backend reports it while it runs. */
    protected progress: OpenProgress | undefined;
    /** The project this window has open, when Studio opened it. */
    protected openedHere: string | undefined;
    protected organizations: Organization[] | undefined;
    protected loading = false;
    protected loadError = '';
    protected poll: number | undefined;
    /** The member's photo, for the sign-in it was read for (`photoKey`); `src` absent for none. */
    protected photo: { key: string; src?: string } | undefined;
    /** Each organization's logo from the portal, once asked: `null` for none. */
    protected logos = new Map<string, string | null>();

    /** What each project's sources listing said, asked once the tree loads. */
    protected sources = new Map<string, SourcesState>();
    protected sourcesGeneration = 0;

    /** The tree: what is typed in the filter, which rows are closed, which has the focus. */
    protected filter = '';
    protected collapsed = new Set<string>();
    protected collapsedFor: string | undefined;
    protected focusedId: string | undefined;
    protected pendingFocus: string | undefined;

    constructor() {
        super();
        this.id = DESKTOP_STUDIO_WIDGET_ID;
        this.title.label = 'Constructor Studio';
        this.title.caption = 'Constructor Studio on the web: your account, your organizations and their projects';
        this.title.closable = true;
        // The way into the Studio Web integration, not a person: the member's
        // photo is beside their name inside the view.
        this.title.iconClass = 'codicon codicon-globe';
        this.addClass('studio-desktop-view');
    }

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.toDisposeOnDetach.push(onDesktopChange(change => this.onOtherViewChanged(change)));
        this.watchScm();
        this.toDisposeOnDetach.push(this.scm.onDidAddRepository(() => this.watchScm()));
        this.toDisposeOnDetach.push(this.scm.onDidRemoveRepository(() => this.watchScm()));
        this.toDisposeOnDetach.push(this.scmWatch);
        void this.refresh();
    }

    protected onBeforeDetach(msg: Message): void {
        window.clearInterval(this.poll);
        this.poll = undefined;
        super.onBeforeDetach(msg);
    }

    /** What another view did (the landing page signed in, switched, opened): read it here too. */
    protected async onOtherViewChanged(change: DesktopChange): Promise<void> {
        if (change.origin === this) {
            return;
        }
        await this.refresh(false);
        if (change.kind === 'opened') {
            await this.readOpenedHere();
            this.update();
        }
    }

    /** One read of the sign-in at a time: the view's own poll and another view's news may ask together. */
    protected reading: Promise<void> = Promise.resolve();

    /** Read the sign-in; `announce` tells the other views of a sign-in seen here. */
    protected refresh(announce = true): Promise<void> {
        const next = this.reading.then(() => this.readStatus(announce));
        this.reading = next.catch(() => undefined);
        return next;
    }

    protected async readStatus(announce: boolean): Promise<void> {
        const before = this.status;
        this.status = await desktopStatus();
        adoptDesktopUser(this.commands, this.status);
        if (this.status?.state === 'signing-in') {
            this.poll ??= window.setInterval(() => void this.refresh(), 1000);
        } else {
            window.clearInterval(this.poll);
            this.poll = undefined;
        }
        const account = accountOf(this.status);
        if (account !== accountOf(before)) {
            if (accountOf(before)) {
                // Signed out, or into another Studio, elsewhere: what was listed is someone else's.
                this.forgetStudio();
            }
            if (account) {
                // Signed in after the window loaded: what was listed signed out is stale.
                if (before !== undefined) {
                    remoteGearCatalogueChanged.fire();
                    if (announce) {
                        announceDesktopChange(this, 'signed-in');
                    }
                } else {
                    // First seen already signed in -- the sign-in finished before
                    // this view looked. Ask again only if the catalogue was refused.
                    remoteGearCatalogueSignedIn();
                }
                await this.loadCollapsed();
                await this.loadEntities();
            }
        }
        this.update();
    }

    /** Whether the "which Studio" picker is open while signed in. */
    protected choosing = false;
    /** Why signing in or out was refused, in the account block. */
    protected accountError = '';

    /** Forget everything that belonged to the Studio being left. */
    protected forgetStudio(): void {
        this.organizations = undefined;
        this.loadError = '';
        this.openErrors = new Map();
        this.sources = new Map();
        this.sourcesGeneration++;
        this.filter = '';
        this.focusedId = undefined;
    }

    /** The backend has connected to another Studio (and signed out of this one). */
    protected async switched(): Promise<void> {
        this.choosing = false;
        this.accountError = '';
        this.forgetStudio();
        await this.refresh();
        announceDesktopChange(this, 'switched');
    }

    protected async signOut(): Promise<void> {
        this.accountError = '';
        const refused = await signOut();
        if (refused) {
            // Still signed in: the list stays, and the reason is said.
            this.accountError = `Could not sign out: ${refused}`;
            this.update();
            return;
        }
        this.forgetStudio();
        await this.refresh();
        announceDesktopChange(this, 'signed-out');
    }

    /** Which Studio this IDE connects to: the build's list, or an address. */
    protected renderPicker(status: DesktopStatus): React.ReactNode {
        return <StudioPicker choice={status} block='studio-desktop' id='studio-desktop-picker' onSwitched={() => void this.switched()} />;
    }

    protected async signIn(): Promise<void> {
        this.accountError = '';
        try {
            const refused = await startSignIn();
            if (refused) {
                this.accountError = `Could not start the sign-in: ${refused}`;
            }
        } finally {
            await this.refresh();
        }
    }

    protected renderAccountError(): React.ReactNode {
        return this.accountError ? <p className='studio-desktop__error' role='alert'>{this.accountError}</p> : undefined;
    }

    /**
     * Clone the project's sources through Studio, then open the folder here. A
     * nested project is checked out under its workspace's name as well, so two
     * workspaces' "api" projects do not share a folder.
     */
    protected async openWorkspace(workspace: Tenant, folder: string = workspace.name): Promise<void> {
        this.opening = workspace.id;
        this.openErrors.delete(workspace.id);
        this.progress = undefined;
        this.update();
        try {
            const path = await openStudioProject(workspace.id, folder, progress => {
                if (this.opening === workspace.id) {
                    this.progress = progress;
                    this.update();
                }
            });
            // In place, not `open(…, { preserveWindow })`: that reloads the whole window.
            await openProjectInPlace(this.workspaceService, URI.fromFilePath(path));
            announceDesktopChange(this, 'opened');
        } catch (error) {
            this.openErrors.set(workspace.id, `Could not open ${workspace.name}: ${error instanceof Error ? error.message : error}`);
        } finally {
            this.opening = undefined;
            this.progress = undefined;
            this.update();
        }
    }

    /** Which project this window has open, asked of the backend for its folder. */
    protected async readOpenedHere(): Promise<void> {
        const root = this.workspaceService.tryGetRoots()[0]?.resource;
        this.openedHere = undefined;
        if (root) {
            this.openedHere = await openedProject(root.path.fsPath());
        }
    }

    /** The member's projects, found the way the portals find them. */
    protected async loadEntities(): Promise<void> {
        this.loading = true;
        this.loadError = '';
        this.update();
        try {
            this.organizations = await loadProjects();
            await this.readOpenedHere();
            this.collapsed = pruneCollapsed(this.collapsed, this.organizations);
            void this.loadSources(this.organizations);
        } catch (error) {
            this.loadError = `Your projects could not be loaded from ${this.status?.studioUrl ?? 'Studio'} ` +
                `(${error instanceof Error ? error.message : error}).`;
        } finally {
            this.loading = false;
            this.update();
        }
    }

    /**
     * Ask each project's sources, a few at a time, so a project with none says
     * so on its row before anyone clicks it. The listing is the one the open
     * itself starts with, so the two cannot disagree.
     */
    protected async loadSources(organizations: Organization[]): Promise<void> {
        const generation = ++this.sourcesGeneration;
        const queue = openableIds(organizations);
        const worker = async () => {
            for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
                const state = await sourcesOf(id);
                if (generation !== this.sourcesGeneration) {
                    return;
                }
                this.sources.set(id, state);
                this.update();
            }
        };
        await Promise.all(Array.from({ length: SOURCES_CONCURRENCY }, worker));
    }

    /** Collapse state is kept per Studio: two Studios have different trees. */
    protected async loadCollapsed(): Promise<void> {
        const key = collapsedStorageKey(this.status?.studioUrl);
        if (this.collapsedFor === key) {
            return;
        }
        this.collapsedFor = key;
        try {
            this.collapsed = parseCollapsed(await this.storage.getData(key));
        } catch {
            this.collapsed = new Set();
        }
    }

    protected setCollapsed(next: Set<string>): void {
        this.collapsed = next;
        void this.storage.setData(collapsedStorageKey(this.status?.studioUrl), [...next]).catch(() => undefined);
        this.update();
    }

    protected openPortal(url: string): void {
        this.windowService.openNewWindow(url, { external: true });
    }

    protected portalLinkOf(id: string): string | undefined {
        const where = locate(this.organizations, id);
        const studioUrl = this.status?.studioUrl;
        if (!where || !studioUrl) {
            return undefined;
        }
        return portalUrl(studioUrl, { organization: where.organization.id, workspace: where.workspace.id, project: where.project?.id });
    }

    /** What a click, Enter or Space on a row does. */
    protected async activateRow(row: TreeRow): Promise<void> {
        if (row.kind === 'organization') {
            if (row.expandable) {
                this.setCollapsed(toggleCollapsed(this.collapsed, row.id));
            }
            return;
        }
        if (this.opening || this.openedHere === row.id) {
            return;
        }
        if (this.sources.get(row.id)?.state === 'empty') {
            // A repository may have been added in the portal since: ask again, and open if so.
            const state = await sourcesOf(row.id);
            this.sources.set(row.id, state);
            this.update();
            if (state.state === 'empty') {
                return;
            }
        }
        await this.openWorkspace({ id: row.id, name: row.name }, row.folder);
    }

    protected onTreeKey(event: React.KeyboardEvent, rows: TreeRow[]): void {
        const action = treeKey(rows, this.focusedId, event.key);
        if (!action) {
            return;
        }
        event.preventDefault();
        const row = rows.find(r => r.id === action.id);
        switch (action.type) {
            case 'focus':
                this.focusRow(action.id);
                break;
            case 'expand':
                this.setCollapsed(toggleCollapsed(this.collapsed, action.id, true));
                break;
            case 'collapse':
                this.setCollapsed(toggleCollapsed(this.collapsed, action.id, false));
                break;
            case 'activate':
                if (row) {
                    void this.activateRow(row);
                }
                break;
        }
    }

    protected focusRow(id: string): void {
        this.focusedId = id;
        this.pendingFocus = id;
        this.update();
    }

    protected render(): React.ReactNode {
        const status = this.status;
        if (!status) {
            return <div className='studio-desktop'><p className='studio-desktop__muted'>
                <span className='codicon codicon-loading codicon-modifier-spin' /> Checking your Studio sign-in…
            </p></div>;
        }
        if (!status.enabled) {
            return <div className='studio-desktop'><p className='studio-desktop__muted'>This IDE is not connected to a Constructor Studio.</p></div>;
        }
        const label = studioLabel(status.studioUrl, status.current);
        const studio = <div className='studio-desktop__studio' title={status.studioUrl}>
            <span className='codicon codicon-globe' />
            {label.name && <b>{label.name}</b>}
            <span className='studio-desktop__host'>{label.host}</span>
        </div>;
        if (status.state === 'signing-in') {
            return <div className='studio-desktop'>
                <header className='studio-desktop__account'>{studio}</header>
                <p><span className='codicon codicon-loading codicon-modifier-spin' /> Finish signing in in your browser.</p>
                <p className='studio-desktop__muted'>Studio opened the sign-in page there; this view updates once you are done.</p>
            </div>;
        }
        if (status.state !== 'signed-in') {
            return <div className='studio-desktop'>
                <header className='studio-desktop__account'>
                    {status.switchable ? this.renderPicker(status) : studio}
                </header>
                <h3 className='studio-desktop__title'>Sign in to Constructor Studio</h3>
                <p>Your projects, their sources and the AI your organization provides are one sign-in away.
                    Nothing is stored on this computer but that sign-in.</p>
                {status.state === 'failed' && <p className='studio-desktop__error' role='alert'>{status.error}</p>}
                {this.renderAccountError()}
                <button className='theia-button studio-desktop__wide-button' onClick={() => void this.signIn()}>
                    Sign in with Constructor ID
                </button>
                <p className='studio-desktop__muted'>Opens the sign-in page in your browser.</p>
            </div>;
        }
        return <div className='studio-desktop'>
            {this.renderAccount(status, studio)}
            {this.renderCard()}
            {this.renderProjects()}
        </div>;
    }

    /** One compact block: who (photo, name, address), the way out, and which Studio. */
    protected renderAccount(status: DesktopStatus, studio: React.ReactNode): React.ReactNode {
        const who = status.user?.name ?? status.user?.email ?? status.user?.sub;
        const email = status.user?.email && status.user.email !== who ? status.user.email : undefined;
        const photo = this.photoOf(status);
        return <header className='studio-desktop__account'>
            <div className='studio-desktop__who'>
                {photo ? <img className='studio-desktop__avatar' src={photo} alt='' data-member-photo />
                    : <span className='studio-desktop__avatar studio-desktop__avatar--none codicon codicon-account' />}
                <div className='studio-desktop__who-text'>
                    <span className='studio-desktop__name' title={email ? `${who} <${email}>` : who}>{who}</span>
                    {email && <span className='studio-desktop__email'>{email}</span>}
                </div>
            </div>
            <div className='studio-desktop__studio-row'>
                {studio}
                <span className='studio-desktop__links'>
                    {status.switchable && <button className='studio-desktop__link' onClick={() => { this.choosing = !this.choosing; this.update(); }}>
                        {this.choosing ? 'Keep this Studio' : 'Switch Studio'}
                    </button>}
                    <button className='studio-desktop__link' onClick={() => void this.signOut()}>Sign out</button>
                </span>
            </div>
            {this.choosing && this.renderPicker(status)}
            {this.renderAccountError()}
        </header>;
    }

    /** The project this window has open, or the one being opened, at the top. */
    protected renderCard(): React.ReactNode {
        if (this.opening) {
            const where = locate(this.organizations, this.opening);
            const name = where?.project?.name ?? where?.workspace.name ?? this.progress?.name ?? '';
            return <section className='studio-desktop__card studio-desktop__card--busy' aria-live='polite'>
                <div className='studio-desktop__eyebrow'>Opening</div>
                <div className='studio-desktop__card-title'>
                    <span className='codicon codicon-loading codicon-modifier-spin' /> {name}
                </div>
                {where && <div className='studio-desktop__card-path'>{this.pathOf(where)}</div>}
                {this.renderProgress()}
            </section>;
        }
        if (!this.openedHere) {
            return <section className='studio-desktop__card studio-desktop__card--empty'>
                <div className='studio-desktop__eyebrow'>This window</div>
                <div className='studio-desktop__muted'>No Studio project is open here. Pick one below: its sources are cloned through Studio.</div>
            </section>;
        }
        const where = locate(this.organizations, this.openedHere);
        if (!where) {
            return <section className='studio-desktop__card'>
                <div className='studio-desktop__eyebrow'>Open in this window</div>
                <div className='studio-desktop__muted'>
                    {this.organizations ? 'A Studio project that is not among your projects on this Studio.' : 'A Studio project.'}
                </div>
            </section>;
        }
        const project = where.project ?? where.workspace;
        const sources = this.sources.get(project.id);
        const link = this.portalLinkOf(project.id);
        const logo = this.logoOf(where.organization.id);
        const repos = this.repoLines();
        const deploy = this.lastDeployOf(project.id);
        return <section className='studio-desktop__card' aria-label={`${project.name} is open in this window`}>
            <div className='studio-desktop__eyebrow'>Open in this window</div>
            <div className='studio-desktop__card-title'>
                <span className={`codicon ${where.project ? ICONS.project : ICONS.workspace}`} /> {project.name}
            </div>
            <div className='studio-desktop__card-path'>
                {logo ? <img className='studio-desktop__logo' src={logo} alt='' /> : undefined}
                {this.pathOf(where, true)}
            </div>
            {repos.length > 0 ? <ul className='studio-desktop__repos' aria-label='Checkouts'>
                {repos.map(r => <li key={r.name} className='studio-desktop__repo' data-repo={r.name}>
                    <span className='codicon codicon-repo' />
                    <span className='studio-desktop__repo-name'>{r.name}</span>
                    {r.branch && <span className='studio-desktop__chip' title='Branch'><span className='codicon codicon-git-branch' />{r.branch}</span>}
                    {r.changes > 0 && <span className='studio-desktop__chip studio-desktop__chip--warn' title='Files changed and not committed'>
                        {plural(r.changes, 'change', 'changes')}</span>}
                    {(r.behind ?? 0) > 0 && <span className='studio-desktop__chip' title='Commits to pull'>{r.behind}↓</span>}
                    {(r.ahead ?? 0) > 0 && <span className='studio-desktop__chip' title='Commits to push'>{r.ahead}↑</span>}
                </li>)}
            </ul> : sources?.state === 'ready' && <div className='studio-desktop__card-meta'>
                <span className='codicon codicon-repo' /> {plural(sources.repositories, 'repository', 'repositories')}
            </div>}
            {deploy && <div className={`studio-desktop__card-meta${deploy.failed ? ' studio-desktop__card-meta--bad' : ''}`} data-last-deploy>
                <span className={`codicon ${deploy.failed ? 'codicon-error' : 'codicon-rocket'}`} /> {deploy.text}
            </div>}
            {link && <div className='studio-desktop__card-actions'>
                <button className='studio-desktop__link' onClick={() => this.openPortal(link)}
                    title={`Open ${project.name} in the portal, in your browser`}>
                    Open in portal <span className='codicon codicon-link-external' />
                </button>
            </div>}
        </section>;
    }

    /** "Organization › Workspace", the organization only when the member has several. */
    protected pathOf(where: NonNullable<ReturnType<typeof locate>>, withOrganization = false): React.ReactNode {
        const orgs = this.organizations ?? [];
        const hint = organizationHints(orgs).get(where.organization.id);
        const parts: React.ReactNode[] = [];
        if (orgs.length > 1 || withOrganization) {
            parts.push(<span key='org'>{where.organization.name}{hint && <span className='studio-desktop__hint'> {hint}</span>}</span>);
        }
        if (where.project) {
            parts.push(<span key='ws'>{where.workspace.name}</span>);
        }
        if (parts.length === 0) {
            return undefined;
        }
        return parts.reduce<React.ReactNode[]>((all, part, i) => i === 0 ? [part] : [...all, <span key={`sep${i}`} className='studio-desktop__sep'> › </span>, part], []);
    }

    /** While a project opens: what is being done, and a bar per clone. */
    protected renderProgress(): React.ReactNode {
        const progress = this.progress;
        const bar = (percent: number | undefined) => <div className='studio-desktop__bar' role='progressbar'
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? 0}>
            <div style={{ width: `${percent ?? 0}%` }} />
        </div>;
        return <div className='studio-desktop__progress'>
            <div>{progress ? describeOpenProgress(progress) : 'Starting…'}</div>
            {progress?.sources.filter(s => s.state !== 'present').map(s => <div key={s.name} className='studio-desktop__progress-source'>
                <div className='studio-desktop__progress-line'>
                    <span>{s.name}</span>
                    <span>{s.state === 'done' ? 'done' : s.state === 'failed' ? 'failed' : s.state === 'waiting' ? 'waiting' : `${s.percent ?? 0}%`}</span>
                </div>
                {bar(s.state === 'done' ? 100 : s.percent)}
            </div>)}
        </div>;
    }

    /** The organizations, their workspaces and projects, with a filter. */
    protected renderProjects(): React.ReactNode {
        const organizations = this.organizations;
        const head = <h3 className='studio-desktop__section-head'>Projects</h3>;
        if (!organizations) {
            if (this.loadError) {
                return <section className='studio-desktop__projects'>{head}
                    <p className='studio-desktop__error' role='alert'>{this.loadError}</p>
                    <button className='theia-button secondary studio-desktop__small-button' onClick={() => void this.loadEntities()}>
                        <span className='codicon codicon-refresh' /> Try again
                    </button>
                </section>;
            }
            return <section className='studio-desktop__projects'>{head}
                <p className='studio-desktop__muted'><span className='codicon codicon-loading codicon-modifier-spin' /> Loading your projects…</p>
            </section>;
        }
        if (organizations.length === 0) {
            return <section className='studio-desktop__projects'>{head}
                <p className='studio-desktop__muted'>
                    You belong to no organization on this Studio yet. Accept an invitation in the portal, then reload.
                </p>
                <button className='theia-button secondary studio-desktop__small-button' onClick={() => void this.loadEntities()}>
                    <span className='codicon codicon-refresh' /> Reload
                </button>
            </section>;
        }
        const rows = treeRows(organizations, { filter: this.filter, collapsed: this.collapsed });
        if (!rows.some(r => r.id === this.focusedId)) {
            this.focusedId = rows.find(r => r.id === this.openedHere)?.id ?? rows[0]?.id;
        }
        const nothingAtAll = organizations.every(o => o.projects.length === 0);
        return <section className='studio-desktop__projects'>
            <div className='studio-desktop__projects-head'>
                {head}
                <button className='studio-desktop__icon-button codicon codicon-refresh' title='Reload your projects' aria-label='Reload your projects'
                    disabled={this.loading} onClick={() => void this.loadEntities()} />
            </div>
            <div className='studio-desktop__filter'>
                <span className='codicon codicon-filter' />
                <input className='theia-input' type='text' placeholder='Filter by name' aria-label='Filter organizations, workspaces and projects'
                    value={this.filter}
                    onChange={e => { this.filter = e.target.value; this.update(); }}
                    onKeyDown={e => {
                        if (e.key === 'Escape' && this.filter) {
                            e.preventDefault();
                            this.filter = '';
                            this.update();
                        } else if (e.key === 'ArrowDown' && rows.length) {
                            e.preventDefault();
                            this.focusRow(rows[0].id);
                        }
                    }} />
            </div>
            {/* A reload that failed leaves the last list in place, and says so. */}
            {this.loadError && <p className='studio-desktop__error' role='alert'>{this.loadError}</p>}
            {nothingAtAll && organizations.length === 1 && <p className='studio-desktop__muted'>
                Your organization has no projects yet. Create one in the portal, then reload.
            </p>}
            {filteredOutEverything(organizations, this.filter) && <p className='studio-desktop__muted'>
                Nothing is called “{this.filter.trim()}”.
            </p>}
            <div className='studio-desktop__tree' role='tree' aria-label='Your projects' onKeyDown={e => this.onTreeKey(e, rows)}>
                {rows.map(row => this.renderRow(row))}
            </div>
        </section>;
    }

    protected renderRow(row: TreeRow): React.ReactNode {
        const here = this.openedHere === row.id;
        const opening = this.opening === row.id;
        const sources = this.sources.get(row.id);
        const empty = row.kind !== 'organization' && sources?.state === 'empty';
        const error = this.openErrors.get(row.id);
        const link = row.kind === 'organization' ? undefined : this.portalLinkOf(row.id);
        const icon = opening ? 'codicon-loading codicon-modifier-spin' : ICONS[row.kind];
        const logo = row.kind === 'organization' && !opening ? this.logoOf(row.id) : undefined;
        const title = row.kind === 'organization'
            ? `${row.name}${row.hint ? ` (${row.hint})` : ''}`
            : here ? `${row.name} is open in this window`
                : empty ? `${row.name} has no repositories yet. Add one in the portal; activate the row to check again.`
                    : `Open ${row.name} here — its sources are cloned through Studio`;
        const classes = ['studio-desktop__row', `studio-desktop__row--${row.kind}`];
        if (here) { classes.push('studio-desktop__row--here'); }
        if (empty) { classes.push('studio-desktop__row--empty'); }
        return <React.Fragment key={row.id}>
            <div className={classes.join(' ')} role='treeitem' data-row-id={row.id}
                aria-level={row.level || 1} aria-expanded={row.expandable ? row.expanded : undefined}
                aria-current={here ? 'true' : undefined} aria-busy={opening || undefined}
                tabIndex={this.focusedId === row.id ? 0 : -1} title={title}
                style={{ paddingLeft: `${4 + Math.max(0, row.level - 1) * 14}px` }}
                ref={el => {
                    if (el && this.pendingFocus === row.id) {
                        this.pendingFocus = undefined;
                        el.focus();
                    }
                }}
                onFocus={() => { this.focusedId = row.id; }}
                onClick={() => { this.focusedId = row.id; void this.activateRow(row); }}>
                <span className={`studio-desktop__twisty codicon ${row.expandable ? (row.expanded ? 'codicon-chevron-down' : 'codicon-chevron-right') : ''}`}
                    onClick={e => {
                        if (row.expandable) {
                            e.stopPropagation();
                            this.focusedId = row.id;
                            this.setCollapsed(toggleCollapsed(this.collapsed, row.id));
                        }
                    }} />
                {logo ? <img className='studio-desktop__icon studio-desktop__logo' src={logo} alt='' data-organization-logo={row.id} />
                    : <span className={`studio-desktop__icon codicon ${icon}`} />}
                <span className='studio-desktop__row-name'>{row.name}</span>
                {row.hint && <span className='studio-desktop__hint'>{row.hint}</span>}
                <span className='studio-desktop__row-meta'>
                    {here ? 'open here'
                        : opening ? 'opening…'
                            : row.kind === 'organization' && !row.expandable ? 'no projects'
                                : sources?.state === 'ready' ? <span title={plural(sources.repositories, 'repository', 'repositories')}>
                                    <span className='codicon codicon-repo' />{sources.repositories}
                                </span> : undefined}
                </span>
            </div>
            {empty && !opening && <div className='studio-desktop__row-note' style={{ paddingLeft: `${40 + Math.max(0, row.level - 1) * 14}px` }}>
                No repositories yet.{' '}
                {link && <button className='studio-desktop__link' onClick={() => this.openPortal(link)}>Add one in the portal</button>}
            </div>}
            {error && !opening && <div className='studio-desktop__row-note studio-desktop__row-note--error' role='alert'
                style={{ paddingLeft: `${40 + Math.max(0, row.level - 1) * 14}px` }}>
                <span>{error}</span>
                <button className='studio-desktop__icon-button codicon codicon-close' title='Dismiss' aria-label='Dismiss'
                    onClick={() => { this.openErrors.delete(row.id); this.update(); }} />
            </div>}
        </React.Fragment>;
    }
    /** The member's photo for this sign-in, asked for once; `undefined` until it is known, or for none. */
    protected photoOf(status: DesktopStatus): string | undefined {
        const key = photoKey(status);
        if (!key) {
            return undefined;
        }
        if (this.photo?.key !== key) {
            this.photo = { key };
            void memberPhoto(status.studioUrl).catch(() => undefined).then(src => {
                if (this.photo?.key === key && src) {
                    this.photo = { key, src };
                    this.update();
                }
            });
        }
        return this.photo.src;
    }

    /** An organization's logo from the portal, asked for once; `undefined` until it is known, or for none. */
    protected logoOf(organizationId: string): string | undefined {
        if (!this.logos.has(organizationId)) {
            this.logos.set(organizationId, null);
            void organizationLogo(organizationId).catch(() => undefined).then(src => {
                if (src) {
                    this.logos.set(organizationId, src);
                    this.update();
                }
            });
        }
        return this.logos.get(organizationId) ?? undefined;
    }
    /** Follow every checkout's SCM: its branch, changes and sync change the card. */
    protected watchScm(): void {
        this.scmWatch.dispose();
        for (const repo of this.scm.repositories) {
            const provider = repo.provider;
            this.scmWatch.push(provider.onDidChange(() => this.update()));
            if (provider.onDidChangeStatusBarCommands) {
                this.scmWatch.push(provider.onDidChangeStatusBarCommands(() => this.update()));
            }
        }
        this.update();
    }

    /** The open project's checkouts, as the SCM view knows them. */
    protected repoLines(): RepoLine[] {
        return this.scm.repositories.map(r => repoLine(r.provider)).sort((a, b) => a.name.localeCompare(b.name));
    }

    /** The project's last deploy, read from Studio once a minute at most; `undefined` for none or until read. */
    protected lastDeployOf(project: string): { text: string; failed: boolean } | undefined {
        const fresh = this.lastDeploy?.project === project && Date.now() - this.lastDeploy.at < 60_000;
        if (!fresh) {
            const keep = this.lastDeploy?.project === project ? this.lastDeploy.line : undefined;
            this.lastDeploy = { project, at: Date.now(), line: keep };
            void StudioApi.fetch(`/studio-environments/v1/deployments?project_id=${encodeURIComponent(project)}`)
                .then(async res => res.ok ? (await res.json() as { items?: DeployRecord[] }).items ?? [] : undefined)
                .catch(() => undefined)
                .then(items => {
                    if (items !== undefined && this.lastDeploy?.project === project) {
                        this.lastDeploy = { project, at: this.lastDeploy.at, line: lastDeployLine(items) };
                        this.update();
                    }
                });
        }
        return this.lastDeploy?.line;
    }
}
