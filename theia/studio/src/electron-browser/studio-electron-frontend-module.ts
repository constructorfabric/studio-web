// Frontend pieces that exist only in the desktop app: Theia loads this module
// for `electron-app` (the `frontendElectron` entry), never for a session's
// `browser-app`, so nothing here can reach the web.

import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { CommonMenus } from '@theia/core/lib/browser/common-menus';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { PreferenceContribution } from '@theia/core/lib/common/preferences/preference-schema';
import {
    CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry, MessageService, type Command
} from '@theia/core/lib/common';
import { ElectronIpcConnectionProvider } from '@theia/core/lib/electron-browser/messaging/electron-ipc-connection-source';
import { DesktopUpdates, describeUpdateCheck, desktopUpdatesPath } from '../common/desktop-updates-protocol';
import {
    CHECK_FOR_UPDATES_COMMAND_ID, DESKTOP_UPDATE_CHANNEL_PREFERENCE_SCHEMA, DesktopUpdateChannelContribution
} from './desktop-update-channel';
import { bindDesktopLanding } from '../browser/desktop-landing-contribution';
import { bindDesktopDomainModel } from '../browser/desktop-domain-model-contribution';
import { DesktopGitContribution, DesktopWorkspaceSourcesController } from '../browser/desktop-git-contribution';
import { DesktopSourcesWidget } from '../browser/desktop-sources-widget';
import { WorkspaceSourcesFrontendController } from '../browser/workspace-sources-controller';
import { WorkspaceSourcesWidget } from '../browser/workspace-sources-widget';

export const CheckForUpdatesCommand: Command = {
    id: CHECK_FOR_UPDATES_COMMAND_ID,
    category: 'Constructor Studio',
    label: 'Check for Updates…'
};

@injectable()
export class CheckForUpdatesContribution implements CommandContribution, MenuContribution {

    @inject(DesktopUpdates)
    protected readonly updates!: DesktopUpdates;

    @inject(MessageService)
    protected readonly messages!: MessageService;

    protected checking = false;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(CheckForUpdatesCommand, {
            isEnabled: () => !this.checking,
            execute: () => this.check()
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(CommonMenus.HELP, {
            commandId: CheckForUpdatesCommand.id,
            label: 'Check for Updates…',
            order: 'z1'
        });
    }

    async check(): Promise<void> {
        this.checking = true;
        try {
            const { level, text } = describeUpdateCheck(await this.updates.check());
            if (level === 'warn') {
                this.messages.warn(text);
            } else {
                this.messages.info(text);
            }
        } finally {
            this.checking = false;
        }
    }
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
    bind(DesktopUpdates).toDynamicValue(ctx =>
        ElectronIpcConnectionProvider.createProxy<DesktopUpdates>(ctx.container, desktopUpdatesPath)
    ).inSingletonScope();
    bind(CheckForUpdatesContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(CheckForUpdatesContribution);
    bind(MenuContribution).toService(CheckForUpdatesContribution);
    // Settings → Extensions → Studio → Desktop: Update Channel, which the updater follows.
    bind(PreferenceContribution).toConstantValue({ schema: DESKTOP_UPDATE_CHANNEL_PREFERENCE_SCHEMA });
    bind(DesktopUpdateChannelContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(DesktopUpdateChannelContribution);
    // The landing page while no Studio project is open, and the placeholder
    // folder's quiet (desktop-landing-contribution.ts).
    bindDesktopLanding(bind);
    // Git on the desktop (desktop-git-contribution.ts): the ribbon's Push, Sync
    // as fetch + fast-forward, and a Sources view of the project's clones in
    // place of the session's canonical-config editor. The controller and the
    // view are rebound, so everything that asks for them gets these; each falls
    // back to the session's behaviour when no Studio is configured.
    bind(DesktopGitContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(DesktopGitContribution);
    bind(FrontendApplicationContribution).toService(DesktopGitContribution);
    rebind(WorkspaceSourcesFrontendController).to(DesktopWorkspaceSourcesController).inSingletonScope();
    rebind(WorkspaceSourcesWidget).to(DesktopSourcesWidget);
    // The project's domain model beside the documents it is read from
    // (desktop-domain-model-contribution.ts): Doc editing's Specs > Domain
    // model, and its findings as Problems markers in those files.
    bindDesktopDomainModel(bind);
});
