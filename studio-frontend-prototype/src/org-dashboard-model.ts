/* The organization's overview: what its leaders ask of it, in their words.
 *
 * The rules — which connection is refused, what is stuck, whose spend it is,
 * which workspace is worst — are the server's (`studio-backend/src/
 * organizations/overview.rs`, one request). What stays here is every word a
 * reader sees, decided once and tested, not improvised in the markup. */

import type { CostGroup, OrgMoney, OrgNeed, OrgOverview, OrgQueue, OrgReason, OrgWorkspace } from "./api";

export type NeedTarget = "connectors" | "costs" | "projects" | "gears" | "tasks" | "people";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "+23%", "−5%", or "new" when nothing was spent before. */
export function growthText(current: number, previous: number): string {
  if (previous <= 0) return current > 0 ? "new" : "—";
  const pct = Math.round(((current - previous) / previous) * 100);
  return pct > 0 ? `+${pct}%` : pct < 0 ? `−${-pct}%` : "±0%";
}

/** One thing that needs the leader: what is wrong, and where it is fixed. */
export function needText(
  n: OrgNeed,
  stuckDays: number,
  money: (v: number) => string,
): { title: string; detail: string; target: NeedTarget } {
  switch (n.kind) {
    case "connection": {
      const shown = n.projects.slice(0, 3).join(", ") + (n.projects.length > 3 ? "…" : "");
      return {
        title: `A ${n.provider ?? "git"} connection is refused (${n.status ?? "401"})`,
        detail: n.projects.length
          ? `${plural(n.projects.length, "project", "projects")} cannot sync: ${shown}`
          : `${plural(n.repos ?? 0, "repository", "repositories")} cannot sync`,
        target: "connectors",
      };
    }
    case "spend": {
      const current = n.current ?? 0;
      return {
        title: `Spend ${growthText(current, n.previous ?? 0)} against the same days last month`,
        detail:
          `${money(current)} in 30 days; the month ends near ${money(n.forecast ?? 0)}` +
          (n.grower ? `. Grows most: ${n.grower}` : ""),
        target: "costs",
      };
    }
    case "pulls":
      return {
        title: `${plural(n.pulls ?? 0, "pull request waits", "pull requests wait")} over ${stuckDays} days`,
        detail: `on ${plural(n.people ?? 0, "person", "people")}`,
        target: "projects",
      };
    case "components":
      return {
        title: `${plural(n.components ?? 0, "component waits", "components wait")} for a decision`,
        detail: "make it a gear of the organization, or leave it in its project",
        target: "gears",
      };
    case "runs":
      return {
        title: `${plural(n.runs ?? 0, "background run", "background runs")} failed`,
        detail: "not a refused connection; the runs list says what",
        target: "tasks",
      };
  }
}

/** What is wrong with a project, in a few words. */
export function reasonText(r: OrgReason, stuckDays: number): string {
  const v = Math.round(r.value ?? 0);
  switch (r.kind) {
    case "refused":
      return "its repository connection is refused";
    case "specs_failing":
      return `${v} ${v === 1 ? "spec fails" : "specs fail"}`;
    case "stuck":
      return `${plural(v, "pull request waits", "pull requests wait")} over ${stuckDays} days`;
    case "spend_grows":
      return `spend +${Math.round((r.value ?? 0) * 100)}%`;
    case "quiet":
      return `quiet for ${v} days`;
  }
}

export function reasonLine(reasons: readonly OrgReason[], stuckDays: number): string {
  return reasons.map((r) => reasonText(r, stuckDays)).join(" · ");
}

/** A workspace's one line: its worst project and why, and how many more. */
export function workspaceLine(ws: OrgWorkspace, stuckDays: number): string {
  const troubled = ws.projects.filter((p) => p.reasons.length > 0);
  if (troubled.length === 0) return `${plural(ws.projects.length, "project", "projects")}, nothing wrong`;
  const more = troubled.length - 1;
  return (
    `${troubled[0].name}: ${reasonLine(troubled[0].reasons, stuckDays)}` +
    (more > 0 ? ` · ${plural(more, "more project", "more projects")}` : "")
  );
}

/** Days without activity: "today", "3 d", or "—" when unknown. */
export function quietText(days: number | null): string {
  return days === null ? "—" : days === 0 ? "today" : `${days} d`;
}

/** Who a queue is: the member's name, the account, or nobody at all. */
export function queueLabel(q: OrgQueue): string {
  return q.who ?? "Nobody asked to review";
}

/** A row of "where the money goes", named. */
export function moneyLabel(group: CostGroup, row: OrgMoney["rows"][number]): string {
  if (row.label) return row.label;
  switch (group) {
    case "person":
      if (row.key === "unattributed") return "Unattributed (not a member's sign-in)";
      if (!row.key) return "IDE sessions (nobody in particular)";
      return `Person ${row.key.slice(0, 8)}`;
    case "source":
      return row.key === "llm" ? "Model calls" : row.key === "session" ? "IDE sessions" : row.key;
    case "payer":
      return (
        { personal: "People's own keys", workspace: "Workspace connections", organization: "The organization" }[row.key] ??
        (row.key || "Unknown")
      );
    case "model":
      return row.key === "ide-session" ? "IDE sessions" : row.key;
    default:
      return row.key || "—";
  }
}

/** The breakdown the reader picked, from the ones the overview carries. */
export function moneyFor(o: OrgOverview, group: CostGroup, personal: boolean): OrgMoney | null {
  return o.money?.find((m) => m.group_by === group && m.include_personal === personal) ?? null;
}

/** The headline over the needs. */
export function needsHeadline(n: number): string {
  return n === 0 ? "Nothing needs you" : `${n} ${n === 1 ? "thing needs" : "things need"} you`;
}

/* ── Needs attention: one list, grouped ───────────────────────────────────── */

/** A row of "Needs attention" for the others: one sentence, one action. */
export interface AttentionRow {
  key: string;
  sentence: string;
  /** What follows the sentence, quieter: where, or how much. */
  detail?: string;
  tone: "danger" | "warn" | "info";
  action: { label: string; target: NeedTarget };
}

const ACTION: Record<OrgNeed["kind"], string> = {
  connection: "Fix the connection",
  spend: "Open Costs",
  pulls: "Open projects",
  components: "Decide",
  runs: "Open runs",
};

/** What needs the organization rather than the reader, from the overview:
 *  its needs, who the stuck pull requests wait on, the components to decide
 *  and the idle people -- each said once. The stuck-pulls need is the sum of
 *  the queues, so with the queues it is left out; the components need is the
 *  decisions card's count, so the card is not repeated. */
export function othersAttention(o: OrgOverview, money: (v: number) => string): AttentionRow[] {
  const stuckDays = o.stuck_days;
  const queues = o.waiting_on ?? [];
  const rows: AttentionRow[] = [];
  for (const [i, n] of o.needs.entries()) {
    if (n.kind === "pulls" && queues.length > 0) continue;
    const t = needText(n, stuckDays, money);
    rows.push({
      key: `need:${n.kind}:${i}`,
      sentence: t.title,
      detail: t.detail,
      tone: n.tone === "danger" ? "danger" : "warn",
      action: { label: ACTION[n.kind], target: t.target },
    });
  }
  for (const q of queues.slice(0, 6))
    rows.push({
      key: `queue:${q.person_id ?? q.who ?? "nobody"}`,
      sentence: `${plural(q.count, "pull request waits", "pull requests wait")} on ${queueLabel(q) === "Nobody asked to review" ? "nobody (no reviewer asked)" : queueLabel(q)}`,
      detail: `the oldest ${q.oldest_days} days without a move`,
      tone: "warn",
      action: { label: "Open projects", target: "projects" },
    });
  if (o.decisions && o.decisions.undecided > 0 && !o.needs.some((n) => n.kind === "components"))
    rows.push({
      key: "decisions",
      sentence: `${plural(o.decisions.undecided, "component waits", "components wait")} for a decision`,
      detail: `${o.decisions.candidates} could become gears`,
      tone: "info",
      action: { label: "Decide", target: "gears" },
    });
  const idle = o.people.idle ?? [];
  if (idle.length > 0) {
    const names = idle.slice(0, 3).map((p) => p.name ?? `Person ${p.person_id.slice(0, 8)}`);
    rows.push({
      key: "idle",
      sentence: `${plural(idle.length, "person has", "people have")} been idle for 30 days`,
      detail: names.join(", ") + (idle.length > 3 ? ` and ${idle.length - 3} more` : ""),
      tone: "info",
      action: { label: "Open People", target: "people" },
    });
  }
  return rows;
}

/** The overview header's one line: how much needs attention. */
export function attentionStatus(you: number | null, others: number): string {
  const total = (you ?? 0) + others;
  if (total === 0) return you === null ? "Reading what needs attention…" : "Nothing needs attention";
  return `${total} ${total === 1 ? "thing needs" : "things need"} attention`;
}

/** The top rows of a breakdown, for the Spend tile's drill-down. */
export function topMoney(m: OrgMoney | null, n = 5): OrgMoney["rows"] {
  return m ? [...m.rows].sort((a, b) => b.cost - a.cost).slice(0, n) : [];
}

/* ── Workspaces ───────────────────────────────────────────────────────────── */

/** A workspace's line in the list, said by what is in it rather than the
 *  word "workspace" again: its projects by name, and whether it manages
 *  itself. A workspace carries no description of its own. */
export function workspaceDescription(projects: readonly string[] | undefined, selfManaged: boolean): string {
  const lead = selfManaged ? "Self-managed" : "";
  if (projects === undefined) return lead;
  const names =
    projects.length === 0
      ? "no projects yet"
      : projects.slice(0, 3).join(", ") + (projects.length > 3 ? ` and ${projects.length - 3} more` : "");
  if (lead) return `${lead} · ${names}`;
  return projects.length === 0 ? "No projects yet" : names;
}

/** A workspace page's status line: "3 projects · 213 findings". Unknown counts
 *  say nothing rather than 0. */
export function workspaceStatus(projects: number | null, findings: number | null): string {
  const parts: string[] = [];
  if (projects !== null) parts.push(plural(projects, "project", "projects"));
  if (findings !== null) parts.push(plural(findings, "finding", "findings"));
  return parts.join(" · ");
}
