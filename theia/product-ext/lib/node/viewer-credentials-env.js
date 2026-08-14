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


module.exports = { assistantEnvironment, readStoredKey, CREDENTIAL_STORE, HOME_IS_MOVABLE };
