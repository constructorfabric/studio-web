// `OrcaService` over the CLI: maps Orca's payloads onto the narrow shape the
// panel needs (see `../common/orca-protocol.ts`).
//
// Field extraction is deliberately defensive. Orca's worktree payload carries
// ~40 fields today (`linkedGitLabMR`, `sortOrder`, `topologyRevisions`, …) and
// it is not our contract: we read the handful we render and ignore the rest, so
// an upstream release that adds or renames a neighbouring field does not break
// the IDE. What we cannot tolerate silently is a *missing* identity (path,
// handle), so those fall back to something visible rather than to `undefined`.

import { injectable, inject } from '@theia/core/shared/inversify';
import {
    type OrcaCreateTaskRequest,
    type OrcaRuntimeStatus,
    type OrcaService,
    type OrcaStartAgentRequest,
    type OrcaTerminal,
    type OrcaWaitOutcome,
    type OrcaWorktree
} from '../common/orca-protocol';
import { OrcaCli, OrcaCliError } from './orca-cli';

/** `terminal wait --for tui-idle` blocks until the agent stops producing. */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
/** Creating a checkout runs setup hooks; it is the slowest thing we call. */
const CREATE_TIMEOUT_MS = 180_000;

@injectable()
export class OrcaServiceImpl implements OrcaService {

    @inject(OrcaCli)
    protected readonly cli!: OrcaCli;

    async status(): Promise<OrcaRuntimeStatus> {
        try {
            const result = await this.cli.json<Record<string, unknown>>(['status']);
            const runtime = asRecord(result.runtime);
            const app = asRecord(result.app);
            return {
                reachable: runtime.reachable === true,
                state: asString(runtime.state) || 'unknown',
                appVersion: asString(runtime.appVersion) || undefined,
                // `app.running` is true for a headless `orca serve` too — it
                // reports the Orca process, not a window. Whether a desktop
                // window exists is `desktopWindowStatus`: `available` when one
                // is open, `openable` when the runtime could open one but has
                // not (which is exactly the headless case).
                desktopRunning: asString(app.desktopWindowStatus)
                    ? asString(app.desktopWindowStatus) === 'available'
                    : app.running === true
            };
        } catch (error) {
            // Not reachable is a normal state, not a failure of the IDE: the
            // panel renders the reason and how to fix it.
            return {
                reachable: false,
                state: 'unreachable',
                desktopRunning: false,
                error: message(error)
            };
        }
    }

    async listWorktrees(): Promise<OrcaWorktree[]> {
        const result = await this.cli.json<Record<string, unknown>>(['worktree', 'list']);
        const rows = Array.isArray(result.worktrees) ? result.worktrees : [];
        return rows.map(row => toWorktree(asRecord(row))).filter(w => w.path.length > 0);
    }

    async registerWorkspace(path: string): Promise<void> {
        await this.cli.json(['repo', 'add', '--path', path], CREATE_TIMEOUT_MS);
    }

    async currentWorktree(): Promise<OrcaWorktree | undefined> {
        try {
            const result = await this.cli.json<Record<string, unknown>>(['worktree', 'current']);
            const row = asRecord(result.worktree);
            const worktree = toWorktree(row);
            return worktree.path ? worktree : undefined;
        } catch {
            // The IDE may be opened on a folder Orca does not manage. That is
            // not an error — it just means "no current worktree".
            return undefined;
        }
    }

    async listTerminals(worktree: string): Promise<OrcaTerminal[]> {
        const result = await this.cli.json<Record<string, unknown>>([
            'terminal', 'list', '--worktree', worktree
        ]);
        const rows = Array.isArray(result.terminals) ? result.terminals : [];
        return rows.map(row => toTerminal(asRecord(row))).filter(t => t.handle.length > 0);
    }

    async createTask(request: OrcaCreateTaskRequest): Promise<OrcaWorktree | undefined> {
        const args = [
            'worktree', 'create',
            '--name', request.name,
            '--agent', request.agent,
            '--prompt', request.prompt
        ];
        if (request.issue !== undefined) {
            args.push('--issue', String(request.issue));
        }
        const result = await this.cli.json<Record<string, unknown>>(args, CREATE_TIMEOUT_MS);
        const row = asRecord(result.worktree ?? result);
        const worktree = toWorktree(row);
        return worktree.path ? worktree : undefined;
    }

    async startAgent(request: OrcaStartAgentRequest): Promise<OrcaTerminal | undefined> {
        const result = await this.cli.json<Record<string, unknown>>([
            'terminal', 'create',
            '--worktree', request.worktree,
            '--command', request.agent,
            '--title', `${request.agent} · studio`
        ]);
        const row = asRecord(result.terminal ?? result);
        const terminal = toTerminal(row);
        if (!terminal.handle) {
            return undefined;
        }
        if (request.prompt) {
            // The TUI needs to be up before it can read stdin. Orca gives us
            // `tui-idle` for exactly this: wait for the agent to settle at its
            // prompt, then type. A timeout here is not fatal — the terminal
            // exists and the human can type into it in Orca.
            await this.waitForIdle(terminal.handle, 30_000).catch(() => 'timeout');
            await this.send(terminal.handle, request.prompt, true);
        }
        return terminal;
    }

    async send(handle: string, text: string, enter: boolean): Promise<void> {
        const args = ['terminal', 'send', '--terminal', handle, '--text', text];
        if (enter) {
            args.push('--enter');
        }
        await this.cli.json(args);
    }

    async interrupt(handle: string): Promise<void> {
        await this.cli.json(['terminal', 'send', '--terminal', handle, '--interrupt']);
    }

    async waitForIdle(handle: string, timeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS): Promise<OrcaWaitOutcome> {
        try {
            const result = await this.cli.json<Record<string, unknown>>(
                ['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(timeoutMs)],
                timeoutMs + 15_000
            );
            return toWaitOutcome(result);
        } catch (error) {
            // A wait that ran out is an answer, not a failure: the agent is
            // still working, and the caller decides whether to keep waiting.
            if (error instanceof OrcaCliError && /timed?\s*out/i.test(error.message)) {
                return 'timeout';
            }
            throw error;
        }
    }

    async read(handle: string): Promise<string> {
        const result = await this.cli.json<Record<string, unknown>>(['terminal', 'read', '--terminal', handle]);
        return terminalTail(result);
    }
}

// ── payload mapping ────────────────────────────────────────────────────────

export function toWorktree(row: Record<string, unknown>): OrcaWorktree {
    // `worktree ps` names the id `worktreeId` where `worktree list` names it
    // `id`; both are the same string and either may reach us.
    const id = asString(row.id) || asString(row.worktreeId);
    const path = asString(row.path);
    const branch = shortBranch(asString(row.branch));
    return {
        id,
        path,
        branch,
        displayName: asString(row.displayName) || branch || path,
        comment: asString(row.comment),
        status: asString(row.workspaceStatus) || 'unknown',
        isMain: row.isMainWorktree === true,
        lastActivityAt: asNumber(row.lastActivityAt)
    };
}

export function toTerminal(row: Record<string, unknown>): OrcaTerminal {
    return {
        handle: asString(row.handle),
        title: asString(row.title) || asString(row.handle),
        agent: asString(row.agentIdentity) || undefined,
        connected: row.connected === true,
        worktreePath: asString(row.worktreePath),
        preview: asString(row.preview),
        lastOutputAt: asNumber(row.lastOutputAt),
        warning: asString(row.warning) || undefined
    };
}

/**
 * The output of a terminal, as `terminal read` reports it.
 *
 * The payload nests it: `result.terminal.tail` is an array of lines, newest
 * last, next to a cursor and a `status`. Verified against Orca 1.4.197 in a
 * container; the flatter shapes stay as a fallback for a release that moves it.
 */
export function terminalTail(result: Record<string, unknown>): string {
    const terminal = asRecord(result.terminal);
    for (const source of [terminal.tail, result.tail, result.lines]) {
        if (Array.isArray(source)) {
            return source.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
        }
    }
    for (const key of ['text', 'output', 'content', 'data']) {
        const value = terminal[key] ?? result[key];
        if (typeof value === 'string') {
            return value;
        }
    }
    return '';
}

/** `refs/heads/feat/x` → `feat/x`; anything else is passed through. */
export function shortBranch(branch: string): string {
    return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch;
}

/**
 * What a `terminal wait` payload says happened.
 *
 * Orca has named this field differently across releases, so match on the
 * meaning rather than on one key: anything mentioning idle is idle, an exit is
 * an exit, and everything else is a timeout — the safe reading, because a
 * caller that believes "idle" too early sends input into a busy TUI.
 */
export function toWaitOutcome(result: Record<string, unknown>): OrcaWaitOutcome {
    const text = [result.outcome, result.status, result.reason, result.for, result.result]
        .filter(v => typeof v === 'string')
        .join(' ')
        .toLowerCase();
    if (text.includes('idle')) {
        return 'idle';
    }
    if (text.includes('exit')) {
        return 'exit';
    }
    if (result.idle === true) {
        return 'idle';
    }
    if (result.exited === true) {
        return 'exit';
    }
    return 'timeout';
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function message(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
