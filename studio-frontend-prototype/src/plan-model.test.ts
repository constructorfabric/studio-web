import { describe, expect, it } from "vitest";
import { linkOf, move, needOf, parseNumber, quarters, sectionBody, teamChoices, withNeed, type Plan, type PlanPeople } from "./plan-model";

const plan: Plan = {
  revision: 3,
  from: "studio",
  changed_at: null,
  changed_by: null,
  file: null,
  lanes: { order: ["CORE"], labels: [{ group: "CORE", label: "Core" }] },
  units: [
    { name: "Northwind", color: "1F3864", teams: [{ tag: "nw_core", name: "Northwind Core", color: null, people: 3, power: 2.5 }] },
  ],
  no_unit_color: "595959",
  people: [{ login: "zed-example", alias: "Zed", team: "nw_core", unit: null, power: 0.5, email: null }],
  projects: [
    { key: "web", name: "Web", source_header: null, studio_project: null },
    { key: "api", name: "API", source_header: null, studio_project: null },
  ],
  needs: [{ number: "20", title: "CORE - Ledger", gear: null, group: "CORE", needs: [{ project: "api", when: "no" }] }],
};

describe("a plan section", () => {
  it("is saved with the revision it was read at, and only its own section", () => {
    expect(sectionBody("people", plan)).toEqual({ revision: 3, people: plan.people });
    expect(sectionBody("units", plan)).toEqual({ revision: 3, units: plan.units, no_unit_color: "595959" });
  });
});

describe("the needs grid", () => {
  it("sets a cell in the projects' order and drops an emptied one", () => {
    const need = withNeed(plan.needs[0], "web", " Q3'26 ", plan.projects);
    expect(need.needs).toEqual([
      { project: "web", when: "Q3'26" },
      { project: "api", when: "no" },
    ]);
    expect(needOf(need, "web")).toBe("Q3'26");
    expect(withNeed(need, "api", "", plan.projects).needs).toEqual([{ project: "web", when: "Q3'26" }]);
  });

  it("suggests the coming quarters", () => {
    expect(quarters(new Date(Date.UTC(2026, 10, 3)), 3)).toEqual(["Q4'26", "Q1'27", "Q2'27"]);
  });
});

describe("plan fields", () => {
  it("read numbers, blank as unset and nonsense as not yet", () => {
    expect(parseNumber("0,5")).toBe(0.5);
    expect(parseNumber(" ")).toBeNull();
    expect(parseNumber("lots")).toBeUndefined();
  });

  it("offer every team by tag, with its unit", () => {
    expect(teamChoices(plan.units)).toEqual([{ tag: "nw_core", label: "nw_core — Northwind Core (Northwind)" }]);
  });

  it("move a row and refuse to move past an end", () => {
    expect(move(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(move(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
});

describe("a person's link to Studio", () => {
  const links: PlanPeople = {
    people: [
      { login: "zed-example", alias: null, team: null, person_id: "p-zed", member: true },
      { login: "out-example", alias: null, team: null, person_id: "p-out", member: false },
      { login: "nobody-example", alias: null, team: null, person_id: null, member: false },
    ],
    unplanned: [],
    members_without_github: 0,
    identities_available: true,
  };

  it("reads the saved match, whatever the case of the login", () => {
    expect(linkOf(links, "Zed-Example")).toEqual({ kind: "member", personId: "p-zed" });
    expect(linkOf(links, "out-example")).toEqual({ kind: "outsider", personId: "p-out" });
    expect(linkOf(links, "nobody-example")).toEqual({ kind: "unknown" });
  });

  it("has nothing to say about a row typed since the save", () => {
    expect(linkOf(links, "new-example")).toEqual({ kind: "unsaved" });
    expect(linkOf(null, "zed-example")).toEqual({ kind: "unsaved" });
  });
});
