// The desktop Studio's own piece of the Electron main process: the updater,
// reachable from the frontend for Help → Check for Updates and for the update
// channel chosen in Settings.

import { ContainerModule, injectable } from '@theia/core/shared/inversify';
import { RpcConnectionHandler } from '@theia/core/lib/common';
import { ElectronConnectionHandler } from '@theia/core/lib/electron-main/messaging/electron-connection-handler';
import {
    DESKTOP_UPDATER_GLOBAL, desktopUpdatesPath, type DesktopUpdates, type UpdateChannelChoice, type UpdateCheck
} from '../common/desktop-updates-protocol';

/** What desktop-updater.js exposes; absent where it did not start (not an installed app). */
interface DesktopUpdater {
    checkNow(): Promise<UpdateCheck>;
    /** Absent from an updater that predates the Settings choice. */
    setChannel?(choice: UpdateChannelChoice): void;
}

@injectable()
export class DesktopUpdatesMain implements DesktopUpdates {
    /** The updater, when this process has one; a seam for tests. */
    protected updater(): DesktopUpdater | undefined {
        return (globalThis as Record<string, unknown>)[DESKTOP_UPDATER_GLOBAL] as DesktopUpdater | undefined;
    }

    async check(): Promise<UpdateCheck> {
        const updater = this.updater();
        if (!updater) {
            return { state: 'unavailable' };
        }
        try {
            return await updater.checkNow();
        } catch (error) {
            return { state: 'failed', message: error instanceof Error ? error.message : String(error) };
        }
    }

    async setChannel(choice: UpdateChannelChoice): Promise<void> {
        // No updater (not an installed app): nothing follows a channel.
        this.updater()?.setChannel?.(choice);
    }
}

export default new ContainerModule(bind => {
    bind(DesktopUpdatesMain).toSelf().inSingletonScope();
    bind(ElectronConnectionHandler).toDynamicValue(ctx =>
        new RpcConnectionHandler(desktopUpdatesPath, () => ctx.container.get(DesktopUpdatesMain))
    ).inSingletonScope();
});
