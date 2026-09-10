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
import { injectable, inject } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { MessageService } from '@theia/core/lib/common/message-service';
// The precise module, not the `@theia/core/lib/browser` barrel: the barrel
// pulls common-frontend-contribution, which calls document.queryCommandSupported
// while loading and takes any jsdom-based test of this widget down with it.
import { OpenerService, open } from '@theia/core/lib/browser/opener-service';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import {
    ORCA_AGENTS,
    OrcaService,
    type OrcaRuntimeStatus,
    type OrcaTerminal,
    type OrcaWorktree,
    type OrcaWorktreeChange
} from '../common/orca-protocol';

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

    protected status: OrcaRuntimeStatus | undefined;
    protected worktrees: OrcaWorktree[] = [];
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
        void this.refresh();
    }

    // ── data ───────────────────────────────────────────────────────────────

    protected async refresh(): Promise<void> {
        await this.run('Refreshing', async () => {
            this.status = await this.orca.status();
            this.workspaceRoot = await this.resolveWorkspaceRoot();
            if (!this.status.reachable) {
                this.worktrees = [];
                this.terminals = [];
                return;
            }
            this.current = await this.orca.currentWorktree();
            this.worktrees = await this.orca.listWorktrees();
            // Default the selection to the worktree the IDE is open on, which
            // is what "work on this project" means from in here.
            if (!this.selected) {
                this.selected = this.current?.id ?? this.worktrees[0]?.id;
            }
            await this.loadSelection();
        });
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
            await this.orca.registerWorkspace(root);
            this.worktrees = await this.orca.listWorktrees();
            this.selected = this.worktrees.find(w => w.path === root)?.id ?? this.worktrees[0]?.id;
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
        return this.status?.agents?.length ? this.status.agents : ORCA_AGENTS;
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
        void this.run(`Creating ${name}`, async () => {
            const agent = this.agents().includes(this.taskAgent) ? this.taskAgent : this.agents()[0];
            const created = await this.orca.createTask({ name, agent, prompt });
            this.taskName = '';
            this.taskPrompt = '';
            this.messages.info(
                created
                    ? `Orca created ${created.branch} at ${created.path} and started ${this.taskAgent}.`
                    : 'Orca accepted the task.'
            );
            this.worktrees = await this.orca.listWorktrees();
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
            }
            await this.loadSelection();
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
        return (
            <div className="studio-orca-status">
                <span>
                    <strong>Orca runtime:</strong>{' '}
                    {status
                        ? status.reachable
                            ? `${status.state}${status.appVersion ? ` · ${status.appVersion}` : ''}` +
                              `${status.desktopRunning ? ' · desktop' : ' · headless'}`
                            : 'not reachable'
                        : '…'}
                </span>
                <button className="theia-button secondary" disabled={!!this.busy} onClick={() => void this.refresh()}>
                    {this.busy || 'Refresh'}
                </button>
                {status && !status.reachable && (
                    <p className="studio-orca-hint">
                        {status.cliMissing
                            // No binary: advising `orca serve` here sent people
                            // looking for a runtime to start in an image that
                            // never carried one.
                            ? 'This session image was built without the Orca runtime. Rebuild it with '
                            : 'Start one with '}
                        {status.cliMissing
                            ? <code>--build-arg STUDIO_ORCA_DEB_URL=…</code>
                            : <code>orca serve</code>}
                        {status.cliMissing
                            ? ', or point ORCA_CLI at a binary this container has.'
                            : ' (headless) or open the Orca desktop app.'}
                        {status.error ? ` Last error: ${status.error}` : ''}
                    </p>
                )}
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
        return (
            <div className="studio-orca-section">
                <h3>Worktrees ({this.worktrees.length})</h3>
                {this.worktrees.length === 0 && (
                    <>
                        <p className="empty">
                            The runtime knows no worktrees yet
                            {this.workspaceRoot ? ` — including ${this.workspaceRoot}, which is open here.` : '.'}
                        </p>
                        {this.workspaceRoot && (
                            <button
                                className="theia-button"
                                disabled={!!this.busy}
                                onClick={() => this.registerWorkspace()}
                            >
                                Register this workspace
                            </button>
                        )}
                    </>
                )}
                <ul className="studio-orca-list">
                    {this.worktrees.map(worktree => {
                        const isCurrent = worktree.id === this.current?.id;
                        return (
                            <li
                                key={worktree.id}
                                className={worktree.id === this.selected ? 'selected' : undefined}
                                onClick={() => {
                                    this.selected = worktree.id;
                                    void this.run('Loading', () => this.loadSelection());
                                }}
                            >
                                <span className="studio-orca-branch">{worktree.branch || worktree.displayName}</span>
                                <span className="studio-orca-meta">
                                    {worktree.status}
                                    {worktree.isMain ? ' · main' : ''}
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
                        {worktree.branch || worktree.displayName}
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
                                // than the documentation does.
                                <span className="studio-orca-meta">
                                    Not in this image:{' '}
                                    {ORCA_AGENTS.filter(a => !this.status?.agents?.includes(a)).join(', ')}
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
