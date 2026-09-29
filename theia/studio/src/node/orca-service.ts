// `OrcaService` over the CLI: maps Orca's payloads onto the narrow shape the
// panel needs (see `../common/orca-protocol.ts`).
//
// Field extraction is deliberately defensive. Orca's worktree payload carries
// ~40 fields today (`linkedGitLabMR`, `sortOrder`, `topologyRevisions`, …) and
// it is not our contract: we read the handful we render and ignore the rest, so
// an upstream release that adds or renames a neighbouring field does not break
// the IDE. What we cannot tolerate silently is a *missing* identity (path,
// handle), so those fall back to something visible rather than to `undefined`.

import * as fs from 'fs';
import * as path from 'path';
import { injectable, inject } from '@theia/core/shared/inversify';
import {
    type OrcaCreateTaskRequest,
    type OrcaRepository,
    type OrcaRuntimeStatus,
    type OrcaService,
    type OrcaStartAgentRequest,
    type OrcaTerminal,
    type OrcaWaitOutcome,
    type OrcaWorktree,
    type OrcaWorktreeChange,
    ORCA_AGENTS
} from '../common/orca-protocol';
import { OrcaCli, OrcaCliError, OrcaCliMissingError, availableAgents, orcaHost } from './orca-cli';
import { NO_PROJECT_SYNC, type OrcaProjectSync } from '../common/desktop-orca-projects';
import { DesktopOrcaProjects, fileStore, type OrcaProjectsPort } from './desktop-orca-projects';
import { pairingOffer } from './orca-terminal-bridge';
import { GitExecutor } from './git-executor';

/** `terminal wait --for tui-idle` blocks until the agent stops producing. */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
/** Creating a checkout runs setup hooks; it is the slowest thing we call. */
const CREATE_TIMEOUT_MS = 180_000;
/** `orca open` launches the app and waits until its runtime answers. */
const OPEN_TIMEOUT_MS = 90_000;

/**
 * The git repositories a workspace root holds: the root itself when it is one,
 * or else the checkouts one level down -- which is how a Studio session lays
 * out its sources (`/workspace/<source>`). Hidden folders and `node_modules`
 * are not sources. A `.git` may be a directory or, in a linked worktree, a file.
 */
export async function gitRepositoriesAt(root: string): Promise<string[]> {
    const isRepository = (dir: string) => fs.promises.stat(path.join(dir, '.git')).then(() => true, () => false);
    if (await isRepository(root)) {
        return [root];
    }
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const found: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
            continue;
        }
        const dir = path.join(root, entry.name);
        if (await isRepository(dir)) {
            found.push(dir);
        }
    }
    return found.sort();
}

@injectable()
export class OrcaServiceImpl implements OrcaService {

    @inject(OrcaCli)
    protected readonly cli!: OrcaCli;

    // Changes are read with git, not with Orca: they are a property of the
    // checkout, and this is the executor the rest of the backend already uses.
    @inject(GitExecutor)
    protected readonly git!: GitExecutor;

    async status(): Promise<OrcaRuntimeStatus> {
        // Where the IDE runs and whether the terminal stream is paired are
        // known without asking Orca, and the panel needs both to say what to
        // do when Orca does not answer.
        const host = orcaHost();
        const paired = pairingOffer() !== undefined;
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
                    : app.running === true,
                agents: availableAgents(ORCA_AGENTS),
                host,
                binary: this.binaryPath(),
                paired
            };
        } catch (error) {
            // Not reachable is a normal state, not a failure of the IDE: the
            // panel renders the reason and how to fix it.
            return {
                reachable: false,
                state: 'unreachable',
                desktopRunning: false,
                error: message(error),
                cliMissing: error instanceof OrcaCliMissingError,
                host,
                binary: error instanceof OrcaCliMissingError ? undefined : this.binaryPath(),
                paired,
                // Reported even here: the panel's agent list does not depend
                // on a runtime answering, and an image missing its agents is
                // worth seeing next to a runtime that is missing too.
                agents: availableAgents(ORCA_AGENTS)
            };
        }
    }

    async listWorktrees(): Promise<OrcaWorktree[]> {
        const result = await this.cli.json<Record<string, unknown>>(['worktree', 'list']);
        const rows = Array.isArray(result.worktrees) ? result.worktrees : [];
        return rows.map(row => toWorktree(asRecord(row))).filter(w => w.path.length > 0);
    }

    async listRepositories(): Promise<OrcaRepository[]> {
        const result = await this.cli.json<Record<string, unknown>>(['repo', 'list']);
        const rows = Array.isArray(result.repos) ? result.repos : [];
        return rows
            .map(row => toRepository(asRecord(row)))
            .filter(repo => repo.id.length > 0);
    }

    async start(): Promise<OrcaRuntimeStatus> {
        if (orcaHost() === 'session') {
            // The container starts Orca, and `open` would try to bring up a
            // desktop window in a container that has no desktop.
            throw new Error('Orca starts with the session. If it is not running, restart the session.');
        }
        await this.cli.json(['open'], OPEN_TIMEOUT_MS);
        return this.status();
    }

    /** The executable in use, for the status line; undefined when there is none. */
    protected binaryPath(): string | undefined {
        try {
            return this.cli.binary?.();
        } catch {
            return undefined;
        }
    }

    /** The member's projects in their own Orca; made on first use, off a session only. */
    protected projects: DesktopOrcaProjects | undefined;

    protected desktopProjects(): DesktopOrcaProjects {
        if (!this.projects) {
            const port: OrcaProjectsPort = {
                listRepositories: () => this.listRepositories(),
                listWorktrees: () => this.listWorktrees(),
                listTerminals: selector => this.listTerminals(selector),
                uncommitted: async checkout => {
                    if (!fs.existsSync(checkout)) {
                        return 0;
                    }
                    return parseStatusRecords(await this.git.statusPorcelain(checkout)).length;
                },
                repositoriesAt: root => gitRepositoriesAt(root),
                addRepository: async repository => {
                    await this.cli.json(['repo', 'add', '--path', repository], CREATE_TIMEOUT_MS);
                },
                removeRepository: repoId => this.removeRepository(repoId)
            };
            this.projects = new DesktopOrcaProjects(port, fileStore());
        }
        return this.projects;
    }

    /**
     * Forget a repository in Orca, leaving every file where it is. The CLI
     * has no `repo rm`; a repository Orca knows is a project host setup, and
     * deleting a repo-backed setup is Orca's own "remove project"
     * (`removeProjectForHost`: state only, read off Orca 1.4.211).
     */
    protected async removeRepository(repoId: string): Promise<void> {
        const result = await this.cli.json<Record<string, unknown>>(['project', 'setups']);
        const setups = Array.isArray(result.setups) ? result.setups.map(asRecord) : [];
        const setup = setups.find(s => asString(s.repoId) === repoId && (asString(s.hostId) || 'local') === 'local');
        await this.cli.json(['project', 'setup-delete', '--setup', asString(setup?.id) || repoId]);
    }

    async trackProject(windowId: string, root: string | undefined): Promise<OrcaProjectSync> {
        if (orcaHost() !== 'local') {
            return NO_PROJECT_SYNC;
        }
        try {
            return await this.desktopProjects().track(windowId, root);
        } catch (error) {
            // Orca not installed or not running: nothing to add to or remove from.
            console.warn(`[orca] cannot sync the open project with Orca: ${message(error)}`);
            return NO_PROJECT_SYNC;
        }
    }

    async registerWorkspace(root: string): Promise<string[]> {
        if (orcaHost() === 'local') {
            // Recorded, so that Studio removes again what it added.
            return this.desktopProjects().add(root);
        }
        const repositories = await gitRepositoriesAt(root);
        for (const repository of repositories) {
            await this.cli.json(['repo', 'add', '--path', repository], CREATE_TIMEOUT_MS);
        }
        return repositories;
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

    /**
     * Uncommitted changes in one worktree.
     *
     * Empty on any failure, deliberately: Orca can still list a worktree
     * whose directory is gone, and a panel that threw here would lose the
     * runtime status and the terminal list along with it.
     */
    async changes(worktreePath: string): Promise<OrcaWorktreeChange[]> {
        const root = worktreePath.trim();
        if (!root) {
            return [];
        }
        try {
            const records = await this.git.statusPorcelain(root);
            return parseStatusRecords(records).map(entry => ({
                ...entry,
                absolutePath: path.join(root, entry.path)
            }));
        } catch (error) {
            console.warn(
                `[orca] cannot read changes in ${root}: ${error instanceof Error ? error.message : String(error)}`
            );
            return [];
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
        // Without --repo Orca infers the repository from the directory the CLI
        // runs in: a session's workspace, but on a desktop a folder that is no
        // checkout, where every task failed with "Missing repo selector".
        if (request.repo?.trim()) {
            args.push('--repo', request.repo.trim());
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

/**
 * `git status --porcelain=v1 -z` records into changes.
 *
 * Two details the format imposes. `-z` separates records with NUL and does
 * NOT quote or escape paths, so a path with a space or a quote in it arrives
 * intact. And a rename or copy is *two* records: the entry naming the new
 * path, then a bare record with the old one — which has to be consumed here,
 * or it would be reported as a change of its own with the next entry's code.
 */
export function parseStatusRecords(
    records: readonly string[]
): readonly { code: string; path: string }[] {
    const out: { code: string; path: string }[] = [];
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        // `XY path`: two status characters, a space, then the path.
        if (record.length < 4) {
            continue;
        }
        const code = record.slice(0, 2);
        const relative = record.slice(3);
        if (code.startsWith('R') || code.startsWith('C')) {
            index += 1; // the source path, which belongs to this same entry
        }
        if (relative) {
            out.push({ code, path: relative });
        }
    }
    return out;
}

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
        repoId: asString(row.repoId) || repoIdOf(id) || undefined,
        lastActivityAt: asNumber(row.lastActivityAt)
    };
}

/**
 * The repository half of a worktree id: Orca spells them `<repo-id>::<path>`
 * (`orca worktree create --help`), which is all an older payload without a
 * `repoId` field carries.
 */
function repoIdOf(worktreeId: string): string {
    const at = worktreeId.indexOf('::');
    return at > 0 ? worktreeId.slice(0, at) : '';
}

export function toRepository(row: Record<string, unknown>): OrcaRepository {
    const repoPath = asString(row.path);
    return {
        id: asString(row.id),
        path: repoPath,
        displayName: asString(row.displayName) || path.basename(repoPath) || asString(row.id)
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
    // stderr rides along on OrcaCliError and used to stop there, so the panel
    // showed a failure with no reason attached to it.
    if (error instanceof OrcaCliError) {
        const detail = error.stderr.trim().split(/\r?\n/)[0] ?? '';
        return detail && !error.message.includes(detail)
            ? `${error.message} — ${detail}`
            : error.message;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
