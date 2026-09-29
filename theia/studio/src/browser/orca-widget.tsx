// Orca panel: agent orchestration from inside the IDE.
//
// The story this panel serves: the project is already open in Theia, and from
// here a person starts agents on it, watches what they are doing, and steers
// them — without switching to another application. Orca owns the agent runs and
// the worktrees; Theia owns editing. This view is the seam.
//
// Everything it shows comes from an Orca runtime over `OrcaService`
// (`../common/orca-protocol.ts`). No Orca code is bundled here.

import * as React from '@theia/core/shared/react';
import { injectable, inject, optional } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { CommandService } from '@theia/core/lib/common/command';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
// The precise module, not the `@theia/core/lib/browser` barrel: the barrel
// pulls common-frontend-contribution, which calls document.queryCommandSupported
// while loading and takes any jsdom-based test of this widget down with it.
import { OpenerService, open } from '@theia/core/lib/browser/opener-service';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
    ORCA_AGENTS,
    OrcaService,
    type OrcaRepository,
    type OrcaRuntimeStatus,
    type OrcaTerminal,
    type OrcaWorktree,
    type OrcaWorktreeChange
} from '../common/orca-protocol';
import { OrcaTerminalOpener, OrcaPairCommand } from './orca-terminal-opener';
import { DesktopOrcaProjectSync } from './desktop-orca-project-sync';
import { ORCA_ADD_PROJECTS_PREFERENCE, keptMessage } from '../common/desktop-orca-projects';
import { ORCA_INSTALL_URL, missingAgentsNote, orcaAvailability, type OrcaAction } from '../common/orca-availability';
import {
    defaultWorktree,
    groupWorktrees,
    worktreeLabel,
    type OrcaWorktreeGroup
} from '../common/orca-worktree-groups';

export const ORCA_WIDGET_ID = 'studio.orca';

/** How long the panel is willing to block on one "wait for idle" click. */
const WAIT_BUDGET_MS = 120_000;

@injectable()
export class OrcaWidget extends ReactWidget {

    static readonly ID = ORCA_WIDGET_ID;
    static readonly LABEL = 'Agents (Orca)';

    @inject(OrcaService)
    protected readonly orca!: OrcaService;

    @inject(MessageService)
    protected readonly messages!: MessageService;

    @inject(WorkspaceService)
    protected readonly workspaces!: WorkspaceService;

    @inject(OpenerService)
    protected readonly openers!: OpenerService;

    @inject(OrcaTerminalOpener)
    protected readonly terminalTabs!: OrcaTerminalOpener;

    // Optional: the panel still renders without them (and its tests bind
    // neither); only the Get Orca and Pair buttons need them.
    @inject(WindowService) @optional()
    protected readonly windows: WindowService | undefined;

    @inject(CommandService) @optional()
    protected readonly commands: CommandService | undefined;

    // The desktop's bookkeeping of projects in the member's Orca (#497);
    // absent from the tests that do not need it, inert in a session.
    @inject(DesktopOrcaProjectSync) @optional()
    protected readonly projectSync: DesktopOrcaProjectSync | undefined;

    protected status: OrcaRuntimeStatus | undefined;
    protected worktrees: OrcaWorktree[] = [];
    /** The repositories Orca knows, to name the worktree groups. */
    protected repositories: OrcaRepository[] = [];
    /** Whether the repositories outside the open project are listed. */
    protected showOtherRepositories = false;
    /** Whether this panel has already handed the workspace to Orca on its own. */
    protected autoRegistered = false;
    protected current: OrcaWorktree | undefined;
    /** Worktree the panel is acting on; defaults to the one Theia is open on. */
    protected selected: string | undefined;
    protected terminals: OrcaTerminal[] = [];
    /** What the agent changed in the selected worktree, uncommitted. */
    protected changes: OrcaWorktreeChange[] = [];
    protected busy = '';
    protected error = '';
    /** The folder this IDE is open on, as Orca would address it. */
    protected workspaceRoot: string | undefined;

    /** New-task form. */
    protected taskName = '';
    protected taskAgent: string = ORCA_AGENTS[0];
    protected taskPrompt = '';
    /** Prompt to send into an already running agent. */
    protected followUp = '';

    constructor() {
        super();
        this.id = OrcaWidget.ID;
        this.title.label = OrcaWidget.LABEL;
        this.title.caption = 'Run and steer coding agents in isolated worktrees (Orca runtime)';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-rocket';
        this.addClass('studio-orca');
    }

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        if (this.projectSync && !this.projectSyncListening) {
            this.projectSyncListening = true;
            this.toDispose.push(this.projectSync.onDidChange(() => void this.refresh()));
        }
        void this.refresh();
    }

    protected projectSyncListening = false;

    // ── data ───────────────────────────────────────────────────────────────

    protected async refresh(): Promise<void> {
        await this.run('Refreshing', async () => {
            this.status = await this.orca.status();
            this.workspaceRoot = await this.resolveWorkspaceRoot();
            if (!this.status.reachable) {
                this.worktrees = [];
                this.repositories = [];
                this.terminals = [];
                this.changes = [];
                return;
            }
            this.current = await this.orca.currentWorktree();
            this.worktrees = await this.orca.listWorktrees();
            this.repositories = await this.loadRepositories();
            // A session's runtime starts empty on every boot, and the panel
            // used to wait for someone to find the Register button. Once per
            // panel, and only when Orca knows nothing: hand it the workspace's
            // repositories, so the agents have somewhere to work.
            // On a member's machine it is their Orca, and they decide: the
            // project sync asks them (always / not now / never).
            if (
                this.status.host !== 'local'
                && this.worktrees.length === 0
                && this.workspaceRoot
                && !this.autoRegistered
            ) {
                this.autoRegistered = true;
                try {
                    if ((await this.orca.registerWorkspace(this.workspaceRoot)).length > 0) {
                        this.worktrees = await this.orca.listWorktrees();
                        this.repositories = await this.loadRepositories();
                    }
                } catch (error) {
                    console.warn(`[orca] could not register the workspace's repositories: ${error instanceof Error ? error.message : error}`);
                }
            }
            // Default the selection to the worktree the IDE is open on, else
            // one of the open project's repositories: the first worktree Orca
            // listed used to win, and on a desktop that was another
            // repository's.
            if (!this.selected || !this.selectedWorktree()) {
                this.selected = defaultWorktree(this.groups(), this.current, this.workspaceRoot)?.id;
            }
            await this.loadSelection();
        });
    }

    /** Orca's repositories; none rather than a failed panel when an older runtime cannot list them. */
    protected async loadRepositories(): Promise<OrcaRepository[]> {
        try {
            return await this.orca.listRepositories();
        } catch (error) {
            console.warn(`[orca] cannot list repositories: ${error instanceof Error ? error.message : error}`);
            return [];
        }
    }

    protected groups(): OrcaWorktreeGroup[] {
        return groupWorktrees(this.worktrees, this.repositories, this.workspaceRoot);
    }

    /** Start Orca on this computer, then show what it answers. */
    protected startOrca(): void {
        void this.run('Starting Orca', async () => {
            this.status = await this.orca.start();
        }).then(async () => {
            if (this.status?.reachable) {
                // Orca was not there to add the open project to before.
                await this.projectSync?.check();
                await this.refresh();
            }
        });
    }

    protected act(action: OrcaAction): void {
        switch (action) {
            case 'install':
                this.windows?.openNewWindow(ORCA_INSTALL_URL, { external: true });
                return;
            case 'start':
                this.startOrca();
                return;
            case 'pair':
                void Promise.resolve(this.commands?.executeCommand(OrcaPairCommand.id)).then(
                    () => this.refresh(),
                    error => {
                        this.error = error instanceof Error ? error.message : String(error);
                        this.update();
                    }
                );
                return;
            default:
                void this.refresh();
        }
    }

    /** The IDE's own folder, or undefined when it was opened on none. */
    protected async resolveWorkspaceRoot(): Promise<string | undefined> {
        const roots = await this.workspaces.roots;
        return roots.length ? roots[0].resource.path.fsPath() : undefined;
    }

    /**
     * Hand this checkout to the runtime.
     *
     * A session container wipes Orca's state on every boot, so after a restart
     * the runtime knows nothing about the workspace that is right there on the
     * volume. One click puts it back; Orca is idempotent about a path it
     * already has.
     */
    protected registerWorkspace(): void {
        const root = this.workspaceRoot;
        if (!root) {
            return;
        }
        void this.run(`Registering ${root}`, async () => {
            const registered = await this.orca.registerWorkspace(root);
            if (registered.length === 0) {
                this.messages.warn(`There is no git repository in ${root} for Orca to work in.`);
            }
            this.worktrees = await this.orca.listWorktrees();
            this.repositories = await this.loadRepositories();
            this.selected = defaultWorktree(this.groups(), this.current, root)?.id;
            await this.loadSelection();
        });
    }

    /**
     * Everything that belongs to the selected worktree.
     *
     * Terminals and changes are loaded together because they answer one
     * question between them — what is the agent doing, and what has it done
     * so far — and because every action that could alter one alters the
     * other.
     */
    protected async loadSelection(): Promise<void> {
        const worktree = this.selectedWorktree();
        this.terminals = worktree ? await this.orca.listTerminals(`path:${worktree.path}`) : [];
        this.changes = worktree ? await this.orca.changes(worktree.path) : [];
    }

    /**
     * Agents this container can start.
     *
     * The runtime reports what it found on PATH; the full list is the
     * fallback for an older backend that does not report any, which is
     * better than offering nothing at all.
     */
    protected agents(): readonly string[] {
        // On a member's machine Orca starts the agent with its own
        // environment, which the IDE's PATH says nothing about: offer them all.
        if (this.status?.host === 'local') {
            return ORCA_AGENTS;
        }
        return this.status?.agents?.length ? this.status.agents : ORCA_AGENTS;
    }

    /**
     * The `--repo` selector for a new task: the selected worktree's
     * repository, else the open project's only one. Undefined leaves it to
     * Orca, which infers it from where the CLI runs — right in a session,
     * never on a desktop.
     */
    protected taskRepository(): string | undefined {
        const selected = this.selectedWorktree();
        if (selected?.repoId) {
            return `id:${selected.repoId}`;
        }
        const project = this.groups().filter(group => group.inProject && group.repoId);
        return project.length === 1 ? `id:${project[0].repoId}` : undefined;
    }

    protected selectedWorktree(): OrcaWorktree | undefined {
        return (
            this.worktrees.find(w => w.id === this.selected)
            ?? (this.current?.id === this.selected ? this.current : undefined)
        );
    }

    /**
     * The `--worktree` selector for a worktree id.
     *
     * Orca accepts `path:…`, `branch:…`, `active` or an id; a path is the one
     * form that survives a runtime restart, so prefer it.
     */
    protected selectorFor(id: string | undefined): string | undefined {
        const worktree = this.worktrees.find(w => w.id === id) ?? (this.current?.id === id ? this.current : undefined);
        return worktree ? `path:${worktree.path}` : undefined;
    }

    /** One place where busy state, errors and re-render are handled. */
    protected async run(label: string, action: () => Promise<void>): Promise<void> {
        this.busy = label;
        this.error = '';
        this.update();
        try {
            await action();
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.busy = '';
            this.update();
        }
    }

    // ── actions ────────────────────────────────────────────────────────────

    protected createTask(): void {
        const name = this.taskName.trim();
        const prompt = this.taskPrompt.trim();
        if (!name || !prompt) {
            this.error = 'A task needs a name (it becomes the branch) and a prompt.';
            this.update();
            return;
        }
        const repo = this.taskRepository();
        if (!repo && this.status?.host === 'local') {
            this.error = 'Pick a worktree of the repository to branch from: Orca needs to know which one.';
            this.update();
            return;
        }
        void this.run(`Creating ${name}`, async () => {
            const agent = this.agents().includes(this.taskAgent) ? this.taskAgent : this.agents()[0];
            const created = await this.orca.createTask({ name, agent, prompt, repo });
            this.taskName = '';
            this.taskPrompt = '';
            this.messages.info(
                created
                    ? `Orca created ${created.branch} at ${created.path} and started ${this.taskAgent}.`
                    : 'Orca accepted the task.'
            );
            this.worktrees = await this.orca.listWorktrees();
            this.repositories = await this.loadRepositories();
            if (created) {
                this.selected = created.id;
            }
            await this.loadSelection();
        });
    }

    protected startAgentHere(agent: string): void {
        const selector = this.selectorFor(this.selected);
        if (!selector) {
            return;
        }
        const prompt = this.followUp.trim() || undefined;
        void this.run(`Starting ${agent}`, async () => {
            const terminal = await this.orca.startAgent({ worktree: selector, agent, prompt });
            this.followUp = '';
            if (terminal) {
                this.messages.info(`${agent} is running in ${terminal.worktreePath || 'the worktree'}.`);
                // Straight into its tab, as Orca does: an agent is watched
                // and answered there, not from this panel's one-line preview.
                await this.terminalTabs.open(terminal);
            }
            await this.loadSelection();
        });
    }

    /** The agent's terminal, live, as a terminal tab in the middle. */
    protected openTerminal(terminal: OrcaTerminal): void {
        void this.run(`Opening ${terminal.title}`, async () => {
            await this.terminalTabs.open(terminal);
        });
    }

    protected sendFollowUp(handle: string): void {
        const text = this.followUp.trim();
        if (!text) {
            return;
        }
        void this.run('Sending', async () => {
            await this.orca.send(handle, text, true);
            this.followUp = '';
            await this.loadSelection();
        });
    }

    protected waitForIdle(handle: string): void {
        void this.run('Waiting for the agent to settle', async () => {
            const outcome = await this.orca.waitForIdle(handle, WAIT_BUDGET_MS);
            this.messages.info(
                outcome === 'idle'
                    ? 'The agent stopped producing output — its turn is done.'
                    : outcome === 'exit'
                      ? 'The agent process exited.'
                      : 'Still working after the wait budget; it keeps running.'
            );
            await this.loadSelection();
        });
    }

    protected interrupt(handle: string): void {
        void this.run('Interrupting', async () => {
            await this.orca.interrupt(handle);
            await this.loadSelection();
        });
    }

    // ── render ─────────────────────────────────────────────────────────────

    /** Take the focus when activated, as the other Studio views do: the Agent
     *  development mode activates this view, and Theia waits two seconds for a
     *  widget that does not. */
    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        if (!this.node.hasAttribute('tabindex')) {
            this.node.tabIndex = -1;
        }
        this.node.focus();
    }

    protected render(): React.ReactNode {
        return (
            <div className="studio-orca-body">
                {this.renderStatus()}
                {this.status?.reachable && (
                    <>
                        {this.renderNewTask()}
                        {this.renderWorktrees()}
                        {this.renderChanges()}
                        {this.renderTerminals()}
                    </>
                )}
                {this.error && <p className="error studio-orca-error">{this.error}</p>}
            </div>
        );
    }

    protected renderStatus(): React.ReactNode {
        const status = this.status;
        const availability = orcaAvailability(status);
        const label: Record<OrcaAction, string> = {
            install: 'Get Orca',
            start: 'Start Orca',
            retry: 'Refresh',
            pair: 'Pair with Orca'
        };
        return (
            <div className="studio-orca-status">
                <span title={status?.binary ? `orca: ${status.binary}` : undefined}>
                    <strong>Orca runtime:</strong> {availability.headline}
                </span>
                {availability.actions.map(action => (
                    <button
                        key={action}
                        className={`theia-button${action === availability.actions[0] && action !== 'retry' ? '' : ' secondary'}`}
                        disabled={!!this.busy}
                        onClick={() => this.act(action)}
                    >
                        {action === 'retry' && this.busy ? this.busy : label[action]}
                    </button>
                ))}
                {!status && (
                    <button className="theia-button secondary" disabled={!!this.busy} onClick={() => void this.refresh()}>
                        {this.busy || 'Refresh'}
                    </button>
                )}
                {availability.advice && <p className="studio-orca-hint">{availability.advice}</p>}
                {availability.notes.map(note => (
                    <p key={note} className="studio-orca-hint">{note}</p>
                ))}
            </div>
        );
    }

    protected renderNewTask(): React.ReactNode {
        return (
            <div className="studio-orca-section">
                <h3>New agent task</h3>
                <p className="studio-orca-hint">
                    Orca creates an isolated worktree for the task and starts the agent in it, so this
                    checkout keeps whatever you are doing right now.
                </p>
                <div className="studio-orca-form">
                    <input
                        className="theia-input"
                        placeholder="task name (becomes the branch)"
                        value={this.taskName}
                        disabled={!!this.busy}
                        onChange={e => {
                            this.taskName = e.target.value;
                            this.update();
                        }}
                    />
                    <select
                        className="theia-select"
                        value={this.taskAgent}
                        disabled={!!this.busy}
                        onChange={e => {
                            this.taskAgent = e.target.value;
                            this.update();
                        }}
                    >
                        {this.agents().map(agent => (
                            <option key={agent} value={agent}>
                                {agent}
                            </option>
                        ))}
                    </select>
                </div>
                <textarea
                    className="theia-input studio-orca-prompt"
                    placeholder="what the agent should do"
                    rows={3}
                    value={this.taskPrompt}
                    disabled={!!this.busy}
                    onChange={e => {
                        this.taskPrompt = e.target.value;
                        this.update();
                    }}
                />
                <button className="theia-button" disabled={!!this.busy} onClick={() => this.createTask()}>
                    Create worktree &amp; run
                </button>
            </div>
        );
    }

    protected renderWorktrees(): React.ReactNode {
        const groups = this.groups();
        const project = groups.filter(group => group.inProject);
        const others = groups.filter(group => !group.inProject);
        const root = this.workspaceRoot;
        // With a project open, its repositories are what this panel is
        // about; the rest of what the runtime knows is one click away.
        const shown = root && !this.showOtherRepositories ? project : [...project, ...others];
        return (
            <div className="studio-orca-section">
                <h3>Worktrees ({root ? project.reduce((n, g) => n + g.worktrees.length, 0) : this.worktrees.length})</h3>
                {!root && (
                    <p className="studio-orca-hint">
                        No project is open, so these are all the worktrees Orca knows on this computer, by
                        repository. Open a project to work on it here.
                    </p>
                )}
                {root && project.length === 0 && (
                    <>
                        <p className="empty">
                            {this.worktrees.length === 0
                                ? `The runtime knows no worktrees yet — including ${root}, which is open here.`
                                : `Orca does not know the repositories of the project open here (${root}) yet.`}
                        </p>
                        <button
                            className="theia-button"
                            disabled={!!this.busy}
                            onClick={() => this.registerWorkspace()}
                        >
                            {this.worktrees.length === 0 ? 'Register this workspace' : "Add this project's repositories to Orca"}
                        </button>
                    </>
                )}
                {shown.map(group => this.renderGroup(group, groups.length > 1))}
                {this.renderProjectSync()}
                {root && others.length > 0 && (
                    <button
                        className="theia-button secondary studio-orca-others"
                        disabled={!!this.busy}
                        onClick={() => {
                            this.showOtherRepositories = !this.showOtherRepositories;
                            this.update();
                        }}
                    >
                        {this.showOtherRepositories
                            ? 'Hide other repositories'
                            : `Other repositories in Orca (${others.length})`}
                    </button>
                )}
            </div>
        );
    }

    /**
     * What Studio does with projects opened here, and what it left in Orca.
     * Only on a member's machine: the sync is inert in a session.
     */
    protected renderProjectSync(): React.ReactNode {
        const sync = this.projectSync;
        if (!sync || this.status?.host !== 'local') {
            return undefined;
        }
        const words = {
            ask: 'Studio asks before adding a project opened here to Orca.',
            always: 'Studio adds projects opened here to Orca, and removes them when they close.',
            never: 'Studio does not add projects opened here to Orca.'
        }[sync.preference()];
        return (
            <div className="studio-orca-project-sync">
                {sync.kept.map(kept => (
                    <p key={kept.path} className="studio-orca-hint studio-orca-kept" title={kept.path}>
                        {keptMessage(kept)}
                    </p>
                ))}
                <p className="studio-orca-hint">
                    {words}{' '}
                    <a
                        href="#"
                        className="studio-orca-link"
                        onClick={event => {
                            event.preventDefault();
                            void this.commands?.executeCommand('preferences:open', ORCA_ADD_PROJECTS_PREFERENCE);
                        }}
                    >
                        Change
                    </a>
                </p>
            </div>
        );
    }

    protected renderGroup(group: OrcaWorktreeGroup, headed: boolean): React.ReactNode {
        return (
            <div key={group.repoId || group.path} className="studio-orca-group">
                {headed && (
                    <h4 className="studio-orca-group-name" title={group.path}>
                        {group.name}
                        {group.inProject && <span className="studio-orca-meta"> · this project</span>}
                    </h4>
                )}
                <ul className="studio-orca-list">
                    {group.worktrees.map(worktree => {
                        const isCurrent = worktree.id === this.current?.id;
                        return (
                            <li
                                key={worktree.id}
                                className={worktree.id === this.selected ? 'selected' : undefined}
                                title={worktree.path}
                                onClick={() => {
                                    this.selected = worktree.id;
                                    void this.run('Loading', () => this.loadSelection());
                                }}
                            >
                                <span className="studio-orca-branch">{worktreeLabel(worktree)}</span>
                                <span className="studio-orca-meta">
                                    {worktree.status}
                                    {worktree.isMain ? ' · main checkout' : ''}
                                    {isCurrent ? ' · open here' : ''}
                                </span>
                                {worktree.comment && <span className="studio-orca-meta">{worktree.comment}</span>}
                            </li>
                        );
                    })}
                </ul>
            </div>
        );
    }

    /**
     * What the agent changed, and a way into it.
     *
     * A worktree's own `status` says an agent finished; it does not say what
     * it touched. Without this the only way to find out is to open a terminal
     * and type `git status`, in a panel whose whole point is not having to.
     */
    protected renderChanges(): React.ReactNode {
        const worktree = this.selectedWorktree();
        if (!worktree) {
            return undefined;
        }
        return (
            <div className='studio-orca-section'>
                <h3>
                    Changes
                    <span className='studio-orca-meta'>
                        {' '}
                        {this.repositoryName(worktree)}
                        {worktreeLabel(worktree)}
                    </span>
                </h3>
                {this.changes.length === 0 ? (
                    // A clean worktree is a real answer, not an empty state:
                    // it means the agent committed, or has not written yet.
                    <p className='studio-orca-meta'>Nothing uncommitted.</p>
                ) : (
                    <ul className='studio-orca-list studio-orca-changes'>
                        {this.changes.map(change => (
                            <li
                                key={change.absolutePath}
                                title={change.absolutePath}
                                onClick={() => this.openChange(change)}
                            >
                                <span className='studio-orca-change-code'>{change.code.trim() || '--'}</span>
                                <span className='studio-orca-change-path'>{change.path}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        );
    }

    /**
     * Open one changed file in the editor.
     *
     * `URI.fromFilePath` rather than a `file://` template: a worktree path can
     * be a Windows one on a developer machine, and that template turns the
     * drive letter into a host.
     */
    /** `repo / ` before a worktree's name, when Orca knows more than one repository. */
    protected repositoryName(worktree: OrcaWorktree): string {
        const groups = this.groups();
        if (groups.length < 2) {
            return '';
        }
        const group = groups.find(g => g.worktrees.some(w => w.id === worktree.id));
        return group ? `${group.name} / ` : '';
    }

    protected openChange(change: OrcaWorktreeChange): void {
        void this.run(`Opening ${change.path}`, async () => {
            await open(this.openers, URI.fromFilePath(change.absolutePath));
        });
    }

    protected renderTerminals(): React.ReactNode {
        const selector = this.selectorFor(this.selected);
        return (
            <div className="studio-orca-section">
                <h3>Agents in this worktree ({this.terminals.length})</h3>
                {!selector && <p className="empty">Pick a worktree above.</p>}
                {selector && (
                    <>
                        <div className="studio-orca-form">
                            {this.agents().map(agent => (
                                <button
                                    key={agent}
                                    className="theia-button secondary"
                                    disabled={!!this.busy}
                                    onClick={() => this.startAgentHere(agent)}
                                >
                                    Start {agent}
                                </button>
                            ))}
                            {this.status?.agents && this.status.agents.length < ORCA_AGENTS.length && (
                                // Naming the absent ones beats leaving someone
                                // wondering why the panel offers fewer agents
                                // than the documentation does. "This image"
                                // only in a session: a desktop has none.
                                <span className="studio-orca-meta">
                                    {missingAgentsNote(
                                        this.status.host,
                                        ORCA_AGENTS.filter(a => !this.status?.agents?.includes(a))
                                    )}
                                </span>
                            )}
                        </div>
                        <input
                            className="theia-input"
                            placeholder="message to the agent (also used as the prompt when starting one)"
                            value={this.followUp}
                            disabled={!!this.busy}
                            onChange={e => {
                                this.followUp = e.target.value;
                                this.update();
                            }}
                        />
                    </>
                )}
                <ul className="studio-orca-list">
                    {this.terminals.map(terminal => (
                        <li key={terminal.handle}>
                            <span className="studio-orca-branch">
                                {terminal.agent ? `${terminal.agent} · ` : ''}
                                {terminal.title}
                            </span>
                            <span className="studio-orca-meta">
                                {terminal.connected ? 'connected' : 'detached'}
                                {terminal.lastOutputAt
                                    ? ` · last output ${new Date(terminal.lastOutputAt).toLocaleTimeString()}`
                                    : ''}
                            </span>
                            {terminal.preview && <code className="studio-orca-preview">{terminal.preview}</code>}
                            <span className="studio-orca-form">
                                <button
                                    className="theia-button"
                                    disabled={!!this.busy}
                                    title="Open the agent's terminal as a tab: all its output, live, and typing goes straight to it"
                                    onClick={() => this.openTerminal(terminal)}
                                >
                                    Open
                                </button>
                                <button
                                    className="theia-button secondary"
                                    disabled={!!this.busy || !this.followUp.trim()}
                                    onClick={() => this.sendFollowUp(terminal.handle)}
                                >
                                    Send
                                </button>
                                <button
                                    className="theia-button secondary"
                                    disabled={!!this.busy}
                                    onClick={() => this.waitForIdle(terminal.handle)}
                                >
                                    Wait for idle
                                </button>
                                <button
                                    className="theia-button secondary"
                                    disabled={!!this.busy}
                                    onClick={() => this.interrupt(terminal.handle)}
                                >
                                    Interrupt
                                </button>
                            </span>
                        </li>
                    ))}
                </ul>
            </div>
        );
    }
}
