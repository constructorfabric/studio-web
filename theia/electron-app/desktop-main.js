// Entry point of the PACKAGED desktop Studio (ADR-0027). `scripts/package.mjs`
// makes it the app's `main`; `theia start` in a checkout never loads it.
//
// A developer's `theia start` gets its settings from the command line and the
// shell: which Studio to sign in to, where the plugins are, where to keep the
// workspace. An installed app has neither, so this fills them in before
// Theia's own electron main starts the backend, which inherits the
// environment. Anything already set in the environment wins, so one build can
// still be pointed at another Studio for a test.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * macOS starts an app from the Finder or the Dock with launchd's PATH --
 * /usr/bin:/bin:/usr/sbin:/sbin -- not the member's: no Homebrew, no tools set
 * up in ~/.zprofile. Terminals, git and the extensions would all miss them. So
 * the PATH is asked of the member's login shell once, as VS Code does. An app
 * started from a terminal already has it, and a shell that does not answer in
 * a few seconds leaves the PATH as it is.
 */
function loginShellPath() {
    const shell = process.env.SHELL || '/bin/zsh';
    const mark = '__STUDIO_PATH__';
    try {
        const out = execFileSync(shell, ['-ilc', `printf '%s%s%s' ${mark} "$PATH" ${mark}`], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
            env: { ...process.env, STUDIO_RESOLVING_SHELL_ENV: '1' },
        });
        // Between the marks: an interactive shell may print a greeting around it.
        return out.split(mark)[1] || undefined;
    } catch {
        return undefined;
    }
}
if (process.platform === 'darwin' && !process.env.TERM_PROGRAM) {
    const shellPath = loginShellPath();
    if (shellPath) {
        process.env.PATH = shellPath;
    }
}

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
 * The Constructor Studio CLI (theia/studio-cli) and the gearbox engine
 * (theia/gearbox-engine) arrive the same way, as pins of that manifest. Their
 * users run what the pin unpacks into, once it is there -- the studio
 * extension's `cfs` (studio/src/node/cfs-command.ts), gearbox-studio's engine,
 * whose path it reads each time it starts one -- so the folder is named even
 * before the first fetch.
 */
const STUDIO_CLI = 'constructorfabric.studio-cli';
const GEARBOX_ENGINE = 'constructorfabric.gearbox-engine';

/** `<plugins>/<id>-<version>/<id>/extension` for the manifest's pin of `id`. */
function pinnedExtension(id) {
    let pins;
    try {
        pins = JSON.parse(fs.readFileSync(assistantsManifest, 'utf8')).assistants;
    } catch {
        return undefined;
    }
    const pin = (Array.isArray(pins) ? pins : [])
        .find(p => typeof p?.id === 'string' && p.id.toLowerCase() === id && typeof p?.version === 'string');
    return pin ? path.join(plugins, `${id}-${pin.version}`, id, 'extension') : undefined;
}

function studioCliRuntime() {
    const extension = pinnedExtension(STUDIO_CLI);
    return extension && path.join(extension, 'runtime');
}

function fetchedEngine() {
    const extension = pinnedExtension(GEARBOX_ENGINE);
    return extension && path.join(extension, 'bin', process.platform === 'win32' ? 'gearbox.exe' : 'gearbox');
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
    // The gearbox engine (gear catalogue, products, `.gdl`): the one a build
    // carries, else the one the manifest has the app fetch; the session image
    // has it on PATH instead.
    GEARBOX_ENGINE: shippedEngine() ?? fetchedEngine(),
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
// Extensions uninstalled while something still held their folder
// (studio/src/node/desktop-plugin-uninstall.ts): removed now, before any
// plugin loads and holds them again. What still will not go stays listed.
const pendingRemovals = path.join(process.env.STUDIO_DATA_DIR, 'pending-plugin-removals.json');
try {
    const left = JSON.parse(fs.readFileSync(pendingRemovals, 'utf8')).filter(folder => {
        try {
            fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
            return fs.existsSync(folder);
        } catch {
            return true;
        }
    });
    if (left.length) {
        fs.writeFileSync(pendingRemovals, JSON.stringify(left, undefined, 2) + '\n');
    } else {
        fs.rmSync(pendingRemovals, { force: true });
    }
} catch {
    // Nothing pending.
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
// macOS hands a link over as an `open-url` event instead, and one that starts
// the app may arrive before Theia listens for it. Until it does, the link is
// put where Theia's start reads it, as on Windows; once it listens, it is
// Theia's alone.
if (process.platform === 'darwin') {
    const { app } = require('electron');
    const early = (event, url) => {
        if (app.listenerCount('open-url') > 1) {
            app.removeListener('open-url', early);
        } else if (!process.argv.includes('--open-url')) {
            event.preventDefault();
            process.argv.push('--open-url', url);
        }
    };
    app.on('open-url', early);
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
