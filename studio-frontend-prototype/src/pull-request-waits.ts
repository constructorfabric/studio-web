/* ── Pull requests, by who they are waiting on ────────────────────────────────
 *
 * The backend decides which ONE bucket an open pull request is in and who is
 * at the front of it (`artifact_ingest/pull_request_waits.rs`). This turns
 * that list into what the project page shows: one queue per person, with how
 * many pull requests wait on them in each bucket.
 *
 * Written for somebody who has never opened a pull request, so every word a
 * reader sees is decided here and tested, not improvised in the markup.
 *
 * A pull request waiting on two reviewers is in BOTH of their queues: each of
 * them is somebody it is waiting on. The headline counts pull requests, not
 * queue entries, so it never adds up to more than there are. */

import type { OpenPullRequest, PullPerson, PullWaiting } from "./api";

/** Buckets in the order a reader should meet them: the stuck ones first. */
export const WAITING_ORDER: PullWaiting[] = ["nobody", "review", "author", "merge", "draft"];

/** What each bucket means, said about the person whose queue it is. */
export const WAITING_LABEL: Record<PullWaiting, string> = {
  review: "to review",
  author: "to rework",
  merge: "ready to merge",
  draft: "draft",
  nobody: "no reviewer",
};

/** The same, as a sentence about one pull request. */
export const WAITING_SENTENCE: Record<PullWaiting, string> = {
  review: "Waiting for a review",
  author: "Waiting for the author",
  merge: "Ready to merge",
  draft: "Draft, still being written",
  nobody: "Nobody has been asked to review it",
};

/** How the badge for a bucket is coloured — the prototype's own tones. */
export const WAITING_TONE: Record<PullWaiting, string> = {
  nobody: "danger",
  review: "warn",
  author: "info",
  merge: "ok",
  draft: "neutral",
};

export type QueueKind = "member" | "outsider" | "account" | "team" | "nobody" | "unnamed";

/** One person's (or team's) queue. */
export interface Queue {
  /** Stable key: a member id, a lowercased login, a team, or a fixed word. */
  key: string;
  kind: QueueKind;
  /** The name to show: the member's name, else the login. */
  name: string;
  /** One line under the name: the login, and whether they are one of ours. */
  sub: string;
  counts: Record<PullWaiting, number>;
  total: number;
  pulls: OpenPullRequest[];
}

function zero(): Record<PullWaiting, number> {
  return { review: 0, author: 0, merge: 0, draft: 0, nobody: 0 };
}

/** The key two accounts of the same member share; else the login. */
function personKey(p: PullPerson): string {
  return p.user_id ? `member:${p.user_id}` : `login:${p.login.toLowerCase()}`;
}

function personKind(p: PullPerson): QueueKind {
  if (p.user_id) return "member";
  return p.in_organization === false ? "outsider" : "account";
}

/** What to call a person: their name where the organization knows it. */
export function personName(p: PullPerson): string {
  return p.display_name?.trim() || p.login;
}

function personSub(p: PullPerson): string {
  switch (personKind(p)) {
    case "member":
      return `@${p.login}`;
    case "outsider":
      return `@${p.login} · not in this organization`;
    default:
      return `@${p.login}`;
  }
}

/** One queue per person (and per team), plus one for the pull requests
 *  nobody was asked to review. That one comes first when it has anything in
 *  it — it is the thing nobody else will notice — then the longest queues. */
export function queuesByPerson(items: OpenPullRequest[]): Queue[] {
  const queues = new Map<string, Queue>();
  const queue = (key: string, kind: QueueKind, name: string, sub: string): Queue => {
    let q = queues.get(key);
    if (!q) {
      q = { key, kind, name, sub, counts: zero(), total: 0, pulls: [] };
      queues.set(key, q);
    }
    return q;
  };
  const add = (q: Queue, pr: OpenPullRequest) => {
    if (q.pulls.includes(pr)) return;
    q.pulls.push(pr);
    q.counts[pr.waiting] += 1;
    q.total += 1;
  };

  for (const pr of items) {
    if (pr.waiting === "nobody") {
      add(queue("nobody", "nobody", "Nobody asked", "open, not a draft, no reviewer"), pr);
      continue;
    }
    const people = pr.waiting_on;
    for (const p of people) {
      add(queue(personKey(p), personKind(p), personName(p), personSub(p)), pr);
    }
    for (const team of pr.waiting_on_teams) {
      add(queue(`team:${team.toLowerCase()}`, "team", team, "team"), pr);
    }
    if (people.length === 0 && pr.waiting_on_teams.length === 0) {
      add(queue("unnamed", "unnamed", "Author not known", "the provider did not name one"), pr);
    }
  }

  return [...queues.values()].sort((a, b) => {
    if (a.kind === "nobody" || b.kind === "nobody") return a.kind === "nobody" ? -1 : 1;
    return b.total - a.total || a.name.localeCompare(b.name);
  });
}

/** How many pull requests are in each bucket — each counted once. */
export function bucketTotals(items: OpenPullRequest[]): Record<PullWaiting, number> {
  const out = zero();
  for (const pr of items) out[pr.waiting] += 1;
  return out;
}

/** "today" / "1 day" / "12 days". */
export function days(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n <= 0) return "today";
  return n === 1 ? "1 day" : `${n} days`;
}

/** The age line under a pull request: how long it has been open, and how
 *  long since anything happened — the second is the one that says "stuck". */
export function ageLine(pr: OpenPullRequest): string {
  const parts: string[] = [];
  if (pr.days_open !== null) {
    parts.push(pr.days_open <= 0 ? "opened today" : `open ${days(pr.days_open)}`);
  }
  if (pr.days_since_update !== null) {
    parts.push(
      pr.days_since_update <= 0 ? "active today" : `quiet for ${days(pr.days_since_update)}`,
    );
  }
  return parts.join(" · ");
}

/** "acme/web#42", or just "#42" when the repository is not known. */
export function prRef(pr: OpenPullRequest): string {
  return `${pr.repo ?? ""}#${pr.number}`;
}

/** Whether a pull request has been quiet long enough to call out. A week is
 *  the line: past it, somebody has usually forgotten. */
export const QUIET_DAYS = 7;
export function isQuiet(pr: OpenPullRequest): boolean {
  return (pr.days_since_update ?? 0) >= QUIET_DAYS;
}

/** What the block says when there is nothing to show — in plain words, and
 *  different for "no repositories", "nothing open" and "nothing synced". */
export function emptyMessage(state: {
  repositories: number;
  synced: boolean;
  open: number;
}): string | null {
  if (state.open > 0) return null;
  if (state.repositories === 0) {
    return "This project has no repositories attached, so there are no pull requests to follow.";
  }
  if (!state.synced) {
    return "The project's repositories have not been read yet. Sync them on the Sources tab to see their pull requests here.";
  }
  return "No pull requests are open — nothing is waiting on anybody.";
}
