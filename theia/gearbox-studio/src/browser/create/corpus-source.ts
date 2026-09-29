// Constructor Studio: the gear corpus as a source New Product can declare.
//
// A desktop project whose repositories hold no gear -- studio-web opened on
// its own -- had nothing to offer in the wizard's sources: they were the
// workspace's folders, and the one folder there contains the destination, so
// it is refused. The product was written with `sources = []` and then refused
// to open ("declares no source roots"). The corpus is on this machine or can
// be: the per-machine copy "Bring the gears here" makes, under
// `~/ConstructorStudio/corpus`. So the wizard offers that.

import type { CorpusOrigin } from "../../common/protocol";

/** The corpus copy on this machine, and the source id the engine names it by. */
export interface CorpusCopy {
  readonly id: string;
  readonly path: string;
}

export type CorpusOffer =
  | { readonly kind: "none" }
  /** The copy is here: offer it, checked when the workspace has no gears of its own. */
  | { readonly kind: "copy"; readonly copy: CorpusCopy; readonly preselect: boolean }
  /**
   * The corpus is known (the Studio backend lists it) but not here: offer to
   * bring it. `unavailable` says why it cannot be brought from here; `note`
   * says what bringing it needs.
   */
  | { readonly kind: "bring"; readonly origin: CorpusOrigin; readonly unavailable?: string; readonly note?: string };

function samePath(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`);
  return n(a) === n(b);
}

export function corpusOffer(input: {
  /** The adopted copy, when there is one (`GearboxService.adoptedCorpus`). */
  readonly copy?: CorpusCopy;
  /** The corpus the backend lists and this machine has no copy of. */
  readonly toBring?: CorpusOrigin;
  /** `CatalogueStore.corpusBringable`: `true`, or why it cannot be brought. */
  readonly bringable?: true | string;
  /** The folders the wizard already offers, with the source id each would be declared as. */
  readonly workspaceRoots: ReadonlyArray<{ readonly path: string; readonly id: string }>;
  /** The engine's roots right now, the corpus copy among them when it is adopted. */
  readonly engineRoots: readonly string[];
}): CorpusOffer {
  const { copy, toBring } = input;
  if (copy !== undefined) {
    // A checkout of the corpus the workspace already has wins: it is the one
    // a person edits, and two sources with one id is a description the loader
    // refuses.
    const shadowed = input.workspaceRoots.some((root) => root.id === copy.id || samePath(root.path, copy.path));
    if (shadowed) return { kind: "none" };
    const ownGears = input.engineRoots.some((root) => !samePath(root, copy.path));
    return { kind: "copy", copy, preselect: !ownGears };
  }
  if (toBring !== undefined) {
    if (input.bringable !== undefined && input.bringable !== true) {
      return { kind: "bring", origin: toBring, unavailable: input.bringable };
    }
    return toBring.needsToken
      ? {
          kind: "bring",
          origin: toBring,
          note: "The corpus is private: Studio relays it to the desktop app while you are signed in there.",
        }
      : { kind: "bring", origin: toBring };
  }
  return { kind: "none" };
}

/**
 * The source New Product declares for the copy.
 *
 * **A `path`, to the copy, and absolute -- chosen, not defaulted.** A
 * `git(url, rev)` source would be the portable spelling: it names the corpus
 * and the commit, resolves on any machine, and since `materializeGitSource`
 * lands it in this same per-machine cache it would even read this very copy
 * here. But `gearbox/product/create` takes sources as `{ id, at }` directories
 * and writes `path(...)` -- the engine has no way to be asked for a git
 * source -- and writing one into its output behind its back is working around
 * the engine, not using it. So the copy is named by path, and by its absolute
 * path: it lives under the member's home, not beside the project, and a
 * `../../../../Users/...` climb is no more portable and much harder to read.
 * The cost is said plainly in the wizard: this product resolves on this
 * machine; to share it, change the source to `git(url, rev)`, which opens
 * anywhere through the same cache.
 */
export function corpusSourceDecl(copy: CorpusCopy): { id: string; at: string } {
  return { id: copy.id, at: copy.path.replace(/\\/g, "/") };
}
