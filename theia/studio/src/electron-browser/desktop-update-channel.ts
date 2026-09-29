// Which updates the desktop Studio takes, as a Theia preference: Settings →
// Extensions → Studio → Desktop: Update Channel (`studio.desktop.updateChannel`).
//
// The preference is the one place the choice lives. This contribution reports
// it to the updater in the Electron main process (theia/electron-app/
// desktop-updater.js) over the DesktopUpdates IPC, at start and on every
// change; the updater holds what it was last told.
//
// Before the preference, the Studio view kept the choice as `updates` in
// ~/ConstructorStudio/settings.json. On start it is copied into the preference
// -- unless the member has set the preference already -- and removed from the
// file, so nobody's choice is lost and nothing is left to disagree.
//
// Registered only by the electron frontend module: a session's browser
// frontend never has this preference, nor anything that reads it.

import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { Endpoint } from '@theia/core/lib/browser/endpoint';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { PreferenceScope } from '@theia/core/lib/common/preferences/preference-scope';
import type { PreferenceSchema } from '@theia/core/lib/common/preferences/preference-schema';
import { DesktopUpdates, type UpdateChannelChoice } from '../common/desktop-updates-protocol';

export const DESKTOP_UPDATE_CHANNEL_PREFERENCE = 'studio.desktop.updateChannel';

/** Registered by `CheckForUpdatesContribution`; named here so Settings can link to it. */
export const CHECK_FOR_UPDATES_COMMAND_ID = 'studio.desktop.checkForUpdates';

export const DESKTOP_UPDATE_CHANNEL_PREFERENCE_SCHEMA: PreferenceSchema = {
    properties: {
        [DESKTOP_UPDATE_CHANNEL_PREFERENCE]: {
            type: 'string',
            enum: ['auto', 'stable', 'beta'],
            enumDescriptions: [
                'Follow the installed version: beta versions for a beta, releases for a release.',
                'Releases only.',
                'Beta versions too: they come out before a release, to try what is next.'
            ],
            default: 'auto',
            // The app's own choice, not a project's: no workspace or folder value.
            scope: PreferenceScope.User,
            description:
                'Which updates the Constructor Studio app takes. The app checks on start and every few hours, ' +
                'and offers each update once it has downloaded. Help → Check for Updates checks now.',
            markdownDescription:
                'Which updates the Constructor Studio app takes. The app checks on start and every few hours, ' +
                'and offers each update once it has downloaded. **Help → Check for Updates** checks now: ' +
                `[Check for Updates](command:${CHECK_FOR_UPDATES_COMMAND_ID}).`
        }
    }
};

/** The preference's value, whatever the settings file holds. */
export function readUpdateChannel(value: unknown): UpdateChannelChoice {
    return value === 'stable' || value === 'beta' ? value : 'auto';
}

/**
 * What to do with the channel the Studio view kept: copy it into the
 * preference unless the member has set the preference themselves (theirs is
 * newer), and remove it from the old file once there is nothing to copy.
 */
export function migrateLegacyChannel(
    legacy: 'stable' | 'beta' | null | undefined,
    userValue: unknown
): { readonly set?: 'stable' | 'beta'; readonly clear: boolean } {
    if (!legacy) {
        return { clear: false };
    }
    return userValue === undefined ? { set: legacy, clear: true } : { clear: true };
}

function updatesUrl(): string {
    return new Endpoint({ path: 'studio-desktop/updates' }).getRestUrl().toString();
}

@injectable()
export class DesktopUpdateChannelContribution implements FrontendApplicationContribution {

    @inject(PreferenceService)
    protected readonly preferences!: PreferenceService;

    @inject(DesktopUpdates)
    protected readonly updates!: DesktopUpdates;

    protected readonly toDispose = new DisposableCollection();

    onStart(): void {
        void this.start();
    }

    onStop(): void {
        this.toDispose.dispose();
    }

    protected async start(): Promise<void> {
        await this.preferences.ready;
        await this.migrate();
        this.toDispose.push(this.preferences.onPreferenceChanged(change => {
            if (change.preferenceName === DESKTOP_UPDATE_CHANNEL_PREFERENCE) {
                void this.report();
            }
        }));
        await this.report();
    }

    /** The member's choice, as the updater should follow it. */
    channel(): UpdateChannelChoice {
        return readUpdateChannel(this.preferences.get(DESKTOP_UPDATE_CHANNEL_PREFERENCE));
    }

    protected async report(): Promise<void> {
        try {
            await this.updates.setChannel(this.channel());
        } catch (error) {
            console.warn(`[studio-desktop] the update channel could not reach the updater: ${error}`);
        }
    }

    /** Move the Studio view's old choice into the preference, once. */
    protected async migrate(): Promise<void> {
        let legacy: 'stable' | 'beta' | null | undefined;
        try {
            // Absent (404) where no Studio is configured: nothing was kept there.
            const answer = await fetch(updatesUrl());
            legacy = answer.ok ? (await answer.json() as { channel?: 'stable' | 'beta' | null }).channel : undefined;
        } catch {
            return;
        }
        const userValue = this.preferences.inspect(DESKTOP_UPDATE_CHANNEL_PREFERENCE)?.globalValue;
        const { set, clear } = migrateLegacyChannel(legacy, userValue);
        try {
            if (set) {
                await this.preferences.set(DESKTOP_UPDATE_CHANNEL_PREFERENCE, set, PreferenceScope.User);
            }
            if (clear) {
                await fetch(updatesUrl(), { method: 'DELETE' });
            }
        } catch (error) {
            // Kept in the old file: the next start tries again.
            console.warn(`[studio-desktop] the update channel could not be moved to Settings: ${error}`);
        }
    }
}
