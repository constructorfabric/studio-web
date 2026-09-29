import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution, type OpenViewArguments } from '@theia/core/lib/browser';
import { Command } from '@theia/core';
import { ComponentsReferenceWidget } from './components-reference-widget';

export const ComponentsReferenceCommand: Command = {
    id: 'studio.components-reference:toggle',
    label: 'Studio: Components Reference',
};

/**
 * Opens the components reference in the main area: from the Building ribbon's
 * Corpus group, the View menu, or the command palette.
 */
@injectable()
export class ComponentsReferenceContribution extends AbstractViewContribution<ComponentsReferenceWidget> {
    constructor() {
        super({
            widgetId: ComponentsReferenceWidget.ID,
            widgetName: ComponentsReferenceWidget.LABEL,
            defaultWidgetOptions: { area: 'main' },
            toggleCommandId: ComponentsReferenceCommand.id,
        });
    }

    override async openView(args: Partial<OpenViewArguments> = {}): Promise<ComponentsReferenceWidget> {
        return super.openView({ ...args, activate: true, reveal: true });
    }
}
