import { commandEnd, shellFor, type TerminalExit } from "./publish-outcome";

/** A terminal whose output and close the test writes, and the watcher's exits. */
function fakeTerminal() {
  let out: ((chunk: string) => void) | undefined;
  let close: (() => void) | undefined;
  const exitListeners: ((e: TerminalExit) => void)[] = [];
  return {
    onOutput: (listener: (chunk: string) => void) => {
      out = listener;
      return { dispose: () => (out = undefined) };
    },
    onTerminalDidClose: (listener: () => void) => {
      close = listener;
      return { dispose: () => (close = undefined) };
    },
    exits: (listener: (e: TerminalExit) => void) => {
      exitListeners.push(listener);
      return { dispose: () => exitListeners.splice(exitListeners.indexOf(listener), 1) };
    },
    write: (chunk: string) => out?.(chunk),
    close: () => close?.(),
    exit: (terminalId: number, code?: number) => [...exitListeners].forEach((l) => l({ terminalId, code })),
    listening: () => exitListeners.length,
  };
}

describe("how a command run as its terminal's process ended", () => {
  it("is ok on exit code 0, whatever the output said on the way", async () => {
    const t = fakeTerminal();
    const ended = commandEnd(t as never, t.exits as never, Promise.resolve(7), 60_000);
    await Promise.resolve();
    t.write("warning: error-prone layer skipped\r\n");
    t.exit(7, 0);
    await expect(ended).resolves.toEqual({ ok: true, code: 0 });
    expect(t.listening()).toBe(0);
  });

  it("failed on any other code, with the registry's refusal as why", async () => {
    const t = fakeTerminal();
    const ended = commandEnd(t as never, t.exits as never, Promise.resolve(7), 60_000);
    await Promise.resolve();
    t.write("\x1b[1;1H173f78a0d749: Pushed\x1b[2;1Herror from registry: denied\x1b[K\r\ndenied\r\n");
    t.exit(7, 1);
    await expect(ended).resolves.toEqual({ ok: false, code: 1, why: "error from registry: denied" });
  });

  it("says the code when the output names no error", async () => {
    const t = fakeTerminal();
    const ended = commandEnd(t as never, t.exits as never, Promise.resolve(7), 60_000);
    await Promise.resolve();
    t.exit(7, 125);
    await expect(ended).resolves.toEqual({ ok: false, code: 125, why: "it exited with 125" });
  });

  it("reads only its own terminal's exit", async () => {
    const t = fakeTerminal();
    const ended = commandEnd(t as never, t.exits as never, Promise.resolve(7), 60_000);
    await Promise.resolve();
    t.exit(3, 1);
    t.exit(7, 0);
    await expect(ended).resolves.toEqual({ ok: true, code: 0 });
  });

  it("keeps an exit that came before the process said its id", async () => {
    const t = fakeTerminal();
    let start!: (id: number) => void;
    const ended = commandEnd(t as never, t.exits as never, new Promise<number>((r) => (start = r)), 60_000);
    t.exit(9, 0);
    t.exit(7, 2);
    start(7);
    await expect(ended).resolves.toMatchObject({ ok: false, code: 2 });
  });

  it("failed when it did not start, the terminal closes or the wait runs out", async () => {
    const refused = fakeTerminal();
    await expect(commandEnd(refused as never, refused.exits as never, Promise.reject(new Error("no shell")), 60_000)).resolves.toEqual({
      ok: false,
      why: "it did not start: no shell",
    });
    const t = fakeTerminal();
    const closed = commandEnd(t as never, t.exits as never, Promise.resolve(7), 60_000);
    t.close();
    await expect(closed).resolves.toEqual({ ok: false, why: "the terminal was closed" });
    jest.useFakeTimers();
    const s = fakeTerminal();
    const slow = commandEnd(s as never, s.exits as never, new Promise<number>(() => undefined), 1_000);
    jest.advanceTimersByTime(1_000);
    await expect(slow).resolves.toEqual({ ok: false, why: "it did not finish in time" });
    jest.useRealTimers();
  });
});

describe("the shell a command runs in", () => {
  it("on Windows is cmd, given the command line as written so its quotes stay", () => {
    expect(shellFor(true, 'docker push "a b" && helm push x')).toEqual({ shellPath: "cmd.exe", shellArgs: '/d /s /c "docker push "a b" && helm push x"' });
  });

  it("elsewhere is sh -c", () => {
    expect(shellFor(false, "docker push x && helm push y")).toEqual({ shellPath: "/bin/sh", shellArgs: ["-c", "docker push x && helm push y"] });
  });
});
