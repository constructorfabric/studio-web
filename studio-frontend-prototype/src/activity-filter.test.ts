import { describe, expect, it } from "vitest";

import { collapseRuns, matchesQuery } from "./activity-filter";
import type { ActivityEvent } from "./api";

/* The fold that produces these rows moved to `artifact_ingest/activity.rs`.
 * This did not, and should not: it narrows what is already on screen as
 * somebody types, and a request per keystroke would be a worse answer to the
 * same question. */

const event = (over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: "e1",
  kind: "check",
  event: "Document checked",
  subject: "prd.md",
  by: "bloat",
  recorded: "2026-09-23T12:00:00Z",
  severity: "high",
  ...over,
});

describe("searching the feed", () => {
  it("searches every column, not the one the reader guessed", () => {
    // The box sits over the table; typing a detector name into it means
    // "find that", not "find that in the column I have not named".
    for (const q of ["checked", "prd", "bloat", "high", "2026-09"]) {
      expect(matchesQuery(event(), q), q).toBe(true);
    }
    expect(matchesQuery(event(), "telepathy")).toBe(false);
  });

  it("ignores case and surrounding space, and an empty query matches all", () => {
    expect(matchesQuery(event(), "  BLOAT ")).toBe(true);
    expect(matchesQuery(event(), "")).toBe(true);
    expect(matchesQuery(event(), "   ")).toBe(true);
  });

  it("does not trip over a row with no severity or no time", () => {
    const bare = event({ severity: null, recorded: null });
    expect(matchesQuery(bare, "prd")).toBe(true);
    expect(matchesQuery(bare, "high")).toBe(false);
  });
});

describe("collapseRuns", () => {
  const checks = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) =>
      event({ id: `c${from + i}`, by: i % 2 ? "leak" : "purpose", recorded: `2026-09-23T12:${String(59 - i).padStart(2, "0")}:00Z`, severity: null }),
    );

  it("folds a run of the same event into one row that keeps its events", () => {
    const rows = collapseRuns([event({ id: "x", kind: "comment", event: "Commented", by: "ann" }), ...checks(220)]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      id: "run:c0",
      event: "Document checked",
      subject: "220 documents",
      by: "purpose, leak",
      recorded: "2026-09-23T12:59:00Z",
    });
    expect(rows[1].items).toHaveLength(220);
  });

  it("leaves comments one per row: each is something a person said", () => {
    const said = Array.from({ length: 5 }, (_, i) => event({ id: `m${i}`, kind: "comment", event: "Comment" }));
    expect(collapseRuns(said)).toHaveLength(5);
  });

  it("leaves a short run, and events that differ, as they are", () => {
    const rows = collapseRuns([...checks(2), event({ id: "y", event: "Commented", kind: "comment" }), ...checks(2, 10)]);
    expect(rows.map((r) => r.id)).toEqual(["c0", "c1", "y", "c10", "c11"]);
  });
});
