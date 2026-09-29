// The IDE-side contract for driving an Orca runtime (github.com/stablyai/orca,
// MIT) from Studio.
//
// # Why the CLI and not Orca's internals
//
// Orca is one Electron project, not a set of packages: its `pnpm-workspace.yaml`
// declares `packages: []` and the engine ships as a single ~7 MB bundle bound to
// Electron plus patched `node-pty` / `xterm`. There is nothing to import. What it
// does expose is a client/server split we can use as-is: `orca serve` runs a
// headless runtime, every CLI command takes `--json` (and `--environment` to
// target a remote runtime), and `orca agent-context --json` publishes the whole
// surface — 234 commands under `schemaVersion: 1`. So Studio speaks to the
// runtime the same way Orca's own CLI does, and upgrades come from upstream.
//
// The backend holds that conversation (see `src/node/orca-service.ts`); the
// frontend only sees the handful of operations below.

import type { OrcaProjectSync } from './desktop-orca-projects';

export const orcaServicePath = '/services/studio-orca';
/** DI key for the proxy on the frontend and the impl on the backend. */
export const OrcaService = Symbol('OrcaService');

/** Agents the panel offers. Orca accepts any CLI agent id it knows. */
export const ORCA_AGENTS = ['claude', 'codex', 'opencode'] as const;
export type OrcaAgent = (typeof ORCA_AGENTS)[number];

/** Is a runtime reachable, and which one. */
export interface OrcaRuntimeStatus {
    /** False when no runtime answers — the panel then explains how to start one. */
    readonly reachable: boolean;
    /** `ready`, `starting`, … as reported by the runtime; `unknown` when absent. */
    readonly state: string;
    readonly appVersion?: string;
    /**
     * True when a desktop Orca window is open on this host, false for a
     * headless `orca serve` — the session container's case.
     */
    readonly desktopRunning: boolean;
    /**
     * The agents this container can actually start, out of [[ORCA_AGENTS]].
     *
     * Orca runs an agent as its CLI in a terminal, so an agent it does not
     * have is a `command not found` in a TUI two clicks later. The panel
     * offers this list instead of the full one.
     */
    readonly agents?: readonly string[];
    /** Why the runtime could not be reached, when it could not. */
    readonly error?: string;
    /**
     * True when there is no `orca` binary at all, as opposed to a binary whose
     * runtime is not answering. The two need different advice: one is fixed by
     * rebuilding the image, the other by starting a runtime.
     */
    readonly cliMissing?: boolean;
    /**
     * Where this IDE runs, as the backend knows it: `session` in a portal
     * session container (Orca starts with the container, the image carries
     * it), `local` anywhere else — the desktop app, a developer's
     * `theia start` — where Orca is the member's own install. The advice for
     * every failure differs between the two. Absent from an older backend,
     * which only ever ran in a session.
     */
    readonly host?: 'session' | 'local';
    /** The `orca` executable Studio found and runs, when it found one. */
    readonly binary?: string;
    /**
     * Whether a pairing for the terminal stream is in place. Only the
     * terminal tabs need it; the panel itself works without one.
     */
    readonly paired?: boolean;
}

/** One repository Orca knows, as `orca repo list` names it. */
export interface OrcaRepository {
    readonly id: string;
    readonly path: string;
    readonly displayName: string;
}

/** One Orca-managed checkout: a branch, a path, and its agent activity. */
export interface OrcaWorktree {
    readonly id: string;
    readonly path: string;
    /** Short branch name (`refs/heads/` stripped). */
    readonly branch: string;
    readonly displayName: string;
    readonly comment: string;
    /** Orca's own lifecycle label, e.g. `in-progress`. */
    readonly status: string;
    readonly isMain: boolean;
    /**
     * The Orca repository this checkout belongs to. Every repository has a
     * worktree on `main`, so without it two repositories read as two
     * identical rows.
     */
    readonly repoId?: string;
    /** Epoch millis of the last agent output, when Orca reports one. */
    readonly lastActivityAt?: number;
}

/** A live terminal in a worktree — usually an agent's TUI. */
export interface OrcaTerminal {
    /** The handle every `terminal *` command takes. */
    readonly handle: string;
    readonly title: string;
    /** `claude`, `codex`, … when Orca recognized an agent in this terminal. */
    readonly agent?: string;
    readonly connected: boolean;
    readonly worktreePath: string;
    /** Last line Orca captured — enough to see whether the agent is working. */
    readonly preview: string;
    readonly lastOutputAt?: number;
    /**
     * What Orca warned about when it created this terminal.
     *
     * A headless runtime has no UI to adopt the tab, so it answers "running,
     * but Orca could not make it discoverable" and keeps the terminal on a
     * background surface. The process runs and takes input either way — the
     * panel shows this so nobody reads it as a failure.
     */
    readonly warning?: string;
}

/**
 * One uncommitted change in a worktree, as `git status` sees it.
 *
 * This is what an agent leaves behind, and the panel's reason for asking: a
 * worktree's `status` says the agent is done, not what it did.
 */
export interface OrcaWorktreeChange {
    /** Porcelain code, e.g. ` M`, `A `, `??`. Two characters, staged first. */
    readonly code: string;
    /** Path relative to the worktree root — what a person reads. */
    readonly path: string;
    /** Absolute path, so the panel can open the file without knowing the root. */
    readonly absolutePath: string;
}

/** Start a task in a *new* checkout: Orca creates the worktree and the agent. */
export interface OrcaCreateTaskRequest {
    /** Becomes the branch and the worktree directory name. */
    readonly name: string;
    readonly agent: string;
    readonly prompt: string;
    /** Optional issue to link the worktree to (`--issue`). */
    readonly issue?: number;
    /**
     * The repository to branch from (`--repo`), as an Orca selector:
     * `id:<id>` or `path:<path>`. Without it Orca infers the repository from
     * the directory the CLI runs in, which on a desktop is no checkout at all.
     */
    readonly repo?: string;
}

/** Start another agent in a checkout that already exists. */
export interface OrcaStartAgentRequest {
    /** Worktree selector: `active`, `path:…`, `branch:…` or an id. */
    readonly worktree: string;
    readonly agent: string;
    /** Sent to the agent's stdin once its TUI is up. Optional. */
    readonly prompt?: string;
}

/** How a wait ended. `idle` is the interesting one: the agent stopped typing. */
export type OrcaWaitOutcome = 'idle' | 'exit' | 'timeout';

export interface OrcaService {
    status(): Promise<OrcaRuntimeStatus>;
    listWorktrees(): Promise<OrcaWorktree[]>;
    /** The repositories Orca knows, to group the worktrees by. */
    listRepositories(): Promise<OrcaRepository[]>;
    /**
     * Start Orca on this computer (`orca open`: launches the app and waits
     * for its runtime) and answer with the status after. Off a session only:
     * a session's runtime starts with the container, and this refuses there.
     */
    start(): Promise<OrcaRuntimeStatus>;
    /**
     * Register a checkout with the runtime, so its worktree appears.
     *
     * Needed because a session container starts the runtime with a clean state
     * directory on every boot (see `theia/docker/entrypoint.sh`): the workspace
     * on the volume outlives it, the runtime's knowledge of it does not.
     * Idempotent — Orca answers with the same repo for a path it already has.
     *
     * The workspace is registered repository by repository: a Studio session's
     * root is a plain folder holding each source's checkout, which Orca
     * refuses as "not a valid git repository". Answers with the repositories
     * it registered.
     */
    registerWorkspace(path: string): Promise<string[]>;
    /**
     * A window reports the project it has open (undefined: none), on start
     * and whenever it changes. On a member's machine this releases from Orca
     * the repositories Studio added for projects no window has open any more,
     * and answers which of this project's repositories Orca does not know
     * (see ./desktop-orca-projects.ts). In a session it does nothing and
     * answers `enabled: false`.
     */
    trackProject(windowId: string, root: string | undefined): Promise<OrcaProjectSync>;
    currentWorktree(): Promise<OrcaWorktree | undefined>;
    listTerminals(worktree: string): Promise<OrcaTerminal[]>;
    /** Uncommitted changes in one worktree, by absolute path. */
    changes(worktreePath: string): Promise<OrcaWorktreeChange[]>;
    createTask(request: OrcaCreateTaskRequest): Promise<OrcaWorktree | undefined>;
    startAgent(request: OrcaStartAgentRequest): Promise<OrcaTerminal | undefined>;
    send(handle: string, text: string, enter: boolean): Promise<void>;
    interrupt(handle: string): Promise<void>;
    waitForIdle(handle: string, timeoutMs: number): Promise<OrcaWaitOutcome>;
    /** Recent output of a terminal, newest last. */
    read(handle: string): Promise<string>;
}
