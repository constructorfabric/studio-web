// The session's modes, chosen by the person, each with its own ribbon.
//
// A Studio session is used by people doing different jobs on one project: the
// product manager writing and checking the specs, the architect composing the
// product out of gears, the developer building it, and whoever runs coding
// agents on it. Each job has a perspective already, but the perspective was a
// thing the portal switched to on the person's behalf, and a picker in View.
// Nothing on screen said which job the IDE was set up for, or how to change it.
//
// So the header says it, laid out as a ribbon: the first row is the menu and
// the modes as tabs, the second is the active mode's ribbon -- its commands in
// captioned groups, each a large button with its icon above its label, drawn
// from commands that already exist. The menu bar is narrowed to what the mode
// needs, the way Gearbox Studio's own shell policy narrows it: by an allow-list
// per mode, since a deny-list loses to every package that adds a menu.

import * as React from '@theia/core/shared/react';
import { environment } from '@theia/core/shared/@theia/application-package/lib/environment';
import { inject, injectable, optional, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { PerspectiveService } from '@theia/core/lib/browser/perspective-service';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { MessageService } from '@theia/core/lib/common/message-service';
import { ContextKeyService } from '@theia/core/lib/browser/context-key-service';
import { MAIN_MENU_BAR, MenuModelRegistry } from '@theia/core/lib/common/menu';
import { DOCUMENTS_PERSPECTIVE_ID, FULL_PERSPECTIVE_ID, ORCA_PERSPECTIVE_ID, WORKBENCH_PERSPECTIVE_ID } from '../common/studio-modes';
import type { StudioCliCommandId } from '../common/studio-cli-protocol';
import { badgeText, RibbonBadges } from './ribbon-badges';
import { STUDIO_CLI_LABELS } from '../common/studio-cli-report';

/** The Gearbox perspective's id, owned by `gearbox-studio`. Named here rather
 *  than imported so this package does not depend on that one. */
export const ARCHITECT_PERSPECTIVE_ID = 'gearbox.product';

export type StudioRole = 'docs' | 'building' | 'development' | 'orca' | 'full';

interface ModeAction {
    command: string;
    label: string;
    /** A codicon name, drawn above the label. */
    icon: string;
    title: string;
    /** Arguments the command is run with. */
    args?: unknown[];
}

/** The part of the command registry the ribbon reads. */
export interface RibbonCommands {
    getCommand(id: string): unknown;
    isEnabled(id: string, ...args: unknown[]): boolean;
    getAllHandlers(id: string): readonly object[];
}

/** How the ribbon draws one action; `undefined` when it is not drawn at all. */
export interface RibbonActionState {
    readonly enabled: boolean;
    /** The tooltip: what the action does, and why it cannot be done now. */
    readonly title: string;
}

/**
 * Whether, and how, an action is drawn.
 *
 * An action whose command is not registered (its package absent from this
 * build) is left out rather than drawn as a button that does nothing. One whose
 * command exists but is not enabled now -- Product with no product open -- is
 * drawn disabled, and says why when the contribution can say: a handler may
 * carry `disabledReason(...args)`, read here by duck typing because the
 * extension that registers it (gearbox-studio) is not a dependency of this one.
 * The ribbon used to draw it enabled and run it into Theia's "no active
 * handler" rejection, which nothing reported: the click did nothing at all.
 */
export function ribbonAction(commands: RibbonCommands, action: Pick<ModeAction, 'command' | 'title' | 'args'>): RibbonActionState | undefined {
    if (!commands.getCommand(action.command)) {
        return undefined;
    }
    const args = action.args ?? [];
    if (commands.isEnabled(action.command, ...args)) {
        return { enabled: true, title: action.title };
    }
    let reason: string | undefined;
    for (const handler of commands.getAllHandlers(action.command)) {
        const explain = (handler as { disabledReason?: unknown }).disabledReason;
        if (typeof explain === 'function') {
            const said: unknown = explain.apply(handler, args);
            if (typeof said === 'string' && said.trim() !== '') {
                reason = said.trim();
                break;
            }
        }
    }
    return { enabled: false, title: `${action.title} — ${reason ?? 'not available right now'}` };
}

interface ModeGroup {
    /** The caption under the group, as a ribbon names its groups. */
    label: string;
    actions: readonly ModeAction[];
}

interface Mode {
    role: StudioRole;
    label: string;
    /** A codicon name for the mode, in the picker. */
    icon: string;
    title: string;
    perspective: string;
    /** Top-level menus this mode keeps, by their label; `'*'` keeps all. */
    menus: readonly string[];
    groups: readonly ModeGroup[];
}

const AGENTS: ModeAction = { command: 'studio.orca.toggle', icon: 'sparkle', label: 'Agents', title: 'Coding agents, their worktrees and their terminals' };
// Toggle, not new: the terminal that is already open comes to the front, and a
// new one is opened only when there is none. `terminal:new` added a shell per
// press, and a session collected them in the bottom panel.
const TERMINAL: ModeAction = { command: 'workbench.action.terminal.toggleTerminal', icon: 'terminal', label: 'Terminal', title: 'Show the terminal, or open one' };
const CHANGES: ModeAction = { command: 'scmView:toggle', icon: 'source-control', label: 'Changes', title: 'What changed, and commit it' };
// The desktop's Push (desktop-git-contribution.ts), with the pull-request link
// the host prints. It named `studio.git-operations:toggle`, which nothing has
// registered since the Operations panel replaced Git Operations (#304), so it
// was never drawn. A session registers no Push: its pushes go through the
// operations queue, and the panel is View > Operations.
/**
 * Doc editing's way to the repository, for people who do not use git: the
 * edited documents, chosen and said in a sentence, sent in one step
 * (share/share-contribution.ts). It replaces Push in that mode — Share pushes,
 * and a second button doing half of it was one more thing to get wrong.
 */
const SHARE: ModeAction = { command: 'studio.share.open', icon: 'cloud-upload', label: 'Share', title: 'Send your edited documents to the team' };
const GIT_OPS: ModeAction = { command: 'studio.desktop.git:push', icon: 'repo-push', label: 'Push', title: 'Push the branch to its remote, and open its pull request' };

/**
 * The Constructor Studio CLI (`cfs`) on the open checkout
 * (studio-cli-contribution.ts). The four a person runs on a project; Initialize
 * and Version stay in the palette -- one is done once, the other asked rarely.
 */
function cliAction(command: StudioCliCommandId): ModeAction {
    const { label, icon, title } = STUDIO_CLI_LABELS[command];
    return { command: `studio.cli.${command}`, label, icon, title };
}
const CLI: ModeGroup = {
    label: 'CLI',
    actions: [cliAction('validate'), cliAction('doctor'), cliAction('info'), cliAction('generate-agents')],
};

/** The modes that are one kind of work each; Full functionality is all of them. */
const BY_WORK: readonly Mode[] = [
    {
        role: 'docs',
        icon: 'book',
        label: 'Doc editing',
        title: 'Write the specs and check them',
        perspective: DOCUMENTS_PERSPECTIVE_ID,
        menus: ['File', 'Edit', 'View', 'Help'],
        groups: [
            // Finding a document by what it says is how writing starts as often
            // as browsing is, so it sits in the ribbon. The product's Search
            // (product-ext): it reads comments, proposed changes and history as
            // well as the files. The rail's magnifier and Ctrl+Shift+F are
            // Theia's search across files, the same in every mode
            // (studio-mode-layout.ts, RAIL); this is the only way to the
            // product's, besides the palette.
            // The product's New document (product-ext): a Markdown file in the
            // open project, its name as its first heading.
            { label: 'Document', actions: [{ command: 'studio.document.new', icon: 'new-file', label: 'New document', title: 'A new document in the project that is open' }] },
            { label: 'Find', actions: [{ command: 'studio.search.open', icon: 'search', label: 'Search', title: 'Search the project: documents, comments, proposed changes and history' }] },
            {
                label: 'Specs',
                actions: [
                    { command: 'studio:analyze:open', icon: 'graph', label: 'Analyze', title: 'How the project\'s specs are doing: coverage, findings, trends' },
                    { command: 'studio.artifact-graph:toggle', icon: 'type-hierarchy', label: 'Traceability', title: 'The graph of what the specs reference and what references them' },
                    cliAction('validate'),
                ],
            },
            // A spec is finished when the team has it: the way there stays in
            // the mode where it is written.
            { label: 'Team', actions: [SHARE, { ...CHANGES, title: 'What changed in the documents, line by line' }] },
            // The assistants beside the document -- Claude Code or Codex, picked
            // by name (product-ext's `studio.assistants.pick`) -- not Orca's
            // agents in worktrees, which is Agent development's. A portal
            // session runs no Orca at all, so AGENTS here was a button onto a
            // runtime that is not there.
            { label: 'Assist', actions: [{ command: 'studio.assistants.pick', icon: 'sparkle', label: 'Agents', title: 'Ask Claude Code or Codex about the specs' }] },
        ],
    },
    {
        role: 'building',
        icon: 'circuit-board',
        label: 'Building',
        title: 'Compose the product out of gears, and generate it',
        perspective: ARCHITECT_PERSPECTIVE_ID,
        // 'Gearbox' is the label gearbox-studio gives its top-level menu
        // (`GEARBOX_MENU_LABEL`); the menu itself appears only with a product open.
        menus: ['File', 'Edit', 'Gearbox', 'View', 'Help'],
        groups: [
            {
                label: 'Product',
                actions: [
                    { command: 'gearbox.product.show', icon: 'package', label: 'Product', title: 'The product: composition, topology, validation' },
                    { command: 'gearbox.product.addGear', icon: 'add', label: 'Add gear', title: 'Put a gear from the catalogue into the product' },
                    // Writing a new gear is a different thing from putting one
                    // into the product, and it was only in File: "Add gear" was
                    // pressed for it.
                    { command: 'gearbox.gear.new', icon: 'new-file', label: 'New gear', title: 'Write a new gear: its gear.gdl and code, in a source of the corpus' },
                ],
            },
            {
                label: 'Corpus',
                actions: [{ command: 'gearbox.catalogue.browse', icon: 'library', label: 'Catalogue', title: 'Every gear the corpus describes' },
                    { command: 'studio.components-reference:toggle', icon: 'book', label: 'Components', title: 'Every component: what it is, how alive it is, where it comes from' },
                    { command: 'studio.roadmap-report:toggle', icon: 'milestone', label: 'Roadmap', title: 'What the roadmap board plans, whether the plan holds, and who is waiting' }],
            },
            {
                label: 'Check',
                actions: [
                    { command: 'gearbox.product.resolve', icon: 'sync', label: 'Resolve', title: 'Resolve the product again, for the profile shown' },
                    { command: 'gearbox.conflicts.show', icon: 'warning', label: 'Conflicts', title: 'What the engine says cannot resolve' },
                    { command: 'gearbox.lock.show', icon: 'lock', label: 'Lock', title: 'The resolution lock: what this resolution pins, and whether the copy on disk matches' },
                    { command: 'gearbox.generate.show', icon: 'run-all', label: 'Generate', title: 'Generate the product\'s code from its description' },
                ],
            },
        ],
    },
    {
        role: 'development',
        icon: 'code',
        label: 'Development',
        title: 'Write the code in the repositories',
        perspective: WORKBENCH_PERSPECTIVE_ID,
        menus: ['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal', 'Help'],
        groups: [
            {
                label: 'Repositories',
                actions: [
                    { command: 'studio.workspace-sources:toggle', icon: 'repo', label: 'Sources', title: 'The project\'s repositories in this session' },
                    { command: 'studio.workspace-sources:sync', icon: 'sync', label: 'Sync', title: 'Pull the repositories up to their remotes' },
                ],
            },
            { label: 'Git', actions: [CHANGES, GIT_OPS] },
            CLI,
            { label: 'Tools', actions: [TERMINAL, AGENTS] },
        ],
    },
    {
        role: 'orca',
        icon: 'hubot',
        label: 'Agent development',
        title: 'Run coding agents in their own worktrees and steer them',
        perspective: ORCA_PERSPECTIVE_ID,
        menus: ['File', 'Edit', 'View', 'Terminal', 'Help'],
        groups: [
            { label: 'Agents', actions: [AGENTS] },
            { label: 'Changes', actions: [{ ...CHANGES, title: 'What the agents changed, and commit it' }, GIT_OPS] },
            { label: 'Tools', actions: [TERMINAL] },
        ],
    },
];

/** Every mode's ribbon at once, each action once, in the modes' own order. */
function everyGroup(): ModeGroup[] {
    const seen = new Set<string>();
    const groups: ModeGroup[] = [];
    for (const mode of BY_WORK) {
        for (const group of mode.groups) {
            const actions = group.actions.filter((a) => !seen.has(a.command));
            actions.forEach((a) => seen.add(a.command));
            if (actions.length > 0) {
                groups.push({ label: group.label, actions });
            }
        }
    }
    return groups;
}

export const MODES: readonly Mode[] = [
    ...BY_WORK,
    {
        role: 'full',
        icon: 'zap',
        label: 'Full functionality',
        title: 'Everything at once: every view, the whole menu, every command in the ribbon',
        perspective: FULL_PERSPECTIVE_ID,
        menus: ['*'],
        groups: everyGroup(),
    },
];

export function roleOf(perspectiveId: string | undefined): StudioRole {
    return MODES.find((m) => m.perspective === perspectiveId)?.role ?? 'development';
}

/** The Development mode, which is what an unknown perspective reads as. */
function developer(): Mode {
    return MODES.find((m) => m.role === 'development') ?? MODES[0];
}

function modeFor(perspectiveId: string | undefined): Mode {
    const role = roleOf(perspectiveId);
    return MODES.find((m) => m.role === role) ?? developer();
}

/** Whether the mode of this perspective keeps the top-level menu labelled `label`. */
export function keepsMenu(perspectiveId: string | undefined, label: string): boolean {
    const allowed = modeFor(perspectiveId).menus;
    return allowed.includes('*') || allowed.includes(label);
}

/** A top-level menu as `emptyMenus` reads it: the part of Theia's menu node it needs. */
export interface TopMenuNode {
    readonly id: string;
    readonly label?: string;
    readonly children?: readonly unknown[];
    isEmpty?(path: string[], matcher: unknown, context: undefined): boolean;
}

/**
 * The labels of the top-level menus with nothing to show now: every entry's
 * `when` is false. Theia's menu bar draws such a menu anyway, and opening it
 * shows an empty box -- the Gearbox menu with no product open, whose entries
 * all wait for `gearbox.context == 'product'`.
 */
export function emptyMenus(menus: readonly TopMenuNode[], matcher: unknown): Set<string> {
    const empty = new Set<string>();
    for (const menu of menus) {
        if (menu.label && Array.isArray(menu.children) && typeof menu.isEmpty === 'function'
            && menu.isEmpty([...MAIN_MENU_BAR, menu.id], matcher, undefined)) {
            empty.add(menu.label);
        }
    }
    return empty;
}

/** What both halves of the header share: the active mode, kept current. */
@injectable()
abstract class ModeAware extends ReactWidget {
    @inject(PerspectiveService) @optional()
    protected readonly perspectives: PerspectiveService | undefined;

    @inject(CommandRegistry)
    protected readonly commands: CommandRegistry;

    protected readonly toDispose = new DisposableCollection();

    protected watchMode(): void {
        if (this.perspectives) {
            this.toDispose.push(this.perspectives.onDidChangePerspective(() => this.update()));
        }
        // A mode's actions are drawn only when their command exists, and most
        // are registered after this widget first renders -- in the desktop app
        // nothing else re-renders it, and its ribbon stayed empty.
        this.toDispose.push(this.commands.onCommandsChanged(() => this.update()));
        this.update();
    }

    @inject(ContextKeyService) @optional()
    protected readonly contextKeys: ContextKeyService | undefined;

    /**
     * Keep the actions' enabled state current. Theia has no event for "a
     * handler's `isEnabled` changed", so the ribbon asks again whenever it may
     * have: after any command ran (opening a product is one), when a context
     * key changes (Gearbox keeps its context -- a product or not -- in one), and
     * when the pointer or the keyboard reaches the ribbon, which is always
     * before a click.
     */
    protected watchEnablement(): void {
        this.toDispose.push(this.commands.onDidExecuteCommand(() => this.update()));
        if (this.contextKeys) {
            this.toDispose.push(this.contextKeys.onDidChange(() => this.update()));
        }
        const refresh = () => this.update();
        this.node.addEventListener('mouseenter', refresh);
        this.node.addEventListener('focusin', refresh);
        this.toDispose.push({
            dispose: () => {
                this.node.removeEventListener('mouseenter', refresh);
                this.node.removeEventListener('focusin', refresh);
            },
        });
    }

    override dispose(): void {
        this.toDispose.dispose();
        super.dispose();
    }

    protected get mode(): Mode {
        return modeFor(this.perspectives?.getActivePerspectiveId());
    }
}

/** The explicit choice of job: a picker first in the header, before the
 *  menu, because the mode decides what the menu and the ribbon offer. */
@injectable()
export class StudioModeSwitch extends ModeAware {
    static readonly ID = 'studio-mode-switch';

    protected open = false;
    protected readonly closeOnOutside = (event: MouseEvent) => {
        if (!this.node.contains(event.target as Node)) {
            this.setOpen(false);
        }
    };
    protected readonly closeOnEscape = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            this.setOpen(false);
        }
    };

    @postConstruct()
    protected init(): void {
        this.id = StudioModeSwitch.ID;
        this.addClass('studio-mode-switch-widget');
        this.watchMode();
        this.toDispose.push({
            dispose: () => {
                document.removeEventListener('mousedown', this.closeOnOutside, true);
                document.removeEventListener('keydown', this.closeOnEscape, true);
            },
        });
    }

    protected setOpen(open: boolean): void {
        if (this.open === open) {
            return;
        }
        this.open = open;
        if (open) {
            document.addEventListener('mousedown', this.closeOnOutside, true);
            document.addEventListener('keydown', this.closeOnEscape, true);
        } else {
            document.removeEventListener('mousedown', this.closeOnOutside, true);
            document.removeEventListener('keydown', this.closeOnEscape, true);
        }
        this.update();
    }

    protected switchTo(mode: Mode): void {
        this.setOpen(false);
        void this.perspectives?.switchPerspective(mode.perspective).catch((error) => {
            console.warn(`studio: could not switch to the ${mode.label} mode`, error);
        });
    }

    protected render(): React.ReactNode {
        const current = this.mode;
        // The list is placed with `fixed` from the button's own rectangle: the
        // top panel clips what overflows it, and the list has to drop over the
        // ribbon and the editor below.
        const rect = this.open ? this.node.getBoundingClientRect() : undefined;
        return (
            <div className="studio-mode-picker">
                <button
                    type="button"
                    className={this.open ? 'studio-mode-current open' : 'studio-mode-current'}
                    aria-haspopup="listbox"
                    aria-expanded={this.open}
                    title={`Mode: ${current.title}`}
                    onClick={() => this.setOpen(!this.open)}
                >
                    <span className={`codicon codicon-${current.icon}`} aria-hidden />
                    <span className="studio-mode-current-label">{current.label}</span>
                    <span className="codicon codicon-chevron-down" aria-hidden />
                </button>
                {this.open && rect && (
                    <div className="studio-mode-list" role="listbox" aria-label="Mode" style={{ left: rect.left, top: rect.bottom + 2 }}>
                        {MODES.map((m) => (
                            <button
                                key={m.role}
                                type="button"
                                role="option"
                                aria-selected={m.role === current.role}
                                className={m.role === current.role ? 'studio-mode-option on' : 'studio-mode-option'}
                                onClick={() => this.switchTo(m)}
                            >
                                <span className={`codicon codicon-${m.icon}`} aria-hidden />
                                <span className="studio-mode-option-text">
                                    <b>{m.label}</b>
                                    <span>{m.title}</span>
                                </span>
                                {m.role === current.role && <span className="codicon codicon-check" aria-hidden />}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        );
    }
}

/** The active mode's ribbon: its commands in captioned groups. */
@injectable()
export class StudioModeBar extends ModeAware {
    static readonly ID = 'studio-mode-bar';

    @inject(MessageService) @optional()
    protected readonly messages: MessageService | undefined;

    /** The numbers on the buttons: Share's documents not shared yet. */
    @inject(RibbonBadges) @optional()
    protected readonly badges: RibbonBadges | undefined;

    @postConstruct()
    protected init(): void {
        this.id = StudioModeBar.ID;
        this.addClass('studio-mode-bar');
        this.watchMode();
        this.watchEnablement();
        if (this.badges) {
            this.toDispose.push(this.badges.onDidChange(() => this.update()));
        }
    }

    /** Run an action, asking again first: the state drawn may be a moment old. */
    protected run(action: ModeAction): void {
        if (!ribbonAction(this.commands, action)?.enabled) {
            this.update();
            return;
        }
        this.commands.executeCommand(action.command, ...(action.args ?? [])).catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`studio: ${action.label} (${action.command}) failed`, error);
            this.messages?.warn(`${action.label}: ${reason}`);
        });
    }

    protected render(): React.ReactNode {
        const mode = this.mode;
        // Only what this session can run -- see `ribbonAction` -- and a group
        // left empty goes with its actions.
        const groups = mode.groups
            .map((g) => ({
                ...g,
                actions: g.actions.flatMap((action) => {
                    const state = ribbonAction(this.commands, action);
                    return state ? [{ action, state }] : [];
                }),
            }))
            .filter((g) => g.actions.length > 0);
        return (
            <div className="studio-ribbon" data-studio-role={mode.role}>
                {groups.map((g) => (
                    <div key={g.label} className="studio-ribbon-group" role="group" aria-label={g.label}>
                        <div className="studio-ribbon-actions">
                            {g.actions.map(({ action: a, state }) => {
                                const badge = badgeText(this.badges?.get(a.command));
                                return <button
                                    key={a.command}
                                    type="button"
                                    // `aria-disabled` rather than `disabled`: a disabled
                                    // button shows no tooltip in some engines, and the
                                    // tooltip is what says why.
                                    className={state.enabled ? 'studio-ribbon-action' : 'studio-ribbon-action disabled'}
                                    aria-disabled={state.enabled ? undefined : true}
                                    title={state.title}
                                    onClick={() => this.run(a)}
                                >
                                    <span className={`codicon codicon-${a.icon}`} aria-hidden />
                                    <span className="studio-ribbon-label">{a.label}</span>
                                    {badge && <span className="studio-ribbon-badge" aria-label={`${badge} waiting`}>{badge}</span>}
                                </button>;
                            })}
                        </div>
                        <div className="studio-ribbon-caption">{g.label}</div>
                    </div>
                ))}
            </div>
        );
    }
}

const STYLE_ID = 'studio-mode-bar-style';
const MODE_BAR_CSS = `
/* Two rows, as a ribbon: the menu and the modes as tabs, then the active
   mode's ribbon. Lumino sizes the panel from its min/max height, so both are
   set to the height of the two rows. */
#theia-top-panel {
    height: 100px !important; min-height: 100px; max-height: 100px;
    display: flex !important; flex-wrap: wrap; align-content: flex-start; align-items: stretch;
    column-gap: 0; row-gap: 0; padding: 0; box-sizing: border-box;
    background: var(--theia-titleBar-activeBackground, var(--theia-editor-background));
    border-bottom: 1px solid var(--theia-widget-border, var(--theia-editorGroup-border));
}
/* Everything in the row flows, except the desktop's window-drag layer, which
   Theia lays over the whole panel and must stay out of the flow: in flow it is
   a 95px block that pushes the menu, the modes and the window controls out of
   the panel. */
#theia-top-panel > *:not(#theia-drag-panel) { position: relative !important; }
/* Relative, not static: the drag layer is positioned, and a positioned box is
   painted over static ones, so with static children every click on the menu,
   the mode picker and the ribbon landed on the drag layer instead. Relative
   keeps them in the flow and puts them above it. */
/* The window's title: the header already names the app's mode and holds its
   menu, and Theia shows the title over the mode picker when it un-hides it. */
#theia-top-panel > #theia-custom-title { display: none !important; }
/* The desktop's minimise / maximise / close, at the end of the first row. */
#theia-top-panel > [id="window-controls"] { order: 2; height: 30px !important; align-self: flex-start; }
/* The window drags by the empty parts of the header, never by a control. */
#theia-top-panel .studio-mode-switch-widget, #theia-top-panel .studio-mode-bar,
#theia-top-panel [id="theia:menubar"], #theia-top-panel .studio-collab-strip { -webkit-app-region: no-drag; }
#theia-top-panel > .theia-icon { display: none !important; }
/* Row one: menu, tabs, collaboration. */
#theia-top-panel .studio-mode-switch-widget { order: 0; height: 30px !important; }
#theia-top-panel [id="theia:menubar"] { order: 1; }
/* Its own width, at the right end. Stretched over the free space it was
   no-drag everywhere, and the desktop window had nothing left to be dragged by:
   the gap between the menu and this line is where it drags now. */
#theia-top-panel .studio-collab-strip { order: 2; height: 30px !important; flex: 0 0 auto !important; margin-left: auto; display: flex; align-items: center; justify-content: flex-end; padding-right: 8px; }
/* The line break between the rows: a zero-height item a full row wide. */
#theia-top-panel::after { content: ''; order: 3; flex-basis: 100%; height: 0; }
/* Row two: the ribbon, full width. */
#theia-top-panel .studio-mode-bar { order: 4; flex: 1 1 100%; height: 69px !important; }

#theia-top-panel .lm-MenuBar { display: flex; align-items: center; }
#theia-top-panel .lm-MenuBar-item {
    font-size: 12px; padding: 0 8px; height: 30px; line-height: 30px;
    color: var(--theia-descriptionForeground, var(--theia-foreground));
}
#theia-top-panel .lm-MenuBar-item.lm-mod-active { color: var(--theia-foreground); background: var(--theia-toolbar-hoverBackground, var(--theia-list-hoverBackground)); }

/* The mode picker, first in the header: the current mode as a button that
   reads as a choice -- icon, name, chevron -- and the list of all of them. */
.studio-mode-switch-widget { flex: 0 0 auto; display: flex; align-items: center; padding: 0 4px 0 6px; }
.studio-mode-current {
    font: inherit; font-size: 12px; font-weight: 600; height: 24px; padding: 0 8px 0 7px;
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    border: 1px solid var(--theia-widget-border, var(--theia-editorGroup-border)); border-radius: 5px;
    background: var(--theia-editor-background); color: var(--theia-foreground);
}
.studio-mode-current .codicon { font-size: 14px; }
.studio-mode-current .codicon-chevron-down { font-size: 12px; opacity: .7; }
.studio-mode-current:hover, .studio-mode-current.open { border-color: var(--theia-focusBorder, var(--theia-button-background)); }
.studio-mode-list {
    position: fixed; z-index: 10000; min-width: 300px; padding: 4px;
    display: flex; flex-direction: column; gap: 1px;
    background: var(--theia-menu-background, var(--theia-editor-background)); color: var(--theia-menu-foreground, var(--theia-foreground));
    border: 1px solid var(--theia-menu-border, var(--theia-widget-border)); border-radius: 6px;
    box-shadow: 0 6px 20px rgba(0,0,0,.18);
}
.studio-mode-option {
    font: inherit; display: flex; align-items: flex-start; gap: 10px; padding: 7px 10px; text-align: left;
    border: none; border-radius: 4px; background: transparent; color: inherit; cursor: pointer;
}
.studio-mode-option > .codicon { font-size: 16px; margin-top: 1px; }
.studio-mode-option:hover { background: var(--theia-menu-selectionBackground, var(--theia-list-hoverBackground)); color: var(--theia-menu-selectionForeground, inherit); }
.studio-mode-option.on { background: var(--theia-list-activeSelectionBackground, var(--theia-list-hoverBackground)); }
.studio-mode-option-text { display: flex; flex-direction: column; gap: 1px; flex: 1; }
.studio-mode-option-text b { font-size: 12px; }
.studio-mode-option-text span { font-size: 11px; opacity: .75; }
.studio-mode-option .codicon-check { margin-left: auto; }
/* The menu follows the picker, set apart from it by a rule. */
#theia-top-panel [id="theia:menubar"] { border-left: 1px solid var(--theia-widget-border, var(--theia-editorGroup-border)); margin: 5px 0; height: 20px !important; padding-left: 4px; }
#theia-top-panel [id="theia:menubar"] .lm-MenuBar-item { height: 20px; line-height: 20px; font-size: 12px; border-radius: 3px; }

/* The ribbon. */
.studio-mode-bar { display: flex; align-items: stretch; min-width: 0; overflow: hidden;
    background: var(--theia-editor-background);
    border-top: 1px solid var(--theia-widget-border, var(--theia-editorGroup-border)); }
.studio-ribbon { display: flex; align-items: stretch; gap: 0; padding: 0 4px; min-width: 0; overflow-x: auto; }
.studio-ribbon-group {
    display: flex; flex-direction: column; justify-content: space-between; padding: 4px 6px 2px;
    border-right: 1px solid var(--theia-widget-border, var(--theia-editorGroup-border));
}
.studio-ribbon-actions { display: flex; align-items: flex-start; gap: 2px; }
.studio-ribbon-action {
    font: inherit; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: 3px;
    min-width: 56px; padding: 5px 6px 3px; border: 1px solid transparent; border-radius: 4px;
    background: transparent; color: var(--theia-foreground); cursor: pointer;
}
.studio-ribbon-action .codicon { font-size: 20px; line-height: 22px; }
.studio-ribbon-action { position: relative; }
/* How many wait behind the button, over its icon's corner, as an activity bar's badge. */
.studio-ribbon-badge {
    position: absolute; top: 1px; right: 8px; min-width: 16px; height: 16px; padding: 0 4px; box-sizing: border-box;
    border-radius: 8px; font-size: 10px; line-height: 16px; font-weight: 600; text-align: center;
    background: var(--theia-activityBarBadge-background, var(--theia-badge-background));
    color: var(--theia-activityBarBadge-foreground, var(--theia-badge-foreground));
}
.studio-ribbon-label { font-size: 11px; line-height: 13px; white-space: nowrap; }
.studio-ribbon-action.disabled { opacity: .45; cursor: default; }
.studio-ribbon-action:not(.disabled):hover { background: var(--theia-toolbar-hoverBackground, var(--theia-list-hoverBackground)); border-color: var(--theia-widget-border, var(--theia-editorGroup-border)); }
.studio-ribbon-caption {
    font-size: 10px; line-height: 14px; text-align: center; white-space: nowrap;
    color: var(--theia-descriptionForeground, var(--theia-foreground)); opacity: .85;
}
`;

interface TopPanel {
    readonly widgets: readonly { readonly id?: string }[];
    insertWidget(index: number, widget: unknown): void;
}

/**
 * Whether the person picks the mode, or something else picks it for them.
 *
 * On the desktop they pick it. In a session the web portal opens, the portal
 * does: it opens the IDE to do one thing -- edit a document, which is Doc
 * editing (`studio.openDocument` and `studio.openInEditor` already switch to
 * it, portal-bridge-contribution.ts) -- and a picker beside that offered modes
 * whose tools the session does not run (Building's Gearbox, Agent
 * development's Orca). The ribbon stays: it is the mode's tools, not the
 * choice of mode.
 */
export function offersModeSwitch(electron: boolean = environment.electron.is()): boolean {
    return electron;
}

/** Mounts the tabs and the ribbon in the top panel, and keeps the menu to the
 *  mode's allow-list as the perspective changes and as plugins add menus. */
@injectable()
export class StudioModeBarContribution implements FrontendApplicationContribution {
    @inject(StudioModeBar)
    protected readonly bar: StudioModeBar;

    @inject(StudioModeSwitch)
    protected readonly switcher: StudioModeSwitch;

    @inject(PerspectiveService) @optional()
    protected readonly perspectives: PerspectiveService | undefined;

    @inject(MenuModelRegistry) @optional()
    protected readonly menus: MenuModelRegistry | undefined;

    @inject(ContextKeyService) @optional()
    protected readonly contextKeys: ContextKeyService | undefined;

    protected readonly toDispose = new DisposableCollection();
    protected shell: FrontendApplication['shell'] | undefined;

    onStart(app: FrontendApplication): void {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = MODE_BAR_CSS;
        document.head.appendChild(style);
        this.toDispose.push({ dispose: () => style.remove() });
        this.shell = app.shell;
        if (offersModeSwitch()) {
            app.shell.addWidget(this.switcher, { area: 'top' });
        }
        app.shell.addWidget(this.bar, { area: 'top' });
    }

    onDidInitializeLayout(): void {
        this.order();
        const prune = () => this.pruneMenus();
        // Plugins contribute top-level menus after start, and the menu bar is
        // re-rendered when they do; the allow-list is applied again each time.
        // Only the menu bar's own children are watched, and at most once a
        // frame: the row also holds the collaboration strip, which repaints on
        // every heartbeat, and a header that re-ran on each of those would be
        // work the page does for nothing.
        let queued = false;
        const schedule = () => {
            if (queued) {
                return;
            }
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                prune();
            });
        };
        const observer = new MutationObserver(schedule);
        const watch = () => {
            const menu = document.querySelector('#theia-top-panel .lm-MenuBar-content');
            if (menu) {
                observer.observe(menu, { childList: true });
                return true;
            }
            return false;
        };
        if (!watch()) {
            // The menu bar mounts after layout on a slow start; look once more.
            setTimeout(() => {
                watch();
                this.order();
                schedule();
            }, 2000);
        }
        this.toDispose.push({ dispose: () => observer.disconnect() });
        if (this.perspectives) {
            this.toDispose.push(this.perspectives.onDidChangePerspective(schedule));
        }
        // A menu empties or fills as its entries' `when` changes: Gearbox's
        // when a product opens or closes.
        if (this.contextKeys) {
            this.toDispose.push(this.contextKeys.onDidChange(schedule));
        }
        schedule();
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    /** The menu first, then the tabs, then the rest; the ribbon last. The
     *  visual order is CSS's (`order`), this only keeps the DOM order close to
     *  it for keyboard focus. The menu bar is added by its own contribution,
     *  whose `onStart` may run before or after ours. */
    protected order(): void {
        const top = (this.shell as unknown as { topPanel?: TopPanel } | undefined)?.topPanel;
        if (!top) {
            return;
        }
        const menuIndex = top.widgets.findIndex((w) => w.id === 'theia:menubar');
        if (offersModeSwitch()) {
            top.insertWidget(menuIndex >= 0 ? menuIndex + 1 : 0, this.switcher);
        }
        top.insertWidget(top.widgets.length, this.bar);
    }

    protected pruneMenus(): void {
        const perspective = this.perspectives?.getActivePerspectiveId();
        const empty = this.menus && this.contextKeys
            ? emptyMenus((this.menus.getMenu(MAIN_MENU_BAR)?.children ?? []) as unknown as TopMenuNode[], this.contextKeys)
            : new Set<string>();
        document.querySelectorAll<HTMLElement>('#theia-top-panel .lm-MenuBar-item').forEach((item) => {
            const label = item.querySelector('.lm-MenuBar-itemLabel')?.textContent?.trim() ?? '';
            const display = keepsMenu(perspective, label) && !empty.has(label) ? '' : 'none';
            if (item.style.display !== display) {
                item.style.display = display;
            }
        });
    }
}
