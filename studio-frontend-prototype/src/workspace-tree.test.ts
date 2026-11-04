import { describe, expect, it } from "vitest";
import type { OrgProjectHealth, OrgWorkspace } from "./api";
import { firstOf, healthSplit, healthText, projectChip, projectHealth, reasonColumn, topSpender, worstReason } from "./workspace-tree";

const project = (id: string, over: Partial<OrgProjectHealth> = {}): OrgProjectHealth => ({
  id,
  name: id.toUpperCase(),
  spend: null,
  previous: null,
  specs_failing: null,
  open_findings: null,
  stuck: 0,
  quiet_days: null,
  broken: false,
  score: 0,
  reasons: [],
  ...over,
});
const workspace = (projects: OrgProjectHealth[]): OrgWorkspace => ({
  id: "ws",
  name: "WS",
  spend: null,
  previous: null,
  specs_failing: 0,
  stuck: 0,
  quiet_days: null,
  score: 0,
  projects,
});

describe("worstReason", () => {
  it("leads with the most severe reason, whatever the order", () => {
    expect(
      worstReason([
        { kind: "quiet", value: 9 },
        { kind: "specs_failing", value: 2 },
        { kind: "stuck", value: 1 },
      ])?.kind,
    ).toBe("specs_failing");
    expect(worstReason([{ kind: "quiet", value: 9 }, { kind: "refused", value: null }])?.kind).toBe("refused");
    expect(worstReason([])).toBeNull();
  });
});

describe("projectHealth and projectChip", () => {
  it("is unknown without the overview, and carries no chip", () => {
    expect(projectHealth(undefined)).toBe("unknown");
    expect(projectChip(undefined)).toBeNull();
  });
  it("is fine with no reasons", () => {
    expect(projectHealth(project("a"))).toBe("ok");
    expect(projectChip(project("a"))).toEqual({ tone: "ok", label: "Healthy", more: 0 });
  });
  it("warns on a quiet or waiting project and fails on failing specs", () => {
    expect(projectHealth(project("a", { reasons: [{ kind: "quiet", value: 12 }] }))).toBe("warn");
    const failing = project("a", { reasons: [{ kind: "stuck", value: 2 }, { kind: "specs_failing", value: 3 }] });
    expect(projectHealth(failing)).toBe("danger");
    // The chip names the state, not the count the Failing column shows.
    expect(projectChip(failing)).toEqual({ tone: "danger", label: "Specs failing", more: 1 });
  });
  it("fails a broken project even without reasons", () => {
    expect(projectHealth(project("a", { broken: true }))).toBe("danger");
    expect(projectChip(project("a", { broken: true }))?.label).toBe("Broken");
  });
});

describe("reasonColumn", () => {
  it("maps each reason to the column that shows its number", () => {
    expect(reasonColumn("specs_failing")).toBe("failing");
    expect(reasonColumn("spend_grows")).toBe("delta");
    expect(reasonColumn("refused")).toBeNull();
  });
});

describe("healthSplit and healthText", () => {
  const ws = workspace([
    project("a"),
    project("b", { reasons: [{ kind: "quiet", value: 9 }] }),
    project("c", { reasons: [{ kind: "specs_failing", value: 1 }] }),
  ]);
  it("splits the listed projects, and counts one the overview lacks as unknown", () => {
    expect(healthSplit(["a", "b", "c", "d"], ws)).toEqual({ ok: 1, warn: 1, danger: 1, unknown: 1 });
    expect(healthSplit(["a"], undefined)).toEqual({ ok: 0, warn: 0, danger: 0, unknown: 1 });
  });
  it("says the problems first and 'all fine' only when they all are", () => {
    expect(healthText({ ok: 1, warn: 1, danger: 1, unknown: 0 })).toBe("1 failing · 1 warning · 1 fine");
    expect(healthText({ ok: 3, warn: 0, danger: 0, unknown: 0 })).toBe("all 3 fine");
    expect(healthText({ ok: 1, warn: 0, danger: 0, unknown: 0 })).toBe("fine");
    expect(healthText({ ok: 0, warn: 2, danger: 0, unknown: 1 })).toBe("2 warnings · 1 not read");
    expect(healthText({ ok: 0, warn: 0, danger: 0, unknown: 0 })).toBe("");
  });
});

describe("topSpender", () => {
  it("names the biggest spender and its share", () => {
    const ws = workspace([project("a", { spend: 30 }), project("b", { spend: 90 }), project("c", { spend: 0 })]);
    expect(topSpender(ws)).toEqual({ id: "b", name: "B", share: 75 });
  });
  it("says nothing with fewer than two projects spending", () => {
    expect(topSpender(workspace([project("a", { spend: 30 }), project("b")]))).toBeNull();
    expect(topSpender(undefined)).toBeNull();
  });
});

describe("firstOf", () => {
  it("shows up to the limit and counts the rest", () => {
    expect(firstOf([1, 2, 3, 4, 5, 6], 4)).toEqual({ shown: [1, 2, 3, 4], more: 2 });
    expect(firstOf([1, 2], 4)).toEqual({ shown: [1, 2], more: 0 });
  });
});
