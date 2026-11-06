/* ── The inbox: everything that waits for a person, in one list ─────────────
 *
 * A shell mechanism over pluggable SOURCES. A source reads one kind of fact
 * Studio already holds and says each item that waits for the person as an
 * `InboxEntry`; the inbox merges every source's entries, applies the person's
 * marks (done, snoozed: studio-user `me/inbox-marks`) and orders them. Nothing
 * is stored for an item: it is read from its fact each time, so it leaves by
 * itself when the fact changes.
 *
 * The sources Studio has today (inbox-sources.ts):
 *
 *   - reviews asked of the person (studio-documents review requests);
 *   - pull requests whose next move is theirs (artifact-ingest);
 *   - deploys waiting for an approval (studio-environments deployments);
 *   - their background work that failed, an undelivered notification among
 *     it (studio-tasks runs).
 *
 * A kit adds a source the same way (`registerInboxSource`). The mapping from
 * each fact to an entry is here, pure, so it is tested without a backend.
 */

import type { Deployment, OpenPullRequest, TaskRun } from "./api";
import type { ReviewRequest } from "./review-requests";

export type InboxTone = "danger" | "warn" | "info";

/** What a person can do about an entry from the inbox itself. */
export type InboxAction =
  /** Opens a page outside the portal (a pull request on GitHub). */
  | { kind: "link"; label: string; href: string }
  /** Opens a place in the portal: a project, or a section of the shell. */
  | { kind: "open"; label: string; workspaceId?: string; projectId?: string; view?: string }
  /** Calls Studio; `ask` is the question a reason is asked with, when one is
   *  needed (declining a deploy). */
  | { kind: "call"; label: string; danger?: boolean; ask?: string; run: (reason?: string) => Promise<void> };

export interface InboxEntry {
  /** The source's id: `review`, `pull`, `deploy`, `run`. */
  source: string;
  /** Unique across sources, and what a mark is kept under. A fact that
   *  changes should change its key, so marking it done hides only this state
   *  of it. */
  key: string;
  /** One sentence: what waits. */
  title: string;
  /** Who, where, since when. */
  detail?: string;
  /** The chip: what kind of wait it is. */
  label: string;
  tone: InboxTone;
  /** When it started waiting, RFC 3339. */
  at?: string | null;
  due?: string | null;
  overdue?: boolean;
  projectId?: string | null;
  projectName?: string | null;
  actions: InboxAction[];
}

export interface InboxMark {
  item_key: string;
  state: "done" | "snoozed" | "open";
  until?: string | null;
  updated_at: string;
}

/** One source's answer: its entries, or why it could not be read. */
export interface SourceResult {
  source: string;
  label: string;
  entries: InboxEntry[];
  error?: string | null;
}

/** Whether a mark hides its item at `now`. */
export function hiddenBy(mark: InboxMark | undefined, now: Date): boolean {
  if (!mark) return false;
  if (mark.state === "done") return true;
  return mark.state === "snoozed" && !!mark.until && new Date(mark.until) > now;
}

const TONE_RANK: Record<InboxTone, number> = { danger: 0, warn: 1, info: 2 };

/** Every source's entries, with the marks applied and in the order a person
 *  works through them: overdue first, then by tone, then by due date, then
 *  the longest-waiting first. Errors are kept per source: one that could not
 *  be read costs its own entries, not the inbox. */
export function mergeInbox(
  results: SourceResult[],
  marks: InboxMark[],
  now: Date,
): { open: InboxEntry[]; hidden: InboxEntry[]; errors: { source: string; label: string; error: string }[] } {
  const marked = new Map(marks.map((m) => [m.item_key, m]));
  const seen = new Set<string>();
  const all: InboxEntry[] = [];
  for (const r of results) {
    for (const e of r.entries) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      all.push(e);
    }
  }
  const time = (s: string | null | undefined, missing: number) => {
    const t = s ? Date.parse(s) : NaN;
    return Number.isFinite(t) ? t : missing;
  };
  const order = (e: InboxEntry) => [
    e.overdue ? 0 : 1,
    TONE_RANK[e.tone],
    time(e.due, Number.MAX_SAFE_INTEGER),
    time(e.at, Number.MAX_SAFE_INTEGER),
  ];
  const sorted = all
    .map((entry, n) => ({ entry, n }))
    .sort((a, b) => {
      const x = order(a.entry);
      const y = order(b.entry);
      for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return x[k] - y[k];
      return a.n - b.n;
    })
    .map((x) => x.entry);
  return {
    open: sorted.filter((e) => !hiddenBy(marked.get(e.key), now)),
    hidden: sorted.filter((e) => hiddenBy(marked.get(e.key), now)),
    errors: results.filter((r) => r.error).map((r) => ({ source: r.source, label: r.label, error: r.error! })),
  };
}

/** How many entries each source has open, for the filter chips. */
export function countBySource(entries: InboxEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) out[e.source] = (out[e.source] ?? 0) + 1;
  return out;
}

/* ── The sources' facts as entries ── */

/** A deploy waiting for an organization administrator's decision. */
export function deployEntries(
  deployments: Deployment[],
  decide: (d: Deployment, action: "approve" | "decline", reason?: string) => Promise<void>,
): InboxEntry[] {
  return deployments
    .filter((d) => d.state === "awaiting_approval")
    .map((d) => ({
      source: "deploy",
      key: `deploy:${d.id}`,
      title: `Approve the deploy of ${d.project_name} to ${d.environment_name}`,
      detail: `${d.requested_by_name || "Somebody"} asked${d.build ? ` · build ${d.build.slice(0, 8)}` : ""}${
        d.action === "uninstall" ? " · uninstall" : ""
      }`,
      label: "Awaiting approval",
      tone: "warn" as const,
      at: d.requested_at,
      projectId: d.project_id,
      projectName: d.project_name,
      actions: [
        { kind: "call" as const, label: "Approve", run: () => decide(d, "approve") },
        {
          kind: "call" as const,
          label: "Decline",
          danger: true,
          ask: "Why is it declined? The person who asked reads this.",
          run: (reason?: string) => decide(d, "decline", reason),
        },
        { kind: "open" as const, label: "Environments", view: "environments" },
      ],
    }));
}

/** How long a failed run stays in the inbox. Past it, Background work has it. */
export const RUN_DAYS = 7;

/** Background work this person started that failed: an undelivered
 *  notification among it. Keyed by the run and its last change, so a retry
 *  that fails again is a new item. */
export function runEntries(runs: TaskRun[], me: readonly string[], now: Date): InboxEntry[] {
  const mine = new Set(me.filter(Boolean));
  const since = now.getTime() - RUN_DAYS * 86_400_000;
  return runs
    .filter((r) => r.state === "failed")
    .filter((r) => mine.size === 0 || mine.has(r.requested_by))
    .filter((r) => Date.parse(r.finished_at ?? r.updated_at) >= since)
    .map((r) => {
      const notify = r.task_type === "notify.deliver";
      return {
        source: "run",
        key: `run:${r.id}@${r.updated_at}`,
        title: notify ? "A notification was not delivered" : `${runWords(r.task_type)} failed`,
        detail: (r.last_error ?? "").split(/\r?\n/)[0]?.slice(0, 200) || undefined,
        label: notify ? "Notification" : "Background work",
        tone: "danger" as const,
        at: r.finished_at ?? r.updated_at,
        actions: [{ kind: "open" as const, label: "Background work", view: "tasks" }],
      };
    });
}

/** `connector.graph_sync` → "Connector graph sync". */
export function runWords(taskType: string): string {
  const w = taskType.replace(/[._]/g, " ").trim();
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : "Background work";
}

/** A review somebody asked of the person. Keyed by the request: a new version
 *  is a new request, so a new item. */
export function reviewEntries(reviews: ReviewRequest[], workspaceId: string): InboxEntry[] {
  return reviews.map((r) => ({
    source: "review",
    key: `review:${r.id}`,
    title: `Review ${r.title}`,
    detail: `${r.requested_by_name ?? "A colleague"} asked${r.due_at ? ` · due ${r.due_at.slice(0, 10)}` : ""}`,
    label: r.overdue ? "Review overdue" : "Review",
    tone: r.overdue ? ("warn" as const) : ("info" as const),
    at: r.created_at,
    due: r.due_at ?? null,
    overdue: r.overdue,
    projectId: r.project_id,
    actions: [{ kind: "open" as const, label: "Open project", workspaceId, projectId: r.project_id }],
  }));
}

/** A pull request whose next move is the person's. Keyed with when it last
 *  changed: done hides it until somebody moves it again. */
export function pullEntries(pulls: OpenPullRequest[], workspaceId: string): InboxEntry[] {
  return pulls.map((p) => ({
    source: "pull",
    key: `pr:${p.id}@${p.updated_at ?? ""}`,
    title: p.title,
    detail: [p.repo ? `${p.repo}#${p.number}` : `#${p.number}`, p.author?.login ? `by ${p.author.login}` : null, p.reason]
      .filter(Boolean)
      .join(" · "),
    label: p.waiting === "review" ? "Review requested" : p.waiting === "merge" ? "Ready to merge" : "Your move",
    tone: "info" as const,
    at: p.updated_at ?? p.created_at,
    projectId: p.project_id,
    actions: [
      ...(p.url ? [{ kind: "link" as const, label: "Open pull request ↗", href: p.url }] : []),
      ...(p.project_id ? [{ kind: "open" as const, label: "Open project", workspaceId, projectId: p.project_id }] : []),
    ],
  }));
}
