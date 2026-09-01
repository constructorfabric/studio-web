/*
 * Signing in to Codex and Claude from inside the product, as yourself.
 *
 * The assistants are not authenticated by an API key alone. Both are normally
 * used on a subscription, through an OAuth flow, and in a hosted session the
 * usual flow does not work: an interactive `codex login` opens a browser and
 * waits for a callback on localhost, and localhost inside a session container
 * is not a place the user's browser can reach.
 *
 * Both tools have a headless path, and that is what this uses:
 *
 *   codex login --device-auth   prints a URL and a short code; the user
 *                               approves it on whatever device they like, and
 *                               the command completes on its own.
 *   claude setup-token          issues a long-lived token for a Claude
 *                               subscription; built for exactly this case.
 *
 * An API key remains available for people who have one instead of a
 * subscription. `codex login --with-api-key` reads it from stdin, so the key
 * never appears in a process argument list where `ps` would show it to
 * everyone else in the container.
 *
 * EVERY command here runs in the calling viewer's own credential home (see
 * viewer-credentials.js). That is what makes "sign in" mean "sign in as me"
 * rather than "sign in for whoever else is in this session".
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { assistantEnvironment, CREDENTIAL_STORE } = require('./viewer-credentials-env');

/** How long a device-code flow may stay open before it is abandoned. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** Output kept per flow. Enough for a code and a URL, not a transcript. */
const MAX_OUTPUT = 16 * 1024;

/*
 * The CLIs colour their output, and the escape sequences are not a display
 * problem alone: the device URL is printed as ESC[94m<url>ESC[0m, so anything
 * matching a URL as "non-whitespace" swallows the terminator too and hands the
 * user a link that does not resolve. Stripped here, once, so both the extracted
 * code and the raw output shown underneath it are clean.
 */
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;
const stripAnsi = text => String(text).replace(ANSI, '');

const ASSISTANTS = {
    codex: {
        label: 'Codex',
        command: 'codex',
        subscriptionArgs: ['login', '--device-auth'],
        apiKeyArgs: ['login', '--with-api-key'],
        statusArgs: ['login', 'status'],
        logoutArgs: ['logout']
    },
    claude: {
        label: 'Claude',
        command: 'claude',
        subscriptionArgs: ['setup-token'],
        // Claude Code takes its key from the environment rather than from a
        // login command, so the key is stored and exported at the next fork.
        apiKeyArgs: undefined,
        statusArgs: ['auth', 'status'],
        logoutArgs: ['auth', 'logout']
    }
};

/** The file an API key for Claude is kept in, inside the viewer's own home. */
const CLAUDE_KEY_FILE = 'anthropic-api-key';

class AssistantAuth {

    constructor(credentials) {
        this.credentials = credentials;
        this.flows = new Map();
    }

    /**
     * The environment every assistant command runs with: this viewer's home,
     * built by the same function that shapes the plugin host's fork so a
     * command cannot end up isolated differently from the extension that will
     * later read what it wrote. Notably, HOME does not move on macOS — see
     * viewer-credentials.js for the keychain reason.
     */
    environment() {
        return assistantEnvironment(this.credentials.home());
    }

    run(kind, args, { input, timeoutMs = 30000 } = {}) {
        const assistant = ASSISTANTS[kind];
        if (!assistant) { return Promise.reject(new Error(`unknown assistant: ${kind}`)); }
        const env = this.environment();
        // The tools refuse to run against a home that does not exist yet.
        fs.mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
        fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
        return new Promise(resolve => {
            const child = execFile(assistant.command, args, { env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT },
                (error, stdout, stderr) => resolve({
                    ok: !error,
                    stdout: stripAnsi(stdout || ''),
                    stderr: stripAnsi(stderr || ''),
                    // ENOENT means the CLI is not installed in this image, which
                    // is a deployment fact worth saying out loud rather than
                    // reporting as "not signed in".
                    missing: !!error && error.code === 'ENOENT'
                }));
            if (input !== undefined) {
                child.stdin.end(input);
            }
        });
    }

    /**
     * Who each assistant currently thinks it is. Read from the tools rather
     * than from a file, so it stays true when a token expires underneath us.
     */
    async status() {
        const [codex, claude] = await Promise.all([this.codexStatus(), this.claudeStatus()]);
        const home = this.credentials.home();
        const identified = !!this.credentials.viewerKey;
        return { codex, claude, home, identified, credentialStore: CREDENTIAL_STORE };
    }

    async codexStatus() {
        const result = await this.run('codex', ASSISTANTS.codex.statusArgs);
        if (result.missing) {
            return { available: false, signedIn: false, detail: 'The codex command is not installed in this session.' };
        }
        const text = (result.stdout + result.stderr).trim();
        const signedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
        return {
            available: true,
            signedIn,
            // "Logged in using ChatGPT" or "Logged in using an API key".
            detail: text.split('\n').find(line => line.trim()) || 'Not signed in'
        };
    }

    async claudeStatus() {
        const result = await this.run('claude', ASSISTANTS.claude.statusArgs);
        if (result.missing) {
            return { available: false, signedIn: false, detail: 'The claude command is not installed in this session.' };
        }
        let parsed;
        try {
            parsed = JSON.parse(result.stdout);
        } catch (error) {
            parsed = undefined;
        }
        if (parsed) {
            return {
                available: true,
                signedIn: !!parsed.loggedIn,
                detail: parsed.loggedIn
                    ? `Signed in (${parsed.authMethod || 'subscription'})`
                    : (this.storedClaudeKey() ? 'An API key is stored; reload the window to use it.' : 'Not signed in')
            };
        }
        return { available: true, signedIn: false, detail: 'Not signed in' };
    }

    storedClaudeKey() {
        try {
            const file = path.join(this.credentials.home(), '.claude', CLAUDE_KEY_FILE);
            const value = fs.readFileSync(file, 'utf8').trim();
            return value || undefined;
        } catch (error) {
            return undefined;
        }
    }

    /**
     * Start a subscription sign-in. Returns immediately with an id: the flow
     * prints a code and then waits, sometimes for minutes, for the person to
     * approve it somewhere else. The frontend polls for the output.
     */
    async beginSignIn(kind) {
        const assistant = ASSISTANTS[kind];
        if (!assistant) { throw new Error(`unknown assistant: ${kind}`); }
        const env = this.environment();
        fs.mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
        fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });

        const id = `${kind}-${Date.now().toString(36)}`;
        const flow = { id, kind, output: '', running: true, exitCode: undefined, startedAt: Date.now() };
        let child;
        try {
            child = spawn(assistant.command, assistant.subscriptionArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            return { id, running: false, output: String(error.message || error), exitCode: -1 };
        }
        flow.child = child;
        const append = chunk => {
            flow.output = (flow.output + stripAnsi(chunk.toString())).slice(-MAX_OUTPUT);
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        child.on('error', error => {
            append(`\n${error.code === 'ENOENT'
                ? `The ${assistant.command} command is not installed in this session.`
                : String(error.message || error)}\n`);
            flow.running = false;
            flow.exitCode = -1;
        });
        child.on('close', code => {
            flow.running = false;
            flow.exitCode = code;
        });
        flow.timer = setTimeout(() => this.cancelSignIn(id), LOGIN_TIMEOUT_MS);
        // Node keeps the process alive for a pending timer; a ten-minute one
        // must not hold a shutdown open.
        if (typeof flow.timer.unref === 'function') { flow.timer.unref(); }
        this.flows.set(id, flow);
        return { id, running: true, output: '', exitCode: undefined };
    }

    async pollSignIn(id) {
        const flow = this.flows.get(id);
        if (!flow) { return { id, running: false, output: '', exitCode: -1, unknown: true }; }
        return { id, running: flow.running, output: flow.output, exitCode: flow.exitCode };
    }

    async cancelSignIn(id) {
        const flow = this.flows.get(id);
        if (!flow) { return false; }
        if (flow.timer) { clearTimeout(flow.timer); }
        if (flow.child && flow.running) {
            try { flow.child.kill('SIGTERM'); } catch (error) { /* already gone */ }
        }
        flow.running = false;
        this.flows.delete(id);
        return true;
    }

    /**
     * Sign in with a provider key. The key is passed on stdin, never as an
     * argument: arguments are visible in the process list to anything else
     * running in the same container.
     */
    async signInWithKey(kind, apiKey) {
        const key = String(apiKey || '').trim();
        if (!key) { return { ok: false, detail: 'No key was given.' }; }

        if (kind === 'codex') {
            const result = await this.run('codex', ASSISTANTS.codex.apiKeyArgs, { input: key });
            if (result.missing) { return { ok: false, detail: 'The codex command is not installed in this session.' }; }
            return {
                ok: result.ok,
                detail: result.ok ? 'Signed in with an API key.' : (result.stderr || result.stdout || 'Sign-in failed.').trim().slice(0, 200)
            };
        }

        if (kind === 'claude') {
            // Claude Code reads ANTHROPIC_API_KEY from its environment, which is
            // fixed when the plugin host forks — so a key stored now takes
            // effect on the next window reload, and the caller is told so
            // rather than left wondering why nothing changed.
            try {
                const directory = path.join(this.credentials.home(), '.claude');
                fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
                const file = path.join(directory, CLAUDE_KEY_FILE);
                fs.writeFileSync(file, key, { mode: 0o600 });
                fs.chmodSync(file, 0o600);
                return { ok: true, reloadRequired: true, detail: 'Key stored. Reload the window to start using it.' };
            } catch (error) {
                return { ok: false, detail: `Could not store the key: ${error.message}` };
            }
        }

        return { ok: false, detail: `unknown assistant: ${kind}` };
    }

    async signOut(kind) {
        const assistant = ASSISTANTS[kind];
        if (!assistant) { return { ok: false, detail: `unknown assistant: ${kind}` }; }
        if (kind === 'claude') {
            try {
                fs.rmSync(path.join(this.credentials.home(), '.claude', CLAUDE_KEY_FILE), { force: true });
            } catch (error) { /* nothing stored */ }
        }
        const result = await this.run(kind, assistant.logoutArgs);
        if (result.missing) { return { ok: false, detail: `The ${assistant.command} command is not installed in this session.` }; }
        return { ok: result.ok, detail: result.ok ? 'Signed out.' : (result.stderr || result.stdout || '').trim().slice(0, 200) };
    }
}

module.exports = { AssistantAuth, ASSISTANTS, CLAUDE_KEY_FILE, stripAnsi };
