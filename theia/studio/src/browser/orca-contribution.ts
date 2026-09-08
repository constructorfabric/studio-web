// View contribution for the Orca agents panel (right area; View menu + command).

import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { Command } from '@theia/core';
import { OrcaWidget } from './orca-widget';

export const OrcaCommand: Command = {
    id: 'studio.orca.toggle',
    label: 'Agents (Orca)'
};

@injectable()
export class OrcaContribution extends AbstractViewContribution<OrcaWidget> {
    constructor() {
        super({
            widgetId: OrcaWidget.ID,
            widgetName: OrcaWidget.LABEL,
            // Right area next to Ask AI: both are "talk to something that works
            // on the project", and neither belongs in the editor area.
            defaultWidgetOptions: { area: 'right', rank: 250 },
            toggleCommandId: OrcaCommand.id
        });
    }
}
