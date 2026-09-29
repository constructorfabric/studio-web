// Entry point of the PACKAGED desktop Studio (ADR-0027). `scripts/package.mjs`
// makes it the app's `main`; `theia start` in a checkout never loads it.
//
// A developer's `theia start` gets its settings from the command line and the
// shell: which Studio to sign in to, where the plugins are, where to keep the
// workspace. An installed app has neither, so this fills them in before
// Theia's own electron main starts the backend, which inherits the
// environment. Anything already set in the environment wins, so one build can
// still be pointed at another Studio for a test.

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Written by the packaging script: the Studios this build offers and the one
 * it starts with. The member's own choice, made in the Studio view, is kept
 * elsewhere (~/ConstructorStudio/settings.json) and wins over the default.
 */
function preset() {
    try {
        return JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'studio-desktop.json'), 'utf8'));
    } catch {
        return {};
    }
}

/** `resources/bin/gearbox[.exe]`, where scripts/package.mjs puts it; absent from a build without one. */
function shippedEngine() {
    const file = path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'gearbox.exe' : 'gearbox');
    return fs.existsSync(file) ? file : undefined;
}

const home = path.join(os.homedir(), 'ConstructorStudio');
const workspace = path.join(home, 'workspace');
const data = path.join(home, 'data');
const { environments, defaultEnvironment } = preset();

/*
 * Claude Code and Codex (#480). The installer carries a manifest of the pinned
 * builds, not the builds: the studio extension fetches each one into
 * ~/ConstructorStudio/plugins/<id>-<version>/ on first need and deploys it
 * live (studio/src/node/desktop-assistants.ts). A copy fetched on an earlier
 * run loads at start like a built-in plugin: its folder is a plugin source.
 * Only the pinned version's folder is, so an older one left behind by an
 * update never loads.
 */
const assistantsManifest = path.join(process.resourcesPath, 'assistants.json');
const plugins = process.env.STUDIO_DESKTOP_PLUGINS || path.join(home, 'plugins');

function fetchedAssistants() {
    let pins;
    try {
        pins = JSON.parse(fs.readFileSync(assistantsManifest, 'utf8')).assistants;
    } catch {
        return [];
    }
    return (Array.isArray(pins) ? pins : [])
        .filter(pin => typeof pin?.id === 'string' && typeof pin?.version === 'string')
        .map(pin => ({ id: pin.id.toLowerCase(), folder: path.join(plugins, `${pin.id.toLowerCase()}-${pin.version}`) }))
        .filter(({ id, folder }) => fs.existsSync(path.join(folder, id, 'extension', 'package.json')))
        .map(({ folder }) => `local-dir:${folder}`);
}

/*
 * The Constructor Studio CLI (theia/studio-cli) arrives the same way, as one
 * more pin of that manifest. The studio extension runs `cfs` from the runtime
 * the pin unpacks into, once it is there (studio/src/node/cfs-command.ts), so
 * the folder is named even before the first fetch.
 */
const STUDIO_CLI = 'constructorfabric.studio-cli';

function studioCliRuntime() {
    let pins;
    try {
        pins = JSON.parse(fs.readFileSync(assistantsManifest, 'utf8')).assistants;
    } catch {
        return undefined;
    }
    const pin = (Array.isArray(pins) ? pins : [])
        .find(p => typeof p?.id === 'string' && p.id.toLowerCase() === STUDIO_CLI && typeof p?.version === 'string');
    return pin ? path.join(plugins, `${STUDIO_CLI}-${pin.version}`, STUDIO_CLI, 'extension', 'runtime') : undefined;
}

const defaults = {
    // A list, not STUDIO_DESKTOP_URL: that one pins a single Studio and hides
    // the choice, which is for a developer's `theia start`.
    STUDIO_DESKTOP_ENVIRONMENTS: environments ? JSON.stringify(environments) : undefined,
    STUDIO_DESKTOP_DEFAULT: defaultEnvironment,
    // The runtime config of the studio extension requires these. On a desktop
    // the actor is the signed-in member, whom the sign-in names later; these
    // only let the IDE start.
    STUDIO_ACTOR_ID: 'desktop',
    STUDIO_WORKSPACE_ID: 'desktop',
    STUDIO_WORKSPACE_ROOT: workspace,
    STUDIO_REPOSITORY_ROOT: workspace,
    STUDIO_DATA_DIR: data,
    // The built-in VS Code plugins ship as a resource beside the app.
    THEIA_DEFAULT_PLUGINS: `local-dir:${path.join(process.resourcesPath, 'plugins')}`,
    // The assistants' manifest, where they go, and where a member may put a
    // VSIX by hand on a machine that cannot reach open-vsx: beside the app.
    STUDIO_DESKTOP_ASSISTANTS: fs.existsSync(assistantsManifest) ? assistantsManifest : undefined,
    STUDIO_DESKTOP_PLUGINS: plugins,
    STUDIO_DESKTOP_VSIX_DIRS: path.dirname(process.execPath),
    // The gearbox engine (gear catalogue, products, `.gdl`), when the build
    // carries one; the session image has it on PATH instead.
    GEARBOX_ENGINE: shippedEngine(),
    // `cfs` from the Constructor Studio CLI extension; the session image has
    // it on PATH instead.
    STUDIO_CFS_RUNTIME: studioCliRuntime(),
};
for (const [name, value] of Object.entries(defaults)) {
    if (value && !process.env[name]) {
        process.env[name] = value;
    }
}
// `cfs` for the terminals, which start with this process's environment: the
// CLI's bin ahead of any `cfs` the member installed. Named before the first
// fetch too, since a shell looks a command up when it runs. (An extension's
// terminal environment collection does not reach terminals when the extension
// is deployed while the app runs.)
if (process.env.STUDIO_CFS_RUNTIME) {
    process.env.PATH = [path.join(process.env.STUDIO_CFS_RUNTIME, 'bin'), process.env.PATH].filter(Boolean).join(path.delimiter);
}
// Added to, not replaced: a THEIA_PLUGINS from the shell still counts.
const fetched = fetchedAssistants();
if (fetched.length) {
    process.env.THEIA_PLUGINS = [process.env.THEIA_PLUGINS, ...fetched].filter(Boolean).join(',');
}
for (const dir of [workspace, data]) {
    fs.mkdirSync(dir, { recursive: true });
}

// The portal's "Open in desktop" link (ADR-0027 §6). Theia takes a link only
// after `--open-url`, which is how it registers the scheme itself once the app
// has run; the installer registers it before that, and hands the link over as
// a bare argument, which Theia would read as a folder to open. So a bare
// `cfstudio:` argument is moved to the end behind the flag -- in this process,
// and so also for an instance already running, which receives this process's
// argv through the single-instance lock (`singleInstance` in package.json).
const link = process.argv.findIndex(arg => /^cfstudio:/i.test(arg));
if (link >= 0 && !process.argv.includes('--open-url')) {
    const [url] = process.argv.splice(link, 1);
    process.argv.push('--open-url', url);
}

// Updates: checked on start and every few hours, offered once downloaded
// (desktop-updater.js), on the channel the member chose in Settings.
try {
    require('./desktop-updater.js').startUpdates();
} catch (error) {
    // A build without the updater (a checkout, an old stage) still starts.
    console.warn(`[studio-desktop] updates are off: ${error}`);
}

require('./lib/backend/electron-main.js');
