// The paths a product is opened with, in the browser, which has no `path`.
//
// Hand-rolled, and they have to be right for two kinds of input: a session's
// POSIX paths (`/workspace/gearbox/products/x`) and a desktop's Windows ones,
// which arrive from discovery with backslashes (`C:\Repos\app\products\x`)
// and from the wizard with forward slashes (`C:/Repos/app/products/x`). Both
// are kept as forward slashes: the engine takes either on Windows, and POSIX
// input comes out exactly as it went in.

/** Backslashes as forward slashes, and no trailing slash (except a root's). */
function normalise(p: string): string {
  const forward = p.replace(/\\/g, "/");
  return forward.length > 1 && !/^[A-Za-z]:\/$/.test(forward) ? forward.replace(/\/+$/, "") : forward;
}

/** `C:/...`, `/...` or `//server/...`: nothing to resolve it against. */
export function isAbsolutePath(p: string): boolean {
  const n = p.replace(/\\/g, "/");
  return n.startsWith("/") || /^[A-Za-z]:\//.test(n);
}

/** The directory a `product.gdl` sits in. */
export function parentOf(file: string): string {
  const n = normalise(file);
  const at = n.lastIndexOf("/");
  if (at < 0) return "/";
  // `C:/product.gdl` sits in `C:/`, `/product.gdl` in `/`.
  if (at === 0) return "/";
  if (/^[A-Za-z]:$/.test(n.slice(0, at))) return n.slice(0, at + 1);
  return n.slice(0, at);
}

/**
 * `at` resolved against the description's directory.
 *
 * `..` is honoured because that is how every real product points at a sibling
 * checkout -- `path("../../../gears-rust")` in the demo -- and never climbs past
 * a drive: `C:` is where a Windows path starts, not a segment to pop. An
 * absolute `at` is returned as it is, which is how New Product names the
 * machine's corpus copy.
 */
export function resolveFrom(directory: string, at: string): string {
  if (isAbsolutePath(at)) return normalise(at);
  const dir = normalise(directory);
  const drive = /^([A-Za-z]:)(\/|$)/.exec(dir)?.[1];
  const rest = drive === undefined ? dir : dir.slice(drive.length);
  const parts = rest.split("/").filter((p) => p.length > 0);
  for (const segment of at.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `${drive ?? ""}/${parts.join("/")}`;
}

/**
 * Whether `file` is inside `root`, segment-wise and whichever slashes either
 * uses. A drive letter compares either case: Theia spells it `c:`, the engine
 * and discovery `C:`.
 */
export function isInside(file: string, root: string): boolean {
  const drive = (p: string) => p.replace(/^([A-Za-z]):/, (_, letter: string) => `${letter.toLowerCase()}:`);
  const f = drive(normalise(file));
  const r = drive(normalise(root));
  if (r === "" || f === r) return false;
  return f.startsWith(r.endsWith("/") ? r : `${r}/`);
}
