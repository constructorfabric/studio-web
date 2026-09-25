// The live side of an Orca terminal: its PTY, streamed into a Theia tab.
//
// # Why not the CLI
//
// The CLI has no attach. `terminal read` answers with a screen and
// `terminal send` with a receipt, so a tab built on them would poll, and an
// agent's TUI polled is a slideshow that eats keystrokes. The runtime itself
// streams: `terminal.subscribe` on its WebSocket answers with the screen as
// it stands, then every chunk the PTY writes, for as long as the socket is
// open. The same socket carries `terminal.send` (raw input) and
// `terminal.updateViewport` (the PTY's size). Probed against Orca 1.4.197:
// `echo live-$((6*7))` typed through it printed `live-42` in the stream, and
// `stty size` after a 120×40 viewport answered `40 120`.
//
// # Why Orca's own client
//
// That socket is end-to-end encrypted (NaCl box keyed by the runtime's public
// key) and authenticated by a paired device's token, over framing that Orca
// versions between releases. Orca ships the client that speaks it, as plain
// CommonJS next to its CLI (`resources/app.asar.unpacked/out/shared`), with
// its dependencies (`ws`, `tweetnacl`, `zod`) in `resources/node_modules`.
// Loading it from the installed Orca, rather than copying it, keeps the
// protocol in lockstep with the runtime that answers it — the same bargain
// as driving the CLI (see ../common/orca-protocol.ts).
//
// # Where the pairing comes from
//
// `orca serve --json` prints a pairing offer (`orca://pair?code=…`: endpoint,
// device token, public key) in its readiness line. The session entrypoint
// lifts it into a file only this user can read and names it in
// STUDIO_ORCA_PAIRING_FILE; STUDIO_ORCA_PAIRING_URL takes the offer itself,
// for a developer pointing the IDE at their own runtime. The offer never
// leaves the backend.

import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { injectable, inject } from '@theia/core/shared/inversify';
import type { OrcaTerminalClient, OrcaTerminalService } from '../common/orca-terminal-protocol';
import { OrcaCli } from './orca-cli';

/** Long enough for a cold runtime to authenticate a first socket. */
const ATTACH_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * The most text one `terminal.send` carries. A paste is split, in order,
 * rather than trusted to whatever frame cap the runtime has this release.
 */
export const SEND_CHUNK = 4096;

/** What `terminal.updateViewport` accepts; a tab outside it is clamped. */
const VIEWPORT = { cols: { min: 20, max: 240 }, rows: { min: 8, max: 120 } } as const;

/** A decoded `orca://pair` offer. Only these three fields are ours to read. */
export interface OrcaPairing {
    readonly endpoint: string;
    readonly deviceToken: string;
    readonly publicKeyB64: string;
}

/** One frame of Orca's RPC envelope. */
export interface OrcaRpcResponse {
    readonly ok: boolean;
    readonly result?: unknown;
    readonly error?: { readonly code?: string; readonly message?: string };
}

export interface OrcaSubscription {
    close(): void;
    /** A unary request on the subscription's own socket. */
    sendRequest(method: string, params: unknown, timeoutMs: number): Promise<OrcaRpcResponse>;
}

export interface OrcaSubscriptionCallbacks {
    onResponse(response: OrcaRpcResponse): void;
    onError(error: Error): void;
    onClose?(): void;
}

/** The two things this module needs from Orca's client. */
export interface OrcaRemoteClient {
    parsePairing(offer: string): OrcaPairing | null;
    subscribe(
        pairing: OrcaPairing,
        method: string,
        params: unknown,
        timeoutMs: number,
        callbacks: OrcaSubscriptionCallbacks
    ): Promise<OrcaSubscription>;
}

/**
 * Where Orca keeps its client, given the CLI it installed.
 *
 * Every package lays it out the same way: the CLI in `resources/bin`, the
 * client in `resources/app.asar.unpacked/out/shared`. The path must be the
 * CLI's real one — `/usr/bin/orca-ide` is a link into `/opt/Orca`.
 */
export function orcaClientDir(cliRealPath: string): string {
    return path.join(path.dirname(path.dirname(cliRealPath)), 'app.asar.unpacked', 'out', 'shared');
}

/** Load Orca's client from next to its CLI. Throws when it is not there. */
export function loadOrcaRemoteClient(cli: string): OrcaRemoteClient {
    const dir = orcaClientDir(fs.realpathSync(cli));
    // createRequire, not require: the backend is bundled, and a bundler would
    // try to resolve these at build time, where no Orca exists.
    const load = createRequire(path.join(dir, 'index.js'));
    const pairing = load('./pairing') as { parsePairingCode(input: string): OrcaPairing | null };
    const client = load('./remote-runtime-client') as {
        subscribeRemoteRuntimeRequest: OrcaRemoteClient['subscribe'];
    };
    return {
        parsePairing: offer => pairing.parsePairingCode(offer),
        subscribe: client.subscribeRemoteRuntimeRequest
    };
}

/** The pairing offer this backend may use, or undefined when there is none. */
export function pairingOffer(
    env: NodeJS.ProcessEnv = process.env,
    read: (file: string) => string = file => fs.readFileSync(file, 'utf8')
): string | undefined {
    const inline = env.STUDIO_ORCA_PAIRING_URL?.trim();
    if (inline) {
        return inline;
    }
    const file = env.STUDIO_ORCA_PAIRING_FILE?.trim();
    if (!file) {
        return undefined;
    }
    try {
        return read(file).trim() || undefined;
    } catch {
        return undefined;
    }
}

export function clampViewport(cols: number, rows: number): { cols: number; rows: number } {
    const clamp = (value: number, { min, max }: { min: number; max: number }) =>
        Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));
    return { cols: clamp(cols, VIEWPORT.cols), rows: clamp(rows, VIEWPORT.rows) };
}

/** What one frame of a `terminal.subscribe` stream means for the tab. */
export interface StreamEvent {
    readonly output?: string;
    /** Set when the stream is over; the reason is for a person. */
    readonly closed?: string;
}

/**
 * Translate one frame of the JSON stream (a subscriber that does not ask for
 * the binary one gets JSON). The shapes, from Orca 1.4.197's handler:
 *
 * - `scrollback`: the screen when the stream starts — `serialized` is xterm's
 *   own serialization of it, `lines` the plain-text fallback;
 * - `data`: a chunk the PTY wrote;
 * - `subscribed` with no stream: the terminal has no live PTY, and `lines` is
 *   its last output; `end` follows;
 * - `end`: the stream is over;
 * - `fit-override-changed` and anything newer: nothing to show.
 */
export function streamEvent(response: OrcaRpcResponse): StreamEvent {
    if (!response.ok) {
        const message = response.error?.message || response.error?.code || 'no reason given';
        return { closed: `Orca refused the stream: ${message}` };
    }
    const frame = (response.result ?? {}) as Record<string, unknown>;
    const lines = Array.isArray(frame.lines) ? frame.lines.filter(l => typeof l === 'string').join('\r\n') : '';
    switch (frame.type) {
        case 'scrollback':
            return { output: typeof frame.serialized === 'string' && frame.serialized ? frame.serialized : lines };
        case 'data':
            return typeof frame.chunk === 'string' ? { output: frame.chunk } : {};
        case 'subscribed':
            return frame.streamId === null || frame.streamId === undefined
                ? { output: lines, closed: 'This terminal has no running process; that was its last output.' }
                : {};
        case 'end':
            return { closed: 'The terminal ended.' };
        default:
            return {};
    }
}

interface Stream {
    readonly handle: string;
    readonly clientId: string;
    subscription?: OrcaSubscription;
    /** Input and resizes, in the order they were made. */
    queue: Promise<void>;
    done: boolean;
}

/**
 * One frontend connection's open Orca tabs. Bound per connection, so a
 * closed window takes its streams with it (see `dispose`).
 */
@injectable()
export class OrcaTerminalBridge implements OrcaTerminalService {

    @inject(OrcaCli)
    protected readonly cli!: OrcaCli;

    protected client: OrcaTerminalClient | undefined;
    protected readonly streams = new Map<string, Stream>();
    protected remote: OrcaRemoteClient | undefined;

    setClient(client: OrcaTerminalClient | undefined): void {
        this.client = client;
    }

    dispose(): void {
        for (const stream of [...this.streams.keys()]) {
            this.close(stream);
        }
        this.client = undefined;
    }

    async attach(stream: string, handle: string, cols: number, rows: number): Promise<void> {
        this.close(stream);
        const remote = this.remoteClient();
        const offer = this.pairingOffer();
        const pairing = offer ? remote.parsePairing(offer) : null;
        if (!pairing) {
            throw new Error(
                'This IDE has no pairing with the Orca runtime, so it cannot stream a terminal. ' +
                    'A session gets one when Orca starts (STUDIO_ORCA_PAIRING_FILE); ' +
                    'restart the session if Orca was still starting.'
            );
        }
        // Input and resizes made while the socket opens wait for it, in order:
        // the tab fits itself to its size right after it opens, which is
        // before Orca has answered, and that resize is the one that matters.
        let ready: () => void = () => undefined;
        const entry: Stream = {
            handle,
            clientId: `studio-${stream}`,
            queue: new Promise<void>(resolve => (ready = resolve)),
            done: false
        };
        this.streams.set(stream, entry);
        let subscription: OrcaSubscription;
        try {
            subscription = await remote.subscribe(
                pairing,
                'terminal.subscribe',
                {
                    terminal: handle,
                    client: { id: entry.clientId, type: 'desktop' },
                    viewport: clampViewport(cols, rows)
                },
                ATTACH_TIMEOUT_MS,
                {
                    onResponse: response => this.onFrame(stream, entry, response),
                    onError: error => this.finish(stream, entry, `Lost the stream from Orca: ${error.message}`),
                    onClose: () => this.finish(stream, entry, 'Orca closed the stream.')
                }
            );
        } catch (error) {
            if (this.streams.get(stream) === entry) {
                this.streams.delete(stream);
            }
            entry.done = true;
            ready();
            throw new Error(`Could not attach to the Orca terminal: ${messageOf(error)}`);
        }
        entry.subscription = subscription;
        ready();
        if (entry.done) {
            // Detached, or ended, while the socket was still opening.
            subscription.close();
        }
    }

    write(stream: string, data: string): Promise<void> {
        return this.enqueue(stream, 'terminal.send', entry =>
            chunkText(data, SEND_CHUNK).map(text => ({ terminal: entry.handle, text }))
        );
    }

    resize(stream: string, cols: number, rows: number): Promise<void> {
        return this.enqueue(stream, 'terminal.updateViewport', entry => [
            {
                terminal: entry.handle,
                client: { id: entry.clientId, type: 'desktop' },
                viewport: clampViewport(cols, rows)
            }
        ]);
    }

    async detach(stream: string): Promise<void> {
        this.close(stream);
    }

    /** Answers with the pairing offer; a seam for tests. */
    protected pairingOffer(): string | undefined {
        return pairingOffer();
    }

    /** Orca's client, loaded once from next to the CLI; a seam for tests. */
    protected remoteClient(): OrcaRemoteClient {
        if (!this.remote) {
            const cli = this.cli.binary();
            try {
                this.remote = loadOrcaRemoteClient(cli);
            } catch (error) {
                throw new Error(
                    `Could not load Orca's terminal client next to ${cli}: ${messageOf(error)}. ` +
                        'It ships with Orca 1.4 and later.'
                );
            }
        }
        return this.remote;
    }

    protected onFrame(stream: string, entry: Stream, response: OrcaRpcResponse): void {
        if (entry.done) {
            return;
        }
        const event = streamEvent(response);
        if (event.output) {
            this.client?.onOutput(stream, event.output);
        }
        if (event.closed) {
            this.finish(stream, entry, event.closed);
        }
    }

    protected enqueue(stream: string, method: string, params: (entry: Stream) => unknown[]): Promise<void> {
        const entry = this.streams.get(stream);
        if (!entry || entry.done) {
            return Promise.resolve();
        }
        const requests = params(entry);
        entry.queue = entry.queue.then(async () => {
            for (const request of requests) {
                const subscription = entry.subscription;
                if (!subscription || entry.done) {
                    return;
                }
                try {
                    const response = await subscription.sendRequest(method, request, REQUEST_TIMEOUT_MS);
                    if (!response.ok) {
                        console.warn(`[orca-terminal] ${method} refused: ${response.error?.message ?? response.error?.code}`);
                    }
                } catch (error) {
                    console.warn(`[orca-terminal] ${method} failed: ${messageOf(error)}`);
                }
            }
        });
        return entry.queue;
    }

    /** The stream ended on Orca's side: tell the tab, once. */
    protected finish(stream: string, entry: Stream, reason: string): void {
        if (entry.done) {
            return;
        }
        entry.done = true;
        if (this.streams.get(stream) === entry) {
            this.streams.delete(stream);
        }
        entry.subscription?.close();
        this.client?.onClosed(stream, reason);
    }

    /** The tab let go: close quietly. */
    protected close(stream: string): void {
        const entry = this.streams.get(stream);
        if (!entry) {
            return;
        }
        entry.done = true;
        this.streams.delete(stream);
        entry.subscription?.close();
    }
}

/**
 * Split text into pieces of at most `size` UTF-16 units, never between the
 * two halves of a surrogate pair: each piece is encoded on its own, and half
 * an emoji encodes as a replacement character.
 */
export function chunkText(text: string, size: number): string[] {
    const chunks: string[] = [];
    let at = 0;
    while (at < text.length) {
        let end = Math.min(text.length, at + size);
        const last = text.charCodeAt(end - 1);
        if (end < text.length && end - at > 1 && last >= 0xd800 && last <= 0xdbff) {
            end -= 1;
        }
        chunks.push(text.slice(at, end));
        at = end;
    }
    return chunks;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
