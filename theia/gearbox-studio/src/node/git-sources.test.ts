import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  cachedCorpora,
  commitFromLsRemote,
  corpusRelay,
  materializeGitSource,
  materializeSharedCorpus,
  sharedCorpusDir,
} from "./git-sources";

const URL = "https://example.invalid/o/gears-rust.git";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

describe("a product's git source", () => {
  let scratch: string;
  let workspace: string;
  let cacheRoot: string;
  let first: string;
  let second: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-git-"));
    workspace = path.join(scratch, "workspace");
    cacheRoot = path.join(scratch, "corpus");
    // A checkout of the corpus in the workspace, two commits deep, standing on
    // the second: the product asks for the first.
    const checkout = path.join(workspace, "gears-rust");
    fs.mkdirSync(checkout, { recursive: true });
    sh(checkout, "init", "--quiet");
    sh(checkout, "remote", "add", "origin", URL);
    fs.writeFileSync(path.join(checkout, "gear.gdl"), "one");
    sh(checkout, "add", ".");
    sh(checkout, "commit", "--quiet", "-m", "one");
    first = sh(checkout, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(checkout, "gear.gdl"), "two");
    sh(checkout, "commit", "--quiet", "-am", "two");
    second = sh(checkout, "rev-parse", "HEAD");
  });

  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  it("uses the workspace checkout when it already is that commit", async () => {
    const dir = await materializeGitSource(workspace, "gears-rust", URL, { rev: second }, { cacheRoot });
    expect(dir).toBe(path.join(workspace, "gears-rust"));
    expect(fs.existsSync(cacheRoot)).toBe(false);
  });

  it("brings another commit into the per-machine cache, from the checkout, never into the project", async () => {
    const dir = await materializeGitSource(workspace, "gears-rust", URL, { rev: first }, { cacheRoot });

    expect(dir).toBe(sharedCorpusDir(cacheRoot, "gears-rust", URL, first));
    expect(path.basename(dir ?? "")).toBe("gears-rust");
    expect(sh(dir ?? "", "rev-parse", "HEAD")).toBe(first);
    expect(fs.readFileSync(path.join(dir ?? "", "gear.gdl"), "utf8")).toBe("one");
    // What it used to do: clone into `<ws>/.gearbox/sources`.
    expect(fs.existsSync(path.join(workspace, ".gearbox"))).toBe(false);
    // And the checkout somebody may have open was not moved.
    expect(sh(path.join(workspace, "gears-rust"), "rev-parse", "HEAD")).toBe(second);
  });

  it("reads a copy already in the cache without asking git anything", async () => {
    const cached = sharedCorpusDir(cacheRoot, "gears-rust", URL, "b".repeat(40));
    fs.mkdirSync(path.join(cached, ".git"), { recursive: true });
    const elsewhere = path.join(scratch, "empty-workspace");
    fs.mkdirSync(elsewhere);

    expect(await materializeGitSource(elsewhere, "gears-rust", URL, { rev: "b".repeat(40) }, { cacheRoot })).toBe(cached);
  });

  it("is the same copy `Bring the gears here` makes, so one serves both", async () => {
    const viaSource = await materializeGitSource(workspace, "gears-rust", URL, { rev: first }, { cacheRoot });
    expect(await materializeSharedCorpus(cacheRoot, "gears-rust", URL, first, false)).toBe(viaSource);
  });

  it("refuses input it would not hand to git", async () => {
    const opts = { cacheRoot };
    expect(await materializeGitSource(workspace, "Gears Rust", URL, { rev: first }, opts)).toBeUndefined();
    expect(await materializeGitSource(workspace, "gears-rust", "--upload-pack=x", { rev: first }, opts)).toBeUndefined();
    expect(await materializeGitSource(workspace, "gears-rust", URL, { branch: "-x" }, opts)).toBeUndefined();
    expect(await materializeGitSource(workspace, "gears-rust", URL, {}, opts)).toBeUndefined();
    expect(
      await materializeGitSource(workspace, "gears-rust", URL, { rev: first }, { cacheRoot, via: { url: "file:///x", helper: "h" } }),
    ).toBeUndefined();
  });
});

describe("cachedCorpora", () => {
  it("finds the copies already on disk, newest first, with no backend to ask", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-cache-"));
    try {
      const older = sharedCorpusDir(root, "gears-rust", URL, "a".repeat(40));
      const newer = sharedCorpusDir(root, "gears-rust", URL, "b".repeat(40));
      const partial = `${sharedCorpusDir(root, "gears-rust", URL, "c".repeat(40))}.partial`;
      const empty = sharedCorpusDir(root, "gears-rust", URL, "d".repeat(40));
      for (const dir of [older, newer, partial]) fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
      fs.mkdirSync(empty, { recursive: true });
      fs.utimesSync(older, new Date(1_000_000), new Date(1_000_000));

      expect(cachedCorpora(root).map((c) => [c.id, c.path])).toEqual([
        ["gears-rust", newer],
        ["gears-rust", older],
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("answers nothing for a cache that is not there", () => {
    expect(cachedCorpora(path.join(os.tmpdir(), "gbx-no-cache-here"))).toEqual([]);
  });
});

describe("commitFromLsRemote", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const c = "c".repeat(40);

  it("takes the branch of exactly that name, not one ending in it", () => {
    const out = `${a}\trefs/heads/feature/main\n${b}\trefs/heads/main\n`;
    expect(commitFromLsRemote(out, "main")).toBe(b);
  });

  it("peels an annotated tag", () => {
    const out = `${a}\trefs/tags/v1\n${c}\trefs/tags/v1^{}\n`;
    expect(commitFromLsRemote(out, "v1")).toBe(c);
  });

  it("answers nothing for a ref the remote does not have", () => {
    expect(commitFromLsRemote(`${a}\trefs/heads/main\n`, "dev")).toBeUndefined();
  });
});

describe("corpusRelay", () => {
  it("is there only while the desktop is signed in", () => {
    const env = { STUDIO_DESKTOP_GIT_BASE: "http://127.0.0.1:3000/studio-api/", STUDIO_DESKTOP_GIT_HELPER: "!helper" };
    expect(corpusRelay("/cf/studio-components-catalog/v1/gearbox/corpus", env)).toEqual({
      url: "http://127.0.0.1:3000/studio-api/cf/studio-components-catalog/v1/gearbox/corpus",
      helper: "!helper",
    });
    expect(corpusRelay("/cf/x", {})).toBeUndefined();
  });
});
