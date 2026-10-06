import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { CatalogueChanged } from "../common/generated/CatalogueChanged";
import type { CatalogueLoadResult } from "../common/generated/CatalogueLoadResult";
import {
  CACHE_FORMAT,
  LoadRecord,
  catalogueCacheFile,
  catalogueCacheKey,
  corpusCommitOf,
  engineIdentity,
  normalizeRoot,
  readCatalogueCache,
  replayCatalogue,
  sameRoots,
  writeCatalogueCache,
  type RecordedCatalogue,
} from "./catalogue-cache";

const COMMIT = "a0a42cec5e68b313c31e3ceb00254b0df89cd8b8";
const NEXT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A per-machine corpus cache holding one copy at `commit`, as `materializeSharedCorpus` leaves it. */
function corpusCache(commit = COMMIT): { cache: string; copy: string } {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-catcache-"));
  const copy = path.join(cache, "github.com__o__gears-rust", commit.slice(0, 12), "gears-rust");
  fs.mkdirSync(path.join(copy, ".git"), { recursive: true });
  fs.writeFileSync(path.join(copy, ".git", "HEAD"), `${commit}\n`);
  return { cache, copy };
}

function engineFile(dir: string, bytes = "engine"): string {
  const file = path.join(dir, process.platform === "win32" ? "gearbox.exe" : "gearbox");
  fs.writeFileSync(file, bytes);
  return file;
}

const load: CatalogueLoadResult = {
  total: 2,
  pending: [
    { source: "gears-rust", gdl_path: "gears/a/gear.gdl", stage: "declared" } as never,
    { source: "gears-rust", gdl_path: "gears/b/gear.gdl", stage: "declared" } as never,
  ],
  designs: [],
  diagnostics: [],
};

function changed(gdl: string, name: string): CatalogueChanged {
  return { gear: { id: name, source: "gears-rust", gdl_path: gdl, display_name: name } as never, replaces: gdl };
}

function finished(): RecordedCatalogue {
  const record = new LoadRecord();
  record.answered(load);
  record.changed(changed("gears/a/gear.gdl", "a"));
  record.changed(changed("gears/b/gear.gdl", "b"));
  record.progress({ token: "catalogue", completed: 2, total: 2, done: true });
  return record.snapshot()!;
}

describe("the catalogue cache key", () => {
  const made: string[] = [];
  afterAll(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
  const fresh = (commit?: string) => {
    const made_ = corpusCache(commit);
    made.push(made_.cache);
    return made_;
  };

  it("is a corpus copy's commit and the engine that read it", () => {
    const { cache, copy } = fresh();
    const key = catalogueCacheKey([copy], cache, "engine|1|2");
    expect(key).toEqual({ format: CACHE_FORMAT, engine: "engine|1|2", roots: [{ path: normalizeRoot(copy), commit: COMMIT }] });
  });

  it("is none for a root that is not a corpus copy at a commit", () => {
    const { cache, copy } = fresh();
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-checkout-"));
    made.push(checkout);
    // A workspace's own checkout changes under a person's hands.
    expect(catalogueCacheKey([checkout], cache, "e")).toBeUndefined();
    // One such root among copies is enough to make the load not one to remember.
    expect(catalogueCacheKey([copy, checkout], cache, "e")).toBeUndefined();
    // A copy on a branch, or one whose HEAD is not the commit its directory names.
    fs.writeFileSync(path.join(copy, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(corpusCommitOf(copy, cache)).toBeUndefined();
    fs.writeFileSync(path.join(copy, ".git", "HEAD"), `${NEXT}\n`);
    expect(corpusCommitOf(copy, cache)).toBeUndefined();
    // No engine to name: nothing is keyed.
    fs.writeFileSync(path.join(copy, ".git", "HEAD"), `${COMMIT}\n`);
    expect(catalogueCacheKey([copy], cache, undefined)).toBeUndefined();
  });

  it("changes with the commit and with the engine binary", () => {
    const a = fresh(COMMIT);
    const b = fresh(NEXT);
    const bin = engineFile(a.cache, "one build");
    const before = engineIdentity(bin)!;
    const keyA = catalogueCacheKey([a.copy], a.cache, before)!;
    expect(catalogueCacheKey([b.copy], b.cache, before)).not.toEqual(keyA);
    // A new pin is a new file: another size, another time.
    fs.writeFileSync(bin, "another, longer build");
    fs.utimesSync(bin, new Date(), new Date(Date.now() + 5000));
    const after = engineIdentity(bin)!;
    expect(after).not.toEqual(before);
    expect(catalogueCacheKey([a.copy], a.cache, after)).not.toEqual(keyA);
  });

  it("finds an engine named by its command on PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-path-"));
    made.push(dir);
    const bin = engineFile(dir);
    expect(engineIdentity(path.basename(bin), { PATH: dir })).toMatch(/\|6\|\d+$/);
    expect(engineIdentity("no-such-gearbox", { PATH: dir })).toBeUndefined();
  });

  it("compares roots however they are spelled", () => {
    expect(sameRoots(["\\\\?\\C:\\Corpus\\gears-rust"], ["c:/corpus/gears-rust/"], "win32")).toBe(true);
    expect(sameRoots(["C:\\corpus\\a"], ["C:\\corpus\\b"], "win32")).toBe(false);
    expect(sameRoots(["/w/a", "/w/b"], ["/w/b", "/w/a"], "linux")).toBe(false);
    expect(sameRoots(["/w/a/"], ["/w/a"], "linux")).toBe(true);
  });
});

describe("the catalogue cache file", () => {
  const made: string[] = [];
  afterAll(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

  it("lives beside the copy, outside the source root", () => {
    const { cache, copy } = corpusCache();
    made.push(cache);
    const key = catalogueCacheKey([copy], cache, "e")!;
    const file = catalogueCacheFile(copy, key);
    expect(path.dirname(path.dirname(file))).toBe(path.dirname(copy));
    expect(file.startsWith(copy + path.sep)).toBe(false);
  });

  it("reads back what was written, for that key only", () => {
    const { cache, copy } = corpusCache();
    made.push(cache);
    const key = catalogueCacheKey([copy], cache, "e")!;
    const file = catalogueCacheFile(copy, key);
    const recorded = finished();
    writeCatalogueCache(file, key, recorded);
    expect(readCatalogueCache(file, key)).toEqual(recorded);
    // Another engine, another commit, another format: a miss, not a stale answer.
    expect(readCatalogueCache(file, { ...key, engine: "other" })).toBeUndefined();
    expect(readCatalogueCache(file, { ...key, roots: [{ ...key.roots[0]!, commit: NEXT }] })).toBeUndefined();
    expect(readCatalogueCache(file, { ...key, format: CACHE_FORMAT + 1 })).toBeUndefined();
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".partial"))).toEqual([]);
  });

  it("is a miss, never an error, when it is corrupt or missing", () => {
    const { cache, copy } = corpusCache();
    made.push(cache);
    const key = catalogueCacheKey([copy], cache, "e")!;
    const file = catalogueCacheFile(copy, key);
    expect(readCatalogueCache(file, key)).toBeUndefined();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"key": ');
    expect(readCatalogueCache(file, key)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ key, catalogue: { load: { total: 1 }, changed: "x" } }));
    expect(readCatalogueCache(file, key)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ key, catalogue: { ...finished(), changed: [{ replaces: 1 }] } }));
    expect(readCatalogueCache(file, key)).toBeUndefined();
  });
});

describe("a recorded load", () => {
  it("is complete only once the engine said done", () => {
    const record = new LoadRecord();
    record.answered(load);
    record.changed(changed("gears/a/gear.gdl", "a"));
    expect(record.snapshot()).toBeUndefined();
    record.progress({ token: "catalogue", completed: 1, total: 2 });
    expect(record.complete).toBe(false);
    record.changed(changed("gears/b/gear.gdl", "b"));
    record.progress({ token: "catalogue", completed: 2, total: 2, done: true });
    expect(record.snapshot()?.changed.map((c) => c.gear.id)).toEqual(["a", "b"]);
  });

  it("is never complete when the engine died in it", async () => {
    const record = new LoadRecord();
    record.answered(load);
    record.changed(changed("gears/a/gear.gdl", "a"));
    record.fail();
    await record.settled;
    record.progress({ token: "catalogue", completed: 2, total: 2, done: true });
    expect(record.complete).toBe(false);
    expect(record.snapshot()).toBeUndefined();
  });

  it("keeps each row's last word, in the order the words arrived", () => {
    const record = new LoadRecord();
    record.answered(load);
    record.changed(changed("gears/a/gear.gdl", "a"));
    record.changed(changed("gears/b/gear.gdl", "b"));
    // A plugin joined to its host after every projection: sent again.
    record.changed({ ...changed("gears/a/gear.gdl", "a"), gear: { ...changed("gears/a/gear.gdl", "a").gear, display_name: "a joined" } });
    record.diagnostics({ diagnostics: [{ code: "GBX0211" } as never] });
    record.progress({ token: "catalogue", completed: 2, total: 2, done: true });
    const snap = record.snapshot()!;
    expect(snap.changed.map((c) => c.gear.display_name)).toEqual(["b", "a joined"]);
    expect(snap.diagnostics).toHaveLength(1);
  });

  it("completes when done arrives before the answer is handed over", () => {
    const record = new LoadRecord();
    record.progress({ token: "catalogue", completed: 0, total: 0, done: true });
    expect(record.complete).toBe(false);
    record.answered({ total: 0, pending: [], designs: [], diagnostics: [] });
    expect(record.complete).toBe(true);
  });
});

describe("the warm start", () => {
  it("tells a client the load again: projections, then diagnostics, then done", () => {
    const told: string[] = [];
    replayCatalogue(
      { ...finished(), diagnostics: [{ code: "GBX0211" } as never] },
      {
        onCatalogueChanged: (e) => told.push(`changed ${e.gear.id}`),
        onCatalogueDiagnostics: (e) => told.push(`diagnostics ${e.diagnostics.length}`),
        onProgress: (e) => told.push(`progress ${e.completed}/${e.total} ${e.done === true ? "done" : ""}`),
      },
    );
    expect(told).toEqual(["changed a", "changed b", "diagnostics 1", "progress 2/2 done"]);
  });
});
