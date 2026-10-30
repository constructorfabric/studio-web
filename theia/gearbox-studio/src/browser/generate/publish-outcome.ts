// Constructor Studio: how a Publish in the Deploy terminal ended, read off the
// terminal's output -- so a build is recorded as published only when its
// pushes went through.

import type { TerminalWidget } from "@theia/terminal/lib/browser/base/terminal-widget";

/** How long Publish waits for its pushes before it stops waiting (and records nothing). */
export const PUBLISH_WAIT_MS = 30 * 60_000;

/** How often `text` holds `needle`. */
function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * How a Publish ended, read off its terminal: `<marker>-ok` or
 * `<marker>-failed` printed more often than the typed command holds it after
 * `echo `. Counted over all the output with its escapes and line ends taken
 * out, not matched per line: Windows' console redraws with cursor moves rather
 * than line ends, and wraps the typed command wherever it likes, so a line
 * that is only the marker may never arrive. The first line that names an
 * error or a refusal is why: the push that failed, not what followed it.
 */
export function publishOutcome(
  terminal: Pick<TerminalWidget, "onOutput" | "onTerminalDidClose">,
  marker: string,
  waitMs: number,
): Promise<{ readonly ok: boolean; readonly why?: string }> {
  return new Promise((resolve) => {
    let buffer = "";
    let all = "";
    let why: string | undefined;
    const subscriptions: { dispose(): void }[] = [];
    const done = (ok: boolean, reason?: string): void => {
      subscriptions.forEach((d) => d.dispose());
      clearTimeout(timer);
      resolve({ ok, ...(ok ? {} : { why: reason ?? why }) });
    };
    const timer = setTimeout(() => done(false, "it did not finish in time"), waitMs);
    subscriptions.push(
      terminal.onOutput((chunk: string) => {
        const plain = chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "\n").replace(/\x1b\][^\x07]*\x07/g, "");
        buffer += plain;
        const lines = buffer.split(/\r?\n|\r/);
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (/\b(error|denied|unauthorized|forbidden)\b/i.test(line) && !line.includes(marker)) why ??= line.slice(0, 240);
        }
        all += plain.replace(/[\r\n]/g, "");
        if (count(all, `${marker}-ok`) > count(all, `echo ${marker}-ok`)) return done(true);
        if (count(all, `${marker}-failed`) > count(all, `echo ${marker}-failed`)) return done(false);
      }),
      terminal.onTerminalDidClose(() => done(false, "the terminal was closed")),
    );
  });
}
