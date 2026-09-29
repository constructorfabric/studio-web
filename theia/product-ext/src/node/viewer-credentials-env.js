/*
 * The environment one viewer's assistants run in.
 *
 * Its own module because two callers need exactly the same answer and must not
 * drift: the plugin host's fork (viewer-credentials.js) and every command the
 * sign-in surface runs (assistant-auth.js). If those two isolated different
 * things, a login would write somewhere the extension never reads.
 */
const fs = require('fs');
const path = require('path');

/** A key the viewer stored for themselves, or nothing. Never logged. */
const os = require('os');

function readStoredKey(file) {
    try {
        const value = fs.readFileSync(file, 'utf8').trim();
        return value || undefined;
    } catch (error) {
        return undefined;
    }
}

/*
 * WHETHER HOME MAY BE MOVED, AND WHY IT SOMETIMES MAY NOT.
 *
 * Repointing HOME is the broadest form of isolation: it catches every tool that
 * writes to `~`, including ones added later. On Linux — which is what a session
 * container runs — that is exactly right, and Claude Code stores its OAuth
 * credentials as a file under CLAUDE_CONFIG_DIR there.
 *
 * On macOS it is actively harmful. The system resolves the login keychain
 * through `$HOME/Library/Keychains`, and Claude Code stores credentials in the
 * keychain rather than in a file. With HOME moved, `security default-keychain`
 * answers "A default keychain could not be found", the sign-in fails after the
 * browser half has already succeeded, and macOS offers to *reset the user's
 * keychain to defaults* — an offer that, accepted, destroys credentials that
 * have nothing to do with this application. Measured, not theorised: that
 * dialog is what a developer running this locally actually got.
 *
 * So HOME moves only where the credential store is files. Everywhere else the
 * tool-specific directories still isolate what they can, and the honest
 * consequence — two viewers on one Mac share Claude's keychain entry — is
 * reported through `status()` rather than left for somebody to discover.
 */
const HOME_IS_MOVABLE = process.platform === 'linux';

/** Where the platform keeps assistant credentials that are not plain files. */
const CREDENTIAL_STORE = HOME_IS_MOVABLE ? 'files' : 'system-keychain';

/**
 * The environment an assistant runs in for one viewer. Shared by the plugin
 * host fork and by any command the sign-in surface runs, so the two cannot
 * drift into isolating different things.
 */
function assistantEnvironment(home, base = process.env) {
    const env = { ...base };
    if (HOME_IS_MOVABLE) {
        env.HOME = home;
        env.USERPROFILE = home;
        env.XDG_CONFIG_HOME = path.join(home, '.config');
        env.XDG_DATA_HOME = path.join(home, '.local', 'share');
        env.XDG_CACHE_HOME = path.join(home, '.cache');
    }
    // Always: these are what the two assistants read first, and they isolate
    // configuration and session state on every platform.
    env.CODEX_HOME = path.join(home, '.codex');
    env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
    env.STUDIO_CREDENTIAL_HOME = home;

    const storedKey = readStoredKey(path.join(home, '.claude', 'anthropic-api-key'));
    if (storedKey) {
        env.ANTHROPIC_API_KEY = storedKey;
    } else {
        delete env.ANTHROPIC_API_KEY;
    }
    return env;
}

/*
 * The directories `assistantEnvironment` names, created.
 *
 * Naming a directory is not enough: the Codex CLI refuses to start against a
 * CODEX_HOME that does not exist ("CODEX_HOME points to …, but that path does
 * not exist", exit 1). The Codex extension spawns `codex app-server` as soon as
 * it activates, with the plugin host's environment, so a fresh credential home
 * — every first session of a viewer, every anonymous connection — left the
 * app-server dead, the extension's webview waiting for it, and after 30 s the
 * extension's only message: "Codex couldn't load its resources." Measured in a
 * session and in the desktop app: the Codex output channel carries the CLI's
 * error, the webview's own assets all load.
 *
 * The sign-in commands (assistant-auth.js) already created these, which is why
 * signing in from the product's surface worked and opening the extension
 * first did not.
 */
function ensureAssistantHomes(env) {
    for (const directory of [env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) {
        if (directory) {
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        }
    }
}



/*
 * The git config a viewer's home carries, as text.
 *
 * Pure, and in this module rather than beside the code that writes it, for the
 * reason this module exists at all: the part with a rule in it is the part
 * worth testing, and `viewer-credentials.js` cannot be loaded without a
 * dependency-injection container.
 *
 * `include` comes FIRST and the person SECOND, because git applies the last
 * value it reads: the session's own config still supplies everything nobody
 * here states, and the person still wins over its default identity.
 *
 * The address is written only when the identity provider stated one. Git needs
 * one to commit at all, and the include supplies the session's, so a person
 * whose account carries no address commits under their own name rather than not
 * at all.
 */
function gitIdentityConfig(containerConfigPath, person) {
    const lines = [
        '# Written by Constructor Studio. This directory is the plugin host HOME,',
        '# so this is the global git config every tool running in it reads.',
        '[include]',
        '\tpath = ' + containerConfigPath
    ];
    const name = person && typeof person.name === 'string' ? person.name.trim() : '';
    const email = person && typeof person.email === 'string' ? person.email.trim() : '';
    if (name || email) {
        lines.push('[user]');
        if (name) { lines.push('\tname = ' + name); }
        if (email) { lines.push('\temail = ' + email); }
    }
    return lines.join('\n') + '\n';
}

/*
 * A git identity in the viewer's home, because that home IS `$HOME` for the
 * plugin host.
 *
 * THE DEFECT THIS FIXES, measured in a running session. The entrypoint writes a
 * global git identity with `git config --global`, which lands in the container
 * user's `~/.gitconfig`. This class then repoints `HOME` for the plugin host so
 * one viewer's assistant credentials cannot be another's — and the plugin host
 * is where the built-in git extension runs. With `HOME` moved, git looks for a
 * global config in a directory that has none, and the IDE's own Commit answers
 * "Make sure you configure your user.name and user.email in git". Reported from
 * use; confirmed by reading the plugin host's own environ and finding no
 * `.gitconfig` in any credential home.
 *
 * So each home gets one. It `include`s the container's config first, so
 * whatever the session was launched with still applies, and then states the
 * person on top — which is the part worth having: before this, every commit
 * made from the IDE was authored by a shared "Constructor Studio" whoever made
 * it, in a product whose whole point is telling collaborators apart.
 *
 * The address is only written when the identity provider stated one. Git needs
 * an address to commit at all, and the include supplies the session's default,
 * so a person with no address on their account commits under their own name and
 * the session's address rather than not at all.
 */
function writeGitConfig(directory, person) {
    const target = path.join(directory, '.gitconfig');
    const body = gitIdentityConfig(path.join(os.homedir(), '.gitconfig'), person);
    try {
        // Rewritten only when it would change: this runs on every plugin-host
        // fork, and a file whose mtime moves for nothing invites a watcher
        // somewhere to act on it.
        if (fs.readFileSync(target, 'utf8') === body) { return; }
    } catch (error) {
        /* absent or unreadable — write it */
    }
    try {
        fs.writeFileSync(target, body, { mode: 0o600 });
    } catch (error) {
        // A home that cannot hold a git config still holds credentials, and the
        // IDE falls back to the message this exists to remove rather than
        // failing to start.
        console.warn('[studio] could not write a git identity for this viewer', error);
    }
}

/*
 * How the anonymous home is linked to the viewer's own.
 *
 * On Windows — the desktop Studio — a directory symlink needs a privilege an
 * ordinary account does not have, so `symlinkSync(…, 'dir')` failed there
 * AFTER the anonymous home had been emptied and removed: the running plugin
 * host was left with a HOME, CODEX_HOME and CLAUDE_CONFIG_DIR that no longer
 * existed, and the Codex CLI refuses to start against a missing CODEX_HOME. A
 * junction is the Windows directory link any account may create; elsewhere
 * the type is ignored.
 */
const HOME_LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/*
 * Point this connection's anonymous home at the home its viewer actually owns.
 *
 * The plugin host is forked with `HOME=<anonymous>` before anybody has said who
 * they are — `PluginHostEnvironmentVariable.process` is synchronous, so the
 * fork cannot wait for identity. The running process keeps the path it was
 * given, so the path is redirected underneath it instead.
 *
 * THREE cases, and the third is the one that was missing. Measured in a running
 * session, whose credential root read:
 *
 *     local-anon-90e726d0-…/
 *     oidc-46ac15da-…/                      (empty)
 *     session-cd95393e-… -> local-anon-90e726d0-…
 *
 * That is ONE connection adopting twice: the IDE's own local identity first,
 * then the portal's when it arrived. The first adoption moved the anonymous
 * directory and left a symlink, correctly. The second created the new home and
 * did nothing else — `lstat().isDirectory()` is false for a symlink, so the
 * move was skipped, and `existsSync` FOLLOWS a symlink, so it reported the path
 * as taken and no new link was made. The plugin host therefore kept resolving
 * to the identity the person had already stopped being.
 *
 * Failure is not fatal in any case: the anonymous home stays in place and
 * works, the viewer signs in to their assistant again next session, and
 * nothing is shared with anybody.
 */
function redirectHome(anonymous, stable) {
    try {
        const existing = fs.lstatSync(anonymous, { throwIfNoEntry: false });
        if (existing && existing.isSymbolicLink()) {
            // Already redirected, possibly somewhere else. Repointing is the
            // whole of "the person changed under a live page".
            if (path.resolve(fs.readlinkSync(anonymous)) === path.resolve(stable)) { return; }
            fs.unlinkSync(anonymous);
        } else if (existing && existing.isDirectory()) {
            // Anything the plugin host wrote before identity arrived belongs
            // to this viewer: it was written by them.
            for (const entry of fs.readdirSync(anonymous)) {
                const from = path.join(anonymous, entry);
                const to = path.join(stable, entry);
                if (!fs.existsSync(to)) {
                    fs.renameSync(from, to);
                }
            }
            fs.rmSync(anonymous, { recursive: true, force: true });
        }
        if (!fs.lstatSync(anonymous, { throwIfNoEntry: false })) {
            fs.symlinkSync(stable, anonymous, HOME_LINK_TYPE);
        }
    } catch (error) {
        console.warn('[studio] could not redirect the anonymous credential home', error);
    }
}

module.exports = {
    assistantEnvironment,
    ensureAssistantHomes,
    gitIdentityConfig,
    writeGitConfig,
    redirectHome,
    HOME_LINK_TYPE,
    readStoredKey,
    CREDENTIAL_STORE,
    HOME_IS_MOVABLE
};
