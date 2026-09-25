import 'reflect-metadata';
jest.mock('@theia/editor/lib/browser/editor-manager', () => ({
    EditorManager: class EditorManager {}
}));
// The controller places files through the workspace, whose service reads the
// application config at import; none of that is under test here.
jest.mock('@theia/workspace/lib/browser/workspace-service', () => ({
    WorkspaceService: class WorkspaceService {}
}));

class MockAbstractViewContribution<T> {
    protected readonly singletonWidget: T;

    constructor(protected readonly options: { widgetId: string; widgetName: string; defaultWidgetOptions: { area: string } }) {
        this.singletonWidget = { id: options.widgetId } as T;
    }

    get viewId(): string {
        return this.options.widgetId;
    }

    get defaultViewOptions(): { area: string } {
        return this.options.defaultWidgetOptions;
    }

    async openView(): Promise<T> {
        return this.singletonWidget;
    }

    registerCommands(): void {}
}

jest.mock('@theia/core/lib/browser', () => ({
    AbstractViewContribution: MockAbstractViewContribution
}));
jest.mock('@theia/core/lib/browser/shell/view-contribution', () => ({
    AbstractViewContribution: MockAbstractViewContribution
}));

import { AnalyzeCommand, AnalyzeContribution } from './analyze-contribution';

describe('AnalyzeContribution', () => {
    it('uses one widget id and opens the Analyze view in the bottom area by default', () => {
        const contribution = new AnalyzeContribution();

        expect(contribution.viewId).toBe('studio:analyze');
        expect(contribution.defaultViewOptions.area).toBe('bottom');
    });

    it('registers a command that reopens the same widget instance instead of creating a second one', async () => {
        const contribution = new AnalyzeContribution();
        const openView = jest.spyOn(contribution, 'openView');
        const commands = {
            registerCommand: jest.fn()
        };

        contribution.registerCommands(commands as never);
        const [, handler] = commands.registerCommand.mock.calls.find(([command]) => command.id === AnalyzeCommand.id) ?? [];

        const firstWidget = await handler.execute();
        const secondWidget = await handler.execute();

        expect(openView).toHaveBeenNthCalledWith(1, { activate: false, reveal: true });
        expect(openView).toHaveBeenNthCalledWith(2, { activate: false, reveal: true });
        expect(firstWidget).toBe(secondWidget);
    });

    it('does not auto-open the Analyze view during frontend startup', async () => {
        const contribution = new AnalyzeContribution() as AnalyzeContribution & { onStart?: () => Promise<void> | void };
        const openView = jest.spyOn(contribution, 'openView');

        await contribution.onStart?.();

        expect(openView).not.toHaveBeenCalled();
    });
});
