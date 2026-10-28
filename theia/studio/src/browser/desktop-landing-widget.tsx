// The desktop landing page (ADR-0027): what the main area shows while the
// window has no Studio project open -- the placeholder folder the app starts
// in, or no folder. Top to bottom: who you are and what connecting gives
// (sign in, or choose a project), the modes as short onboarding cards, and
// "Work offline" -- open a folder, or one opened lately -- so the app is
// useful with no network and no account.
//
// Nothing here decides: which state it is in, which folders it lists and what
// the cards say are in desktop-landing-state.ts, with its tests; the routes it
// calls are desktop-studio-client.ts, the same ones the Studio view calls.

import * as React from '@theia/core/shared/react';
import { inject, injectable, optional } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { PerspectiveService } from '@theia/core/lib/browser/perspective-service';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { PROJECT_WORKSPACE_EXTENSION, openProjectInPlace } from './desktop-open-project';
import { adoptDesktopUser } from './desktop-studio-widget';
import type { Organization } from './desktop-projects';
import {
    SourcesState, TreeRow, filteredOutEverything, locate, openableIds, portalUrl, studioLabel, treeRows,
} from './desktop-studio-tree';
import { describeOpenProgress, type OpenProgress } from '../common/desktop-open-progress';
import {
    DesktopChange, DesktopStatus, announceDesktopChange, desktopStatus, loadProjects, onDesktopChange, openStudioProject,
    organizationOnboarding, sourcesOf, startSignIn,
} from './desktop-studio-client';
import { StudioPicker } from './desktop-studio-picker';
import {
    LandingStatus, LandingView, ModeCard, ONBOARDING_STORAGE_KEY, OrganizationOnboarding, RecentFolder, landingView, modeCards,
    noOrganizationHint, onboardingDismissed, recentFolders,
} from './desktop-landing-state';
import { MODES } from './studio-mode-bar';

export const DESKTOP_LANDING_WIDGET_ID = 'studio.desktop.landing';

/** Theia's own "Open Folder…" (Windows, Linux) and "Open…" (macOS, where folders open through it). */
export const OPEN_FOLDER_COMMAND_ID = 'workspace:openFolder';
export const OPEN_COMMAND_ID = 'workspace:open';

/** How often the landing reads the sign-in state while it is on screen: the Studio view may sign in or out too. */
const STATUS_POLL_MS = 2000;
/** How many sources listings are asked at once. */
const SOURCES_CONCURRENCY = 4;

const ICONS: Record<TreeRow['kind'], string> = {
    organization: 'codicon-organization',
    workspace: 'codicon-folder-library',
    project: 'codicon-project',
};

type Status = DesktopStatus & LandingStatus;

@injectable()
export class DesktopLandingWidget extends ReactWidget {
    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(CommandRegistry)
    protected readonly commands: CommandRegistry;

    @inject(StorageService)
    protected readonly storage: StorageService;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    @inject(PerspectiveService) @optional()
    protected readonly perspectives: PerspectiveService | undefined;

    protected status: Status | undefined;
    protected statusKnown = false;
    protected poll: number | undefined;

    protected organizations: Organization[] | undefined;
    protected projectsFor: string | undefined;
    protected loading = false;
    protected loadError = '';
    protected sources = new Map<string, SourcesState>();
    protected sourcesGeneration = 0;
    /** How to get an organization; read only once the member turns out to have none. */
    protected organizationOnboarding: OrganizationOnboarding | undefined;
    protected filter = '';

    protected opening: { id: string; name: string } | undefined;
    protected progress: OpenProgress | undefined;
    protected openError: { id: string; message: string } | undefined;

    protected recent: RecentFolder[] = [];
    /** `undefined` until storage answers: the cards wait rather than flash. */
    protected dismissed: boolean | undefined;

    constructor() {
        super();
        this.id = DESKTOP_LANDING_WIDGET_ID;
        this.title.label = 'Welcome';
        this.title.caption = 'Constructor Studio Desktop: connect, choose a project, or work offline';
        this.title.iconClass = 'codicon codicon-home';
        this.title.closable = true;
        this.addClass('studio-landing-view');
        this.node.tabIndex = -1;
        // A page, scrolled natively like the start page it stands in for.
        this.scrollOptions = undefined;
    }

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.toDisposeOnDetach.push(onDesktopChange(change => this.onOtherViewChanged(change)));
        void this.refresh();
        void this.loadRecent();
        void this.loadOnboarding();
        this.poll = window.setInterval(() => {
            if (this.isVisible && !this.opening) {
                void this.refresh();
            }
        }, STATUS_POLL_MS);
        if (this.perspectives) {
            this.toDisposeOnDetach.push(this.perspectives.onDidChangePerspective(() => this.update()));
        }
    }

    protected onBeforeDetach(msg: Message): void {
        window.clearInterval(this.poll);
        this.poll = undefined;
        super.onBeforeDetach(msg);
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        (this.node.querySelector<HTMLElement>('.studio-landing__primary') ?? this.node).focus();
    }

    /** What the Studio view did (signed in or out, switched, opened): read it here too. */
    protected onOtherViewChanged(change: DesktopChange): void {
        if (change.origin !== this) {
            void this.refresh(false);
        }
    }

    /**
     * Read the sign-in state; on a change of Studio or of who is signed in, load
     * the projects again. `announce` tells the other views of a sign-in seen here.
     */
    async refresh(announce = true): Promise<void> {
        const before = this.status;
        const status = await desktopStatus() as Status | undefined;
        this.statusKnown = true;
        const changed = JSON.stringify(status) !== JSON.stringify(before);
        this.status = status;
        if (!changed) {
            return;
        }
        adoptDesktopUser(this.commands, status);
        const key = status?.state === 'signed-in' ? `${status.studioUrl}|${status.user?.sub}` : undefined;
        if (key !== this.projectsFor) {
            this.projectsFor = key;
            this.forgetProjects();
            if (key) {
                if (announce && before && before.state !== 'signed-in') {
                    // The Studio view polls only while it started a sign-in itself.
                    announceDesktopChange(this, 'signed-in');
                }
                void this.loadEntities();
            }
        }
        this.update();
    }

    /** The picker switched the Studio: read it here, then tell the Studio view. */
    protected async switched(): Promise<void> {
        await this.refresh(false);
        announceDesktopChange(this, 'switched');
    }

    protected forgetProjects(): void {
        this.organizations = undefined;
        this.organizationOnboarding = undefined;
        this.loadError = '';
        this.sources = new Map();
        this.sourcesGeneration++;
        this.filter = '';
        this.openError = undefined;
    }

    protected async signIn(): Promise<void> {
        try {
            await startSignIn();
        } finally {
            await this.refresh();
        }
    }

    protected async loadEntities(): Promise<void> {
        this.loading = true;
        this.loadError = '';
        this.update();
        const forKey = this.projectsFor;
        try {
            const organizations = await loadProjects();
            if (forKey !== this.projectsFor) {
                return;
            }
            this.organizations = organizations;
            if (organizations.length === 0) {
                // Asked here, before the list is shown, so the page does not
                // say "an invitation" and then change its mind.
                const onboarding = await organizationOnboarding();
                if (forKey !== this.projectsFor) {
                    return;
                }
                this.organizationOnboarding = onboarding;
            }
            void this.loadSources(organizations);
        } catch (error) {
            if (forKey === this.projectsFor) {
                this.loadError = error instanceof Error ? error.message : String(error);
            }
        } finally {
            this.loading = false;
            this.update();
        }
    }

    /** Each project's sources, a few at a time, so one with none says so before it is clicked. */
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

    protected async loadRecent(): Promise<void> {
        try {
            const recent = await this.workspaceService.recentWorkspaces();
            this.recent = recentFolders(recent, this.status?.startFolder ?? (await desktopStatus() as Status | undefined)?.startFolder);
        } catch {
            this.recent = [];
        }
        this.update();
    }

    protected async loadOnboarding(): Promise<void> {
        try {
            this.dismissed = onboardingDismissed(await this.storage.getData(ONBOARDING_STORAGE_KEY));
        } catch {
            this.dismissed = false;
        }
        this.update();
    }

    /** "Got it": the cards stay away on this machine until Help → Welcome. */
    protected dismissOnboarding(): void {
        this.dismissed = true;
        void this.storage.setData(ONBOARDING_STORAGE_KEY, true).catch(() => undefined);
        this.update();
    }

    /** Help → Welcome: the cards again. */
    showOnboarding(): void {
        this.dismissed = false;
        void this.storage.setData(ONBOARDING_STORAGE_KEY, false).catch(() => undefined);
        this.update();
    }

    /** Clone the project's sources through Studio, then open its folder in this window. */
    protected async openProject(row: TreeRow): Promise<void> {
        if (this.opening || row.kind === 'organization') {
            return;
        }
        if (this.sources.get(row.id)?.state === 'empty') {
            // A repository may have been added in the portal since: ask again.
            const state = await sourcesOf(row.id);
            this.sources.set(row.id, state);
            this.update();
            if (state.state === 'empty') {
                return;
            }
        }
        this.opening = { id: row.id, name: row.name };
        this.progress = undefined;
        this.openError = undefined;
        this.update();
        try {
            const path = await openStudioProject(row.id, row.folder ?? row.name, progress => {
                if (this.opening?.id === row.id) {
                    this.progress = progress;
                    this.update();
                }
            });
            // In place, not `open(…, { preserveWindow })`: that reloads the whole window.
            await openProjectInPlace(this.workspaceService, URI.fromFilePath(path));
            announceDesktopChange(this, 'opened');
        } catch (error) {
            this.openError = { id: row.id, message: `Could not open ${row.name}: ${error instanceof Error ? error.message : error}` };
        } finally {
            this.opening = undefined;
            this.progress = undefined;
            this.update();
        }
    }

    protected openFolder(): void {
        const id = this.commands.getCommand(OPEN_FOLDER_COMMAND_ID) && this.commands.isEnabled(OPEN_FOLDER_COMMAND_ID)
            ? OPEN_FOLDER_COMMAND_ID : OPEN_COMMAND_ID;
        void this.commands.executeCommand(id).catch(e => console.warn('[studio-desktop] open folder failed', e));
    }

    protected openRecent(folder: RecentFolder): void {
        const uri = new URI(folder.uri);
        // A folder opens in place; a workspace file is another window's
        // workspace, which Theia changes only by loading it.
        void (uri.path.ext === PROJECT_WORKSPACE_EXTENSION
            ? this.workspaceService.open(uri, { preserveWindow: true })
            : openProjectInPlace(this.workspaceService, uri));
    }

    protected switchMode(card: ModeCard): void {
        void this.perspectives?.switchPerspective(card.perspective)
            .catch(e => console.warn(`[studio-desktop] could not switch to the ${card.label} mode`, e));
    }

    protected openPortal(url: string): void {
        this.windowService.openNewWindow(url, { external: true });
    }

    /** Which state the page is in; public for the contribution's tests. */
    get view(): LandingView {
        return landingView(this.status, this.statusKnown, { organizations: this.organizations, loading: this.loading, error: this.loadError });
    }

    protected render(): React.ReactNode {
        const view = this.view;
        return <div className='studio-landing' data-view={view.kind}>
            <div className='studio-landing__body'>
                <header className='studio-landing__head'>
                    <span className='studio-landing__eyebrow'>Constructor Studio Desktop</span>
                    <h1 className='studio-landing__title'>You are in Constructor Studio Desktop.</h1>
                    <p className='studio-landing__sub'>Connect to your organization and choose a project, or keep working offline.</p>
                </header>
                <section className='studio-landing__section studio-landing__connect' aria-label='Connect'>
                    {this.renderConnect(view)}
                </section>
                {this.renderOnboarding()}
                {this.renderOffline(view)}
            </div>
        </div>;
    }

    protected studioLine(status: Status): React.ReactNode {
        const label = studioLabel(status.studioUrl, status.current);
        return <span className='studio-landing__studio' title={status.studioUrl}>
            <span className='codicon codicon-globe' />
            {label.name && <b>{label.name}</b>}
            <span className='studio-landing__muted'>{label.host}</span>
        </span>;
    }

    protected hostOf(): string {
        return studioLabel(this.status?.studioUrl, this.status?.current).host || 'Studio';
    }

    protected renderConnect(view: LandingView): React.ReactNode {
        const status = this.status;
        switch (view.kind) {
            case 'checking':
                return <p className='studio-landing__muted'>
                    <span className='codicon codicon-loading codicon-modifier-spin' /> Checking your Studio sign-in…
                </p>;
            case 'no-studio':
                return <>
                    <h2 className='studio-landing__section-head'>Connect</h2>
                    <p className='studio-landing__muted'>This app is not set up for a Constructor Studio, so there is nothing to sign in to.
                        Folders on this computer open as usual below.</p>
                </>;
            case 'signing-in':
                return <>
                    <h2 className='studio-landing__section-head'>Connect</h2>
                    {status && <div className='studio-landing__account'>{this.studioLine(status)}</div>}
                    <p role='status'><span className='codicon codicon-loading codicon-modifier-spin' /> Finish signing in in your browser.</p>
                    <p className='studio-landing__muted'>Studio opened the Constructor ID page there; this page updates once you are done.</p>
                </>;
            case 'connect':
                return <>
                    <h2 className='studio-landing__section-head'>Connect</h2>
                    <p className='studio-landing__lead'>Sign in to reach your organization's projects, clone their sources through Studio,
                        and use the AI your organization provides. Nothing but that sign-in is stored on this computer.</p>
                    <div className='studio-landing__account'>
                        {status && (status.switchable
                            ? <StudioPicker choice={status} onSwitched={() => void this.switched()} />
                            : this.studioLine(status))}
                    </div>
                    {view.error && (view.unreachable
                        ? <p className='studio-landing__error' role='alert'>
                            {this.hostOf()} could not be reached ({view.error}). Check your connection and try again, or work offline below.
                        </p>
                        : <p className='studio-landing__error' role='alert'>{view.error}</p>)}
                    <div className='studio-landing__actions'>
                        <button className='studio-landing__btn studio-landing__btn--primary studio-landing__primary' onClick={() => void this.signIn()}>
                            <span className='codicon codicon-account' /> Sign in with Constructor ID
                        </button>
                        <span className='studio-landing__muted studio-landing__note'>Opens the sign-in page in your browser.</span>
                    </div>
                </>;
            default:
                return this.renderProjects(view);
        }
    }

    /**
     * What to do with no organization, in the words the Studio's setting allows
     * (ADR-0051 §5). The forms are the portal's; this names the way and, where
     * the member asked, what became of it -- their own request, nobody else's.
     */
    protected renderNoOrganization(): React.ReactNode {
        const host = this.hostOf();
        const hint = noOrganizationHint(this.organizationOnboarding);
        switch (hint.kind) {
            case 'create':
                return <p className='studio-landing__muted'>You belong to no organization on {host} yet.
                    Create your own or accept an invitation in the portal, then reload.</p>;
            case 'ask':
                return <p className='studio-landing__muted'>You belong to no organization on {host} yet.
                    Ask for one in the portal, where a platform administrator reviews it, or accept an invitation there; then reload.</p>;
            case 'pending':
                return <>
                    <p className='studio-landing__muted'>You belong to no organization on {host} yet.</p>
                    <p>You asked for <b>{hint.name}</b> on {new Date(hint.askedAt).toLocaleDateString()}.
                        A platform administrator reviews it; reload once it is approved.</p>
                </>;
            case 'rejected':
                return <>
                    <p className='studio-landing__muted'>You belong to no organization on {host} yet.</p>
                    <p>Your request for <b>{hint.name}</b> was not approved.{hint.reason && <> {hint.reason}</>}</p>
                    <p className='studio-landing__muted'>You can ask again, or accept an invitation, in the portal.</p>
                </>;
            default:
                return <p className='studio-landing__muted'>You belong to no organization on {host} yet.
                    Accept an invitation in the portal, then reload.</p>;
        }
    }

    protected renderProjects(view: LandingView): React.ReactNode {
        const status = this.status!;
        const who = status.user?.name ?? status.user?.email ?? status.user?.sub;
        const head = <div className='studio-landing__projects-head'>
            <h2 className='studio-landing__section-head'>Choose a project</h2>
            <button className='studio-landing__icon-button codicon codicon-refresh' title='Reload your projects' aria-label='Reload your projects'
                disabled={this.loading} onClick={() => void this.loadEntities()} />
        </div>;
        const account = <div className='studio-landing__account'>
            {this.studioLine(status)}
            {who && <span className='studio-landing__who'><span className='codicon codicon-account' /> {who}</span>}
        </div>;
        if (view.kind === 'projects-loading') {
            return <>{head}{account}
                <p className='studio-landing__muted'><span className='codicon codicon-loading codicon-modifier-spin' /> Loading your projects…</p>
            </>;
        }
        if (view.kind === 'projects-error') {
            return <>{head}{account}
                <p className='studio-landing__error' role='alert'>
                    {view.unreachable
                        ? `${this.hostOf()} could not be reached (${view.error}). Check your connection and try again, or work offline below.`
                        : `Your projects could not be loaded from ${this.hostOf()} (${view.error}).`}
                </p>
                <div className='studio-landing__actions'>
                    <button className='studio-landing__btn' onClick={() => void this.loadEntities()}>
                        <span className='codicon codicon-refresh' /> Try again
                    </button>
                </div>
            </>;
        }
        if (view.kind === 'no-organizations') {
            return <>{head}{account}
                {this.renderNoOrganization()}
                <div className='studio-landing__actions'>
                    {status.studioUrl && <button className='studio-landing__btn' onClick={() => this.openPortal(status.studioUrl!)}>
                        <span className='codicon codicon-link-external' /> Open the portal
                    </button>}
                    <button className='studio-landing__btn' onClick={() => void this.loadEntities()}>
                        <span className='codicon codicon-refresh' /> Reload
                    </button>
                </div>
            </>;
        }
        if (view.kind !== 'projects') {
            return undefined;
        }
        const organizations = view.organizations;
        const rows = treeRows(organizations, { filter: this.filter });
        const nothingAtAll = organizations.every(o => o.projects.length === 0);
        return <>{head}{account}
            {this.opening && this.renderOpening()}
            <div className='studio-landing__filter'>
                <span className='codicon codicon-filter' />
                <input className='theia-input' type='text' placeholder='Filter by name' aria-label='Filter organizations, workspaces and projects'
                    value={this.filter}
                    onChange={e => { this.filter = e.target.value; this.update(); }}
                    onKeyDown={e => {
                        if (e.key === 'Escape' && this.filter) {
                            e.preventDefault();
                            this.filter = '';
                            this.update();
                        }
                    }} />
            </div>
            {this.loadError && <p className='studio-landing__error' role='alert'>{this.loadError}</p>}
            {nothingAtAll && <p className='studio-landing__muted'>
                {organizations.length === 1 ? 'Your organization has no projects yet.' : 'Your organizations have no projects yet.'}
                {' '}Create one in the portal, then reload.
            </p>}
            {filteredOutEverything(organizations, this.filter) && <p className='studio-landing__muted'>Nothing is called “{this.filter.trim()}”.</p>}
            <ul className='studio-landing__list' aria-label='Your projects'>
                {rows.map(row => this.renderRow(row))}
            </ul>
        </>;
    }

    protected renderRow(row: TreeRow): React.ReactNode {
        const indent = { paddingLeft: `${8 + Math.max(0, row.level - 1) * 16}px` };
        if (row.kind === 'organization') {
            return <li key={row.id} className='studio-landing__org' style={indent}>
                <span className={`codicon ${ICONS.organization}`} />
                <span className='studio-landing__row-name'>{row.name}</span>
                {row.hint && <span className='studio-landing__hint'>{row.hint}</span>}
                {!row.expandable && <span className='studio-landing__row-meta'>no projects</span>}
            </li>;
        }
        const sources = this.sources.get(row.id);
        const empty = sources?.state === 'empty';
        const opening = this.opening?.id === row.id;
        const error = this.openError?.id === row.id ? this.openError.message : undefined;
        const where = locate(this.organizations, row.id);
        const link = where && this.status?.studioUrl
            ? portalUrl(this.status.studioUrl, { organization: where.organization.id, workspace: where.workspace.id, project: where.project?.id })
            : undefined;
        const classes = ['studio-landing__row', `studio-landing__row--${row.kind}`];
        if (empty) { classes.push('studio-landing__row--empty'); }
        return <li key={row.id}>
            <button className={classes.join(' ')} style={indent} data-row-id={row.id} disabled={!!this.opening && !opening}
                aria-busy={opening || undefined}
                title={empty ? `${row.name} has no repositories yet. Add one in the portal, then click to check again.`
                    : `Open ${row.name} here: its sources are cloned through Studio`}
                onClick={() => void this.openProject(row)}>
                <span className={`codicon ${opening ? 'codicon-loading codicon-modifier-spin' : ICONS[row.kind]}`} />
                <span className='studio-landing__row-name'>{row.name}</span>
                <span className='studio-landing__row-meta'>
                    {opening ? 'opening…'
                        : empty ? 'no repositories'
                            : sources?.state === 'ready'
                                ? `${sources.repositories} ${sources.repositories === 1 ? 'repository' : 'repositories'}`
                                : ''}
                </span>
                {!opening && !empty && <span className='studio-landing__row-go codicon codicon-arrow-right' aria-hidden />}
            </button>
            {empty && !opening && <div className='studio-landing__row-note' style={{ paddingLeft: `${34 + Math.max(0, row.level - 1) * 16}px` }}>
                No repositories yet, so there is nothing to clone.{' '}
                {link && <button className='studio-landing__link' onClick={() => this.openPortal(link)}>Add one in the portal</button>}
            </div>}
            {error && <div className='studio-landing__row-note studio-landing__error' role='alert'
                style={{ paddingLeft: `${34 + Math.max(0, row.level - 1) * 16}px` }}>{error}</div>}
        </li>;
    }

    protected renderOpening(): React.ReactNode {
        const progress = this.progress;
        return <div className='studio-landing__opening' aria-live='polite'>
            <div className='studio-landing__opening-title'>
                <span className='codicon codicon-loading codicon-modifier-spin' /> Opening {this.opening?.name}
            </div>
            <div className='studio-landing__muted'>{progress ? describeOpenProgress(progress) : 'Starting…'}</div>
            {progress?.sources.filter(s => s.state !== 'present').map(s => {
                const percent = s.state === 'done' ? 100 : s.percent ?? 0;
                return <div key={s.name} className='studio-landing__progress'>
                    <div className='studio-landing__progress-line'>
                        <span>{s.name}</span>
                        <span>{s.state === 'done' ? 'done' : s.state === 'failed' ? 'failed' : s.state === 'waiting' ? 'waiting' : `${percent}%`}</span>
                    </div>
                    <div className='studio-landing__bar' role='progressbar' aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                        <div style={{ width: `${percent}%` }} />
                    </div>
                </div>;
            })}
        </div>;
    }

    protected renderOnboarding(): React.ReactNode {
        if (this.dismissed !== false) {
            return undefined;
        }
        const registered = this.perspectives?.getRegisteredPerspectives?.().map(p => p.id);
        const cards = modeCards(MODES, registered?.length ? registered : undefined, this.perspectives?.getActivePerspectiveId());
        if (cards.length === 0) {
            return undefined;
        }
        return <section className='studio-landing__section studio-landing__onboarding' aria-label='Modes'>
            <div className='studio-landing__projects-head'>
                <h2 className='studio-landing__section-head'>One IDE, a mode for each kind of work</h2>
                <button className='studio-landing__link' onClick={() => this.dismissOnboarding()}>Got it</button>
            </div>
            <p className='studio-landing__muted'>Switch any time from the mode picker at the top. Each mode arranges the views and the ribbon for its job.</p>
            <div className='studio-landing__cards'>
                {cards.map(card => <button key={card.role} className={`studio-landing__card${card.current ? ' studio-landing__card--current' : ''}`}
                    aria-pressed={card.current} title={`Switch to ${card.label}`} onClick={() => this.switchMode(card)}>
                    <span className={`codicon codicon-${card.icon} studio-landing__card-icon`} aria-hidden />
                    <span className='studio-landing__card-text'>
                        <b>{card.label}</b>
                        <span>{card.line}</span>
                    </span>
                </button>)}
            </div>
        </section>;
    }

    protected renderOffline(view: LandingView): React.ReactNode {
        const emphasised = view.kind === 'no-studio' || (view.kind === 'connect' && view.unreachable)
            || (view.kind === 'projects-error' && view.unreachable);
        return <section className='studio-landing__section studio-landing__offline' aria-label='Work offline'>
            <h2 className='studio-landing__section-head'>Work offline</h2>
            <p className='studio-landing__muted'>Open a folder on this computer. No network and no account needed; sign in later whenever you like.</p>
            <div className='studio-landing__actions'>
                <button className={`studio-landing__btn${emphasised ? ' studio-landing__btn--primary' : ''}`} onClick={() => this.openFolder()}>
                    <span className='codicon codicon-folder-opened' /> Open folder…
                </button>
            </div>
            {this.recent.length > 0 && <>
                <h3 className='studio-landing__subhead'>Recent folders</h3>
                <ul className='studio-landing__list' aria-label='Recent folders'>
                    {this.recent.map(folder => <li key={folder.uri}>
                        <button className='studio-landing__row studio-landing__row--recent' title={`Open ${folder.path}`} onClick={() => this.openRecent(folder)}>
                            <span className='codicon codicon-folder' />
                            <span className='studio-landing__row-name'>{folder.name}</span>
                            <span className='studio-landing__row-path'>{folder.path}</span>
                        </button>
                    </li>)}
                </ul>
            </>}
        </section>;
    }
}
