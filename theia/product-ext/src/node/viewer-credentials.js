/*
 * One credential home per viewer, not one per container.
 *
 * THE PROBLEM THIS EXISTS FOR. A hosted Studio session is reused: the session
 * gear's idempotency key is (tenant, workspace), not the user, so the second
 * person to open a workspace gets the container the first person started. The
 * assistants authenticate against files and environment variables in that
 * container's home directory — `~/.codex/auth.json` for Codex, `~/.claude` for
 * Claude Code, and any provider key injected as environment at launch. So
 * without this, the second person's assistant calls run as the first person:
 * billed to their subscription, logged as their account, and readable by
 * anyone who can open a terminal in the session.
 *
 * That is not a leak between tenants. It is a leak between colleagues, which
 * is the kind people discover late and cannot undo.
 *
 * THE SEAM. Theia forks a plugin host per frontend connection
 * (`ConnectionContainerModule` in plugin-ext's hosted backend module), and it
 * offers `PluginHostEnvironmentVariable` as a supported way to shape that
 * fork's environment. Both halves are per connection, so a browser session can
 * be given its own credential directory without patching Theia and without one
 * session's environment reaching another's.
 *
 * WHAT ISOLATION IS GUARANTEED, AND WHAT IS BEST EFFORT. Isolation is by
 * connection and is unconditional: even before a viewer identifies itself, a
 * connection gets a directory nobody else shares, so the cross-user case
 * cannot happen. Identity makes that directory *stable* — sign in as the same
 * person tomorrow and your Codex login is still there — and that half depends
 * on the frontend announcing itself before the plugin host forks. When it does
 * not, the session falls back to an anonymous per-connection home: private,
 * but you log in to the assistant again. Losing a login is recoverable;
 * borrowing somebody else's is not, so the fallback fails in that direction.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ContainerModule } = require('inversify');
const { ConnectionContainerModule } = require('@theia/core/lib/node/messaging/connection-container-module');
const { PluginHostEnvironmentVariable } = require('@theia/plugin-ext/lib/common/plugin-protocol');
const { assistantEnvironment } = require('./viewer-credentials-env');
const { AssistantAuth } = require('./assistant-auth');

const VIEWER_CREDENTIALS_PATH = '/services/studio-viewer-credentials';
const ASSISTANT_AUTH_PATH = '/services/studio-assistant-auth';

/** Where per-viewer homes live. Outside the workspace: never committed. */
function credentialsRoot() {
    return process.env.STUDIO_CREDENTIALS_ROOT
        || path.join(os.homedir(), '.studio-credentials');
}

/*
 * A directory name that is derived from the viewer key rather than trusting
 * it. The key arrives over RPC from a frontend, so it is input: a value like
 * `../../workspace` would otherwise choose the directory. The readable part is
 * kept for anyone looking at the filesystem, and a hash of the full key makes
 * it unique — two keys that sanitize to the same prefix still get their own
 * home.
 */
function directoryNameFor(viewerKey) {
    const key = String(viewerKey || '');
    const readable = key.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
    return (readable || 'viewer') + '-' + digest;
}

function ensureDirectory(directory) {
    // 0700: an assistant credential is as sensitive as an SSH key, and these
    // sit under a home directory a container may share with other processes.
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(directory, 0o700);
    } catch (error) {
        // A filesystem that does not carry modes (a bind mount from a host
        // that does not) is not a reason to refuse to run.
    }
    return directory;
}

/**
 * Per-connection state: which viewer this browser session belongs to, and the
 * directory their assistant credentials live in.
 */
class ViewerCredentials {

    constructor() {
        // Anonymous until the frontend says otherwise, and unique either way.
        this.connectionId = crypto.randomUUID();
        this.viewerKey = undefined;
    }

    /*
     * Called by the frontend once it knows who is looking — which, measured,
     * is *after* Theia has already forked the plugin host. Theia starts
     * loading plugins in its own `onStart`, several contributions before the
     * product's, so a plugin host that has been given `HOME=<anonymous>` is
     * the normal case rather than the exception.
     *
     * Waiting is not available: `PluginHostEnvironmentVariable.process` is
     * synchronous, so the fork cannot be held until identity resolves. So the
     * anonymous directory is redirected instead: its contents move into the
     * viewer's stable home and the anonymous path becomes a symlink to it. The
     * running plugin host keeps the path it was given and that path now
     * resolves to the right place, so a Codex login performed in this session
     * lands in the viewer's home and is still there tomorrow.
     *
     * This is safe because of *when* the assistants read credentials: on first
     * use, when somebody actually talks to one, which is long after startup.
     * The redirect happens within a second of page load.
     */
    async setViewer(viewerKey) {
        const key = String(viewerKey || '').trim();
        if (!key || key === this.viewerKey) { return this.home(); }

        const anonymous = path.join(credentialsRoot(), 'session-' + this.connectionId);
        const stable = ensureDirectory(path.join(credentialsRoot(), directoryNameFor(key)));
        this.viewerKey = key;

        try {
            const existing = fs.lstatSync(anonymous, { throwIfNoEntry: false });
            if (existing && existing.isDirectory()) {
                // Anything the plugin host wrote before identity arrived
                // belongs to this viewer: it was written by them.
                for (const entry of fs.readdirSync(anonymous)) {
                    const from = path.join(anonymous, entry);
                    const to = path.join(stable, entry);
                    if (!fs.existsSync(to)) {
                        fs.renameSync(from, to);
                    }
                }
                fs.rmSync(anonymous, { recursive: true, force: true });
            }
            if (!fs.existsSync(anonymous)) {
                fs.symlinkSync(stable, anonymous, 'dir');
            }
        } catch (error) {
            // A failed redirect leaves the anonymous home in place and working.
            // The viewer signs in to the assistant again next session; nothing
            // is lost and nothing is shared.
            console.warn('[studio] could not redirect the anonymous credential home', error);
        }
        return stable;
    }

    /** The directory this connection's plugin host should treat as home. */
    home() {
        const name = this.viewerKey
            ? directoryNameFor(this.viewerKey)
            : 'session-' + this.connectionId;
        return ensureDirectory(path.join(credentialsRoot(), name));
    }

    /** Whether the home is stable across sessions or only for this one. */
    async status() {
        return {
            identified: !!this.viewerKey,
            home: this.home(),
            root: credentialsRoot()
        };
    }
}

/**
 * Points the plugin host — and therefore every assistant extension running in
 * it — at this connection's credential home.
 *
 * `HOME` is set as well as the tool-specific variables because an extension
 * that predates either of them will still write to `~`. Setting only
 * CODEX_HOME would isolate Codex and leave the next assistant to be added
 * writing into a shared directory, which is the failure this class exists to
 * make impossible rather than unlikely.
 */
class ViewerCredentialsEnvironment {

    constructor(credentials) {
        this.credentials = credentials;
    }

    process(env) {
        let home;
        try {
            home = this.credentials.home();
        } catch (error) {
            console.error('[studio] could not prepare a credential home; ' +
                'the plugin host keeps the container default', error);
            return;
        }
        // One builder for the fork and for the sign-in commands, so the two
        // cannot isolate different things. See assistantEnvironment above for
        // why HOME does not move on every platform.
        const prepared = assistantEnvironment(home, env);
        Object.assign(env, prepared);
        // Assign cannot express a deletion: a key the container was launched
        // with must not survive into a viewer who has none of their own.
        if (!prepared.ANTHROPIC_API_KEY) {
            delete env.ANTHROPIC_API_KEY;
        }
    }
}

const connectionModule = ConnectionContainerModule.create(({ bind, bindBackendService }) => {
    // No decorators: this package is plain CommonJS with no build step, so
    // inversify is given a factory rather than asked to construct the class.
    bind(ViewerCredentials).toDynamicValue(() => new ViewerCredentials()).inSingletonScope();
    bind(PluginHostEnvironmentVariable).toDynamicValue(ctx =>
        new ViewerCredentialsEnvironment(ctx.container.get(ViewerCredentials))).inSingletonScope();
    bindBackendService(VIEWER_CREDENTIALS_PATH, ViewerCredentials);
    // Signing in runs commands in this viewer's home, so it shares the
    // connection-scoped credentials rather than resolving a home of its own.
    bind(AssistantAuth).toDynamicValue(ctx =>
        new AssistantAuth(ctx.container.get(ViewerCredentials))).inSingletonScope();
    bindBackendService(ASSISTANT_AUTH_PATH, AssistantAuth);
});

const mod = new ContainerModule(bind => {
    bind(ConnectionContainerModule).toConstantValue(connectionModule);
});

module.exports = mod;
module.exports.default = mod;
module.exports.ViewerCredentials = ViewerCredentials;
module.exports.ViewerCredentialsEnvironment = ViewerCredentialsEnvironment;
module.exports.VIEWER_CREDENTIALS_PATH = VIEWER_CREDENTIALS_PATH;
module.exports.ASSISTANT_AUTH_PATH = ASSISTANT_AUTH_PATH;
module.exports.directoryNameFor = directoryNameFor;
module.exports.credentialsRoot = credentialsRoot;
