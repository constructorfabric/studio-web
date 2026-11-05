// The Domain model view on the desktop: its command (Doc editing's ribbon,
// Specs > Domain model, and the palette), its place below the editor beside
// Analyze, and the bindings the desktop's frontend module calls.
//
// Bound only in electron-browser/studio-electron-frontend-module.ts: a
// session registers no `studio.domain-model:toggle`, so its ribbon leaves the
// button out (studio-mode-bar.tsx, `ribbonAction`) and the web is unchanged.

import { injectable, interfaces } from '@theia/core/shared/inversify';
import { AbstractViewContribution, bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager';
import { DesktopDomainModelClient } from './desktop-domain-model-client';
import { DesktopDomainModelController } from './desktop-domain-model-controller';
import { DesktopDomainModelWidget } from './desktop-domain-model-widget';
import '../../src/browser/desktop-domain-model.css';

/** The ribbon names this id (studio-mode-bar.tsx, Doc editing > Specs). */
export const DOMAIN_MODEL_TOGGLE_COMMAND_ID = 'studio.domain-model:toggle';

@injectable()
export class DesktopDomainModelContribution extends AbstractViewContribution<DesktopDomainModelWidget> {
    constructor() {
        super({
            widgetId: DesktopDomainModelWidget.ID,
            widgetName: DesktopDomainModelWidget.LABEL,
            defaultWidgetOptions: { area: 'bottom' },
            toggleCommandId: DOMAIN_MODEL_TOGGLE_COMMAND_ID,
        });
    }
}

export function bindDesktopDomainModel(bind: interfaces.Bind): void {
    bind(DesktopDomainModelClient).toSelf().inSingletonScope();
    bind(DesktopDomainModelController).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(DesktopDomainModelController);
    bind(DesktopDomainModelWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: DesktopDomainModelWidget.ID,
        createWidget: () => ctx.container.get(DesktopDomainModelWidget),
    })).inSingletonScope();
    bindViewContribution(bind, DesktopDomainModelContribution);
}
