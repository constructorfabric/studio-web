// Which screen belongs to which subject, and for how long.
//
// `StudioContextService` answers *what is being worked on*. This answers the two
// questions that follow from it, and they are not the same question:
//
//   * **availability** -- where a screen may be opened at all;
//   * **lifetime** -- which subject an already-open one belongs to.
//
// Scoping by `context.kind` alone answers only the first, and a UX pass found
// what the gap costs. Stage an Add Gear proposal against one product, open
// another: the kind is still `product`, so nothing is withdrawn, and
// `ProductEditService.commitAddGear` reads `this.product.current.open` at commit
// time -- so the proposal built for the first product is written to the second.
// The empty `Gearbox Product` tab the pass reported is the same defect with a
// visible symptom; this is the same defect without one.
//
// So a screen is scoped to a `ContextIdentity` -- `product:<path>`, not
// `product` -- and the shell withdraws on a change of *subject*, not merely on a
// change of kind.
//
// **Data and pure functions, no injection**, for the reason
// `session-command-ids.ts` is dependency-free: this is read by the view
// contributions, by the scope service and by the claims, and a module that
// imported widgets to name them would close a cycle through every one of them.
// The ids are therefore literals, and a regression claim asserts each one is a
// widget this application actually registers.

import { URI } from "@theia/core/lib/common/uri";

import type { StudioContext } from "./studio-context-service";

/** The three kinds of work, spelled as `StudioContext` spells them. */
export type ContextKind = StudioContext["kind"];

/**
 * *Which* subject, not which kind of subject.
 *
 * The whole point of the file: `product:/a/product.gdl` and
 * `product:/b/product.gdl` are different scopes, and a screen belonging to one
 * has no business surviving into the other.
 */
export type ContextIdentity = "home" | `product:${string}` | `gear:${string}`;

/**
 * How long an open screen lives.
 *
 * `context-kind` exists for screens with no subject of their own to go stale
 * about; everything that draws one product's answer is `context-instance`.
 */
export type Lifetime = "global" | "context-kind" | "context-instance";

export interface Screen {
  readonly widgetId: string;
  /** Where it may be opened. Availability and lifetime are separate axes. */
  readonly availableIn: readonly ContextKind[];
  readonly lifetime: Lifetime;
  /** Folds the side panels while it is the current main tab. */
  readonly focus?: boolean;
}

const ALL_KINDS: readonly ContextKind[] = ["home", "product", "gear"];

/**
 * Every screen this application has, and what it belongs to.
 *
 * Two entries are worth reading twice.
 *
 * **The Graph is `availableIn: all` and `context-kind`, and its staleness is
 * fixed where the staleness is.** It holds per-subject state -- a focused gear
 * id from one product's closure -- so a stale one is a real complaint. But it is
 * also the one screen that is *valid with no product*: its co-location view
 * reads the catalogue, and three claims reach it from Home. Withdrawing it on
 * every change of subject therefore destroyed a screen that the new context can
 * hold perfectly well, and destroyed it mid-interaction -- observed as a view
 * switch that silently did not take, because the widget behind the click had
 * been rebuilt and a fresh one starts on co-location.
 *
 * So the widget survives and `GraphWidget` clears what belonged to the previous
 * product. Closing a screen is the right answer when nothing in it means
 * anything any more, which is true of the five product screens above and is not
 * true of this one.
 *
 * **The Inspector is `global`**, and its subject gate is a context key rather
 * than a lifetime: what makes it empty is an absent *selection*, not an absent
 * product, and `QuickViewService.getPicks` filters on `when` alone, so a gate
 * that must reach `Open View...` has to be a key.
 */
export const SCREENS: readonly Screen[] = [
  { widgetId: "gearbox.start", availableIn: ["home"], lifetime: "context-kind" },
  { widgetId: "gearbox.product", availableIn: ["product"], lifetime: "context-instance" },
  // **An entrance, not a widget.** Adding a gear is a modal dialog; the row
  // stays because what these tables scope is where the entrance may appear, and
  // an id absent from here reads as "not ours" and is permitted everywhere --
  // which is how `View > Add Gear` reached Home before they existed.
  //
  // No `focus`: a dialog does not fold the side panels and give them back, it
  // takes the screen and returns it. `focusScreens()` is the three that do.
  { widgetId: "gearbox.add-gear", availableIn: ["product"], lifetime: "context-instance" },
  { widgetId: "gearbox.lock", availableIn: ["product"], lifetime: "context-instance" },
  { widgetId: "gearbox.conflicts", availableIn: ["product"], lifetime: "context-instance" },
  { widgetId: "gearbox.generate", availableIn: ["product"], lifetime: "context-instance" },
  { widgetId: "gearbox.gear", availableIn: ["gear"], lifetime: "context-instance" },
  { widgetId: "gearbox.create", availableIn: ALL_KINDS, lifetime: "context-instance", focus: true },
  {
    widgetId: "gearbox.gear.create",
    availableIn: ALL_KINDS,
    lifetime: "context-instance",
    focus: true,
  },
  { widgetId: "gearbox.graph", availableIn: ALL_KINDS, lifetime: "context-kind", focus: true },
  { widgetId: "gearbox.catalogue", availableIn: ALL_KINDS, lifetime: "global" },
  { widgetId: "gearbox.catalogue-diagnostics", availableIn: ALL_KINDS, lifetime: "global" },
  { widgetId: "gearbox.inspector", availableIn: ALL_KINDS, lifetime: "global" },
];

/** The declaration for one widget, or `undefined` when it is not ours. */
export function screenFor(widgetId: string): Screen | undefined {
  return SCREENS.find((screen) => screen.widgetId === widgetId);
}

/**
 * Which subject a context is.
 *
 * By canonical URI rather than by the raw string, because the same product can
 * be named `/a/b/product.gdl` and `/a/./b/product.gdl` by two callers, and two
 * spellings of one subject would withdraw a screen from itself.
 * `ProductSessionService.isDirty` normalises the same way for the same reason.
 */
export function identityOf(context: StudioContext): ContextIdentity {
  switch (context.kind) {
    case "home":
      return "home";
    case "product":
      return `product:${canonical(context.product.path)}`;
    case "gear":
      return `gear:${canonical(context.root)}`;
  }
}

/**
 * The identity of one product, for a caller holding a path rather than a context.
 *
 * **Exists because spelling it by hand was wrong.** `identityOf` canonicalises,
 * so `product:${path}` written out is a *different string* from the identity the
 * same product answers to -- `file:///a/product.gdl` against `/a/product.gdl` --
 * and every owner check against it silently refused. The Add Gear dialog did
 * exactly that, so its own preview was rejected as composed for another product
 * and it could not write at all.
 */
export function productIdentity(path: string): ContextIdentity {
  return `product:${canonical(path)}`;
}

/** The kind an identity belongs to, without re-deriving it from the context. */
export function kindOf(identity: ContextIdentity): ContextKind {
  if (identity === "home") return "home";
  return identity.startsWith("product:") ? "product" : "gear";
}

/** Whether a screen may be opened in this kind of context. */
export function availableIn(widgetId: string, kind: ContextKind): boolean {
  const screen = screenFor(widgetId);
  // Not ours: this module has no opinion, and answering `false` would disable
  // every Theia view that happens to pass through a shared helper.
  if (screen === undefined) return true;
  return screen.availableIn.includes(kind);
}

/**
 * The `when` clause that expresses a screen's availability, or `undefined` when
 * it is available everywhere.
 *
 * `undefined` rather than a tautology: a clause that is always true still costs
 * a context-key evaluation per menu open, and a reader has to check whether it
 * means something.
 */
export function whenClauseFor(widgetId: string, contextKey: string): string | undefined {
  const screen = screenFor(widgetId);
  if (screen === undefined) return undefined;
  if (screen.availableIn.length >= ALL_KINDS.length) return undefined;
  return screen.availableIn.map((kind) => `${contextKey} == '${kind}'`).join(" || ");
}

/**
 * The screens that must be withdrawn when the subject moves from `prev` to
 * `next`.
 *
 * Takes both identities, which is the whole point: `context-instance` screens
 * go on a product A to product B move, where a comparison of *kinds* sees no
 * change at all.
 *
 * `prev === undefined` is the first reconcile after a start, where a restored
 * layout may hold anything: everything out of place is withdrawn.
 */
export function outOfScope(
  prev: ContextIdentity | undefined,
  next: ContextIdentity,
): readonly string[] {
  const kind = kindOf(next);
  return SCREENS.filter((screen) => {
    if (screen.lifetime === "global") return false;
    if (!screen.availableIn.includes(kind)) return true;
    if (screen.lifetime === "context-kind") return prev !== undefined && kindOf(prev) !== kind;
    return prev !== next;
  }).map((screen) => screen.widgetId);
}

/** The screens that fold the side panels while they are the current main tab. */
export function focusScreens(): readonly string[] {
  return SCREENS.filter((screen) => screen.focus === true).map((screen) => screen.widgetId);
}

/**
 * A widget that remembers which subject opened it.
 *
 * Stamped by the `open*` path of each stateful screen, and read by the
 * withdrawal sweep -- so a wizard survives exactly as long as the thing it was
 * composed for. Optional because most widgets carry no state worth owning.
 */
export interface OwnedWidget {
  ownerIdentity?: ContextIdentity;
}

export namespace OwnedWidget {
  export function is(widget: unknown): widget is OwnedWidget {
    return typeof widget === "object" && widget !== null && "ownerIdentity" in widget;
  }
}

function canonical(path: string): string {
  // `normalizePath` as well as `fromFilePath`, and the second half is the half
  // that does the work here: `fromFilePath` settles the scheme and the
  // separators, and leaves `/a/./b` alone. Two spellings of one product would
  // withdraw its screens from themselves on every reconcile.
  return URI.fromFilePath(path).normalizePath().toString();
}
