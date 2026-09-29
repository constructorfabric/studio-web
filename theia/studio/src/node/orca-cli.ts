// Thin runner over the `orca` CLI — the seam between Studio and an Orca
// runtime.
//
// Every command is invoked with `--json`, and every response comes back in the
// same envelope the runtime uses:
//
//     { "id": "<request id>", "ok": true,  "result": { … } }
//     { "id": "<request id>", "ok": false, "error":  { … } }
//
// so this module's whole job is: find the binary, run it with a timeout, and
// hand back `result` or throw with something an operator can read.
//
// Shaped after `git-executor.ts` deliberately — same timeout/output-cap/typed-
// error posture, because this is the same class of thing: a child process we do
// not control speaking a text protocol.

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { injectable } from '@theia/core/shared/inversify';

const execFileAsync = promisify(execFile);

/** Most commands are a round-trip to a local runtime; a few create checkouts. */
const DEFAULT_TIMEOUT_MS = 20_000;
/** `terminal wait` blocks by design, so it carries its own budget. */
const MAX_TIMEOUT_MS = 10 * 60_000;
/** A terminal read can be long; anything past this is truncated, not buffered. */
const OUTPUT_LIMIT = 1024 * 1024;

export class OrcaCliError extends Error {
    constructor(
        message: string,
        readonly args: readonly string[],
        readonly stderr: string
    ) {
        super(message);
        this.name = 'OrcaCliError';
    }
}

/** Thrown when no `orca` binary can be found — the panel turns it into advice. */
export class OrcaCliMissingError extends OrcaCliError {
    constructor(readonly searched: readonly string[]) {
        super(
            'Orca is not installed where Studio looks for it. On your own computer, install Orca ' +
                '(github.com/stablyai/orca/releases) and open it once, or set ORCA_CLI to its orca ' +
                'executable; a session image carries it only when built with ' +
                `--build-arg STUDIO_ORCA_DEB_URL=…. Looked at: ${searched.join(', ')}`,
            [],
            ''
        );
        this.name = 'OrcaCliMissingError';
    }
}

/** The shape Node's failed `execFile` hands back. */
export interface InvocationFailure {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly message?: string;
    /**
     * `ENOENT` when there was no binary to run — and the process exit code,
     * as a number, when there was. Node overloads this field.
     */
    readonly code?: string | number;
    /** True when the timeout killed it, rather than the CLI deciding to stop. */
    readonly killed?: boolean;
}

/**
 * What a failed invocation should surface.
 *
 * Pure and exported because the interesting case cannot be reproduced by
 * spawning: on a machine with the Orca desktop app installed, Windows
 * resolves `orca` through its App Paths registry entry even with PATH empty,
 * so "nothing to run" is not a state a test can arrange there.
 *
 * ENOENT is the one that used to leak: the candidate list ends in bare names,
 * which `binary()` always accepts, so a missing CLI only ever showed up as the
 * loader's `spawn orca ENOENT` — and that told a session's owner nothing.
 */
export function invocationError(failure: InvocationFailure, args: readonly string[]): OrcaCliError {
    if (failure.code === 'ENOENT') {
        return new OrcaCliMissingError(findOrcaBinary().searched);
    }
    // A refused command still carries the envelope on stdout, and its message
    // beats "exit code 1".
    const envelope = parseEnvelope(failure.stdout ?? '');
    if (envelope && envelope.ok === false) {
        return new OrcaCliError(describeError(envelope), args, failure.stderr ?? '');
    }
    // Node's own message is `Command failed: <the entire command line>`, which
    // is what the panel used to show: the handle and the text that was typed,
    // and not one word about why. Name the command, give the reason.
    const what = args.slice(0, 2).join(' ') || 'invocation';
    const stderr = (failure.stderr ?? '').trim().split(/\r?\n/)[0] ?? '';
    if (failure.killed) {
        return new OrcaCliError(
            `orca ${what} was killed before it answered (timeout)`,
            args,
            failure.stderr ?? ''
        );
    }
    const exit = typeof failure.code === 'number' ? ` (exit ${failure.code})` : '';
    const reason = stderr || failure.message || 'no output';
    return new OrcaCliError(`orca ${what} failed${exit}: ${reason}`, args, failure.stderr ?? '');
}

/**
 * Where to run Orca commands.
 *
 * They used to run from the Theia backend's own working directory,
 * /app/browser-app, which is not an Orca-managed checkout — so every command
 * that needs a repository selector answered "Missing repo selector. Pass
 * --repo or run from inside an Orca-managed worktree", including the panel's
 * own Create-worktree button. The session's workspace IS the repository the
 * panel registers, so that is where these belong.
 *
 * Returns undefined when none of the candidates exists, which leaves the
 * inherited directory in place rather than pointing the CLI at nothing.
 */
/**
 * Which of [[ORCA_AGENTS]] this container can start.
 *
 * Resolved against PATH rather than by running anything: an agent's TUI is
 * not something to launch just to find out whether it exists. PATHEXT is
 * honoured so a developer machine answers as truthfully as a container.
 */
export function availableAgents(
    agents: readonly string[],
    env: NodeJS.ProcessEnv = process.env,
    exists: (path: string) => boolean = existsSync
): readonly string[] {
    const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const suffixes = ['', ...(env.PATHEXT ?? '').split(path.delimiter).filter(Boolean)];
    return agents.filter(agent =>
        dirs.some(dir => suffixes.some(suffix => exists(path.join(dir, agent + suffix))))
    );
}

export function commandCwd(
    env: NodeJS.ProcessEnv = process.env,
    exists: (path: string) => boolean = existsSync
): string | undefined {
    const candidates = [env.STUDIO_WORKSPACE_ROOT, env.STUDIO_REPOSITORY_ROOT, '/workspace'];
    for (const candidate of candidates) {
        const path = candidate?.trim();
        if (path && exists(path)) {
            return path;
        }
    }
    return undefined;
}

/**
 * Where the CLI might be, in order of authority.
 *
 * `ORCA_CLI` first so a session container can point at whatever it ships;
 * then where Orca's own installers put it on each platform; then the shell
 * command Orca's *Install CLI* action links (`/usr/local/bin/orca`, or
 * `~/.local/bin/orca` when that directory is missing, on macOS;
 * `~/.local/bin/orca-ide` on Linux — read off Orca 1.4.211's
 * `resolveCommandPath`); and the bare names last, looked up on PATH by
 * [[findOrcaBinary]].
 *
 * The explicit locations matter more than they look: an app started from the
 * Dock, the Start menu or a desktop launcher does not get the PATH a login
 * shell builds, so `~/.local/bin` and Homebrew's prefix are often not on it.
 */
export function candidateBinaries(env: NodeJS.ProcessEnv = process.env, platform: string = os.platform()): string[] {
    const out: string[] = [];
    const configured = env.ORCA_CLI?.trim();
    if (configured) {
        out.push(configured);
    }
    // The platform's own path module, so a test on one OS builds another's paths.
    const p = platform === 'win32' ? path.win32 : path.posix;
    const home = env.HOME ?? env.USERPROFILE ?? '';
    if (platform === 'win32') {
        // The installer is per-user by default (%LOCALAPPDATA%\Programs\orca);
        // a per-machine install goes under Program Files.
        const local = env.LOCALAPPDATA ?? (home ? p.join(home, 'AppData', 'Local') : '');
        if (local) {
            out.push(p.join(local, 'Programs', 'orca', 'resources', 'bin', 'orca.exe'));
        }
        const programFiles = env.ProgramFiles ?? env.PROGRAMFILES;
        if (programFiles) {
            out.push(p.join(programFiles, 'Orca', 'resources', 'bin', 'orca.exe'));
        }
    } else if (platform === 'darwin') {
        out.push('/Applications/Orca.app/Contents/Resources/bin/orca');
        if (home) {
            out.push(p.join(home, 'Applications', 'Orca.app', 'Contents', 'Resources', 'bin', 'orca'));
        }
        out.push('/usr/local/bin/orca');
        out.push('/opt/homebrew/bin/orca');
        if (home) {
            out.push(p.join(home, '.local', 'bin', 'orca'));
        }
    } else {
        // The Linux package (orca-ide_*.deb / .rpm) names the CLI `orca-ide`,
        // not `orca`: it installs /opt/Orca/resources/bin/orca-ide and links
        // it as /usr/bin/orca-ide. Verified against v1.4.197's amd64 deb.
        out.push('/opt/Orca/resources/bin/orca-ide');
        out.push('/usr/bin/orca-ide');
        out.push('/opt/orca/resources/bin/orca');
        out.push('/usr/local/bin/orca');
        // The AppImage installs nothing; its Install CLI action links this.
        if (home) {
            out.push(p.join(home, '.local', 'bin', 'orca-ide'));
            out.push(p.join(home, '.local', 'bin', 'orca'));
        }
    }
    // Both names, because the executable is `orca` on macOS/Windows and
    // `orca-ide` in the Linux packages.
    out.push('orca');
    out.push('orca-ide');
    return out;
}

/** What [[findOrcaBinary]] found, and everything it looked at to find it. */
export interface OrcaBinaryLookup {
    /** An absolute path to an executable Node can spawn without a shell. */
    readonly found?: string;
    readonly searched: readonly string[];
}

/** A bare command name, as opposed to a path. */
function isBareName(candidate: string): boolean {
    return !candidate.includes('/') && !candidate.includes('\\');
}

/**
 * The `orca` executable to run, resolved to an absolute path.
 *
 * Resolving the bare names here rather than leaving them to the loader does
 * three things the loader cannot:
 *
 * - the terminal bridge loads Orca's client from next to the CLI, which needs
 *   a real path — a bare `orca` was resolved against the backend's working
 *   directory, and the stream failed while the panel said "ready";
 * - on Windows only `.exe` and `.com` can be spawned without a shell (Node
 *   refuses a `.cmd` since the CVE-2024-27980 fix), so a `.cmd` shim on PATH
 *   is followed to the `orca.exe` beside it, which is where Orca's own shim
 *   points;
 * - "not installed" becomes an answer, instead of a loader ENOENT two calls
 *   later.
 *
 * `ORCA_CLI` is authoritative when set: pointing it at nothing is reported as
 * nothing, not papered over by another install.
 */
export function findOrcaBinary(
    env: NodeJS.ProcessEnv = process.env,
    platform: string = os.platform(),
    exists: (file: string) => boolean = existsSync
): OrcaBinaryLookup {
    const windows = platform === 'win32';
    const p = windows ? path.win32 : path.posix;
    const dirs = (env.PATH ?? env.Path ?? '').split(windows ? ';' : ':').filter(Boolean);
    // What runs without a shell, in the order PATHEXT names it.
    const spawnable = ['.com', '.exe'];
    const pathext = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map(ext => ext.trim().toLowerCase())
        .filter(Boolean);
    const direct = pathext.filter(ext => spawnable.includes(ext));
    const suffixes = windows ? (direct.length ? direct : spawnable) : [''];
    const shims = windows ? pathext.filter(ext => ext === '.cmd' || ext === '.bat') : [];

    const onPath = (name: string): string | undefined => {
        for (const dir of dirs) {
            for (const suffix of suffixes) {
                const file = p.join(dir, name + suffix);
                if (exists(file)) {
                    return file;
                }
            }
            for (const shim of shims) {
                const beside = p.join(dir, name + '.exe');
                if (exists(p.join(dir, name + shim)) && exists(beside)) {
                    return beside;
                }
            }
        }
        return undefined;
    };

    const configured = env.ORCA_CLI?.trim();
    const searched: string[] = [];
    for (const candidate of configured ? [configured] : candidateBinaries(env, platform)) {
        if (isBareName(candidate)) {
            searched.push(`${candidate} on PATH`);
            const found = onPath(candidate);
            if (found) {
                return { found, searched };
            }
        } else {
            searched.push(candidate);
            if (exists(candidate)) {
                return { found: candidate, searched };
            }
        }
    }
    return { searched };
}

/**
 * Where this IDE runs, for the advice the panel gives: a portal session
 * (the session gate hands it STUDIO_SESSION_TOKEN, and the container starts
 * Orca), or a person's own machine, where Orca is their own install.
 */
export function orcaHost(env: NodeJS.ProcessEnv = process.env): 'session' | 'local' {
    return env.STUDIO_SESSION_TOKEN?.trim() ? 'session' : 'local';
}

@injectable()
export class OrcaCli {

    /**
     * The executable found last time. Only a found one is remembered, and only
     * while it is still there: Orca installed, updated or removed while the IDE
     * runs is picked up on the next Refresh, not after a restart.
     */
    protected resolved: string | undefined;

    /**
     * The binary to run, as an absolute path.
     *
     * @throws OrcaCliMissingError when there is none; the status turns that
     * into install advice rather than an error.
     */
    binary(): string {
        if (this.resolved && existsSync(this.resolved)) {
            return this.resolved;
        }
        this.resolved = undefined;
        const lookup = findOrcaBinary();
        if (!lookup.found) {
            throw new OrcaCliMissingError(lookup.searched);
        }
        this.resolved = lookup.found;
        return lookup.found;
    }

    /**
     * Run one command and return its `result` payload.
     *
     * @param args the command and its flags, without `--json`.
     * @throws OrcaCliError when the process fails, the output is not JSON, or
     * the runtime answered `ok: false`.
     */
    async json<T>(args: readonly string[], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
        const full = [...args, '--json'];
        const binary = this.binary();
        let stdout: string;
        try {
            const result = await execFileAsync(binary, full, {
                timeout: Math.min(timeoutMs, MAX_TIMEOUT_MS),
                maxBuffer: OUTPUT_LIMIT,
                windowsHide: true,
                cwd: commandCwd()
            });
            stdout = result.stdout;
        } catch (error) {
            throw invocationError(error as InvocationFailure, full);
        }
        const envelope = parseEnvelope(stdout);
        if (!envelope) {
            throw new OrcaCliError(
                `orca ${args.join(' ')} did not answer JSON: ${stdout.slice(0, 200)}`,
                full,
                ''
            );
        }
        if (envelope.ok === false) {
            throw new OrcaCliError(describeError(envelope), full, '');
        }
        return envelope.result as T;
    }
}

interface Envelope {
    readonly id?: string;
    readonly ok?: boolean;
    readonly result?: unknown;
    readonly error?: unknown;
}

/**
 * Read the envelope out of stdout.
 *
 * Tolerant of leading noise on purpose: an update notice or a warning printed
 * before the payload must not turn a successful command into a parse failure.
 */
export function parseEnvelope(stdout: string): Envelope | undefined {
    const trimmed = stdout.trim();
    if (!trimmed) {
        return undefined;
    }
    const start = trimmed.indexOf('{');
    if (start < 0) {
        return undefined;
    }
    try {
        return JSON.parse(trimmed.slice(start)) as Envelope;
    } catch {
        return undefined;
    }
}

/** The most specific message an error envelope carries. */
export function describeError(envelope: Envelope): string {
    const error = envelope.error;
    if (typeof error === 'string') {
        return error;
    }
    if (error && typeof error === 'object') {
        const record = error as Record<string, unknown>;
        for (const key of ['message', 'detail', 'reason', 'code']) {
            const value = record[key];
            if (typeof value === 'string' && value) {
                return value;
            }
        }
        return JSON.stringify(error);
    }
    return 'orca refused the command without a reason';
}
