// Constructor Studio: how a command run in a terminal of its own ended --
// so a build is recorded as published only when its pushes went through.
//
// The terminal's process is the command itself, not a shell it was typed
// into: its exit code says how it ended. Reading the output for a marker the
// command echoed broke on Windows' console, which redraws with cursor moves
// and wraps the typed command wherever it likes. The output is still read,
// for the line that says why it failed.

import type { Event } from "@theia/core/lib/common/event";
import type { TerminalWidget } from "@theia/terminal/lib/browser/base/terminal-widget";

/** How long Publish waits for its pushes before it stops waiting (and records nothing). */
export const PUBLISH_WAIT_MS = 30 * 60_000;

/** How a command ended; `why` when it failed. */
export interface CommandEnd {
  readonly ok: boolean;
  readonly code?: number;
  readonly why?: string;
}

/** A terminal process ended: what `TerminalWatcher.onTerminalExit` fires. */
export interface TerminalExit {
  readonly terminalId: number;
  readonly code?: number;
}

/**
 * The shell that runs `command` and then ends with its exit code. On Windows
 * the arguments go as one command line, so `cmd` reads the quotes the
 * command holds as they are written, rather than as node-pty escapes them.
 */
export function shellFor(windows: boolean, command: string): { readonly shellPath: string; readonly shellArgs: string | string[] } {
  return windows ? { shellPath: "cmd.exe", shellArgs: `/d /s /c "${command}"` } : { shellPath: "/bin/sh", shellArgs: ["-c", command] };
}

/** The first line of output that names an error or a refusal: the push that failed, not what followed it. */
export class WhyLine {
  protected buffer = "";
  protected found: string | undefined;

  feed(chunk: string): void {
    if (this.found !== undefined) return;
    // eslint-disable-next-line no-control-regex
    this.buffer += chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "\n").replace(/\x1b\][^\x07]*\x07/g, "");
    const lines = this.buffer.split(/\r?\n|\r/);
    this.buffer = lines.pop() ?? "";
    this.found = lines.map((l) => l.trim()).find((l) => /\b(error|denied|unauthorized|forbidden)\b/i.test(l))?.slice(0, 240);
  }

  get line(): string | undefined {
    return this.found ?? (/\b(error|denied|unauthorized|forbidden)\b/i.test(this.buffer) ? this.buffer.trim().slice(0, 240) : undefined);
  }
}

/**
 * How the command in `terminal` ended: its process's exit code, as `exits`
 * reports it for the terminal's id. `started` is the terminal's id once its
 * process runs; an exit reported before then is kept, not missed.
 */
export function commandEnd(
  terminal: Pick<TerminalWidget, "onOutput" | "onTerminalDidClose">,
  exits: Event<TerminalExit>,
  started: Promise<number>,
  waitMs: number,
): Promise<CommandEnd> {
  return new Promise((resolve) => {
    const why = new WhyLine();
    const early = new Map<number, number | undefined>();
    let id: number | undefined;
    let settled = false;
    const subscriptions: { dispose(): void }[] = [];
    const done = (end: CommandEnd): void => {
      if (settled) return;
      settled = true;
      subscriptions.forEach((d) => d.dispose());
      clearTimeout(timer);
      resolve(end);
    };
    const exited = (code: number | undefined): void => {
      if (code === 0) return done({ ok: true, code });
      const line = why.line;
      done({ ok: false, ...(code !== undefined ? { code } : {}), why: line ?? (code !== undefined ? `it exited with ${code}` : "it ended without an exit code") });
    };
    const timer = setTimeout(() => done({ ok: false, why: "it did not finish in time" }), waitMs);
    subscriptions.push(
      terminal.onOutput((chunk: string) => why.feed(chunk)),
      exits((e) => {
        if (id === undefined) early.set(e.terminalId, e.code);
        else if (e.terminalId === id) exited(e.code);
      }),
      terminal.onTerminalDidClose(() => done({ ok: false, why: "the terminal was closed" })),
    );
    started.then(
      (n) => {
        id = n;
        if (early.has(n)) exited(early.get(n));
      },
      (e: unknown) => done({ ok: false, why: `it did not start: ${e instanceof Error ? e.message : String(e)}` }),
    );
  });
}
