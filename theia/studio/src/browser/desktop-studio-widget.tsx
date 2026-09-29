// The desktop Studio's own view (ADR-0027): who is signed in, and what they can
// open. In a session the portal hands the IDE its token; on the desktop there
// is no portal, so this view is where the member signs in. The token never
// reaches it — the IDE backend holds it and attaches it on the way to Studio.
//
// Top to bottom: the account (which Studio, who, switch, sign out), the project
// this window has open as a card, the member's organizations → workspaces →
// projects as a tree with a filter. What decides anything about the tree is in
// desktop-studio-tree.ts, with its tests. The app's own settings -- which
// updates it takes -- are in Settings (studio.desktop.updateChannel), and
// Help → Check for Updates checks now: electron-browser/, desktop app only.

import * as React from '@theia/core/shared/react';
import { inject, injectable } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { Endpoint } from '@theia/core/lib/browser/endpoint';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { StorageService } from '@theia/core/lib/browser/storage-service';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { CommandService } from '@theia/core/lib/common/command';
import { StudioApi } from './studio-api';
import { IDENTITY_VIEWER_COMMAND_ID } from './portal-bridge-contribution';
import { DesktopEnvironmentChoice } from '../common/desktop-environments';
import { Organization, Tenant, projectsOf } from './desktop-projects';
import {
    SourcesState, TreeRow, collapsedStorageKey, filteredOutEverything, locate, openableIds, organizationHints,
    parseCollapsed, portalUrl, pruneCollapsed, sourcesStateOf, studioLabel, toggleCollapsed, treeKey, treeRows,
} from './desktop-studio-tree';
import { describeOpenProgress, type OpenProgress } from '../common/desktop-open-progress';
import { remoteGearCatalogueChanged, remoteGearCatalogueSignedIn } from './gearbox-remote-catalogue';

export const DESKTOP_STUDIO_WIDGET_ID = 'studio.desktop';

/** How many sources listings are asked at once after the tree loads. */
const SOURCES_CONCURRENCY = 4;

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

export async function desktopStatus(): Promise<DesktopStatus | undefined> {
    try {
        const answer = await fetch(desktopUrl('status'));
        return answer.ok ? await answer.json() as DesktopStatus : undefined;
    } catch {
        return undefined;
    }
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

    protected status: DesktopStatus | undefined;
    /** The workspace being cloned and opened. */
    protected opening: string | undefined;
    /** Why an open failed, per row, shown on that row. */
    protected openErrors = new Map<string, string>();
    /** How far the open is, polled from the backend while it runs. */
    protected progress: OpenProgress | undefined;
    protected progressPoll: number | undefined;
    /** The project this window has open, when Studio opened it. */
    protected openedHere: string | undefined;
    protected organizations: Organization[] | undefined;
    protected loading = false;
    protected loadError = '';
    protected poll: number | undefined;
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
        this.title.caption = 'Your Constructor Studio account and projects';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-account';
        this.addClass('studio-desktop-view');
    }

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        void this.refresh();
    }

    protected onBeforeDetach(msg: Message): void {
        window.clearInterval(this.poll);
        window.clearInterval(this.progressPoll);
        super.onBeforeDetach(msg);
    }

    protected async refresh(): Promise<void> {
        const before = this.status?.state;
        this.status = await desktopStatus();
        adoptDesktopUser(this.commands, this.status);
        if (this.status?.state === 'signing-in') {
            this.poll ??= window.setInterval(() => void this.refresh(), 1000);
        } else {
            window.clearInterval(this.poll);
            this.poll = undefined;
        }
        if (this.status?.state === 'signed-in' && before !== 'signed-in') {
            // Signed in after the window loaded: what was listed signed out is stale.
            if (before !== undefined) {
                remoteGearCatalogueChanged.fire();
            } else {
                // First seen already signed in -- the sign-in finished before
                // this view looked. Ask again only if the catalogue was refused.
                remoteGearCatalogueSignedIn();
            }
            await this.loadCollapsed();
            await this.loadEntities();
        }
        this.update();
    }

    /** Whether the "which Studio" picker is open while signed in. */
    protected choosing = false;
    protected customUrl = '';
    protected switchError = '';

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

    /** Connect to another Studio: the backend signs out of this one first. */
    protected async switchTo(target: { id: string } | { studioUrl: string }): Promise<void> {
        this.switchError = '';
        const answer = await fetch(desktopUrl('environment'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(target),
        });
        if (!answer.ok) {
            this.switchError = ((await answer.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${answer.status}`;
            this.update();
            return;
        }
        this.choosing = false;
        this.forgetStudio();
        await this.refresh();
    }

    protected async signOut(): Promise<void> {
        await fetch(desktopUrl('sign-out'), { method: 'POST' });
        this.forgetStudio();
        await this.refresh();
    }

    /** Which Studio this IDE connects to: the build's list, or an address. */
    protected renderPicker(status: DesktopStatus): React.ReactNode {
        if (!status.switchable) {
            return undefined;
        }
        const current = status.current;
        const value = current?.id === 'custom' ? 'custom' : current?.id ?? '';
        return <div className='studio-desktop__picker'>
            <label className='studio-desktop__label' htmlFor='studio-desktop-picker'>Studio</label>
            <select id='studio-desktop-picker' className='theia-select' value={value}
                onChange={e => e.target.value === 'custom'
                    ? (this.customUrl = current?.id === 'custom' ? current.studioUrl : '', this.choosing = true, this.update())
                    : void this.switchTo({ id: e.target.value })}>
                {status.environments.map(env => <option key={env.id} value={env.id}>{env.label} — {env.studioUrl.replace(/^https?:\/\//, '')}</option>)}
                <option value='custom'>{current?.id === 'custom' ? `Other — ${current.label}` : 'Other…'}</option>
            </select>
            {(this.choosing || current?.id === 'custom') && <div className='studio-desktop__picker-custom'>
                <input className='theia-input' placeholder='https://studio.example.com' aria-label='Studio address'
                    value={this.customUrl} onChange={e => { this.customUrl = e.target.value; this.update(); }}
                    onKeyDown={e => e.key === 'Enter' && void this.switchTo({ studioUrl: this.customUrl })} />
                <button className='theia-button secondary' onClick={() => void this.switchTo({ studioUrl: this.customUrl })}>Use</button>
            </div>}
            {this.switchError && <p className='studio-desktop__error' role='alert'>{this.switchError}</p>}
        </div>;
    }

    protected async signIn(): Promise<void> {
        await fetch(desktopUrl('sign-in'), { method: 'POST' });
        await this.refresh();
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
        this.progressPoll = window.setInterval(() => void this.readProgress(workspace.id), 400);
        try {
            const answer = await fetch(desktopUrl('open'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: workspace.id, name: folder }),
            });
            const body = await answer.json() as { path?: string; error?: string };
            if (!answer.ok || !body.path) {
                throw new Error(body.error ?? `HTTP ${answer.status}`);
            }
            await this.workspaceService.open(URI.fromFilePath(body.path), { preserveWindow: true });
        } catch (error) {
            this.openErrors.set(workspace.id, `Could not open ${workspace.name}: ${error instanceof Error ? error.message : error}`);
        } finally {
            window.clearInterval(this.progressPoll);
            this.progressPoll = undefined;
            this.opening = undefined;
            this.progress = undefined;
            this.update();
        }
    }

    protected async readProgress(workspaceId: string): Promise<void> {
        try {
            const progress = await (await fetch(desktopUrl('open-progress'))).json() as OpenProgress | null;
            if (this.opening === workspaceId && progress?.workspaceId === workspaceId) {
                this.progress = progress;
                this.update();
            }
        } catch {
            // A backend from before this route: the spinner alone, as before.
        }
    }

    /** Which project this window has open, asked of the backend for its folder. */
    protected async readOpenedHere(): Promise<void> {
        const root = this.workspaceService.tryGetRoots()[0]?.resource;
        this.openedHere = undefined;
        if (!root) {
            return;
        }
        try {
            const answer = await fetch(`${desktopUrl('opened')}?root=${encodeURIComponent(root.path.fsPath())}`);
            this.openedHere = answer.ok ? (await answer.json() as { tenantId?: string }).tenantId : undefined;
        } catch {
            this.openedHere = undefined;
        }
    }

    /** The member's projects, found the way the portals find them. */
    protected async loadEntities(): Promise<void> {
        this.loading = true;
        this.loadError = '';
        this.update();
        try {
            this.organizations = await projectsOf(async path => {
                const answer = await StudioApi.fetch(path);
                if (!answer.ok) {
                    throw new Error(`HTTP ${answer.status}`);
                }
                return answer.json();
            });
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
                const state = await this.sourcesOf(id);
                if (generation !== this.sourcesGeneration) {
                    return;
                }
                this.sources.set(id, state);
                this.update();
            }
        };
        await Promise.all(Array.from({ length: SOURCES_CONCURRENCY }, worker));
    }

    protected async sourcesOf(id: string): Promise<SourcesState> {
        try {
            const answer = await StudioApi.fetch(`/studio-git/v1/sources?project_id=${encodeURIComponent(id)}`);
            return sourcesStateOf(answer.status, await answer.json().catch(() => undefined));
        } catch {
            return { state: 'unknown' };
        }
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
            const state = await this.sourcesOf(row.id);
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

    /** One compact block: which Studio, who, and the two ways out. */
    protected renderAccount(status: DesktopStatus, studio: React.ReactNode): React.ReactNode {
        const who = status.user?.name ?? status.user?.email ?? status.user?.sub;
        return <header className='studio-desktop__account'>
            {studio}
            <div className='studio-desktop__who'>
                <span className='codicon codicon-account' />
                <span className='studio-desktop__name' title={status.user?.email ? `${who} <${status.user.email}>` : who}>{who}</span>
            </div>
            <div className='studio-desktop__links'>
                {status.switchable && <button className='studio-desktop__link' onClick={() => { this.choosing = !this.choosing; this.update(); }}>
                    {this.choosing ? 'Keep this Studio' : 'Switch Studio'}
                </button>}
                <button className='studio-desktop__link' onClick={() => void this.signOut()}>Sign out</button>
            </div>
            {this.choosing && this.renderPicker(status)}
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
        return <section className='studio-desktop__card' aria-label={`${project.name} is open in this window`}>
            <div className='studio-desktop__eyebrow'>Open in this window</div>
            <div className='studio-desktop__card-title'>
                <span className={`codicon ${where.project ? ICONS.project : ICONS.workspace}`} /> {project.name}
            </div>
            <div className='studio-desktop__card-path'>{this.pathOf(where)}</div>
            {sources?.state === 'ready' && <div className='studio-desktop__card-meta'>
                <span className='codicon codicon-repo' /> {plural(sources.repositories, 'repository', 'repositories')}
            </div>}
            {link && <div className='studio-desktop__card-actions'>
                <button className='theia-button secondary studio-desktop__small-button' onClick={() => this.openPortal(link)}
                    title={`Open ${project.name} in the portal, in your browser`}>
                    <span className='codicon codicon-link-external' /> Open in portal
                </button>
            </div>}
        </section>;
    }

    /** "Organization › Workspace", the organization only when the member has several. */
    protected pathOf(where: NonNullable<ReturnType<typeof locate>>): React.ReactNode {
        const orgs = this.organizations ?? [];
        const hint = organizationHints(orgs).get(where.organization.id);
        const parts: React.ReactNode[] = [];
        if (orgs.length > 1) {
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
                <span className={`studio-desktop__icon codicon ${icon}`} />
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
}
