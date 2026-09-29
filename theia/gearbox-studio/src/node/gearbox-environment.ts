// Constructor Studio: where the engine, its source roots and the workspace are.
//
// Gearbox Studio ran from a checkout of the gearbox repository: the engine was
// `target/debug/gearbox` in that Cargo workspace, the gear corpus the
// `../gears-rust` beside it, and the products `products/*/product.gdl`. A
// Constructor Studio session has none of that. It has one directory,
// `/workspace`, holding one checkout per source (`/workspace/gears-rust`,
// `/workspace/<project>`), and the engine installed at `/usr/local/bin/gearbox`
// by the session image.
//
// A desktop IDE (theia/electron-app) has no `/workspace`: the member opens a
// project, cloned under ~/ConstructorStudio/workspaces/<project>, and that
// folder — the one Theia has open — plays the part `/workspace` plays in a
// session. The session's order is untouched: `GEARBOX_WORKSPACE`, then
// `/workspace`, and only then the opened folder.

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

/** Directories never worth descending into when looking for descriptions. */
const SKIP = new Set(["node_modules", "target", ".git", ".gearbox", "dist", "lib"]);
/** Deep enough for `gears/system/authn-resolver/plugins/x/gear.gdl`. */
const MAX_DEPTH = 7;

export function workspaceDir(env: NodeJS.ProcessEnv = process.env, opened?: string): string {
  const fromEnv = env.GEARBOX_WORKSPACE?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  if (fs.existsSync("/workspace")) return "/workspace";
  // Off a session: the folder the IDE has open, before the process's own
  // directory — which on a desktop is the application's, holding no gear.
  return opened ?? process.cwd();
}

/**
 * The folder behind a workspace URI as Theia keeps it: a folder's `file://`
 * URI, or a `*.theia-workspace` / `*.code-workspace` file, whose folder is
 * the one beside it. Undefined for anything that is not a local path.
 */
export function folderOfWorkspaceUri(uri: string | undefined): string | undefined {
  if (!uri?.startsWith("file:")) return undefined;
  let folder: string;
  try {
    folder = fileURLToPath(uri);
  } catch {
    return undefined;
  }
  try {
    return fs.statSync(folder).isDirectory() ? folder : path.dirname(folder);
  } catch {
    return undefined;
  }
}

/**
 * Is `dir` one checkout holding gear descriptions? Then it is a source root of
 * its own, not a workspace of checkouts — a member who opened a repository
 * directly, not a project folder with repositories in it.
 */
export function isDescribedCheckout(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git")) && holdsDescription(dir, 0);
}

export function enginePath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GEARBOX_ENGINE?.trim();
  if (fromEnv) return fromEnv;
  // On PATH, where the session image puts it. `.exe` on Windows, because
  // `spawn` does not add it and the failure is an ENOENT for a binary that is
  // right there.
  return process.platform === "win32" ? "gearbox.exe" : "gearbox";
}

/**
 * The source roots the engine scans: `GEARBOX_ROOT` when set (one path, or
 * several separated by the platform's path delimiter), otherwise every
 * checkout directly under the workspace that holds a `gear.gdl`. A checkout,
 * not the workspace: the engine names a source after its root, and a product
 * says `source(id = "gears-rust", ...)`.
 */
export function sourceRoots(env: NodeJS.ProcessEnv = process.env, workspace = workspaceDir(env)): string[] {
  const fromEnv = env.GEARBOX_ROOT?.trim();
  if (fromEnv) {
    return fromEnv
      .split(path.delimiter)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => path.resolve(p));
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspace, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith("."))
    .map((e) => path.join(workspace, e.name))
    .filter((dir) => holdsDescription(dir, 0))
    .sort();
}

function holdsDescription(dir: string, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.some((e) => e.isFile() && e.name === "gear.gdl")) return true;
  return entries.some(
    (e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".") && holdsDescription(path.join(dir, e.name), depth + 1),
  );
}

/**
 * The products a person can open: `<checkout>/product.gdl`, which is where
 * Studio's portal saves one, and `<checkout>/products/<name>/product.gdl`, the
 * layout the gearbox repository itself uses.
 *
 * The workspace itself counts as a checkout too, for a desktop member who
 * opened one repository directly: then `<workspace>/product.gdl` and
 * `<workspace>/products/<name>/product.gdl` are that repository's products, and
 * the second is where New Product suggests putting one. A session's
 * `/workspace` holds no `products/` of its own, so it finds nothing new there.
 */
export function productFiles(workspace = workspaceDir()): string[] {
  const out = new Set<string>();
  let checkouts: fs.Dirent[];
  try {
    checkouts = fs.readdirSync(workspace, { withFileTypes: true });
  } catch {
    return [];
  }
  const consider = (file: string) => {
    if (fs.existsSync(file)) out.add(file);
  };
  const productsUnder = (dir: string) => {
    let products: fs.Dirent[];
    try {
      products = fs.readdirSync(path.join(dir, "products"), { withFileTypes: true });
    } catch {
      return;
    }
    for (const p of products) {
      if (p.isDirectory()) consider(path.join(dir, "products", p.name, "product.gdl"));
    }
  };
  consider(path.join(workspace, "product.gdl"));
  productsUnder(workspace);
  for (const c of checkouts) {
    if (!c.isDirectory() || SKIP.has(c.name) || c.name.startsWith(".")) continue;
    const dir = path.join(workspace, c.name);
    consider(path.join(dir, "product.gdl"));
    productsUnder(dir);
  }
  return [...out].sort();
}
