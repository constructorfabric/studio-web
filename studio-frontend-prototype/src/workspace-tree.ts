/* ── A workspace's projects, summarised ───────────────────────────────────────
 *
 * The Workspaces table names a workspace and then, expanded, used to list its
 * projects by name only. These rules turn the organization overview's
 * per-project health (`GET /studio-organizations/v1/overview`) into what the
 * rows show: one status per project, the split of a workspace's projects into
 * fine / warn / failing, and which project spends most of its money.
 *
 * The server decides WHAT is wrong (`reasons`); this decides only how bad each
 * reason reads and which one a row leads with. */

import type { OrgProjectHealth, OrgReason, OrgWorkspace } from "./api";

export type ProjectHealth = "ok" | "warn" | "danger" | "unknown";

/** Worst first: a refused connection stops everything, a quiet project only
 *  might be forgotten. */
const SEVERITY: Record<OrgReason["kind"], { rank: number; tone: "warn" | "danger"; label: string }> = {
  refused: { rank: 0, tone: "danger", label: "Repo refused" },
  specs_failing: { rank: 1, tone: "danger", label: "Specs failing" },
  stuck: { rank: 2, tone: "warn", label: "PRs waiting" },
  spend_grows: { rank: 3, tone: "warn", label: "Spend rising" },
  quiet: { rank: 4, tone: "warn", label: "Gone quiet" },
};

/** The reason a project's row leads with, or null when nothing is wrong. */
export function worstReason(reasons: readonly OrgReason[]): OrgReason | null {
  let worst: OrgReason | null = null;
  for (const r of reasons) if (!worst || SEVERITY[r.kind].rank < SEVERITY[worst.kind].rank) worst = r;
  return worst;
}

/** One project's health: unknown when the overview does not carry it. */
export function projectHealth(h: OrgProjectHealth | undefined): ProjectHealth {
  if (!h) return "unknown";
  const worst = worstReason(h.reasons);
  if (h.broken) return "danger";
  return worst ? SEVERITY[worst.kind].tone : "ok";
}

/** The chip a project row carries: a state in a word or two, never the count
 *  its own columns already show. `more` counts the other problems. */
export function projectChip(h: OrgProjectHealth | undefined): {
  tone: "ok" | "warn" | "danger";
  label: string;
  more: number;
} | null {
  if (!h) return null;
  const worst = worstReason(h.reasons);
  if (!worst) return h.broken ? { tone: "danger", label: "Broken", more: 0 } : { tone: "ok", label: "Healthy", more: 0 };
  return { tone: SEVERITY[worst.kind].tone, label: SEVERITY[worst.kind].label, more: h.reasons.length - 1 };
}

/** Which column a reason belongs to, so that cell — not a second copy of its
 *  number — carries the tone. */
export function reasonColumn(kind: OrgReason["kind"]): "spend" | "delta" | "failing" | "stuck" | "quiet" | null {
  switch (kind) {
    case "specs_failing":
      return "failing";
    case "stuck":
      return "stuck";
    case "spend_grows":
      return "delta";
    case "quiet":
      return "quiet";
    case "refused":
      return null;
  }
}

export interface HealthSplit {
  ok: number;
  warn: number;
  danger: number;
  unknown: number;
}

/** How a workspace's projects split by health. Projects the overview does not
 *  know are `unknown`, not fine. */
export function healthSplit(projectIds: readonly string[], ws: OrgWorkspace | undefined): HealthSplit {
  const split: HealthSplit = { ok: 0, warn: 0, danger: 0, unknown: 0 };
  for (const id of projectIds) split[projectHealth(ws?.projects.find((p) => p.id === id))]++;
  return split;
}

/** The split in words, the fine ones last and only when it is all of them:
 *  "1 failing · 1 warning", "all 3 fine", "" for no projects. */
export function healthText(s: HealthSplit): string {
  const total = s.ok + s.warn + s.danger + s.unknown;
  if (total === 0) return "";
  if (s.ok === total) return total === 1 ? "fine" : `all ${total} fine`;
  const parts: string[] = [];
  if (s.danger) parts.push(`${s.danger} failing`);
  if (s.warn) parts.push(`${s.warn} ${s.warn === 1 ? "warning" : "warnings"}`);
  if (s.ok) parts.push(`${s.ok} fine`);
  if (s.unknown) parts.push(`${s.unknown} not read`);
  return parts.join(" · ");
}

/** The project that spends most, and its share of the workspace's spend.
 *  Null with fewer than two projects spending: "100% of one" says nothing. */
export function topSpender(ws: OrgWorkspace | undefined): { id: string; name: string; share: number } | null {
  if (!ws) return null;
  const spending = ws.projects.filter((p) => (p.spend ?? 0) > 0);
  if (spending.length < 2) return null;
  const total = spending.reduce((n, p) => n + (p.spend ?? 0), 0);
  const top = spending.reduce((a, b) => ((b.spend ?? 0) > (a.spend ?? 0) ? b : a));
  return { id: top.id, name: top.name, share: Math.round(((top.spend ?? 0) / total) * 100) };
}

/** The first `max` items and how many more there are. */
export function firstOf<T>(items: readonly T[], max = 4): { shown: T[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}
