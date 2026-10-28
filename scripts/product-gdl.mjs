#!/usr/bin/env node
// Have the Gearbox engine write product.gdl: Constructor Studio as a product,
// made of exactly the gears the studio-backend binary links.
//
// We do not render the file. The binary says what it links
// (`studio-backend gears`); the engine reads the gear descriptions (a gear.gdl
// beside every Studio module, and gears-rust's), and writes the product
// through its own RPC -- `gearbox/product/create`, then one
// `gearbox/product/applyEdits` adding each gear and its plugins. Which host a
// plugin goes under is the catalogue's answer (a plugin's `implements` is a
// host's extension point), not ours.
//
//   studio-backend gears > /tmp/gears.json
//   node scripts/product-gdl.mjs --gears /tmp/gears.json --gears-rust ../gears-rust
//
// Without a local `gearbox`, run the engine from the backend image:
//
//   node scripts/product-gdl.mjs --gears /tmp/gears.json --gears-rust ../gears-rust --image studio-backend
//
// The product file is <repo>/product.gdl. Its sources are `studio-backend`
// (this repository's gears) and `gears-rust`, a checkout beside the
// repository (`../gears-rust`), as the desktop corpus lays them out.
// `cargo test` (assembly::product_description) fails when the file names
// other gears than the binary links.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((out, a, i, all) => (a.startsWith("--") ? [...out, [a.slice(2), all[i + 1]]] : out), []),
);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gearsRust = resolve(args["gears-rust"] ?? resolve(repo, "../gears-rust"));
const image = args.image;
if (!args.gears) throw new Error("--gears <file>: the output of `studio-backend gears`");
if (!existsSync(gearsRust)) throw new Error(`no gears-rust checkout at ${gearsRust}`);
if (basename(gearsRust) !== "gears-rust") throw new Error("the gears-rust checkout's directory must be named gears-rust: the engine names a root by it");

// What the engine sees: the paths inside its container, or the real ones.
const at = image
  ? { repo: "/w/studio-web", gearsRust: "/w/gears-rust" }
  : { repo, gearsRust };
const roots = [at.gearsRust, `${at.repo}/studio-backend`];
const productPath = `${at.repo}/product.gdl`;

/** The engine command, with `args`, as a [program, args] pair. */
function engine(...rest) {
  if (!image) return ["gearbox", rest];
  return [
    "docker",
    ["run", "--rm", "-i", "-v", `${repo}:/w/studio-web`, "-v", `${gearsRust}:/w/gears-rust:ro`, "-w", "/w", "--entrypoint", "gearbox", image, ...rest],
  ];
}

// The engine must be the one the images pin. `gearbox --version` is `0.1.0`
// for every commit, so a stale image looks current until it refuses a field
// its gears use (an engine from before `maturity` says GBX0106 on every
// gear.gdl here). The images record the commit beside the binary.
const pinned = /^ARG STUDIO_GEARBOX_REF=(\S+)/m.exec(readFileSync(resolve(repo, "studio-backend/Dockerfile"), "utf8"))?.[1];
{
  const [prog, rest] = image
    ? ["docker", ["run", "--rm", "--entrypoint", "cat", image, "/usr/local/share/gearbox/REVISION"]]
    : ["sh", ["-c", "cat \"$(dirname \"$(command -v gearbox)\")/../share/gearbox/REVISION\" 2>/dev/null"]];
  const rev = spawnSync(prog, rest, { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).stdout.trim();
  if (!rev && image) throw new Error(`${image} records no engine revision: it predates the pin (${pinned}); rebuild it`);
  if (rev && pinned && rev !== pinned) throw new Error(`the engine is ${rev}, the images pin ${pinned}: use an engine built from the pin`);
  if (!rev) console.error(`warning: cannot tell which engine \`gearbox\` is; the images pin ${pinned}`);
}

const linked = JSON.parse(readFileSync(args.gears, "utf8"));
const linkedNames = new Set(linked.map((g) => g.name));

// The catalogue: which root each gear is in, and which host each plugin fills.
const [cprog, cargs] = engine("catalogue", ...roots.flatMap((r) => ["--root", r]), "--format", "json");
const cat = spawnSync(cprog, cargs, { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" }, maxBuffer: 64 << 20 });
if (cat.status !== 0) throw new Error(`gearbox catalogue failed:\n${cat.stderr}`);
const catalogue = JSON.parse(cat.stdout.slice(cat.stdout.indexOf("{"))).gears;
const hostOfSpec = new Map();
for (const [id, g] of Object.entries(catalogue)) for (const p of g.extension_points ?? []) if (p.spec) hostOfSpec.set(p.spec, id);

const undescribed = [];
const hosts = new Map(); // host id -> plugin ids
const plugins = [];
for (const g of linked) {
  const described = catalogue[g.name];
  if (!described) {
    undescribed.push(g.name);
    continue;
  }
  const spec = (described.implements ?? described.fills)?.point?.spec;
  if (spec) plugins.push([g.name, hostOfSpec.get(spec)]);
  else hosts.set(g.name, []);
}
for (const [plugin, host] of plugins) {
  if (!host || !hosts.has(host)) throw new Error(`${plugin}: its host ${host ?? "(none)"} is not linked`);
  hosts.get(host).push(plugin);
}
// Linked, but no description anywhere: the toolkit's runtime, which every
// assembly has and no product names. Anything else is a gear.gdl missing.
const runtime = new Set(["gear-orchestrator"]);
const missing = undescribed.filter((n) => !runtime.has(n));
if (missing.length) throw new Error(`no gear.gdl describes: ${missing.join(", ")}`);

// The session.
const [prog, rpcArgs] = engine("rpc", "--stdio");
const child = spawn(prog, rpcArgs, { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
let buf = Buffer.alloc(0);
const waiting = new Map();
// The engine gone -- it could not start, or it exited before answering --
// settles every call still waiting with why, and refuses the next ones: an
// await that never settles ends the script with Node's unsettled-await code
// and no word about the engine.
let gone = null;
const fail = (why) => {
  if (gone) return;
  gone = why;
  for (const settle of waiting.values()) settle({ error: { message: why } });
  waiting.clear();
};
child.on("error", (e) => fail(`the engine could not start: ${e.message}`));
child.on("exit", (code, signal) => fail(`the engine exited (${signal ?? code}) before answering`));
child.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const head = buf.indexOf("\r\n\r\n");
    if (head < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, head).toString())[1]);
    if (buf.length < head + 4 + len) return;
    const msg = JSON.parse(buf.subarray(head + 4, head + 4 + len).toString());
    buf = buf.subarray(head + 4 + len);
    if (msg.id != null && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  }
});
let next = 1;
const send = (msg) => {
  const body = Buffer.from(JSON.stringify(msg));
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
};
const call = async (method, params) => {
  if (gone) throw new Error(`${method}: ${gone}`);
  const answer = await new Promise((r) => {
    const id = next++;
    waiting.set(id, r);
    send({ jsonrpc: "2.0", id, method, params });
  });
  if (answer.error) throw new Error(`${method}: ${answer.error.message}`);
  return answer.result;
};

try {
  await call("initialize", { roots, workspace: at.repo, allow_writes: true });
  send({ jsonrpc: "2.0", method: "initialized", params: {} });
  // A regeneration, not an edit: the file is the build's, so it starts over.
  rmSync(resolve(repo, "product.gdl"), { force: true });
  await call("gearbox/product/create", {
    path: productPath,
    id: "studio-web",
    name: "Constructor Studio",
    sources: [
      { id: "studio-backend", at: "studio-backend" },
      { id: "gears-rust", at: relative(at.repo, at.gearsRust).replace(/\\/g, "/") },
    ],
  });
  const sorted = [...hosts.keys()].sort();
  const edits = [
    ...sorted.map((gear) => ({ kind: "add_gear", gear, source: catalogue[gear].source })),
    ...sorted.filter((g) => hosts.get(g).length).map((gear) => ({ kind: "set_plugins", gear, plugins: hosts.get(gear).sort() })),
  ];
  const applied = await call("gearbox/product/applyEdits", { path: productPath, edits });
  console.error(`product.gdl: ${sorted.length} gears, ${plugins.length} plugins${applied?.written === false ? " (not written)" : ""}`);
  if (!linkedNames.size) throw new Error("the gear list is empty");
} finally {
  if (!gone) {
    await call("shutdown", null).catch(() => undefined);
    send({ jsonrpc: "2.0", method: "exit" });
    child.stdin.end();
  }
}

// GDL 1.1: a profile whose gears keep data names the Postgres they keep it in,
// or the product does not resolve (GBX0306). One server for every gear
// database, as config/dev.yaml's `pg_main`; the password stays a reference.
// Written as text because the engine's profile edit only writes strings, and
// `database` is a `postgres(...)` call.
{
  const file = resolve(repo, "product.gdl");
  const text = readFileSync(file, "utf8");
  const plain = 'embedded(id = "dev"),';
  if (!text.includes(plain)) throw new Error(`product.gdl has no \`${plain}\` to give a database`);
  writeFileSync(
    file,
    text.replace(
      plain,
      [
        "embedded(",
        '            id = "dev",',
        "            development = True,",
        "            database = postgres(",
        '                host = "127.0.0.1",',
        "                port = 5433,",
        '                user = "studio",',
        '                password = "${STUDIO_PG_PASSWORD}",',
        "            ),",
        "        ),",
      ].join("\n"),
    ),
  );
}
