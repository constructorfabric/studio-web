// The decisions a staged open makes, separated from the sequence that makes them.
//
// **Extracted because the failure paths could not be tested any other way, and
// they were wrong.** `ProductSessionService` cannot be constructed outside a
// browser: it injects `MonacoTextModelService` and `WorkspaceService` as tokens,
// and loading those in Node reaches Monaco's ESM `.css` imports. So the three
// rules a UX review found broken -- which step a `git(...)` source belongs to,
// whether a catalogue load failed at all, and what counts as an open that
// succeeded -- lived where nothing deterministic could reach them.
//
// They are decisions over plain data, so they are functions over plain data. The
// sequence stays in the service, where reading it top to bottom is the point.

import type { ProductIntent } from "../../common/generated/ProductIntent";
import type { SourceDecl } from "../../common/generated/SourceDecl";
import type { ProductRef } from "../../common/protocol";

/**
 * The four steps an open takes, named after what each one is waiting for.
 *
 * Here rather than beside the service, so a decision and the step it attributes
 * a failure to are declared in one place.
 */
export type OpeningStage = "workspace" | "describe" | "catalogue" | "resolve";

export const OPENING_STAGES: readonly OpeningStage[] = [
  "workspace",
  "describe",
  "catalogue",
  "resolve",
];

/** What each step is waiting for, in the words a person would use. */
export const OPENING_LABEL: Readonly<Record<OpeningStage, string>> = {
  workspace: "starting the engine on the product's folder",
  describe: "reading the description",
  catalogue: "loading the gears it declares",
  resolve: "resolving the default profile",
};

/** Either carry on, or stop at a step with a reason. */
export type Outcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export const GO: Outcome = { ok: true };

/**
 * The source roots a description declares, and the ones that cannot be reached.
 *
 * `refused` is a `git(...)` source that could not be brought here (absent from
 * `gitRoots`). Refused rather than skipped: a catalogue quietly missing a
 * source is indistinguishable from a product whose gears do not exist.
 */
export function sourceRootsOf(
  intent: Pick<ProductIntent, "sources">,
  resolve: (at: string) => string,
  /** Constructor Studio: git sources already brought in, by source id. */
  gitRoots: Readonly<Record<string, string>> = {},
): { readonly roots: readonly string[]; readonly refused: readonly string[] } {
  const roots: string[] = [];
  const refused: string[] = [];
  // Typed explicitly: `sources` is a mapped type keyed by `SourceId`, and
  // `Object.entries` widens its values to `unknown`.
  const declared = Object.entries(intent.sources ?? {}) as [string, SourceDecl][];
  for (const [id, source] of declared) {
    if (source.kind === "path") {
      roots.push(resolve(source.at));
    } else if (source.kind === "git" && gitRoots[id] !== undefined) {
      roots.push(gitRoots[id] as string);
    } else {
      refused.push(id);
    }
  }
  return { roots, refused };
}

/**
 * Whether a description's sources can be used, and why not when they cannot.
 *
 * **Both refusals belong to `describe`, not to `catalogue`.** Nothing has been
 * loaded when this runs, and what is wrong is what the description says -- so
 * attributing them to the load would point a person at the step after the one
 * they can fix.
 */
export function sourcesUsable(
  label: string,
  sources: { readonly roots: readonly string[]; readonly refused: readonly string[] },
  /** Why each refused git source could not be fetched, by source id, when git said. */
  failures: Readonly<Record<string, string>> = {},
): Outcome {
  if (sources.refused.length > 0) {
    // Named, not counted: which source cannot be reached is the actionable part.
    const why = sources.refused
      .map((id) => failures[id])
      .filter((reason): reason is string => reason !== undefined && reason !== "");
    return {
      ok: false,
      reason:
        `${label} declares ${sources.refused.join(", ")} as a git source that could not be fetched` +
        (why.length > 0 ? `: ${why.join("; ")}` : ". Check its URL and revision.") +
        ` Or point it at a local path.`,
    };
  }
  if (sources.roots.length === 0) {
    return { ok: false, reason: `${label} declares no source roots, so there are no gears to compose.` };
  }
  return GO;
}

/**
 * Whether a catalogue load worked.
 *
 * **`CatalogueStore.load` does not reject**, and this function exists because of
 * that: it records a failure as `status: "error"` on its own state and returns
 * normally. Awaiting it and carrying on attributed an engine that would not start
 * to whichever step failed afterwards.
 */
export function catalogueUsable(
  state: { readonly status: string; readonly error?: string | undefined },
  what: string,
): Outcome {
  if (state.status !== "error") return GO;
  return { ok: false, reason: `${what}: ${state.error ?? "no reason was reported"}` };
}

/**
 * Whether the store ended up holding this product, resolved.
 *
 * **Not `open !== undefined`, which was true whatever happened.**
 * `ProductStore.open` sets `open` in its *first* update, before it has evaluated
 * anything, and a failure leaves it set on purpose -- the panel renders the error
 * beside the product it is about. So the old test reported an unresolvable
 * product as a successful open, and it went into Recent: the list a person trusts
 * to reopen things that worked.
 */
export function openedSuccessfully(
  ref: ProductRef,
  state: {
    readonly status: string;
    readonly open: ProductRef | undefined;
    readonly error?: string | undefined;
  },
): Outcome {
  if (state.open?.path === ref.path && state.status === "ready") return GO;
  return {
    ok: false,
    reason: state.error ?? `${ref.label} could not be resolved, so it was not opened.`,
  };
}
