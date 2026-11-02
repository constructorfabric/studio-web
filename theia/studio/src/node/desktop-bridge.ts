/**
 * The bridge between a desktop Studio and the portal (ADR-0027 phases 4 and 5).
 *
 * Nothing may dial a member's laptop, so both directions start here:
 *
 * - **Events** go out to `/studio-theia/v1/desktop-sessions/{id}/events`, in the
 *   envelope a container posts to its S2S ingress, under the member's own
 *   token. The lease is the session: Studio checks the member holds it.
 * - **Commands** come in on `studio-events`, the portal's own channel, which
 *   this desktop reads under the member's token. Of what it hears it keeps
 *   only `desktop_session.command_sent` about a lease it holds, and hands each
 *   to the window showing that workspace, which runs it and says how it went.
 *
 * A desktop has no operation queue (its Git is `desktop-git.ts`), so of the
 * commands a container takes it runs `open_in_editor`, and answers the others
 * that it cannot.
 */

export const DESKTOP_EVENTS_PATH = (leaseId: string) =>
    `/studio-theia/v1/desktop-sessions/${encodeURIComponent(leaseId)}/events`;
export const EVENTS_STREAM_PATH = '/studio-events/v1/stream';
export const COMMAND_SENT = 'desktop_session.command_sent';

/** One command the portal sent this desktop. */
export interface DesktopCommand {
    readonly commandId: string;
    readonly workspaceId: string;
    readonly command: string;
    readonly params: Record<string, unknown>;
    /** When this desktop heard it, for dropping what nobody picked up. */
    readonly heardAt: number;
}

/** What came of one command, as the window reports it. */
export interface CommandOutcome {
    readonly commandId: string;
    readonly command: string;
    readonly ok: boolean;
    readonly detail?: string;
}

/**
 * The SSE frames complete in `buffer`, and what is left of it. Only `data:`
 * lines count — the channel sends unnamed frames and `:` keep-alives — and a
 * frame that is not JSON is skipped rather than ending the stream.
 */
export function sseFrames(buffer: string): { frames: unknown[]; rest: string } {
    const normalized = buffer.replace(/\r\n/g, '\n');
    const blocks = normalized.split('\n\n');
    const rest = blocks.pop() ?? '';
    const frames: unknown[] = [];
    for (const block of blocks) {
        const data = block
            .split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, ''))
            .join('\n');
        if (!data) {
            continue;
        }
        try {
            frames.push(JSON.parse(data));
        } catch {
            // Not ours to understand; the next frame may be.
        }
    }
    return { frames, rest };
}

/**
 * The command in `frame`, when it is one sent to a lease this desktop holds.
 * `workspaceOf` answers a lease id with the workspace it holds open.
 */
export function commandIn(
    frame: unknown,
    workspaceOf: (leaseId: string) => string | undefined,
    now: number,
): DesktopCommand | undefined {
    if (!frame || typeof frame !== 'object') {
        return undefined;
    }
    const f = frame as { kind?: unknown; subject_type?: unknown; subject_id?: unknown; payload?: unknown };
    if (f.kind !== COMMAND_SENT || f.subject_type !== 'desktop_session' || typeof f.subject_id !== 'string') {
        return undefined;
    }
    const workspaceId = workspaceOf(f.subject_id);
    const p = (f.payload ?? {}) as { command_id?: unknown; command?: unknown; params?: unknown; workspace_id?: unknown };
    if (!workspaceId || typeof p.command_id !== 'string' || typeof p.command !== 'string') {
        return undefined;
    }
    // The lease names the workspace; a payload that disagrees is not trusted.
    if (typeof p.workspace_id === 'string' && p.workspace_id !== workspaceId) {
        return undefined;
    }
    const params = p.params && typeof p.params === 'object' && !Array.isArray(p.params)
        ? p.params as Record<string, unknown>
        : {};
    return { commandId: p.command_id, workspaceId, command: p.command, params, heardAt: now };
}

/** How long a command waits for a window, and how many may wait per workspace. */
export const COMMAND_TTL_MS = 120_000;
export const COMMANDS_KEPT = 20;

/**
 * Commands waiting for the window that shows their workspace. A window asks
 * with a long poll; a command nobody picks up within {@link COMMAND_TTL_MS}
 * is dropped, since opening a file minutes after it was asked surprises more
 * than it helps.
 */
export class CommandInbox {
    protected readonly waiting = new Map<string, DesktopCommand[]>();
    protected readonly listeners = new Map<string, Set<() => void>>();

    constructor(protected readonly now: () => number = Date.now) { }

    push(command: DesktopCommand): void {
        const queue = this.fresh(command.workspaceId);
        if (queue.some(c => c.commandId === command.commandId)) {
            return; // the stream reconnected and replayed it
        }
        queue.push(command);
        queue.splice(0, Math.max(0, queue.length - COMMANDS_KEPT));
        this.waiting.set(command.workspaceId, queue);
        for (const wake of this.listeners.get(command.workspaceId) ?? []) {
            wake();
        }
    }

    /** Take the workspace's commands, waiting up to `waitMs` for one. */
    async take(workspaceId: string, waitMs: number): Promise<DesktopCommand[]> {
        if (this.fresh(workspaceId).length === 0 && waitMs > 0) {
            await new Promise<void>(resolve => {
                const listeners = this.listeners.get(workspaceId) ?? new Set();
                this.listeners.set(workspaceId, listeners);
                const done = () => {
                    clearTimeout(timer);
                    listeners.delete(done);
                    resolve();
                };
                const timer = setTimeout(done, waitMs);
                listeners.add(done);
            });
        }
        const taken = this.fresh(workspaceId);
        this.waiting.delete(workspaceId);
        return taken;
    }

    /** Drop everything: signed out, or another Studio. */
    clear(): void {
        this.waiting.clear();
    }

    protected fresh(workspaceId: string): DesktopCommand[] {
        const now = this.now();
        return (this.waiting.get(workspaceId) ?? []).filter(c => now - c.heardAt < COMMAND_TTL_MS);
    }
}

/** The forwarder's envelope, as a container posts it (studio-event-forwarder.ts). */
export function eventEnvelope(workspaceId: string, kind: string, event: unknown): string {
    return JSON.stringify({ session: { workspaceId }, kind, event });
}

/** The `workspace-activity` event that says what came of a command. */
export function commandActivity(outcome: CommandOutcome, at: string): Record<string, unknown> {
    return {
        type: 'desktop-command',
        commandId: outcome.commandId,
        command: outcome.command,
        ok: outcome.ok,
        detail: outcome.detail,
        at,
    };
}

/** How long to wait before the `attempt`-th reconnect: 2 s doubling to a minute. */
export function reconnectDelay(attempt: number): number {
    return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt));
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Where the bridge talks to, and as whom. */
export interface BridgeTarget {
    readonly studioUrl: string;
    readonly gatewayPrefix: string;
    readonly accessToken: () => Promise<string>;
}

/** Post one event for a lease. Best effort: a lost event is not a failure here. */
export async function postDesktopEvent(
    doFetch: Fetch,
    target: BridgeTarget,
    leaseId: string,
    workspaceId: string,
    kind: string,
    event: unknown,
): Promise<boolean> {
    try {
        const answer = await doFetch(`${target.studioUrl}${target.gatewayPrefix}${DESKTOP_EVENTS_PATH(leaseId)}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${await target.accessToken()}`,
                'Content-Type': 'application/json',
            },
            body: eventEnvelope(workspaceId, kind, event),
        });
        return answer.ok;
    } catch {
        return false;
    }
}

/**
 * Listens on `studio-events` while this desktop holds a lease, and puts the
 * commands addressed to it in the inbox. Reconnects with a growing delay, and
 * with a fresh token each time, so an expired one ends only one connection.
 */
export class CommandListener {
    protected running = false;
    protected abort: AbortController | undefined;
    protected attempt = 0;

    constructor(
        protected readonly target: () => BridgeTarget | undefined,
        protected readonly workspaceOf: (leaseId: string) => string | undefined,
        protected readonly inbox: CommandInbox,
        protected readonly doFetch: Fetch = (input, init) => fetch(input, init),
        protected readonly wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    ) { }

    get listening(): boolean {
        return this.running;
    }

    start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        void this.loop();
    }

    stop(): void {
        this.running = false;
        this.abort?.abort();
        this.abort = undefined;
    }

    protected async loop(): Promise<void> {
        while (this.running) {
            const target = this.target();
            if (!target) {
                this.running = false;
                return;
            }
            const heard = await this.listenOnce(target);
            if (!this.running) {
                return;
            }
            // A connection that delivered something was a good one: start
            // the delays over.
            this.attempt = heard ? 0 : this.attempt + 1;
            await this.wait(reconnectDelay(this.attempt));
        }
    }

    /** One connection, until it ends. `true` when a frame came through. */
    protected async listenOnce(target: BridgeTarget): Promise<boolean> {
        this.abort = new AbortController();
        let heard = false;
        try {
            const answer = await this.doFetch(`${target.studioUrl}${target.gatewayPrefix}${EVENTS_STREAM_PATH}`, {
                headers: { Authorization: `Bearer ${await target.accessToken()}`, Accept: 'text/event-stream' },
                signal: this.abort.signal,
            });
            if (!answer.ok || !answer.body) {
                return false;
            }
            const reader = answer.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    return heard;
                }
                buffer += decoder.decode(value, { stream: true });
                const { frames, rest } = sseFrames(buffer);
                buffer = rest;
                for (const frame of frames) {
                    heard = true;
                    const command = commandIn(frame, this.workspaceOf, Date.now());
                    if (command) {
                        this.inbox.push(command);
                    }
                }
            }
        } catch {
            return heard; // aborted, or the network went
        }
    }
}
