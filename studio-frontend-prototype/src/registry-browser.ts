/* A registry of the organization, browsed from its place under Organization
 * › Infrastructure (registry-browser-view.tsx): its repositories, each one's
 * versions, and what in it nothing in Studio accounts for (the orphans).
 *
 * Not the component registry (registry.ts): this one holds images and charts.
 * Pure, so it is tested without a backend. */

import type { OrgRegistry, RegistryOrphan, RegistryRepository, RegistryTag } from "./api";
import { whereItRuns } from "./images";

/** What the organization's environments do with a registry. */
export function roleWords(role: OrgRegistry["role"]): string {
  return role === "push" ? "builds push to it" : role === "pull" ? "clusters pull from it" : "builds push to it and clusters pull from it";
}

/** The kind of registry, as its maker names it. */
export const REGISTRY_KIND: Record<OrgRegistry["kind"], string> = {
  ghcr: "GitHub Container Registry",
  harbor: "Harbor",
  oci: "OCI registry",
};

/** Repositories by name; whose project each is, or that it is nobody's. */
export function repositoryRows(repos: readonly RegistryRepository[]): (RegistryRepository & { owner: string })[] {
  return [...repos]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => ({ ...r, owner: r.project_name || (r.project_id ? r.project_id.slice(0, 8) : "no project") }));
}

/** A repository's versions, newest first; one with no push time last. */
export function sortTags(tags: readonly RegistryTag[]): RegistryTag[] {
  return [...tags].sort((a, b) => (b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""));
}

/** Whether a version may be deleted from the registry, and why not. */
export function versionDeletion(t: Pick<RegistryTag, "running_in" | "digest">): { allowed: boolean; reason: string | null } {
  if (t.running_in.length > 0) return { allowed: false, reason: `${whereItRuns(t.running_in)} Deploy something else there first.` };
  // A version is deleted by its digest; one the listing gave none for cannot be.
  if (!t.digest) return { allowed: false, reason: "The registry's listing gives no digest for it, and a version is deleted by its digest." };
  return { allowed: true, reason: null };
}

/** Why something is an orphan, and what to do about it. */
export const ORPHAN_REASON: Record<RegistryOrphan["reason"], { title: string; next: string }> = {
  unowned: {
    title: "Belongs to no project",
    next: "Its path is not under any project's: it was pushed from outside Studio, or its project is gone.",
  },
  unrecorded: {
    title: "Not recorded",
    next: "It is under a project's path, but no build, promotion or import of Studio put it there.",
  },
  undeployed: {
    title: "Never deployed",
    next: "Recorded, and nothing has run it: a candidate for the retention to take.",
  },
  missing: {
    title: "Missing from the registry",
    next: "Studio recorded it, and the registry no longer has it: a deploy of it would fail.",
  },
};

/** The order the orphans are read in: what breaks a deploy first. */
const REASON_ORDER: RegistryOrphan["reason"][] = ["missing", "unowned", "unrecorded", "undeployed"];

/** The orphans by reason, in the order they matter, each reason with its count. */
export function orphanGroups(orphans: readonly RegistryOrphan[]): { reason: RegistryOrphan["reason"]; items: RegistryOrphan[] }[] {
  return REASON_ORDER.map((reason) => ({
    reason,
    items: orphans.filter((o) => o.reason === reason).sort((a, b) => a.repository.localeCompare(b.repository)),
  })).filter((g) => g.items.length > 0);
}

/** The orphans in one line: `2 missing · 5 never deployed`. */
export function orphanSummary(orphans: readonly RegistryOrphan[]): string {
  if (orphans.length === 0) return "Nothing: everything in it is accounted for.";
  const words: Record<RegistryOrphan["reason"], string> = {
    missing: "missing",
    unowned: "of no project",
    unrecorded: "not recorded",
    undeployed: "never deployed",
  };
  return orphanGroups(orphans)
    .map((g) => `${g.items.length} ${words[g.reason]}`)
    .join(" · ");
}
