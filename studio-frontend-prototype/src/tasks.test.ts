import { describe, expect, it } from "vitest";

import type { TaskRun } from "./api";
import { foldRecurring, mergePages, stateTone } from "./tasks";

function run(id: string, task_type: string, state: string, created_at: string): TaskRun {
  return { id, task_type, state, created_at, attempts: 1, payload: {} } as unknown as TaskRun;
}

describe("background work list", () => {
  it("folds a scheduled task's succeeded runs into one row", () => {
    const rows = foldRecurring(
      [
        run("1", "session.reap", "succeeded", "2026-11-04T10:05:00Z"),
        run("2", "catalog.sync", "failed", "2026-11-04T10:04:00Z"),
        run("3", "session.reap", "succeeded", "2026-11-04T10:00:00Z"),
        run("4", "session.reap", "failed", "2026-11-04T09:55:00Z"),
        run("5", "session.reap", "succeeded", "2026-11-04T09:50:00Z"),
      ],
      new Set(["session.reap"]),
    );
    expect(rows.map((r) => [r.id, r.folded])).toEqual([
      ["1", 2],
      ["2", undefined],
      ["4", undefined],
    ]);
  });

  it("leaves a task no schedule fires as it is", () => {
    const rows = foldRecurring([run("1", "import", "succeeded", "2026-11-04T10:00:00Z"), run("2", "import", "succeeded", "2026-11-04T09:00:00Z")], new Set());
    expect(rows).toHaveLength(2);
  });

  it("merges failed and running into one page, newest first", () => {
    const failed = [run("f1", "a", "failed", "2026-11-04T10:00:00Z"), run("f2", "a", "failed", "2026-11-04T08:00:00Z")];
    const running = [run("r1", "b", "running", "2026-11-04T09:00:00Z")];
    expect(mergePages([failed, running], 0, 2).map((r) => r.id)).toEqual(["f1", "r1"]);
    expect(mergePages([failed, running], 2, 2).map((r) => r.id)).toEqual(["f2"]);
  });

  it("gives every state a tone, so no chip is left without one", () => {
    expect(["queued", "running", "succeeded", "failed", "cancelled"].map(stateTone)).toEqual(["neutral", "running", "ok", "danger", "warn"]);
  });
});
