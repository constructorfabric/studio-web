import { describe, expect, it } from "vitest";

import type { Deployment, OpenPullRequest, TaskRun } from "./api";
import {
  countBySource,
  deployEntries,
  hiddenBy,
  mergeInbox,
  pullEntries,
  reviewEntries,
  runEntries,
  runWords,
  type InboxEntry,
} from "./inbox";
import type { ReviewRequest } from "./review-requests";

const now = new Date("2026-11-06T12:00:00Z");

const entry = (key: string, extra: Partial<InboxEntry> = {}): InboxEntry => ({
  source: key.split(":")[0],
  key,
  title: key,
  label: "x",
  tone: "info",
  actions: [],
  ...extra,
});

describe("merging the sources", () => {
  it("puts the overdue first, then by tone, due date and age", () => {
    const { open } = mergeInbox(
      [
        {
          source: "a",
          label: "A",
          entries: [
            entry("a:old", { at: "2026-11-01T00:00:00Z" }),
            entry("a:new", { at: "2026-11-05T00:00:00Z" }),
            entry("a:danger", { tone: "danger" }),
          ],
        },
        { source: "b", label: "B", entries: [entry("b:overdue", { overdue: true }), entry("b:due", { due: "2026-11-07T00:00:00Z" })] },
      ],
      [],
      now,
    );
    expect(open.map((e) => e.key)).toEqual(["b:overdue", "a:danger", "b:due", "a:old", "a:new"]);
  });

  it("applies the marks: done hides, a snooze hides until it runs out", () => {
    const { open, hidden } = mergeInbox(
      [{ source: "a", label: "A", entries: [entry("a:1"), entry("a:2"), entry("a:3"), entry("a:4")] }],
      [
        { item_key: "a:1", state: "done", updated_at: "" },
        { item_key: "a:2", state: "snoozed", until: "2026-11-07T00:00:00Z", updated_at: "" },
        { item_key: "a:3", state: "snoozed", until: "2026-11-05T00:00:00Z", updated_at: "" },
      ],
      now,
    );
    expect(open.map((e) => e.key)).toEqual(["a:3", "a:4"]);
    expect(hidden.map((e) => e.key)).toEqual(["a:1", "a:2"]);
    expect(hiddenBy({ item_key: "x", state: "open", updated_at: "" }, now)).toBe(false);
  });

  it("keeps a source's failure to itself and an item once", () => {
    const r = mergeInbox(
      [
        { source: "a", label: "A", entries: [entry("a:1")] },
        { source: "b", label: "B", entries: [entry("a:1")], error: "503" },
      ],
      [],
      now,
    );
    expect(r.open).toHaveLength(1);
    expect(r.errors).toEqual([{ source: "b", label: "B", error: "503" }]);
    expect(countBySource(r.open)).toEqual({ a: 1 });
  });
});

describe("the facts as entries", () => {
  it("lists the deploys waiting for a decision, with Approve and Decline", async () => {
    const decided: string[] = [];
    const d = (id: string, state: string) =>
      ({ id, state, project_id: "p", project_name: "Shop", environment_name: "prod", requested_by_name: "Ann", requested_at: "2026-11-06T10:00:00Z", build: "abcdef123456" }) as unknown as Deployment;
    const out = deployEntries([d("1", "awaiting_approval"), d("2", "succeeded")], async (dep, action, reason) => {
      decided.push(`${dep.id}:${action}:${reason ?? ""}`);
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "deploy:1", title: "Approve the deploy of Shop to prod", tone: "warn" });
    expect(out[0].detail).toBe("Ann asked · build abcdef12");
    const [approve, decline] = out[0].actions;
    expect(approve.kind === "call" && decline.kind === "call" && decline.ask).toBeTruthy();
    if (approve.kind === "call") await approve.run();
    if (decline.kind === "call") await decline.run("not now");
    expect(decided).toEqual(["1:approve:", "1:decline:not now"]);
  });

  it("lists the person's recent failed runs, a notification said as one", () => {
    const run = (id: string, extra: Partial<TaskRun>) =>
      ({ id, state: "failed", task_type: "connector.graph_sync", requested_by: "me", updated_at: "2026-11-06T00:00:00Z", last_error: "401\nmore", ...extra }) as TaskRun;
    const out = runEntries(
      [
        run("1", {}),
        run("2", { task_type: "notify.deliver" }),
        run("3", { requested_by: "someone" }),
        run("4", { state: "succeeded" }),
        run("5", { finished_at: "2026-10-01T00:00:00Z" }),
      ],
      ["me"],
      now,
    );
    expect(out.map((e) => [e.key, e.title, e.label])).toEqual([
      ["run:1@2026-11-06T00:00:00Z", "Connector graph sync failed", "Background work"],
      ["run:2@2026-11-06T00:00:00Z", "A notification was not delivered", "Notification"],
    ]);
    expect(out[0].detail).toBe("401");
    expect(runWords("")).toBe("Background work");
  });

  it("says a review and a pull request with where to go", () => {
    const review = { id: "r", title: "PRD", project_id: "p", requested_by_name: "Bo", due_at: "2026-11-08T00:00:00Z", overdue: true, created_at: "2026-11-01T00:00:00Z" } as ReviewRequest;
    const [r] = reviewEntries([review], "w");
    expect(r).toMatchObject({ key: "review:r", title: "Review PRD", label: "Review overdue", tone: "warn", overdue: true });
    expect(r.actions).toEqual([{ kind: "open", label: "Open project", workspaceId: "w", projectId: "p" }]);

    const pull = { id: "x", title: "Fix", repo: "o/r", number: 7, url: "https://g/7", project_id: "p", waiting: "review", reason: "asked", author: { login: "ann" }, updated_at: "2026-11-05T00:00:00Z", created_at: null } as unknown as OpenPullRequest;
    const [p] = pullEntries([pull], "w");
    expect(p).toMatchObject({ key: "pr:x@2026-11-05T00:00:00Z", label: "Review requested", detail: "o/r#7 · by ann · asked" });
    expect(p.actions.map((a) => a.kind)).toEqual(["link", "open"]);
  });
});
