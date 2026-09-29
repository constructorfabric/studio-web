// Constructor Studio: a product's git source, brought onto this machine.
//
// A description Studio writes names its corpus as a git source at the commit it
// was checked against -- `source(id = "gears-rust", at = git(url, rev))` -- so
// it says by itself what it was built from. The engine takes source roots as
// directories and names each after its directory, so opening such a product
// needs that commit on disk, in a directory called by the source's id.
//
// A checkout the session already has is used when it is that repository at
// that commit. Otherwise the commit is brought into the one per-machine cache
// the corpus copy lives in (`~/ConstructorStudio/corpus`, below), never into
// the project: a commit never changes, so every project that names it reads
// the same copy. A checkout of the same repository in the workspace is cloned
// from locally when it has the commit (no second download); a private corpus
// is cloned through the Studio relay. Never by moving a checkout somebody may
// have open.

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import { remoteKey } from "../common/git-remote";

export { remoteKey };

const git = promisify(execFile);

export interface GitRef {
  readonly rev?: string | null;
  readonly tag?: string | null;
  readonly branch?: string | null;
}

/** A source id the engine accepts, which is also a safe directory name. */
export function isKebabId(id: string): boolean {
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id);
}

/** A ref this passes to git: nothing that reads as an option or climbs. */
export function isSafeRef(ref: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(ref) && !ref.startsWith("-") && !ref.includes("..");
}

/** A remote git may be asked to fetch: https or ssh-style, never an option. */
export function isSafeUrl(url: string): boolean {
  return /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(url);
}

/** The one ref asked for, rev first: a rev is exact, a branch moves. */
export function pickRef(ref: GitRef): string | undefined {
  const r = ref.rev ?? ref.tag ?? ref.branch ?? undefined;
  return r !== undefined && r !== null && isSafeRef(r) ? r : undefined;
}

function isCommit(ref: string): boolean {
  return /^[0-9a-f]{40}$/.test(ref);
}

/**
 * The commit `ref` names in `git ls-remote` output: the branch of that name,
 * else the tag (peeled, for an annotated one). Exact names only -- ls-remote
 * matches by suffix, and `feature/main` is not `main`.
 */
export function commitFromLsRemote(output: string, ref: string): string | undefined {
  const byName = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha !== undefined && name !== undefined && isCommit(sha)) byName.set(name, sha);
  }
  const wanted = ref.startsWith("refs/")
    ? [`${ref}^{}`, ref]
    : [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`];
  for (const name of wanted) {
    const sha = byName.get(name);
    if (sha !== undefined) return sha;
  }
  return undefined;
}

async function run(args: string[]): Promise<string> {
  const { stdout } = await git("git", args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function commitOf(dir: string, ref: string): Promise<string | undefined> {
  return run(["-C", dir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => undefined);
}

function checkoutsOf(workspace: string): string[] {
  try {
    return fs
      .readdirSync(workspace, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => path.join(workspace, e.name))
      .filter((d) => fs.existsSync(path.join(d, ".git")));
  } catch {
    return [];
  }
}

/** The `-c` pair that gives the relay's credential helper to one command only. */
function signedBy(via: CorpusRelay | undefined): string[] {
  return via === undefined ? [] : ["-c", "credential.helper=", "-c", `credential.helper=${via.helper}`];
}

export interface GitSourceOptions {
  /** The per-machine cache the copy lands in: `corpusCacheRoot()`. */
  readonly cacheRoot: string;
  /**
   * How to reach the repository when it is the corpus Studio relays (a
   * private one), signed with the member's own token. The copy is still
   * keyed, and named, by `url`.
   */
  readonly via?: CorpusRelay;
}

/**
 * A directory named `id` holding `url` at `ref`, or `undefined` when the input
 * is not something to hand to git or the ref names no commit. Rejects with
 * git's reason when the repository cannot be reached.
 */
export async function materializeGitSource(
  workspace: string,
  id: string,
  url: string,
  ref: GitRef,
  options: GitSourceOptions,
): Promise<string | undefined> {
  const want = pickRef(ref);
  if (!isKebabId(id) || !isSafeUrl(url) || want === undefined) return undefined;
  if (options.via !== undefined && !/^https?:\/\/[^\s]+$/.test(options.via.url)) return undefined;

  const same: string[] = [];
  for (const dir of checkoutsOf(workspace)) {
    // The configured URL, not `remote get-url`'s: that one applies `insteadOf`
    // rewrites, and two spellings of one repository must compare as written.
    const origin = await run(["-C", dir, "config", "--get", "remote.origin.url"]).catch(() => "");
    if (origin !== "" && remoteKey(origin) === remoteKey(url)) same.push(dir);
  }

  // A checkout already there, at that commit, under the source's own name.
  for (const dir of same) {
    if (path.basename(dir) !== id) continue;
    const head = await commitOf(dir, "HEAD");
    const target = await commitOf(dir, want);
    if (head !== undefined && head === target) return dir;
  }

  // Which commit: the cache is keyed by one, and a branch or a tag names one
  // only for now. Asked of the checkout we have when there is one, else of
  // the remote (through the relay when it takes one).
  const donor = same[0];
  let rev: string | undefined = isCommit(want) ? want : undefined;
  if (rev === undefined && donor !== undefined) {
    const fetched = await run(["-C", donor, "fetch", "--quiet", "origin", want]).then(
      () => true,
      () => false,
    );
    rev = fetched ? await commitOf(donor, "FETCH_HEAD") : await commitOf(donor, want);
  }
  if (rev === undefined) {
    const listed = await run([...signedBy(options.via), "ls-remote", options.via?.url ?? url, want]);
    rev = commitFromLsRemote(listed, want);
  }
  if (rev === undefined) return undefined;

  const cached = await materializeSharedCorpus(options.cacheRoot, id, url, rev, false);
  if (cached !== undefined) return cached;

  if (donor !== undefined) {
    // No second download: the checkout we have may already hold the commit,
    // or can fetch the one ref into itself.
    if ((await commitOf(donor, rev)) === undefined) {
      await run(["-C", donor, "fetch", "--quiet", "origin", rev]).catch(() => undefined);
    }
    if ((await commitOf(donor, rev)) !== undefined) {
      return materializeSharedCorpus(options.cacheRoot, id, url, rev, true, undefined, donor);
    }
  }
  return materializeSharedCorpus(options.cacheRoot, id, url, rev, true, options.via);
}

// Constructor Studio: one copy of the gear corpus per machine, not per project.
//
// A desktop project whose own repositories hold no gear lists the corpus from
// the Studio backend, which keeps one checkout of it for everybody. Opening a
// gear, resolving a product or generating needs the files here, though -- and
// cloning the corpus into every project that wants them is the thing this is
// here to avoid. So it lands once, under the member's Studio directory, one
// directory per commit: a commit never changes, so every project reading it
// reads the same tree, and moving to a newer commit is a new directory rather
// than a checkout switched under somebody's open editor.

/**
 * How to clone a corpus whose host needs a token Studio does not hand out:
 * from the Studio backend, which relays it with that token, signed with the
 * member's own token by the desktop's credential helper.
 */
export interface CorpusRelay {
  /** `<gateway>/<clone path>`: what `git clone` is given. */
  readonly url: string;
  /** The `credential.helper` value that answers for the gateway. */
  readonly helper: string;
}

/**
 * The relay for `clonePath`, from what the desktop publishes while signed in
 * (`STUDIO_DESKTOP_GIT_BASE`, `STUDIO_DESKTOP_GIT_HELPER`). Undefined off the
 * desktop, or signed out: there is no token to sign with then.
 */
export function corpusRelay(clonePath: string, env: NodeJS.ProcessEnv = process.env): CorpusRelay | undefined {
  const gateway = env.STUDIO_DESKTOP_GIT_BASE?.trim();
  const helper = env.STUDIO_DESKTOP_GIT_HELPER?.trim();
  if (!gateway || !helper || !clonePath.startsWith("/")) return undefined;
  return { url: `${gateway.replace(/\/+$/, "")}${clonePath}`, helper };
}

/** Where the shared corpora live: `STUDIO_CORPUS_CACHE`, else `~/ConstructorStudio/corpus`. */
export function corpusCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.STUDIO_CORPUS_CACHE?.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), "ConstructorStudio", "corpus");
}

/** `<root>/<host__owner__repo>/<commit[0..12]>/<id>`: named by `id`, which the engine names the source after. */
export function sharedCorpusDir(root: string, id: string, url: string, rev: string): string {
  const repo = remoteKey(url).replace(/[^a-z0-9._-]+/g, "__");
  return path.join(root, repo, rev.slice(0, 12), id);
}

/** A corpus copy found in the cache. */
export interface CachedCorpus {
  /** The source id: the copy's directory name. */
  readonly id: string;
  readonly path: string;
  /** When the copy was made, to prefer the newest. */
  readonly madeAt: number;
}

/**
 * Every finished copy under the cache, newest first: `<root>/<repo>/<commit>/<id>`
 * holding a `.git`. A `.partial` clone is not one. Reads the disk only, so it
 * answers with no Studio to ask -- signed out, or offline.
 */
export function cachedCorpora(root: string): CachedCorpus[] {
  const dirs = (dir: string): fs.Dirent[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      return [];
    }
  };
  const found: CachedCorpus[] = [];
  for (const repo of dirs(root)) {
    for (const commit of dirs(path.join(root, repo.name))) {
      for (const copy of dirs(path.join(root, repo.name, commit.name))) {
        if (copy.name.endsWith(".partial") || !isKebabId(copy.name)) continue;
        const at = path.join(root, repo.name, commit.name, copy.name);
        if (!fs.existsSync(path.join(at, ".git"))) continue;
        let madeAt = 0;
        try {
          madeAt = fs.statSync(at).mtimeMs;
        } catch {
          continue;
        }
        found.push({ id: copy.name, path: at, madeAt });
      }
    }
  }
  return found.sort((a, b) => b.madeAt - a.madeAt);
}

/**
 * The corpus `url` at commit `rev`, from the shared cache. Undefined when it is
 * not there and `fetch` is false, or when the input is not something to hand
 * to git. Cloned into a `.partial` directory and renamed at the end, so an
 * interrupted clone is never taken for a corpus.
 *
 * `from`, when given, is a local checkout of the same repository that holds
 * the commit: cloned from instead of the network. The copy is still keyed and
 * named by `url`.
 */
export async function materializeSharedCorpus(
  root: string,
  id: string,
  url: string,
  rev: string,
  fetch: boolean,
  via?: CorpusRelay,
  from?: string,
): Promise<string | undefined> {
  if (!isKebabId(id) || !isSafeUrl(url) || !isCommit(rev)) return undefined;
  const target = sharedCorpusDir(root, id, url, rev);
  if (fs.existsSync(path.join(target, ".git"))) return target;
  if (!fetch) return undefined;
  if (via !== undefined && !/^https?:\/\/[^\s]+$/.test(via.url)) return undefined;
  if (from !== undefined && !path.isAbsolute(from)) return undefined;
  const partial = `${target}.partial`;
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (from !== undefined) {
    // A local clone: objects are linked or copied, nothing is downloaded, and
    // the copy does not depend on the checkout afterwards.
    await run(["clone", "--quiet", "--no-checkout", "--", from, partial]);
  } else {
    // Through the relay the helper is given for this one command (`-c` before
    // `clone`), so nothing about it lands in the copy's config: the copy is a
    // fixed commit and never fetches again.
    await run([...signedBy(via), "clone", "--quiet", "--filter=blob:none", "--no-checkout", via?.url ?? url, partial]);
  }
  await run(["-C", partial, "checkout", "--quiet", "--detach", rev]);
  fs.renameSync(partial, target);
  return target;
}
