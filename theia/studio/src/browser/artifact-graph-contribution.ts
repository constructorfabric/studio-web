import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser';
import { Command } from '@theia/core';
import { ArtifactGraphWidget } from './artifact-graph-widget';

export const ArtifactGraphCommand: Command = {
    id: 'studio.artifact-graph:toggle',
    label: 'Studio: Toggle Artifact Graph',
};

/**
 * View contribution for the Artifact Graph (ADR-0022 experiment). Registers the
 * toggle command `studio.artifact-graph:toggle`; the widget is opened on demand
 * from the command palette or via the portal bridge's `studio.openGraph`
 * message. Not auto-revealed on boot.
 */
@injectable()
export class ArtifactGraphContribution extends AbstractViewContribution<ArtifactGraphWidget> {
    constructor() {
        super({
            widgetId: ArtifactGraphWidget.ID,
            widgetName: ArtifactGraphWidget.LABEL,
            defaultWidgetOptions: { area: 'main' },
            toggleCommandId: ArtifactGraphCommand.id,
        });
    }
}
