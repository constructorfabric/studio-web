// The desktop Studio's updates (ADR-0027 phase 6): Help → Check for Updates,
// and the channel the member chose in Settings.
//
// The updater lives in the Electron main process (theia/electron-app/
// desktop-updater.js): it checks on start and every few hours, and asks once an
// update has downloaded. This is the one way the frontend reaches it — over
// Theia's electron IPC, so it exists only in the desktop app. A session's
// browser frontend never loads the module that asks.

export const desktopUpdatesPath = '/services/studio-desktop-updates';
/** DI key for the proxy on the frontend. */
export const DesktopUpdates = Symbol('DesktopUpdates');

/** What a check found, in terms the frontend turns into one sentence. */
export type UpdateCheck =
    /** This app is not updated in place: a checkout's `theia start`, an unpacked zip. */
    | { readonly state: 'unavailable' }
    | { readonly state: 'current'; readonly version: string; readonly channel: 'stable' | 'beta' }
    /** Found; it downloads now, and the restart question follows. */
    | { readonly state: 'downloading'; readonly version: string; readonly current: string }
    /** Found, by a build that does not update itself (an unsigned macOS app): the release page is offered. */
    | { readonly state: 'manual'; readonly version: string; readonly current: string }
    /** Already downloaded; the restart question has been asked again. */
    | { readonly state: 'ready'; readonly version: string }
    | { readonly state: 'failed'; readonly message: string };

/** Which updates the app takes: `auto` follows the installed version (betas for a beta). */
export type UpdateChannelChoice = 'auto' | 'stable' | 'beta';

export interface DesktopUpdates {
    check(): Promise<UpdateCheck>;
    /** Tell the updater the member's choice in Settings; it holds it until the next one. */
    setChannel(choice: UpdateChannelChoice): Promise<void>;
}

/** Where desktop-updater.js hands itself over in the main process. */
export const DESKTOP_UPDATER_GLOBAL = '__studioDesktopUpdater';

/** The sentence the member reads after a check. */
export function describeUpdateCheck(result: UpdateCheck): { level: 'info' | 'warn'; text: string } {
    switch (result.state) {
        case 'unavailable':
            return { level: 'info', text: 'This copy of Constructor Studio is not updated in place: updates come to an installed app.' };
        case 'current':
            return {
                level: 'info',
                text: `Constructor Studio ${result.version} is the latest${result.channel === 'beta' ? ', betas included' : ''}.`
            };
        case 'downloading':
            return {
                level: 'info',
                text: `Constructor Studio ${result.version} is available (you have ${result.current}). ` +
                    'It is downloading; you will be asked to restart when it is ready.'
            };
        case 'manual':
            return {
                level: 'info',
                text: `Constructor Studio ${result.version} is available (you have ${result.current}). ` +
                    'This copy does not update itself: download the new one from its release page.'
            };
        case 'ready':
            return { level: 'info', text: `Constructor Studio ${result.version} is downloaded and installs when you restart.` };
        case 'failed':
            return { level: 'warn', text: `Could not check for updates: ${result.message}` };
    }
}
