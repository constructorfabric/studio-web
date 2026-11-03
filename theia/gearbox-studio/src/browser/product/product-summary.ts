// The Product view's words for the product as a whole: its profile, what to
// do next, and how a feature or a count reads.
//
// Plain functions, next to the widget rather than inside it, so the decisions
// are tested without a widget (desktop-contributing.md, "Keep the logic out of
// the widget"). The words follow the portal's product summary
// (studio-frontend-prototype/src/product-sections.ts, `productSummary` and
// `PRODUCT_PROFILES`) -- the same product should not be described two ways --
// copied rather than imported, because Theia does not depend on the portal.

import type { Diagnostic } from "../../common/generated/Diagnostic";
import type { InclusionReason } from "../../common/generated/InclusionReason";
import type { ProductStatus } from "../product-store";

/** `1 warning`, `2 warnings`: a count and its noun, agreeing. */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * How each deployment kind reads beside a profile's id.
 *
 * The portal names its three fixed profiles `dev · one process`, `local ·
 * processes on one host` and `prod · Kubernetes`. A product here declares its
 * own profile ids, so the id is kept and the kind supplies the portal's half.
 */
const KIND_WORDS: Readonly<Record<string, string>> = {
  embedded: "one process",
  self_hosted: "processes on one host",
  "self-hosted": "processes on one host",
  kubernetes: "Kubernetes",
};

/** `local · processes on one host`; the bare id for a kind with no words. */
export function profileLabel(id: string, kind: string | undefined): string {
  const words = kind === undefined ? undefined : KIND_WORDS[kind];
  return words === undefined ? id : `${id} · ${words}`;
}

/** The one step the summary band suggests. */
export type NextStep =
  | { readonly kind: "wait"; readonly title: string; readonly detail: string }
  | { readonly kind: "reconnect"; readonly title: string; readonly detail: string; readonly action: string }
  | { readonly kind: "retry"; readonly title: string; readonly detail: string; readonly action: string }
  | { readonly kind: "checks"; readonly title: string; readonly detail: string; readonly action: string }
  | { readonly kind: "apply"; readonly title: string; readonly detail: string; readonly action: string }
  | { readonly kind: "add-gear"; readonly title: string; readonly detail: string; readonly action: string }
  | { readonly kind: "generate"; readonly title: string; readonly detail: string; readonly action: string };

/**
 * What to do next, in the order a product gets in the way of itself.
 *
 * A lost engine first, because nothing else can be done until it is back; then
 * a description the engine refused; then conflicts, which Generate would
 * refuse anyway; then unapplied edits, which Generate would not see; and only
 * a clean, saved product is offered Generate -- and Deploy after it, which is
 * on the Generate stage.
 */
export function nextStepOf(args: {
  readonly status: ProductStatus;
  readonly stale: boolean;
  readonly failed: boolean;
  readonly conflicts: number;
  readonly pending: number;
  readonly gears: number;
  readonly canGenerate: boolean;
}): NextStep {
  if (args.stale) {
    return {
      kind: "reconnect",
      title: "Reconnect the engine",
      detail: "What is shown is from before the connection was lost.",
      action: "Reconnect engine",
    };
  }
  if (args.status === "loading" || args.status === "resolving") {
    return { kind: "wait", title: "Checking the product…", detail: "The next step appears once the check is done." };
  }
  if (args.failed) {
    return {
      kind: "retry",
      title: "The product could not be checked",
      detail: "Fix the description, then check it again.",
      action: "Retry",
    };
  }
  if (args.conflicts > 0) {
    return {
      kind: "checks",
      title: `Resolve ${plural(args.conflicts, "conflict", "conflicts")}`,
      detail: "Generate needs a product without conflicts.",
      action: "Review checks",
    };
  }
  if (args.pending > 0) {
    return {
      kind: "apply",
      title: `Apply ${plural(args.pending, "change", "changes")}`,
      detail: "Edits are written to the description when applied.",
      action: "Apply changes",
    };
  }
  if (args.gears === 0) {
    return { kind: "add-gear", title: "Add your first gear", detail: "A product is composed from gears.", action: "Add gear" };
  }
  if (!args.canGenerate) {
    return { kind: "wait", title: "Ready", detail: "This engine cannot generate code." };
  }
  return {
    kind: "generate",
    title: "Generate the code",
    detail: "Then build and deploy it from the Run & Deploy stage.",
    action: "Generate",
  };
}

/**
 * `theia-bridge` as `Theia bridge`: a Cargo feature name read as words.
 *
 * Only a label -- the id stays beside it, because the id is what the
 * description is written in and what a person searches for.
 */
export function humanizeFeature(name: string): string {
  const words = name.split(/[-_]+/).filter((word) => word !== "");
  if (words.length === 0) return name;
  const first = words[0]!;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(" ");
}

/**
 * The worst problem the engine reports about each gear, by gear id.
 *
 * Keyed by `Diagnostic.subject`, which is `{kind}:{payload}` on the wire (see
 * `selectionOf` in diagnostics-list.tsx); only `gear:` subjects name a gear. A
 * diagnostic about a binding or a profile marks no gear row: it is on Checks.
 */
export function gearHealth(diagnostics: readonly Diagnostic[]): Map<string, "error" | "warning"> {
  const worst = new Map<string, "error" | "warning">();
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== "error" && diagnostic.severity !== "warning") continue;
    const subject = diagnostic.subject;
    if (typeof subject !== "string" || !subject.startsWith("gear:")) continue;
    const gear = subject.slice("gear:".length);
    if (worst.get(gear) === "error") continue;
    worst.set(gear, diagnostic.severity);
  }
  return worst;
}

/**
 * Why a gear is in the product, as a chip's words: `Added by you`,
 * `Required by X`, `Plugin of X`.
 *
 * Shorter than `describeInclusion`, whose full sentence stays in the chip's
 * tooltip and in `data-inclusion-sentence`, where a claim may read it.
 */
export function inclusionChip(reason: InclusionReason): string {
  switch (reason.reason) {
    case "selected":
      return "Added by you";
    case "colocated_by":
      return `Required by ${reason.gear}`;
    case "plugin_of":
      return `Plugin of ${reason.host}`;
  }
}
