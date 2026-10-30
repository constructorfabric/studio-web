import { publishOutcome } from "./publish-outcome";

/** A terminal whose output the test writes. */
function fakeTerminal() {
  let out: ((chunk: string) => void) | undefined;
  let close: (() => void) | undefined;
  return {
    onOutput: (listener: (chunk: string) => void) => {
      out = listener;
      return { dispose: () => (out = undefined) };
    },
    onTerminalDidClose: (listener: () => void) => {
      close = listener;
      return { dispose: () => (close = undefined) };
    },
    write: (chunk: string) => out?.(chunk),
    close: () => close?.(),
  };
}

describe("how a Publish ended", () => {
  const marker = "studio-publish-abc";

  it("is ok on its marker's line, not on the typed command that echoes it", async () => {
    const t = fakeTerminal();
    const ended = publishOutcome(t as never, marker, 60_000);
    t.write(`C:\\ws> docker push x && echo ${marker}-ok || echo ${marker}-failed\r\n`);
    t.write("c51e269162b6: Pushed\r\n");
    t.write(`${marker}-ok \r\n`);
    await expect(ended).resolves.toEqual({ ok: true });
  });

  it("is ok on Windows' console, which wraps the command and moves the cursor instead of ending lines", async () => {
    const t = fakeTerminal();
    const ended = publishOutcome(t as never, marker, 60_000);
    t.write(`\x1b[?25l\x1b[1;1Hc:\\ws> helm push x.tgz && echo ${marker}-ok || echo stu\x1b[2;1Hdio-publish-abc-failed\x1b[K`);
    t.write(`\x1b[5;1HPushed: ghcr.io/acme/charts/shop:0.1.0\x1b[K\x1b[6;1H${marker}-ok\x1b[K\x1b[?25h`);
    await expect(ended).resolves.toEqual({ ok: true });
  });

  it("failed, with the registry's refusal as why", async () => {
    const t = fakeTerminal();
    const ended = publishOutcome(t as never, marker, 60_000);
    t.write("173f78a0d749: Pushed\r\nerror from registry: denied\r\ndenied\r\n");
    t.write(`\x1b[0m${marker}-failed\r\n`);
    await expect(ended).resolves.toEqual({ ok: false, why: "error from registry: denied" });
  });

  it("failed when the terminal closes or the wait runs out", async () => {
    const t = fakeTerminal();
    const closed = publishOutcome(t as never, marker, 60_000);
    t.close();
    await expect(closed).resolves.toEqual({ ok: false, why: "the terminal was closed" });
    jest.useFakeTimers();
    const slow = publishOutcome(fakeTerminal() as never, marker, 1_000);
    jest.advanceTimersByTime(1_000);
    await expect(slow).resolves.toEqual({ ok: false, why: "it did not finish in time" });
    jest.useRealTimers();
  });
});
