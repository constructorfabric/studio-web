import { describe, expect, it } from "vitest";

import type { OpenPullRequest, PullPerson } from "./api";
import {
  ageLine,
  bucketTotals,
  days,
  emptyMessage,
  isQuiet,
  personName,
  prRef,
  queuesByPerson,
} from "./pull-request-waits";

/* Which bucket a pull request is in is the backend's decision
 * (`artifact_ingest/pull_request_waits.rs`, tested there). What is tested here
 * is the page's half: who gets a queue, what each queue is called, and the
 * words a reader who does not know git actually sees. */

const member = (login: string, id: string, name: string | null = null): PullPerson => ({
  login,
  user_id: id,
  display_name: name,
  in_organization: true,
});
const outsider = (login: string): PullPerson => ({
  login,
  user_id: null,
  display_name: null,
  in_organization: false,
});
const unknown = (login: string): PullPerson => ({
  login,
  user_id: null,
  display_name: null,
  in_organization: null,
});

const pr = (over: Partial<OpenPullRequest> = {}): OpenPullRequest => ({
  id: `pr-${over.number ?? 1}`,
  repo: "acme/web",
  provider: "github",
  number: 1,
  title: "Add the thing",
  url: "https://github.com/acme/web/pull/1",
  author: member("alice", "u-alice", "Alice"),
  waiting: "review",
  waiting_on: [],
  waiting_on_teams: [],
  reason: "",
  review_decision: null,
  reviewers: [],
  assignees: [],
  draft: false,
  open_threads: 0,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  days_open: 36,
  days_since_update: 6,
  ...over,
});

describe("queues by person", () => {
  it("puts a pull request waiting on two reviewers in both of their queues", () => {
    const items = [
      pr({ number: 1, waiting_on: [member("bob", "u-bob", "Bob"), member("carol", "u-carol", "Carol")] }),
    ];
    const queues = queuesByPerson(items);
    expect(queues.map((q) => q.name).sort()).toEqual(["Bob", "Carol"]);
    for (const q of queues) {
      expect(q.counts.review).toBe(1);
      expect(q.total).toBe(1);
    }
    // ...but it is still ONE pull request in the totals.
    expect(bucketTotals(items).review).toBe(1);
  });

  it("joins two logins of the same member into one queue", () => {
    const queues = queuesByPerson([
      pr({ number: 1, waiting_on: [member("bob", "u-bob", "Bob")] }),
      pr({ number: 2, waiting: "author", waiting_on: [member("bob-work", "u-bob", "Bob")] }),
    ]);
    expect(queues).toHaveLength(1);
    expect(queues[0].counts).toMatchObject({ review: 1, author: 1 });
    expect(queues[0].total).toBe(2);
  });

  it("puts the pull requests nobody was asked about first, under one queue", () => {
    const queues = queuesByPerson([
      pr({ number: 1, waiting_on: [member("bob", "u-bob", "Bob")] }),
      pr({ number: 2, waiting_on: [member("bob", "u-bob", "Bob")] }),
      pr({ number: 3, waiting: "nobody" }),
    ]);
    expect(queues[0].kind).toBe("nobody");
    expect(queues[0].name).toBe("Nobody asked");
    expect(queues[0].counts.nobody).toBe(1);
    expect(queues[1].name).toBe("Bob");
  });

  it("orders people by how much waits on them, then by name", () => {
    const queues = queuesByPerson([
      pr({ number: 1, waiting_on: [member("zed", "u-z", "Zed")] }),
      pr({ number: 2, waiting_on: [member("zed", "u-z", "Zed")] }),
      pr({ number: 3, waiting_on: [member("bea", "u-b", "Bea")] }),
      pr({ number: 4, waiting_on: [member("amy", "u-a", "Amy")] }),
    ]);
    expect(queues.map((q) => q.name)).toEqual(["Zed", "Amy", "Bea"]);
  });

  it("puts somebody owed two reviews before somebody with six drafts", () => {
    const drafts = [1, 2, 3, 4, 5, 6].map((n) =>
      pr({ number: n, waiting: "draft", waiting_on: [member("dan", "u-d", "Dan")] }),
    );
    const queues = queuesByPerson([
      ...drafts,
      pr({ number: 7, waiting_on: [member("eve", "u-e", "Eve")] }),
      pr({ number: 8, waiting_on: [member("eve", "u-e", "Eve")] }),
    ]);
    expect(queues.map((q) => q.name)).toEqual(["Eve", "Dan"]);
  });

  it("says when an account is not one of the organization's people", () => {
    const [q] = queuesByPerson([pr({ waiting_on: [outsider("dependabot")] })]);
    expect(q.kind).toBe("outsider");
    expect(q.name).toBe("dependabot");
    expect(q.sub).toBe("@dependabot · not in this organization");
  });

  it("does not call anybody an outsider when the directory could not be asked", () => {
    const [q] = queuesByPerson([pr({ waiting_on: [unknown("bob")] })]);
    expect(q.kind).toBe("account");
    expect(q.sub).toBe("@bob");
  });

  it("gives a team its own queue", () => {
    const [q] = queuesByPerson([pr({ waiting_on_teams: ["Backend"] })]);
    expect(q.kind).toBe("team");
    expect(q.name).toBe("Backend");
  });

  it("keeps a pull request with nobody named visible rather than dropping it", () => {
    const [q] = queuesByPerson([pr({ waiting: "merge", waiting_on: [] })]);
    expect(q.kind).toBe("unnamed");
    expect(q.total).toBe(1);
  });

  it("uses the member's name, and the login when there is none", () => {
    expect(personName(member("bob", "u-bob", "Bob Smith"))).toBe("Bob Smith");
    expect(personName(member("bob", "u-bob", "  "))).toBe("bob");
    expect(personName(outsider("carol"))).toBe("carol");
  });
});

describe("the words under a pull request", () => {
  it("says how long it has been open and how long it has been quiet", () => {
    expect(ageLine(pr())).toBe("open 36 days · quiet for 6 days");
    expect(ageLine(pr({ days_open: 0, days_since_update: 0 }))).toBe("opened today · active today");
    expect(ageLine(pr({ days_open: 1, days_since_update: null }))).toBe("open 1 day");
  });

  it("calls out a pull request quiet for a week or more", () => {
    expect(isQuiet(pr({ days_since_update: 6 }))).toBe(false);
    expect(isQuiet(pr({ days_since_update: 7 }))).toBe(true);
    expect(isQuiet(pr({ days_since_update: null }))).toBe(false);
  });

  it("names a pull request by repository and number", () => {
    expect(prRef(pr({ number: 42 }))).toBe("acme/web#42");
    expect(prRef(pr({ repo: null, number: 42 }))).toBe("#42");
  });

  it("reads a day count the way a person says it", () => {
    expect(days(null)).toBe("—");
    expect(days(0)).toBe("today");
    expect(days(1)).toBe("1 day");
    expect(days(5)).toBe("5 days");
  });
});

describe("empty states", () => {
  it("tells apart no repositories, nothing synced and nothing open", () => {
    expect(emptyMessage({ repositories: 0, synced: false, open: 0 })).toMatch(/no repositories/);
    expect(emptyMessage({ repositories: 2, synced: false, open: 0 })).toMatch(/Sources tab/);
    expect(emptyMessage({ repositories: 2, synced: true, open: 0 })).toMatch(/nothing is waiting/);
    expect(emptyMessage({ repositories: 2, synced: true, open: 3 })).toBeNull();
  });
});
