import { describe, expect, it } from "vitest";

import type { DomainModel, ModelEntity } from "./domain-runtime";
import { allLevelTabs, isGeneric, levelTabs, modelTabs } from "./level-tabs";

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

describe("level tabs", () => {
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

  it("leaves out what an administrator turned off", () => {
    expect(levelTabs(BUILT_IN, modelTabs(m, "organization"), ["costs", "risks"]).map((t) => t.id)).toEqual([
      "org",
      "environments",
    ]);
  });

  it("keeps the built-in list for a level the model gives no tabs", () => {
    expect(levelTabs(BUILT_IN, modelTabs(m, "workspace"), ["costs"]).map((t) => t.id)).toEqual(["org", "environments"]);
    expect(allLevelTabs(BUILT_IN, []).map((t) => t.name)).toEqual(["org", "environments", "costs"]);
  });
});
