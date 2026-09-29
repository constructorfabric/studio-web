import * as fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

/**
 * How the IDE launches `cfs`, the Constructor Studio CLI -- one answer for
 * every caller (the map runner, the kit installer), so the session image and
 * a desktop are chosen the same way everywhere.
 *
 * The session image has `cfs` on PATH (/opt/cfs/bin). A desktop gets it from
 * the Constructor Studio CLI extension (theia/studio-cli), which it fetches
 * like Claude Code and Codex and whose folder electron-app/desktop-main.js
 * names in `STUDIO_CFS_RUNTIME`. That runtime wins over whatever the member
 * installed themselves: it is pinned to the version the session runs
 * (theia/cfs.json).
 */
export interface CfsCommand {
    readonly executable: string;
    /** Arguments that come before cfs's own: the script or module, for Python. */
    readonly prefixArguments: readonly string[];
    /** How the command is named in results and errors. */
    readonly identity: string;
    /** Variables the command runs with, over the IDE's own. */
    readonly env?: Readonly<Record<string, string>>;
    /** The skill engine this command is pinned to, for `cfs init --version`. */
    readonly engine?: string;
}

export const CFS_ON_PATH: CfsCommand = Object.freeze({ executable: 'cfs', prefixArguments: [], identity: 'cfs' });

/** `STUDIO_CFS_COMMAND`: an executable, never a shell fragment -- it is launched without a shell. */
export function configuredCfsCommand(env: NodeJS.ProcessEnv = process.env): CfsCommand | undefined {
    const configured = env.STUDIO_CFS_COMMAND?.trim();
    if (!configured) {
        return undefined;
    }
    if (configured.includes('\0')) {
        throw new Error('STUDIO_CFS_COMMAND contains an invalid NUL byte');
    }
    return { executable: configured, prefixArguments: [], identity: configured };
}

/**
 * The Constructor Studio CLI extension's runtime (`STUDIO_CFS_RUNTIME`), once
 * it has been fetched: its Python runs `cfs` as a module, with the runtime's
 * own home, where its engine is cached. `cfs` and the engine's `init` resolve
 * the engine from the home directory, so a home of its own is what keeps the
 * pin -- a member's `~/.cf-studio` is neither read nor written. UTF-8, since
 * Python otherwise writes a pipe in the Windows code page and stops at the
 * first character of cfs's output it lacks; no version check, since the
 * engine is pinned and its advice would be `cfs update`.
 *
 * Looked up on every call, not once: the extension may arrive while the IDE
 * runs.
 */
export function runtimeCfsCommand(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): CfsCommand | undefined {
    const runtime = env.STUDIO_CFS_RUNTIME?.trim();
    if (!runtime) {
        return undefined;
    }
    const python = platform === 'win32'
        ? path.join(runtime, 'python', 'python.exe')
        : path.join(runtime, 'python', 'bin', 'python3');
    if (!existsSync(python)) {
        return undefined;
    }
    const home = path.join(runtime, 'home');
    return {
        executable: python,
        prefixArguments: ['-m', 'studio_proxy'],
        identity: 'cfs (Constructor Studio CLI extension)',
        env: { HOME: home, USERPROFILE: home, PYTHONUTF8: '1', CFS_NO_VERSION_CHECK: '1' },
        engine: pinnedEngine(runtime)
    };
}

/** For a caller that runs one command and reports its failure: the configured one, the extension's, else `cfs` from PATH. */
export function cfsCommand(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CfsCommand {
    return configuredCfsCommand(env) ?? runtimeCfsCommand(env, platform) ?? CFS_ON_PATH;
}

/** The environment to launch `command` with: the IDE's own, unless the command brings variables of its own. */
export function cfsEnvironment(command: CfsCommand, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | undefined {
    return command.env ? { ...env, ...command.env } : undefined;
}

/**
 * Every way to reach `cfs` for a Workspace, in order: the configured command,
 * the extension's runtime, `cfs` from PATH, then the Workspace's own engine
 * script through Python. A caller probes them in turn and takes the first that
 * answers.
 *
 * The interpreter depends on the platform: Windows has no `python3` but for the
 * Store's stub, which opens the Store instead of running anything; it has
 * `python`, or the `py` launcher.
 */
export async function cfsCommandCandidates(
    workspaceRoot: string,
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): Promise<readonly CfsCommand[]> {
    const candidates: CfsCommand[] = [];
    const configured = configuredCfsCommand(env);
    if (configured) {
        candidates.push(configured);
    }
    const runtime = runtimeCfsCommand(env, platform);
    if (runtime) {
        candidates.push(runtime);
    }
    if (configured?.executable !== CFS_ON_PATH.executable) {
        candidates.push(CFS_ON_PATH);
    }

    const localScript = path.join(workspaceRoot, '.cf-studio', '.core', 'skills', 'studio', 'scripts', 'studio.py');
    let script: string;
    try {
        script = await fs.realpath(localScript);
    } catch (error) {
        if (isMissingFileError(error)) {
            return candidates;
        }
        throw error;
    }
    const interpreters: ReadonlyArray<readonly [string, readonly string[]]> = platform === 'win32'
        ? [['python', []], ['py', ['-3']]]
        : [['python3', []]];
    for (const [executable, flags] of interpreters) {
        candidates.push({ executable, prefixArguments: [...flags, script], identity: script });
    }
    return candidates;
}

/** `runtime/cfs.json`'s engine, as build_vsix.py writes it; undefined when it cannot be read. */
function pinnedEngine(runtime: string): string | undefined {
    try {
        const engine = (JSON.parse(readFileSync(path.join(runtime, 'cfs.json'), 'utf8')) as { engine?: unknown }).engine;
        return typeof engine === 'string' && /^v?[0-9][0-9A-Za-z.+-]*$/u.test(engine) ? engine : undefined;
    } catch {
        return undefined;
    }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === 'object' && error !== null && 'code' in error
        && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
