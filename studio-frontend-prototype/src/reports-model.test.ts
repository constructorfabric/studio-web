import { describe, expect, it } from "vitest";
import {
  canRefresh,
  draftOf,
  inputOf,
  needsAttention,
  parseConsumers,
  stateOf,
  stateText,
  type ReportSource,
} from "./reports-model";

const empty: ReportSource = {
  report: "roadmap",
  connection_id: null,
  plan_file: null,
  plan_uploaded: false,
  board: null,
  roots: [],
  consumers: {},
  snapshot: null,
  plan: null,
  last_refresh: null,
};

describe("the source form", () => {
  it("round-trips what is saved", () => {
    const saved: ReportSource = {
      ...empty,
      connection_id: "c1",
      plan_file: "o/r:gears.yaml@main",
      board: "o/48",
      roots: ["3342", "o/r#4507"],
      consumers: { A: "Acronis", V: "Virtuozzo" },
    };
    const d = draftOf(saved);
    expect(d).toEqual({
      connectionId: "c1",
      planFile: "o/r:gears.yaml@main",
      planYaml: null,
      board: "o/48",
      roots: "3342 o/r#4507",
      consumers: "A=Acronis, V=Virtuozzo",
    });
    expect(inputOf(d)).toEqual({
      connection_id: "c1",
      plan_file: "o/r:gears.yaml@main",
      board: "o/48",
      roots: ["3342", "o/r#4507"],
      consumers: { A: "Acronis", V: "Virtuozzo" },
    });
  });

  it("sends an upload only when one was picked or cleared", () => {
    const d = draftOf(empty);
    expect("plan_yaml" in inputOf(d)).toBe(false);
    expect(inputOf({ ...d, planYaml: "board: o/48\n" }).plan_yaml).toBe("board: o/48\n");
    expect(inputOf({ ...d, planYaml: "" }).plan_yaml).toBe("");
    // An empty connection is the organization's first one.
    expect(inputOf(d).connection_id).toBeNull();
  });

  it("reads consumers however they are separated", () => {
    expect(parseConsumers("A=Acronis, C=Constructor;V=Virtuozzo\nX=a=b")).toEqual({
      A: "Acronis",
      C: "Constructor",
      V: "Virtuozzo",
      X: "a=b",
    });
    expect(parseConsumers(" , =x, y= ")).toEqual({});
  });
});

describe("refresh", () => {
  it("is possible once something can name the board", () => {
    const d = draftOf(empty);
    expect(canRefresh(d, empty)).toBe(false);
    expect(canRefresh({ ...d, board: "o/48" }, empty)).toBe(true);
    expect(canRefresh({ ...d, planFile: "o/r:gears.yaml" }, empty)).toBe(true);
    expect(canRefresh({ ...d, planYaml: "board: o/48\n" }, empty)).toBe(true);
    expect(canRefresh({ ...d, planYaml: "" }, empty)).toBe(false);
    const planned = { ...empty, plan: { board: "o/48", people: 3, teams: 1, projects: 0 } };
    expect(canRefresh(d, planned)).toBe(true);
  });
});

describe("a source's state", () => {
  const snapshot = { from: "o/r:p.yaml@main", sha: "abc", read_at: "2026-10-01T09:30:00Z", size: 10 };
  const plan = { board: null, people: 27, teams: 6, projects: 9 };

  it("says what is missing, what failed, or where the plan came from", () => {
    expect(stateOf(empty).kind).toBe("empty");
    expect(stateOf({ ...empty, plan_file: "o/r:p.yaml" })).toEqual({ kind: "unread", what: "o/r:p.yaml" });
    const read = { ...empty, snapshot, plan };
    expect(stateOf(read)).toEqual({ kind: "ready", from: "o/r:p.yaml@main", at: "2026-10-01T09:30:00Z", plan });
    expect(stateText(stateOf(read))).toBe(
      "Plan from o/r:p.yaml@main, read 2026-10-01 09:30 — 27 people, 6 teams, 9 projects.",
    );
    const up = { ...read, snapshot: { ...snapshot, from: "upload" } };
    expect(stateText(stateOf(up))).toContain("an uploaded file");
    // A failure is said first: the plan read before it is still what is drawn.
    const failed = { ...read, last_refresh: { at: "t", sync_run: null, error: "not visible" } };
    expect(stateOf(failed)).toEqual({ kind: "failed", error: "not visible" });
    expect(stateText(stateOf(failed))).toContain("not visible");
    expect(stateText(stateOf(empty))).toContain("Not configured");
  });

  it("warns when the board is set but there is no plan to draw people from", () => {
    // What dev showed: board, roots and consumers saved, refresh succeeded,
    // and People and the Gantt empty because no plan was ever loaded.
    const boardOnly = {
      ...empty,
      board: "constructorfabric/48",
      last_refresh: { at: "t", sync_run: "r", error: null },
    };
    expect(stateOf(boardOnly)).toEqual({ kind: "no-plan" });
    const text = stateText(stateOf(boardOnly));
    expect(text).toContain("load gears.yaml");
    expect(text).toContain("People");
    expect(text).toContain("Gantt");
    expect(needsAttention(stateOf(boardOnly))).toBe(true);
  });

  it("warns when the plan names nobody", () => {
    const nobody = { ...empty, snapshot, plan: { board: "o/48", people: 0, teams: 0, projects: 2 } };
    expect(stateOf(nobody)).toEqual({ kind: "no-people", from: "o/r:p.yaml@main" });
    expect(stateText(stateOf(nobody))).toContain("names no people");
    expect(needsAttention(stateOf({ ...empty, snapshot, plan }))).toBe(false);
  });

  // What dev showed: a plan read, a refresh that went through, and no gears,
  // because the board sync could not reach the connection.
  it("says the board was not read, even with a plan in hand", () => {
    const unread = {
      ...empty,
      snapshot,
      plan,
      board_error: "board constructorfabric/48 was not read: connection ddff5557 not found",
    };
    expect(stateOf(unread).kind).toBe("board-unread");
    expect(stateText(stateOf(unread))).toContain("connection ddff5557 not found");
    expect(needsAttention(stateOf(unread))).toBe(true);
  });
});
