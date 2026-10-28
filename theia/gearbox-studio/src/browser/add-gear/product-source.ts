// Catalogue source IDs name local roots. GDL source IDs are aliases chosen by the product.
import type { ProductIntent } from "../../common/generated/ProductIntent";
import type { ResolvedRoot } from "../../common/generated/ResolvedRoot";
import { volumeOf } from "../create/paths";

export interface ProductSourceContext {
  readonly productPath: string;
  readonly intent: Pick<ProductIntent, "sources" | "selected_gears">;
  readonly roots: readonly ResolvedRoot[];
  readonly sourceOf: (gear: string) => string | undefined;
}

export type ProductSource =
  | { readonly ok: true; readonly source: string }
  | { readonly ok: false; readonly reason: string };

/** A declared path or an existing selection proves a binding; directory names do not. */
export function productSourceFor(catalogueSource: string, context: ProductSourceContext): ProductSource {
  const roots = new Map<string, string>();
  for (const root of context.roots) {
    const key = pathKey(root.path);
    if (key !== undefined) roots.set(root.id, key);
  }
  // Constructor Studio: a git or registry source is brought onto this machine
  // in a directory named by its id (`node/git-sources.ts`), so the catalogue ID
  // is the declared alias and there is no path to prove it by.
  const declared = context.intent.sources[catalogueSource];
  if (declared !== undefined && declared.kind !== "path") return { ok: true, source: catalogueSource };
  const target = roots.get(catalogueSource);
  if (target === undefined) return { ok: false, reason: `The catalogue source ${catalogueSource} is no longer open. Reconnect and select the gear again.` };
  const openPaths = new Set(roots.values());
  const bindings = new Map<string, Set<string>>();
  for (const [id, source] of Object.entries(context.intent.sources)) {
    if (source.kind !== "path") continue;
    const at = sourcePath(context.productPath, source.at);
    bindings.set(id, new Set(at !== undefined && openPaths.has(at) ? [at] : []));
  }
  // A relocated checkout still owns the same gears. Their written source aliases
  // survive relocation and are stronger evidence than the machine's folder name.
  for (const selected of context.intent.selected_gears) {
    const owner = context.sourceOf(selected.gear);
    const root = owner === undefined ? undefined : roots.get(owner);
    if (root !== undefined) bindings.get(selected.source)?.add(root);
  }
  const candidates = [...bindings].filter(([, paths]) => paths.size === 1 && paths.has(target)).map(([id]) => id);
  if (candidates.includes(catalogueSource)) return { ok: true, source: catalogueSource };
  if (candidates.length === 1) return { ok: true, source: candidates[0]! };
  if (candidates.length === 0) {
    // Preserve a declared catalogue ID when no path/selection contradicts it.
    if (bindings.get(catalogueSource)?.size === 0) return { ok: true, source: catalogueSource };
    // An empty product can have a single relocated source. Only the unmatched
    // one-to-one case is knowable; multiple sources must never be paired by order.
    const unbound = [...bindings].filter(([, paths]) => paths.size === 0).map(([id]) => id);
    const bound = new Set([...bindings.values()].flatMap(paths => [...paths]));
    const unmatchedRoots = [...openPaths].filter(root => !bound.has(root));
    if (unbound.length === 1 && unmatchedRoots.length === 1 && unmatchedRoots[0] === target) {
      return { ok: true, source: unbound[0]! };
    }
  }
  return { ok: false, reason: `Cannot identify one declared source for catalogue source ${catalogueSource}. Check the product's sources and their gear selections in product.gdl before adding this gear.` };
}

function slash(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "");
}

/** Compare Windows paths without case, preserving POSIX case and UNC share identity. */
function pathKey(path: string): string | undefined {
  const volume = volumeOf(slash(path));
  if (volume === undefined) return undefined;
  const parts: string[] = [];
  for (const part of volume.segments) {
    if (part === "..") parts.pop();
    else parts.push(volume.root === "/" ? part : part.toLowerCase());
  }
  return `${volume.root}|${parts.join("/")}`;
}

function sourcePath(productPath: string, at: string): string | undefined {
  const target = slash(at);
  if (volumeOf(target) !== undefined) return pathKey(target);
  const product = slash(productPath);
  return pathKey(`${product.slice(0, product.lastIndexOf("/"))}/${target}`);
}
