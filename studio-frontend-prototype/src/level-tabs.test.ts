import { describe, expect, it } from "vitest";

import type { DomainModel, ModelEntity } from "./domain-runtime";
import { hiddenToSave, isGeneric, levelTabs, modelTabs, parseHiddenTabs, shownTabs, tabToOpen } from "./level-tabs";
import { visibleTabs, type ProjectTemplate } from "./project-types";

const shows = (name: string, target: string, label: string) => ({
  name,
  type: target,
  relation: target,
  extends: "edge",
  relationType: "shows",
  relationLabel: label,
});

function model(entities: ModelEntity[]): DomainModel {
  return {
    entities,
    byId: new Map(entities.map((e) => [e.id, e])),
    buckets: [],
    canEdit: true,
    source: "server",
    studioTypes: new Set(),
    gts: { types: {}, relations: {} },
  };
}

const BUILT_IN = [
  { id: "org", icon: "home", label: "Overview" },
  { id: "environments", icon: "layers", label: "Environments" },
  { id: "costs", icon: "coins", label: "Costs" },
];

const ORG = [
  { id: "org", icon: "home", label: "Overview" },
  { id: "projects", icon: "grid", label: "Workspaces" },
  { id: "costs", icon: "coins", label: "Costs" },
];

const m = model([
  {
    id: "organization",
    properties: [
      { name: "name", type: "string" },
      shows("org", "organization", "Overview"),
      shows("costs", "budget", "Money"),
      shows("risks", "risk", "Risks"),
      shows("environments", "deployment-environment", "Environments"),
    ],
  },
  { id: "workspace", properties: [] },
]);

describe("level tabs from the model", () => {
  it("reads the shows relations in the type's order", () => {
    expect(modelTabs(m, "organization").map((t) => t.name)).toEqual(["org", "costs", "risks", "environments"]);
  });

  it("puts a known tab on its screen with the model's label, and a new one on the generic screen", () => {
    const tabs = levelTabs(BUILT_IN, modelTabs(m, "organization"));
    expect(tabs.map((t) => t.id)).toEqual(["org", "costs", "type:risks", "environments"]);
    expect(tabs[1].label).toBe("Money");
    expect(tabs[1].icon).toBe("coins");
    const risks = tabs[2];
    expect(isGeneric(risks.id) && "target" in risks && risks.target).toBe("risk");
  });

  it("keeps the built-in list for a level the model gives no tabs", () => {
    expect(levelTabs(BUILT_IN, modelTabs(m, "workspace")).map((t) => t.id)).toEqual(["org", "environments", "costs"]);
  });

  it("hides a model tab, generic or not, like any other", () => {
    const all = levelTabs(BUILT_IN, modelTabs(m, "organization"));
    expect(shownTabs(all, ["costs", "type:risks"]).map((t) => t.id)).toEqual(["org", "environments"]);
  });
});

describe("hidden tabs", () => {
  it("reads the hidden names a settings document holds, and nothing else", () => {
    expect(parseHiddenTabs({ hidden_tabs: ["costs", "costs", 3, "", "org"] })).toEqual(["costs", "org"]);
    expect(parseHiddenTabs({ hidden_tabs: "costs" })).toEqual([]);
    expect(parseHiddenTabs(null)).toEqual([]);
    expect(parseHiddenTabs({ icon: "x" })).toEqual([]);
  });

  it("leaves out what an administrator turned off, in the level's order", () => {
    expect(shownTabs(ORG, ["costs", "org"]).map((t) => t.id)).toEqual(["projects"]);
    expect(shownTabs(ORG, ["gone"]).map((t) => t.id)).toEqual(["org", "projects", "costs"]);
  });

  it("never leaves a level without a tab", () => {
    expect(shownTabs(ORG, ["org", "projects", "costs"]).map((t) => t.id)).toEqual(["org", "projects", "costs"]);
  });

  it("stores only the level's own names, and refuses to turn everything off", () => {
    expect(hiddenToSave(ORG, new Set(["costs", "gone", "org"]))).toEqual(["org", "costs"]);
    expect(hiddenToSave(ORG, new Set())).toEqual([]);
    expect(hiddenToSave(ORG, new Set(["org", "projects", "costs"]))).toBeNull();
  });

  it("narrows what a project's template shows, never widens it", () => {
    const all = [
      { id: "overview" as const, icon: "home", label: "Overview" },
      { id: "specs" as const, icon: "scan", label: "Specs" },
      { id: "sources" as const, icon: "plug", label: "Sources" },
      { id: "people" as const, icon: "users", label: "Team" },
    ];
    const template: ProjectTemplate = { key: "t", title: "T", description: "", tabs: ["overview", "specs", "sources"] };
    const byTemplate = visibleTabs(all, template);
    // `people` is hidden by the project too, but the template already left it out.
    expect(shownTabs(byTemplate, ["specs", "people"]).map((t) => t.id)).toEqual(["overview", "sources"]);
    expect(shownTabs(byTemplate, ["overview", "specs", "sources"]).map((t) => t.id)).toEqual([
      "overview",
      "specs",
      "sources",
    ]);
  });

  it("moves off a tab that was turned off", () => {
    const shown = shownTabs(ORG, ["org"]);
    expect(tabToOpen(shown, "costs")).toBe("costs");
    expect(tabToOpen(shown, "org")).toBe("projects");
    expect(tabToOpen(shown, "org", "costs")).toBe("costs");
    expect(tabToOpen(shown, "org", "org")).toBe("projects");
  });
});
