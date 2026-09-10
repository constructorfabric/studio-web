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
    constructor(searched: readonly string[]) {
        super(
            'the orca CLI is not installed. A session image carries it only when built ' +
                'with --build-arg STUDIO_ORCA_DEB_URL=…; elsewhere set ORCA_CLI to the ' +
                `binary, or install Orca (github.com/stablyai/orca). Looked at: ${searched.join(', ')}`,
            [],
            ''
        );
        this.name = 'OrcaCliMissingError';
    }
}

/**
 * Where the CLI might be, in order of authority.
 *
 * `ORCA_CLI` first so a session container can point at whatever it ships;
 * then the per-platform install location of the desktop app, which is what a
 * developer's machine has; `orca` on PATH last, since that is the case we can
 * neither verify nor blame precisely.
 */
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
        return new OrcaCliMissingError(candidateBinaries());
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

export function candidateBinaries(env: NodeJS.ProcessEnv = process.env, platform: string = os.platform()): string[] {
    const out: string[] = [];
    const configured = env.ORCA_CLI?.trim();
    if (configured) {
        out.push(configured);
    }
    const home = env.HOME ?? env.USERPROFILE ?? '';
    if (platform === 'win32') {
        const local = env.LOCALAPPDATA ?? (home ? path.join(home, 'AppData', 'Local') : '');
        if (local) {
            out.push(path.join(local, 'Programs', 'orca', 'resources', 'bin', 'orca.exe'));
        }
    } else if (platform === 'darwin') {
        out.push('/Applications/Orca.app/Contents/Resources/bin/orca');
        if (home) {
            out.push(path.join(home, 'Applications', 'Orca.app', 'Contents', 'Resources', 'bin', 'orca'));
        }
    } else {
        // The Linux package (orca-ide_*.deb / .rpm) names the CLI `orca-ide`,
        // not `orca`: it installs /opt/Orca/resources/bin/orca-ide and links
        // it as /usr/bin/orca-ide. Verified against v1.4.197's amd64 deb.
        out.push('/opt/Orca/resources/bin/orca-ide');
        out.push('/usr/bin/orca-ide');
        out.push('/opt/orca/resources/bin/orca');
        out.push('/usr/local/bin/orca');
    }
    // Both names, because the executable is `orca` on macOS/Windows and
    // `orca-ide` in the Linux packages.
    out.push('orca');
    out.push('orca-ide');
    return out;
}

@injectable()
export class OrcaCli {

    /** Resolved lazily and remembered: the answer cannot change under us. */
    protected resolved: string | undefined;

    /**
     * The binary to run.
     *
     * The bare names at the end of the candidate list are always accepted
     * here — resolving a name against PATH (and PATHEXT, on Windows) is the
     * loader's job, not ours. Which means this cannot report a missing CLI:
     * the failure surfaces when the spawn fails, and [[OrcaCliMissingError]]
     * is raised there instead.
     */
    binary(): string {
        if (this.resolved) {
            return this.resolved;
        }
        const candidates = candidateBinaries();
        for (const candidate of candidates) {
            // The bare names are not paths — let execFile resolve them
            // against PATH and report the failure if they are not there.
            if (candidate === 'orca' || candidate === 'orca-ide' || existsSync(candidate)) {
                this.resolved = candidate;
                return candidate;
            }
        }
        throw new OrcaCliMissingError(candidates);
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
