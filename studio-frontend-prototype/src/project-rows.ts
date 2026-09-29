/* ── The projects table, row by row ──────────────────────────────────────────
 *
 * What each column of a workspace's projects table says, worked out from the
 * one portfolio answer (`GET /studio-organizations/v1/rollups`). Nothing here
 * asks the server anything: every row arrives with its review, specs, pull
 * requests, team and last event already counted, and this file only decides
 * how they read.
 *
 * The rule from rollups.ts holds for every cell: a value the server could not
 * read is `null`, and a cell with a null says so in words ("unavailable",
 * "Not recorded") rather than rendering a zero that means something else.
 */
import type { RollupRow } from "./api";

/** How a project's review stands, most urgent first. */
export type ReviewTone = "findings" | "check" | "clear" | "empty" | "unknown";

export interface Review {
  tone: ReviewTone;
  /** The line that reads as the state: "3 open findings". */
  label: string;
  /** The counts behind it: "0 open findings · 8 not checked · 1 open comment". */
  detail: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The review column. Open findings outrank everything: they are a detector
 *  saying something is wrong. A spec that failed its check comes next, then
 *  specs nobody has checked yet — which is work, but not yet a problem. */
export function reviewOf(r: RollupRow): Review {
  const open = r.open_findings ?? null;
  const specs = r.specs ?? null;
  if (open == null && specs == null) {
    return { tone: "unknown", label: "Review unavailable", detail: null };
  }
  const checked = r.specs_checked ?? 0;
  const failing = r.specs_failing ?? 0;
  const notChecked = specs == null ? 0 : Math.max(0, specs - checked);
  const comments = r.open_comments == null ? null : plural(r.open_comments, "open comment");
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(" · ") || null;

  if (open) {
    return {
      tone: "findings",
      label: plural(open, "open finding"),
      detail: join(
        failing ? plural(failing, "spec needs check", "specs need check") : null,
        notChecked ? `${notChecked} not checked` : null,
        comments,
      ),
    };
  }
  if (failing || notChecked) {
    return {
      tone: "check",
      label: failing
        ? plural(failing, "spec needs check", "specs need check")
        : plural(notChecked, "spec not checked", "specs not checked"),
      detail: join(
        open == null ? null : plural(open, "open finding"),
        failing && notChecked ? `${notChecked} not checked` : null,
        comments,
      ),
    };
  }
  if (!specs) {
    return { tone: "empty", label: "No specs yet", detail: comments };
  }
  return {
    tone: "clear",
    label: "No open findings",
    detail: join(plural(checked, "spec checked", "specs checked"), comments),
  };
}

/** The review filter above the table. */
export type ReviewFilter = "all" | "findings" | "check" | "clear";

export const REVIEW_FILTERS: { id: ReviewFilter; label: string }[] = [
  { id: "all", label: "All reviews" },
  { id: "findings", label: "Open findings" },
  { id: "check", label: "Specs to check" },
  { id: "clear", label: "No open findings" },
];

export function inReviewFilter(review: Review, filter: ReviewFilter): boolean {
  return filter === "all" || review.tone === filter;
}

export type ProjectSort = "priority" | "name" | "updated";

export const PROJECT_SORTS: { id: ProjectSort; label: string }[] = [
  { id: "priority", label: "Review priority" },
  { id: "updated", label: "Last update" },
  { id: "name", label: "Name" },
];

const TONE_RANK: Record<ReviewTone, number> = { findings: 0, check: 1, empty: 2, clear: 3, unknown: 4 };

/** Order rows for the chosen sort. Review priority puts the project that most
 *  needs somebody first: open findings by how many, then specs to check. */
export function sortProjects<T extends { name: string; row?: RollupRow }>(
  items: T[],
  sort: ProjectSort,
): T[] {
  const key = (p: T) => p.row ?? ({} as RollupRow);
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  const at = (p: T) => {
    const t = Date.parse(key(p).last_at ?? "");
    return Number.isNaN(t) ? -Infinity : t;
  };
  const out = [...items];
  if (sort === "name") return out.sort(byName);
  if (sort === "updated") return out.sort((a, b) => at(b) - at(a) || byName(a, b));
  return out.sort((a, b) => {
    const ra = key(a);
    const rb = key(b);
    const ta = TONE_RANK[reviewOf(ra).tone];
    const tb = TONE_RANK[reviewOf(rb).tone];
    if (ta !== tb) return ta - tb;
    const oa = (ra.open_findings ?? 0) - (rb.open_findings ?? 0);
    if (oa) return -oa;
    const ca = (ra.specs_failing ?? 0) - (rb.specs_failing ?? 0);
    if (ca) return -ca;
    return byName(a, b);
  });
}

const KIND_LABEL: Record<string, string> = {
  new_gears: "Gears",
  product: "Product",
  existing: "Existing code",
};

/** "Kind · purpose", under the project's name. */
export function kindLine(r: RollupRow | undefined): string {
  const kind = r?.project_kind ? (KIND_LABEL[r.project_kind] ?? r.project_kind) : "Project";
  const brief = r?.brief?.split(/\r?\n/)[0]?.trim();
  return brief ? `${kind} · ${brief}` : kind;
}

/** The specs column: how many, and where they were written. */
export function specsCell(r: RollupRow | undefined): { label: string; detail: string | null } {
  const specs = r?.specs ?? null;
  if (specs == null) return { label: "—", detail: null };
  const authored = r?.specs_authored ?? 0;
  return {
    label: plural(specs, "spec"),
    detail: !authored ? null : authored === specs ? "Created in Studio" : `${authored} created in Studio`,
  };
}

/** The pull requests column, or `null` when the project never synced one. */
export function pullsCell(
  r: RollupRow | undefined,
): { label: string; detail: string; days: number[] } | null {
  if (r?.pulls_open == null) return null;
  const window = r.activity_days ?? r.pull_days?.length ?? 7;
  return {
    label: `${r.pulls_open} open`,
    detail: `${r.pulls_merged ?? 0} merged · ${plural(window, "day")}`,
    days: r.pull_days ?? [],
  };
}

export function teamText(r: RollupRow | undefined): string {
  return r?.team == null ? "—" : plural(r.team, "person", "people");
}

/** The last update column: when, and what happened. */
export function lastUpdate(
  r: RollupRow | undefined,
  locale = "en-US",
): { when: string; what: string } {
  const t = Date.parse(r?.last_at ?? "");
  if (Number.isNaN(t)) return { when: "Not recorded", what: "No recorded activity" };
  const when = new Date(t).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const what = [r?.last_event, r?.last_subject].filter(Boolean).join(" · ");
  return { when, what: what || "Updated" };
}
