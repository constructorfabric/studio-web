import 'reflect-metadata';
jest.mock('inversify', () => {
    const actual = jest.requireActual('inversify');
    return {
        ...actual,
        inject: () => () => undefined,
        injectable: () => <T>(target: T): T => target,
        named: () => () => undefined
    };
});
jest.mock('perfect-scrollbar', () => ({
    __esModule: true,
    default: class {
        update(): void {}
        destroy(): void {}
    }
}));
jest.mock('@theia/core/lib/browser/shell/view-contribution', () => ({
    AbstractViewContribution: class<T> {
        constructor(protected readonly options: { toggleCommandId?: string; widgetId: string; widgetName: string; defaultWidgetOptions: { area: string } }) {}
        async openView(): Promise<T> {
            return { id: this.options.widgetId } as T;
        }
        registerCommands(commands: { registerCommand: (command: { id: string }) => unknown }): void {
            if (this.options.toggleCommandId) {
                commands.registerCommand({ id: this.options.toggleCommandId });
            }
        }
        registerMenus(menus: { registerMenuAction: (path: readonly string[], item: { commandId: string }) => void }): void {
            if (this.options.toggleCommandId) {
                const { CommonMenus } = require('@theia/core/lib/browser/common-menus');
                menus.registerMenuAction(CommonMenus.VIEW_VIEWS, { commandId: this.options.toggleCommandId });
            }
        }
    }
}));
jest.mock('@theia/core/lib/browser/shell/application-shell', () => ({
    ApplicationShell: Symbol('ApplicationShell')
}));
jest.mock('@theia/core/lib/browser/shell/shell-layout-restorer', () => ({
    ShellLayoutRestorer: Symbol('ShellLayoutRestorer'),
    ApplicationShellLayoutMigrationError: { is: () => false }
}));
jest.mock('./studio-widget', () => ({
    StudioWidget: { ID: 'studio:widget', LABEL: 'Studio Widget' }
}));
jest.mock('./workspace-graph-widget', () => ({
    WorkspaceGraphWidget: { ID: 'studio:workspace-graph', LABEL: 'Workspace Graph' }
}));
jest.mock('./object-details-widget', () => ({
    ObjectDetailsWidget: { ID: 'studio:object-details', LABEL: 'Object Details' }
}));
jest.mock('./git-operations-widget', () => ({
    GitOperationsWidget: { ID: 'studio:git-operations', LABEL: 'Git Operations' }
}));
jest.mock('./analyze-widget', () => ({
    AnalyzeWidget: { ID: 'studio:analyze', LABEL: 'Analyze' }
}));
jest.mock('./audit-widget', () => ({
    AuditWidget: { ID: 'studio:audit', LABEL: 'Audit' },
    AUDIT_FILTERS: []
}));
jest.mock('./orca-widget', () => ({
    ORCA_WIDGET_ID: 'studio.orca',
    OrcaWidget: { ID: 'studio.orca', LABEL: 'Agents (Orca)' }
}));
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { CommonMenus } from '@theia/core/lib/browser/common-menus';
import { FrontendApplication } from '@theia/core/lib/browser/frontend-application';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { AuditCommand, AuditContribution } from './audit-contribution';
import { StudioContribution, StudioCommand } from './studio-contribution';
import { StudioWidget } from './studio-widget';
import { WorkspaceGraphWidget } from './workspace-graph-widget';
import { ObjectDetailsWidget } from './object-details-widget';
import { GitOperationsWidget } from './git-operations-widget';
import { AnalyzeWidget } from './analyze-widget';
import { AuditWidget } from './audit-widget';
import { OrcaWidget } from './orca-widget';

describe('StudioContribution', () => {
    it('initializes the default layout only through initializeLayout', async () => {
        const widgets = new Map([
            [StudioWidget.ID, { id: StudioWidget.ID, isAttached: false }],
            [WorkspaceGraphWidget.ID, { id: WorkspaceGraphWidget.ID, isAttached: false }],
            [ObjectDetailsWidget.ID, { id: ObjectDetailsWidget.ID, isAttached: false }],
            [GitOperationsWidget.ID, { id: GitOperationsWidget.ID, isAttached: false }],
            [AnalyzeWidget.ID, { id: AnalyzeWidget.ID, isAttached: false }],
            [AuditWidget.ID, { id: AuditWidget.ID, isAttached: false }],
            [OrcaWidget.ID, { id: OrcaWidget.ID, isAttached: false }]
        ]);
        const widgetManager = {
            getOrCreateWidget: jest.fn(async (id: string) => widgets.get(id))
        };
        const shell = {
            addWidget: jest.fn(async (widget: { isAttached: boolean }, _options: unknown) => {
                widget.isAttached = true;
            }),
            activateWidget: jest.fn()
        };
        const contribution = new StudioContribution(widgetManager as never);

        await contribution.initializeLayout({ shell } as never);

        expect(shell.addWidget).toHaveBeenCalledTimes(7);
        expect(shell.addWidget).toHaveBeenCalledWith(
            expect.objectContaining({ id: OrcaWidget.ID }),
            { area: 'right' }
        );
        // The Agents panel is revealed by activating it, and the graph is
        // activated last so the focus lands there rather than in Orca.
        expect(shell.activateWidget.mock.calls.map(([id]: [string]) => id))
            .toEqual([OrcaWidget.ID, WorkspaceGraphWidget.ID]);
    });

    it('does not compose the default layout when Theia restores a saved layout', async () => {
        const contribution = new StudioContribution({ getOrCreateWidget: jest.fn() } as never);
        const initializeLayout = jest.spyOn(contribution, 'initializeLayout');
        const application = new TestFrontendApplication(
            async () => true,
            [contribution],
            { pendingUpdates: Promise.resolve() }
        );

        await application.runInitializeLayout();

        expect(initializeLayout).not.toHaveBeenCalled();
    });

    it('composes the default layout when Theia has no saved layout', async () => {
        const contribution = new StudioContribution({
            getOrCreateWidget: jest.fn(async (id: string) => ({ id, isAttached: false }))
        } as never);
        const shell = {
            addWidget: jest.fn(async (widget: { isAttached: boolean }) => {
                widget.isAttached = true;
            }),
            activateWidget: jest.fn(),
            pendingUpdates: Promise.resolve()
        };
        const application = new TestFrontendApplication(
            async () => false,
            [contribution],
            shell
        );

        await application.runInitializeLayout();

        expect(shell.addWidget).toHaveBeenCalledTimes(7);
        expect(shell.activateWidget).toHaveBeenCalledWith(OrcaWidget.ID);
        expect(shell.activateWidget).toHaveBeenCalledWith(WorkspaceGraphWidget.ID);
    });

    it('registers exactly one Studio toggle command and one View menu entry', () => {
        const commands = createRecordingCommandRegistry();
        const menus = new RecordingMenuRegistry();
        const contribution = new StudioContribution({ getOrCreateWidget: jest.fn() } as never);

        contribution.registerCommands(commands as never);
        contribution.registerMenus(menus as never);

        expect(commands.getCommand(StudioCommand.id)).toMatchObject({ id: StudioCommand.id });
        expect(menus.actionsFor(CommonMenus.VIEW_VIEWS, StudioCommand.id)).toHaveLength(1);
    });

    it('registers exactly one Audit toggle command and one View menu entry', () => {
        const commands = createRecordingCommandRegistry();
        const menus = new RecordingMenuRegistry();
        const contribution = new AuditContribution();

        contribution.registerCommands(commands as never);
        contribution.registerMenus(menus as never);

        expect(commands.getCommand(AuditCommand.id)).toMatchObject({ id: AuditCommand.id });
        expect(menus.actionsFor(CommonMenus.VIEW_VIEWS, AuditCommand.id)).toHaveLength(1);
    });

    it('uses Theia theme variables and focus-visible rules in the stylesheet', () => {
        const cssPath = path.resolve(__dirname, 'style/index.css');
        const css = fs.readFileSync(cssPath, 'utf8');

        expect(css).toContain('var(--theia-focusBorder)');
        expect(css).toContain('var(--theia-editorWidget-background)');
        expect(css).toContain('.studio-audit__filter:focus-visible');
        expect(css).toContain('.studio-status-badge--blocked');
        expect(css).toContain('.studio-status-badge--pending');
    });
});

class TestFrontendApplication extends FrontendApplication {
    constructor(
        restoreLayout: () => Promise<boolean>,
        contributions: FrontendApplicationContribution[],
        shell: { pendingUpdates: Promise<void> }
    ) {
        super(
            {} as never,
            {} as never,
            {} as never,
            { restoreLayout } as never,
            { getContributions: () => contributions } as never,
            shell as never,
            {} as never
        );
    }

    async runInitializeLayout(): Promise<void> {
        await this.initializeLayout();
    }

    protected override async measureContribution<T>(
        _contribution: FrontendApplicationContribution,
        _hook: string,
        fn: () => T | PromiseLike<T>
    ): Promise<T> {
        return fn();
    }
}

class RecordingMenuRegistry {
    protected readonly actions: Array<{ path: readonly string[]; commandId: string }> = [];

    registerMenuAction(path: readonly string[], item: { commandId: string }): void {
        this.actions.push({ path, commandId: item.commandId });
    }

    actionsFor(path: readonly string[], commandId: string): Array<{ path: readonly string[]; commandId: string }> {
        return this.actions.filter(action => samePath(action.path, path) && action.commandId === commandId);
    }
}

function createRecordingCommandRegistry(): Pick<CommandRegistry, 'registerCommand' | 'getCommand'> {
    const commands = new Map<string, { id: string }>();
    return {
        registerCommand(command: { id: string }) {
            commands.set(command.id, command);
            return { dispose() {} };
        },
        getCommand(id: string): { id: string } | undefined {
            return commands.get(id);
        }
    };
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
