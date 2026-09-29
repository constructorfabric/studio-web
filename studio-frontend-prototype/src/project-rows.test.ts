import { describe, expect, it } from "vitest";
import type { RollupRow } from "./api";
import {
  inReviewFilter,
  kindLine,
  lastUpdate,
  pullsCell,
  reviewOf,
  sortProjects,
  specsCell,
  teamText,
} from "./project-rows";

const row = (over: Partial<RollupRow> = {}): RollupRow => ({
  id: "p",
  name: "P",
  kind: "project",
  ...over,
});

describe("reviewOf", () => {
  it("puts open findings first, with the counts behind them", () => {
    const r = reviewOf(row({ open_findings: 3, specs: 5, specs_checked: 4, specs_failing: 1, open_comments: 2 }));
    expect(r.tone).toBe("findings");
    expect(r.label).toBe("3 open findings");
    expect(r.detail).toBe("1 spec needs check · 1 not checked · 2 open comments");
  });

  it("says specs need a check when nothing is open but a check failed", () => {
    const r = reviewOf(row({ open_findings: 0, specs: 13, specs_checked: 5, specs_failing: 5, open_comments: 1 }));
    expect(r.tone).toBe("check");
    expect(r.label).toBe("5 specs need check");
    expect(r.detail).toBe("0 open findings · 8 not checked · 1 open comment");
  });

  it("counts unchecked specs as work when nothing failed", () => {
    const r = reviewOf(row({ open_findings: 0, specs: 3, specs_checked: 1, specs_failing: 0 }));
    expect(r.tone).toBe("check");
    expect(r.label).toBe("2 specs not checked");
  });

  it("reads clear only when every spec was checked and passed", () => {
    const r = reviewOf(row({ open_findings: 0, specs: 3, specs_checked: 3, specs_failing: 0, open_comments: 2 }));
    expect(r).toEqual({ tone: "clear", label: "No open findings", detail: "3 specs checked · 2 open comments" });
  });

  it("does not call a project with no specs clear", () => {
    expect(reviewOf(row({ open_findings: 0, specs: 0 })).tone).toBe("empty");
  });

  it("says unavailable, not clear, when nothing could be counted", () => {
    expect(reviewOf(row()).tone).toBe("unknown");
  });

  it("filters by tone", () => {
    const r = reviewOf(row({ open_findings: 1, specs: 1 }));
    expect(inReviewFilter(r, "all")).toBe(true);
    expect(inReviewFilter(r, "findings")).toBe(true);
    expect(inReviewFilter(r, "clear")).toBe(false);
  });
});

describe("sortProjects", () => {
  const items = [
    { name: "Clear", row: row({ open_findings: 0, specs: 1, specs_checked: 1, last_at: "2026-09-27T10:00:00Z" }) },
    { name: "Few", row: row({ open_findings: 1, specs: 1, last_at: "2026-09-20T10:00:00Z" }) },
    { name: "Many", row: row({ open_findings: 4, specs: 1 }) },
    { name: "Check", row: row({ open_findings: 0, specs: 2, specs_checked: 2, specs_failing: 1 }) },
  ];

  it("orders by review priority, the most urgent first", () => {
    expect(sortProjects(items, "priority").map((p) => p.name)).toEqual(["Many", "Few", "Check", "Clear"]);
  });

  it("orders by last update, undated last", () => {
    expect(sortProjects(items, "updated").map((p) => p.name)).toEqual(["Clear", "Few", "Check", "Many"]);
  });

  it("orders by name", () => {
    expect(sortProjects(items, "name").map((p) => p.name)).toEqual(["Check", "Clear", "Few", "Many"]);
  });
});

describe("cells", () => {
  it("names the kind and the first line of the brief", () => {
    expect(kindLine(row({ project_kind: "new_gears", brief: "Billing gears\nmore" }))).toBe("Gears · Billing gears");
    expect(kindLine(row())).toBe("Project");
  });

  it("says where specs were written", () => {
    expect(specsCell(row({ specs: 3, specs_authored: 3 }))).toEqual({ label: "3 specs", detail: "Created in Studio" });
    expect(specsCell(row({ specs: 3, specs_authored: 1 })).detail).toBe("1 created in Studio");
    expect(specsCell(row({ specs: 1, specs_authored: 0 }))).toEqual({ label: "1 spec", detail: null });
    expect(specsCell(row()).label).toBe("—");
  });

  it("has no pull request cell for a project that never synced one", () => {
    expect(pullsCell(row())).toBeNull();
    expect(pullsCell(row({ pulls_open: 6, pulls_merged: 9, pull_days: [0, 1, 2, 0, 0, 3, 3], activity_days: 7 }))).toEqual({
      label: "6 open",
      detail: "9 merged · 7 days",
      days: [0, 1, 2, 0, 0, 3, 3],
    });
  });

  it("counts people", () => {
    expect(teamText(row({ team: 7 }))).toBe("7 people");
    expect(teamText(row({ team: 1 }))).toBe("1 person");
    expect(teamText(row())).toBe("—");
  });

  it("says not recorded rather than inventing a time", () => {
    expect(lastUpdate(row())).toEqual({ when: "Not recorded", what: "No recorded activity" });
    const u = lastUpdate(row({ last_at: "2026-09-27T10:00:00Z", last_event: "Document checked", last_subject: "spec.md" }), "en-US");
    expect(u.what).toBe("Document checked · spec.md");
    expect(u.when).toMatch(/Sep 2[67]/);
  });
});
