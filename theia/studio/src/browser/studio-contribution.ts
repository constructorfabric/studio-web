import { inject, injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import type { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import type { FrontendApplication } from '@theia/core/lib/browser/frontend-application';
import type { OpenViewArguments } from '@theia/core/lib/browser';
import { Command } from '@theia/core';
import { WidgetManager } from '@theia/core/lib/browser/widget-manager';
import { StudioWidget } from './studio-widget';
import { GitOperationsWidget } from './git-operations-widget';
import { WorkspaceGraphWidget } from './workspace-graph-widget';
import { ObjectDetailsWidget } from './object-details-widget';
import { AnalyzeWidget } from './analyze-widget';
import { AuditWidget } from './audit-widget';
import { OrcaWidget } from './orca-widget';

export const StudioCommand: Command = { id: 'studio:command' };

const DEFAULT_LAYOUT: ReadonlyArray<{ id: string; area: 'left' | 'main' | 'right' | 'bottom' }> = [
    { id: StudioWidget.ID, area: 'left' },
    { id: WorkspaceGraphWidget.ID, area: 'main' },
    { id: ObjectDetailsWidget.ID, area: 'right' },
    { id: OrcaWidget.ID, area: 'right' },
    { id: GitOperationsWidget.ID, area: 'bottom' },
    { id: AnalyzeWidget.ID, area: 'bottom' },
    { id: AuditWidget.ID, area: 'bottom' }
] as const;

@injectable()
export class StudioContribution extends AbstractViewContribution<StudioWidget> implements FrontendApplicationContribution {
    constructor(
        @inject(WidgetManager) protected readonly widgetManager: WidgetManager
    ) {
        super({
            widgetId: StudioWidget.ID,
            widgetName: StudioWidget.LABEL,
            defaultWidgetOptions: { area: 'left' },
            toggleCommandId: StudioCommand.id
        });
    }

    async initializeLayout(app: FrontendApplication): Promise<void> {
        for (const placement of DEFAULT_LAYOUT) {
            const widget = await this.widgetManager.getOrCreateWidget(placement.id);
            if (widget.isAttached) {
                continue;
            }
            await app.shell.addWidget(widget, { area: placement.area });
        }
        // Adding a widget to a side area only puts it in that area's tab bar;
        // the panel stays collapsed until something activates it, which is how
        // the Agents panel came out invisible on a fresh session. Activating it
        // expands the right panel, and the graph is activated afterwards so
        // that it, not Orca, ends up with the focus.
        await app.shell.activateWidget(OrcaWidget.ID);
        await app.shell.activateWidget(WorkspaceGraphWidget.ID);
    }
    override async openView(args: Partial<OpenViewArguments> = {}): Promise<StudioWidget> {
        return super.openView({ activate: false, reveal: true, ...args });
    }
}
