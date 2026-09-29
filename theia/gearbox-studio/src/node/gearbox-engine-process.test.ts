import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { silenceVerdict, spawnEngine } from "./gearbox-engine-process";

describe("silenceVerdict", () => {
  it("lets a busy engine run past the allowance while it keeps talking", () => {
    // 90 s into a 60 s allowance, but the engine spoke 5 s ago.
    expect(silenceVerdict(0, 85_000, 90_000, 60_000, 600_000)).toEqual({ expired: false, recheckInMs: 55_000 });
  });

  it("ends a silent one at the allowance, as the flat deadline did", () => {
    expect(silenceVerdict(0, 0, 60_000, 60_000, 600_000)).toEqual({ expired: true, reason: "and sent nothing for 60000ms" });
    // Output from before the request does not count for it.
    expect(silenceVerdict(10_000, 5_000, 70_000, 60_000, 600_000)).toMatchObject({ expired: true });
  });

  it("ends one that talks forever at the ceiling", () => {
    expect(silenceVerdict(0, 599_999, 600_000, 60_000, 600_000)).toEqual({ expired: true, reason: "in 600000ms" });
  });
});

/**
 * A stand-in engine: answers every request after `delayMs`, and while it works
 * either sends a notification every 100 ms or says nothing at all.
 */
function fakeEngine(delayMs: number, chatty: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-engine-"));
  const script = path.join(dir, "gearbox");
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node
let buf = Buffer.alloc(0);
const send = (m) => { const b = JSON.stringify(m); process.stdout.write("Content-Length: " + Buffer.byteLength(b) + "\\r\\n\\r\\n" + b); };
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const head = buf.indexOf("\\r\\n\\r\\n");
    if (head < 0) return;
    const len = Number(/Content-Length: (\\d+)/i.exec(buf.slice(0, head).toString())[1]);
    if (buf.length < head + 4 + len) return;
    const msg = JSON.parse(buf.slice(head + 4, head + 4 + len).toString());
    buf = buf.slice(head + 4 + len);
    if (msg.id === undefined) { if (msg.method === "exit") process.exit(0); continue; }
    const ticker = ${chatty} ? setInterval(() => send({ jsonrpc: "2.0", method: "$/progress", params: {} }), 100) : undefined;
    setTimeout(() => { clearInterval(ticker); send({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }); }, ${delayMs});
  }
});
`,
  );
  fs.chmodSync(script, 0o755);
  return script;
}

const logger = { info: async () => undefined, warn: async () => undefined } as never;

describe("an engine request", () => {
  const made: string[] = [];
  afterAll(() => made.forEach((p) => fs.rmSync(path.dirname(p), { recursive: true, force: true })));

  it("survives a load that takes longer than the allowance while the engine reports progress", async () => {
    const engine = fakeEngine(1_500, true);
    made.push(engine);
    const handle = spawnEngine(engine, [], logger);
    try {
      await expect(handle.request("gearbox/product/load", {}, 500)).resolves.toEqual({ ok: true });
      expect(handle.dead).toBe(false);
    } finally {
      handle.dispose();
    }
  });

  it("still ends an engine that says nothing for the allowance", async () => {
    const engine = fakeEngine(5_000, false);
    made.push(engine);
    const handle = spawnEngine(engine, [], logger);
    await expect(handle.request("gearbox/product/load", {}, 500)).rejects.toThrow(
      "the engine did not answer `gearbox/product/load` and sent nothing for 500ms",
    );
    await handle.exited;
    expect(handle.dead).toBe(true);
  });
});
