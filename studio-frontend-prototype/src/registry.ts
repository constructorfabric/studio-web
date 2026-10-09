/* The organization's component registry (ADR-0041), as the Components page
 * reads it: every component its projects declare, where each was found, and
 * the state a person or discovery put it in.
 *
 * Pure rules behind `component-registry.tsx`, kept here for their tests. */

import type {
  RegistryDecision,
  RegistryDecisionInput,
  RegistryEntry,
  RegistryOwner,
  RegistryProjectWalk,
  RegistryPublishPreview,
  RegistrySuggestion,
} from "./api";
import { occurrencePlace } from "./org-gear-repository";

/** The states in the order a component moves through them. */
export const REGISTRY_STATES = ["candidate", "declared", "registered", "published", "deprecated", "rejected", "merged"] as const;

export const STATE_LABEL: Record<string, string> = {
  candidate: "could become a gear",
  declared: "declared in a project",
  registered: "registered",
  published: "published",
  deprecated: "deprecated",
  rejected: "rejected",
  merged: "merged",
};

/** The badge tone a state is drawn in. */
export const STATE_TONE: Record<string, string> = {
  candidate: "info",
  declared: "warn",
  registered: "ok",
  published: "ok",
  deprecated: "danger",
  rejected: "",
  merged: "",
};

/** What a person can do to an entry (ADR-0041 P2). */
export type RegistryAction = "register" | "reject" | "deprecate" | "restore" | "publish" | "mark_published" | "merge" | "edit";

/** The button for each action. */
export const ACTION_LABEL: Record<RegistryAction, string> = {
  register: "Register",
  reject: "Reject",
  deprecate: "Deprecate",
  restore: "Restore",
  publish: "Publish to the platform…",
  mark_published: "Mark published",
  merge: "Merge into…",
  edit: "Edit",
};

/** The past tense, for the decisions history. */
export const ACTION_DONE: Record<string, string> = {
  declare: "opened a pull request declaring",
  register: "registered",
  reject: "rejected",
  deprecate: "deprecated",
  restore: "restored",
  publish: "opened a contribution to the platform for",
  mark_published: "marked published",
  published: "found it on the platform",
  merge: "merged",
  edit: "edited",
};

/** The actions the server allows from a state, in the order the buttons
 *  show. The same table the backend enforces; a move outside it is refused
 *  there too. */
export function allowedActions(state: string, opts: { platformAdmin?: boolean } = {}): RegistryAction[] {
  switch (state) {
    case "candidate":
    case "declared":
      return ["register", "reject", "merge", "edit"];
    case "registered":
      // Only a platform administrator says by hand that the platform has it.
      return opts.platformAdmin
        ? ["publish", "mark_published", "deprecate", "merge", "edit"]
        : ["publish", "deprecate", "merge", "edit"];
    case "published":
      return ["deprecate", "merge", "edit"];
    case "rejected":
      return ["restore", "merge", "edit"];
    case "deprecated":
      return ["restore", "merge", "edit"];
    case "merged":
      return ["edit"];
    default:
      return [];
  }
}

/** An owner in a few words: "Ada (person)", "Payments (team)". */
export function ownerLabel(o: RegistryOwner | null | undefined): string | null {
  if (!o || !o.name) return null;
  return `${o.name} (${o.kind === "person" ? "person" : "team"})`;
}

/** The entries a decision may name (a replacement, a merge target): every
 *  other entry that is not merged itself. */
export function decisionTargets(entries: readonly RegistryEntry[], self: string): string[] {
  return entries
    .filter((e) => e.state !== "merged" && e.name.toLowerCase() !== self.toLowerCase())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** One line of the decisions history. `names` turns a person id into a name. */
export function decisionLine(d: RegistryDecision, names: Record<string, string> = {}): string {
  const who = d.by_name || names[d.by] || d.by;
  const what = ACTION_DONE[d.action] ?? d.action;
  const move = d.from === d.to ? "" : ` (${d.from} → ${d.to})`;
  const details = d.details ?? {};
  const extra: string[] = [];
  if (typeof details.replaced_by === "string") extra.push(`use ${details.replaced_by} instead`);
  if (typeof details.merge_into === "string") extra.push(`into ${details.merge_into}`);
  if (typeof details.merged_from === "string") extra.push(`took in ${details.merged_from}`);
  if (typeof details.version === "string") extra.push(`version ${details.version}`);
  if (typeof details.pr_url === "string") extra.push(`pull request ${details.pr_url}`);
  else if (typeof details.branch === "string" && d.action === "declare") extra.push(`branch ${details.branch}`);
  const contribution = details.contribution as { pr_url?: string | null; repo?: string } | undefined;
  if (contribution && typeof contribution === "object") {
    extra.push(contribution.pr_url ? `pull request ${contribution.pr_url}` : `into ${contribution.repo ?? "the platform"}`);
  }
  const owner = details.owner as RegistryOwner | undefined;
  if (owner && typeof owner === "object" && owner.name) extra.push(`owner ${ownerLabel(owner)}`);
  const said = [extra.join(", "), d.reason ? `“${d.reason}”` : ""].filter(Boolean).join(" — ");
  return `${who} ${what}${move}${said ? `: ${said}` : ""}`;
}

/** What a refused decision says to a person. A 403 means only an
 *  administrator may decide; anything else is the server's own words. */
export function decisionRefusal(status: number | undefined, fallback: string): string {
  if (status === 403) return `Only an organization administrator can decide about the registry (${fallback}).`;
  return fallback;
}

export function stateCounts(entries: readonly RegistryEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) out[e.state] = (out[e.state] ?? 0) + 1;
  return out;
}

/** The projects that declare it, by name where the server knows one. */
export function projectsOf(e: RegistryEntry): string[] {
  const seen: string[] = [];
  for (const o of e.occurrences) {
    const name = o.scope === "organization" ? occurrencePlace(o) : o.project_name || o.project_id || o.repo;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** Declared in more than one repository: two copies of one component, or two
 *  components sharing a name. Either way a person should look. */
export function isDuplicated(e: RegistryEntry): boolean {
  return new Set(e.occurrences.map((o) => o.repo)).size > 1;
}

/** No repository declares it any more. A merged entry never is: what it was
 *  found as belongs to the entry it was merged into, so its having no
 *  occurrence of its own is the merge, not a loss. (An older backend still
 *  flags merged entries; this reads past it.) */
export function isOrphaned(e: RegistryEntry): boolean {
  return e.orphaned && e.state !== "merged";
}

export interface RegistryFilter {
  state: string | null;
  q: string;
  project: string | null;
}

export function filterEntries(entries: readonly RegistryEntry[], f: RegistryFilter): RegistryEntry[] {
  const q = f.q.trim().toLowerCase();
  return entries.filter(
    (e) =>
      (!f.state || e.state === f.state) &&
      (!f.project || e.occurrences.some((o) => o.project_id === f.project)) &&
      (!q ||
        e.name.toLowerCase().includes(q) ||
        (e.description ?? "").toLowerCase().includes(q) ||
        e.occurrences.some((o) => o.path.toLowerCase().includes(q) || o.repo.toLowerCase().includes(q))),
  );
}

/** Every project the registry has seen, for the project filter. */
export function registryProjects(entries: readonly RegistryEntry[]): { id: string; name: string }[] {
  const out = new Map<string, string>();
  for (const e of entries) {
    for (const o of e.occurrences) if (o.project_id && !out.has(o.project_id)) out.set(o.project_id, o.project_name || o.project_id);
  }
  return [...out].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/* ── Candidates (ADR-0041 P3) ─────────────────────────────────────────────── */

/** Code that looks like a gear and is not declared one, strongest first. */
export function candidatesOf(entries: readonly RegistryEntry[]): RegistryEntry[] {
  return entries
    .filter((e) => e.state === "candidate")
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.name.localeCompare(b.name));
}

/** Why a candidate looks like a gear, one line per signal, heaviest first:
 *  "own REST surface: rest.rs (+3)". */
export function evidenceLines(e: Pick<RegistryEntry, "evidence">): string[] {
  return (e.evidence ?? [])
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((v) => `${v.detail} (+${v.weight})`);
}

/** Where a candidate was detected, for its row: the first detected
 *  occurrence's project and path. */
export function candidateWhere(e: RegistryEntry): string {
  const o = e.occurrences.find((x) => x.declared_in === "detected") ?? e.occurrences[0];
  if (!o) return "—";
  const project = o.scope === "organization" ? occurrencePlace(o) : o.project_name || o.project_id || o.repo;
  return `${project} · ${o.path}`;
}

/** The project ids a candidate was detected in, so Declare it can name one
 *  when it was found in several. */
export function detectedProjects(e: Pick<RegistryEntry, "occurrences">): string[] {
  const out: string[] = [];
  for (const o of e.occurrences) {
    if (o.declared_in === "detected" && o.project_id && !out.includes(o.project_id)) out.push(o.project_id);
  }
  return out;
}

/** What a refused Declare it says to a person: a 403 is the administrator
 *  rule, a 503 a deployment without studio-product. */
export function declareRefusal(status: number | undefined, fallback: string): string {
  if (status === 403) return `Only an organization administrator can declare a gear (${fallback}).`;
  if (status === 503) return `Declaring a gear is not available in this deployment (${fallback}).`;
  return fallback;
}

/** One line for what the last walk did with a project. */
export function walkLine(w: RegistryProjectWalk | undefined): { text: string; failed: boolean; hint: string | null } {
  if (!w) return { text: "not read yet", failed: false, hint: null };
  if (w.error) return { text: `not read: ${w.error}`, failed: true, hint: null };
  const failed = w.repos.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    return {
      text: `${failed.length} of ${w.repos.length} repositor${w.repos.length === 1 ? "y" : "ies"} not readable`,
      failed: true,
      hint: failed.find((r) => r.hint)?.hint ?? failed[0].error ?? null,
    };
  }
  const n = w.repos.reduce((sum, r) => sum + r.components, 0);
  const fresh = w.repos.some((r) => r.status === "read");
  return { text: `${fresh ? "read" : "unchanged"} · ${n} component${n === 1 ? "" : "s"}`, failed: false, hint: null };
}

/* ── Publishing, consumers and suggestions (ADR-0041 P4, ADR-0042 §4) ────── */

/** Where an entry stands with the platform: a contribution waiting for its
 *  pull request to be merged, or published (with the platform's version). */
export function publishStatus(
  e: Pick<RegistryEntry, "state" | "contribution" | "version">,
): { kind: "pending" | "published"; label: string; prUrl: string | null } | null {
  if (e.state === "published") {
    const label = e.version ? `Published (v${e.version.replace(/^v/, "")})` : "Published";
    return { kind: "published", label, prUrl: e.contribution?.pr_url ?? null };
  }
  if (e.state === "registered" && e.contribution) {
    return { kind: "pending", label: "Contribution PR opened", prUrl: e.contribution.pr_url ?? null };
  }
  return null;
}

/** A publish's dry run in words: where the pull request goes and what it
 *  carries, one line each. */
export function publishPreviewLines(p: RegistryPublishPreview): string[] {
  const lines = [
    `Pull request into ${p.repo} (${p.base_branch}) from ${p.branch}`,
    `Placed at ${p.path}/ — ${p.files.length} file${p.files.length === 1 ? "" : "s"}`,
  ];
  if (p.skipped.length > 0) lines.push(`Not copied (not text): ${p.skipped.join(", ")}`);
  return lines;
}

/** "Used by 3 projects", or null when nobody uses it. */
export function consumersLabel(e: Pick<RegistryEntry, "consumers">): string | null {
  const n = (e.consumers ?? []).length;
  if (n === 0) return null;
  return `Used by ${n} project${n === 1 ? "" : "s"}`;
}

/** One consumer in words: "Insight (cargo, product)". */
export function consumerLine(c: { project_name: string; project_id: string; via: string[] }): string {
  return `${c.project_name || c.project_id} (${c.via.join(", ")})`;
}

/** What deprecating it affects: the projects that use it, or null. */
export function deprecationImpact(e: Pick<RegistryEntry, "consumers">): string | null {
  const used = e.consumers ?? [];
  if (used.length === 0) return null;
  const names = used.map((c) => c.project_name || c.project_id);
  return `${names.length} project${names.length === 1 ? " uses" : "s use"} it and will see it deprecated: ${names.join(", ")}.`;
}

/** Applying a suggestion: the `edit` decision that sets what it proposed. */
export function suggestionEdit(s: RegistrySuggestion): RegistryDecisionInput {
  const input: RegistryDecisionInput = { action: "edit", capabilities: s.capabilities };
  if (s.description) input.description = s.description;
  if (s.category) input.category = s.category;
  return input;
}

/** What a refused suggestion says to a person: a 403 is the administrator
 *  rule, a 400 a missing model key, a 503 a model that could not be asked. */
export function suggestRefusal(status: number | undefined, fallback: string): string {
  if (status === 403) return `Only an organization administrator can ask for a suggestion (${fallback}).`;
  if (status === 400) return `Add a model key to your profile, or connect one under Connections, to ask for a suggestion (${fallback}).`;
  if (status === 503) return `No suggestion this time (${fallback}).`;
  return fallback;
}
