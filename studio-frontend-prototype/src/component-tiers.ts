/* The two tiers of components on the Components page (ADR-0042).
 *
 * The platform's components are synced once, in the platform's tenant, and
 * every organization reads them beside its own. The server marks each node
 * with its `tier`; this file is what the pages do with the mark: which nodes
 * each level shows (the platform's at the top of the path, the
 * organization's under it), the note about components the platform shadows,
 * and the hint on a source the platform already reads. */

import type { CatalogNode, CatalogRepoSource } from "./api";

/** The levels the catalogue is shown at. `all` is what a product draws on
 *  (a project's candidates), not a page of its own. */
export type TierTab = "platform" | "organization" | "all";

export const TIER_TABS: { value: TierTab; label: string; title: string }[] = [
  {
    value: "platform",
    label: "Platform",
    title: "The shared components every organization builds on. Read-only: what you edit is your organization's annotation.",
  },
  {
    value: "organization",
    label: "Ours",
    title: "Your organization's own components: its catalogue sources and its registry.",
  },
  { value: "all", label: "All", title: "Both, as a product draws on them." },
];

/** A node's tier. A node from a server older than the tiers is the
 *  organization's: that is all such a server ever listed. */
export function nodeTier(node: CatalogNode): "platform" | "organization" {
  return node.value.tier === "platform" ? "platform" : "organization";
}

export function inTierTab(node: CatalogNode, tab: TierTab): boolean {
  return tab === "all" || nodeTier(node) === tab;
}

/** How many nodes each tab shows. */
export function tierCounts(nodes: readonly CatalogNode[]): Record<TierTab, number> {
  const out: Record<TierTab, number> = { platform: 0, organization: 0, all: nodes.length };
  for (const n of nodes) out[nodeTier(n)] += 1;
  return out;
}

/** What to say about the organization's components the platform's shadow:
 *  the same name in both, listed once, as the platform's. Null for none. */
export function shadowedNote(names: readonly string[] | undefined): string | null {
  if (!names || names.length === 0) return null;
  const shown = names.slice(0, 5).join(", ");
  const more = names.length > 5 ? ` and ${names.length - 5} more` : "";
  const subject =
    names.length === 1
      ? "1 of your organization's components is also the platform's"
      : `${names.length} of your organization's components are also the platform's`;
  const verb = names.length === 1 ? "is" : "are";
  return `${subject} and ${verb} listed once, as the platform's: ${shown}${more}. Your notes on them are kept as your annotation.`;
}

/** The organization's sources the platform already reads. */
export function shadowedSources(items: readonly CatalogRepoSource[]): CatalogRepoSource[] {
  return items.filter((s) => s.shadowed_by_platform === true);
}

/** The hint on a source the platform already provides. */
export function sourceShadowHint(s: CatalogRepoSource): string {
  return `The platform already provides ${s.repo} (${s.mode || "gears"}): remove it from your sources, its components are listed as the platform's.`;
}

/** The organization's sources without one: what "remove" saves. */
export function withoutSource(
  items: readonly CatalogRepoSource[],
  gone: CatalogRepoSource,
): CatalogRepoSource[] {
  const key = (s: CatalogRepoSource) =>
    `${s.repo.trim().toLowerCase()}|${(s.mode || "gears").toLowerCase()}|${s.git_ref ?? ""}`;
  return items.filter((s) => key(s) !== key(gone));
}

/** What a component page says about a platform component, whose facts an
 *  organization reads and cannot change. Null for the organization's own. */
export function annotationNote(node: CatalogNode): string | null {
  if (nodeTier(node) !== "platform") return null;
  return "A platform component: its facts are the platform's, synced once for every organization. What you edit here is saved as your organization's annotation, laid over them.";
}
