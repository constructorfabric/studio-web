// Which update channel the desktop Studio follows -- the part of the updater
// that decides, apart from electron so a plain `node --test` covers it
// (desktop-update-channel.test.mjs).
//
// The member chooses in Settings: `studio.desktop.updateChannel`, a Theia
// preference that the desktop frontend reports to the main process over IPC
// (theia/studio/src/electron-browser/desktop-update-channel.ts), at start and
// on every change. The preference is the one place the choice lives; the main
// process only holds what it was last told.

/**
 * The electron-updater channel: `beta` when the member asked for pre-releases,
 * `latest` when they asked for releases only. Without a choice (`auto`, or
 * nothing reported yet) an installed pre-release follows betas -- whoever
 * installed 0.3.0-beta.1 wants 0.3.0-beta.2, not to wait for 0.3.0 -- and a
 * release follows releases.
 */
function channelFrom(chosen, currentVersion) {
    if (chosen === 'beta') {
        return 'beta';
    }
    if (chosen === 'stable') {
        return 'latest';
    }
    return String(currentVersion).includes('-') ? 'beta' : 'latest';
}

/**
 * What the frontend last reported. `reported` settles on the first report, so
 * the first check on start can wait for the member's choice rather than check
 * the wrong channel before the window has loaded.
 */
function channelChoice() {
    let chosen;
    let settle;
    const reported = new Promise(resolve => { settle = resolve; });
    return {
        reported,
        get: () => chosen,
        set(choice) {
            chosen = choice === 'beta' || choice === 'stable' ? choice : undefined;
            settle();
        },
    };
}

module.exports = { channelFrom, channelChoice };
