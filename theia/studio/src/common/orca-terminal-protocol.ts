// An Orca terminal, live, in a Theia terminal tab.
//
// `OrcaService` (./orca-protocol.ts) talks to the runtime through the CLI, and
// the CLI can only poll a terminal: `terminal read` for a screen, `terminal
// send` for input. An agent's TUI needs more than that: every byte as it is
// written, keystrokes as they are typed, and a PTY the size of the tab it is
// shown in. The runtime has all three on its WebSocket (`terminal.subscribe`,
// the stream Orca's own desktop and mobile clients read), and the backend
// holds that stream for the frontend (see `src/node/orca-terminal-bridge.ts`).
//
// One stream per open tab. The frontend names it, so frames that arrive before
// `attach` has answered still find their tab.

import type { RpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

export const orcaTerminalServicePath = '/services/studio-orca-terminal';

/** How an `attach` refused for want of a pairing begins; the frontend offers to pair on it. */
export const NO_ORCA_PAIRING = 'This IDE has no pairing with the Orca runtime';
/**
 * How an `attach` refused for a pairing Orca no longer accepts begins: the
 * device was revoked in Orca, or Orca was reinstalled and has a new key. The
 * frontend offers to pair again on it, as it does for a missing one.
 */
export const STALE_ORCA_PAIRING = 'Orca no longer accepts the pairing this IDE keeps';
/** Whether an `attach` failure is one a new pairing fixes. */
export function needsPairing(message: string): boolean {
    return message.includes(NO_ORCA_PAIRING) || message.includes(STALE_ORCA_PAIRING);
}
/** DI key for the proxy on the frontend. */
export const OrcaTerminalService = Symbol('OrcaTerminalService');

/** What the backend pushes into an open tab. */
export interface OrcaTerminalClient {
    /**
     * The screen as it is when the stream starts, then live output after it.
     * `data` is terminal output as-is (ANSI and all), ready for xterm.
     */
    onOutput(stream: string, data: string): void;
    /**
     * The stream is over: the terminal exited, the runtime went away, or it
     * refused the stream. `reason` is for the person looking at the tab.
     */
    onClosed(stream: string, reason: string): void;
}

export interface OrcaTerminalService extends RpcServer<OrcaTerminalClient> {
    /**
     * Start streaming one Orca terminal into the tab named `stream`.
     *
     * The PTY is sized to `cols` × `rows` for as long as the tab watches it
     * (Orca clamps to what it supports), and goes back to its own size once
     * the tab lets go.
     *
     * @throws when the runtime cannot be reached or does not know the handle;
     * the message says which, in words for a person.
     */
    attach(stream: string, handle: string, cols: number, rows: number): Promise<void>;
    /** Keystrokes, pastes, control sequences — written to the PTY unchanged. */
    write(stream: string, data: string): Promise<void>;
    resize(stream: string, cols: number, rows: number): Promise<void>;
    /** Stop streaming. The terminal and its agent keep running in Orca. */
    detach(stream: string): Promise<void>;
    /**
     * Whether this IDE is paired by hand. A session is not: its entrypoint
     * pairs it when Orca starts. An IDE on a developer's machine is, with the
     * Orca desktop app already running there.
     */
    canPair(): Promise<boolean>;
    /**
     * Pair with the Orca runtime on this computer, from the `orca://pair?code=…`
     * link Orca generates (Settings → Pair another Orca client → This computer).
     * Kept, readable by this user only, for the IDE's next starts.
     *
     * @throws when the link is not an Orca pairing, or this IDE pairs itself.
     */
    pair(offer: string): Promise<void>;
}
