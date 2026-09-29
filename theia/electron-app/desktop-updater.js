// Updates for the PACKAGED desktop Studio (ADR-0027 phase 6).
//
// Where they come from: one rolling GitHub release, `desktop-updates`, that
// every desktop release refreshes with its installer and the channel files
// electron-builder writes -- `latest.yml` for a release, `beta.yml` for a
// pre-release and a release alike. A rolling release rather than GitHub's
// "latest": this repository also publishes the product (`v*`) and its
// infrastructure (`infra-v*`), and the newest of those is not a desktop.
// The address is the updater's `generic` feed, written by `scripts/package.mjs`
// into the app's `app-update.yml`.
//
// What a member sees: nothing, until an update has downloaded; then one
// question -- restart now, later, or read what changed. "Later" installs it
// when the app next quits. No update is ever forced. Help → Check for Updates
// checks now and says what it found (theia/studio/src/electron-main): the
// updater hands itself over as `globalThis.__studioDesktopUpdater`, since the
// Theia electron-main modules are bundled apart from this file.
//
// Which channel: what the member chose in Settings (`studio.desktop.updateChannel`),
// which the desktop frontend reports here over IPC at start and on every
// change, so the choice takes effect without a restart. The first check on
// start waits for that report. See desktop-update-channel.js.
//
// Bundled into one file by `scripts/package.mjs` (esbuild), because the
// packaged app ships without node_modules.

const { app, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { channelFrom, channelChoice } = require('./desktop-update-channel.js');

const RELEASES = 'https://github.com/constructorfabric/studio-web/releases/tag';
const FIRST_CHECK_MS = 10_000;
/** How long the first check waits for the window to report the member's channel. */
const CHANNEL_WAIT_MS = 60_000;
const EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Start checking for updates. Only in an installed app: a checkout's
 * `theia start` and an unpacked zip have nothing to update in place.
 */
function startUpdates({ log = console } = {}) {
    if (!app.isPackaged || process.env.STUDIO_DESKTOP_NO_UPDATES === '1') {
        return;
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // A beta member moving back to stable keeps what they have until stable
    // passes it, rather than being walked back to an older version.
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = {
        info: m => log.info(`[studio-desktop] update: ${m}`),
        warn: m => log.warn(`[studio-desktop] update: ${m}`),
        error: m => log.error(`[studio-desktop] update: ${m}`),
        debug: () => undefined,
    };

    let asked = false;
    /** The update that has downloaded, once one has: the restart question is about it. */
    let downloaded;
    const offer = async info => {
        const { response } = await dialog.showMessageBox({
            type: 'info',
            title: 'Constructor Studio update',
            message: `Constructor Studio ${info.version} is available`,
            detail: `You have ${app.getVersion()}. It is downloaded and installs when you restart, `
                + 'or the next time you quit the app.',
            buttons: ['Restart and update', 'Later', 'What\'s new'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
        });
        if (response === 0) {
            autoUpdater.quitAndInstall();
        } else if (response === 2) {
            void shell.openExternal(`${RELEASES}/desktop-v${info.version}`);
        }
    };
    autoUpdater.on('update-downloaded', async info => {
        downloaded = info;
        // Asked once on its own; Check for Updates asks again.
        if (asked) {
            return;
        }
        asked = true;
        await offer(info);
    });
    autoUpdater.on('error', error => {
        // Offline, rate-limited, or a release in the middle of being uploaded:
        // the next check tries again, and the member is not told about any of it.
        log.warn(`[studio-desktop] update check failed: ${error instanceof Error ? error.message : error}`);
    });

    const choice = channelChoice();
    const check = () => {
        const channel = channelFrom(choice.get(), app.getVersion());
        autoUpdater.channel = channel;
        autoUpdater.allowPrerelease = channel === 'beta';
        return autoUpdater.checkForUpdates();
    };

    /**
     * Check now, for Help → Check for Updates, and say what was found. A found
     * update downloads as on any check, and the restart question follows it.
     */
    globalThis.__studioDesktopUpdater = {
        /** The member's choice in Settings: `auto`, `stable` or `beta`. */
        setChannel(chosen) {
            choice.set(chosen);
        },
        async checkNow() {
            const current = app.getVersion();
            if (downloaded) {
                void offer(downloaded);
                return { state: 'ready', version: downloaded.version };
            }
            const channel = channelFrom(choice.get(), current) === 'beta' ? 'beta' : 'stable';
            try {
                const result = await check();
                const version = result?.updateInfo?.version;
                return result?.isUpdateAvailable && version
                    ? { state: 'downloading', version, current }
                    : { state: 'current', version: current, channel };
            } catch (error) {
                return { state: 'failed', message: error instanceof Error ? error.message : String(error) };
            }
        },
    };
    app.whenReady().then(() => {
        const quietly = () => check().catch(() => undefined);
        const waitForChannel = new Promise(resolve => setTimeout(resolve, CHANNEL_WAIT_MS));
        setTimeout(() => void Promise.race([choice.reported, waitForChannel]).then(quietly), FIRST_CHECK_MS);
        setInterval(quietly, EVERY_MS).unref?.();
    });
}

module.exports = { startUpdates };
