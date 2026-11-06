import { describe, expect, it } from "vitest";

import { hiddenToSave, parseHiddenTabs, shownTabs, tabToOpen } from "./level-tabs";
import { visibleTabs, type ProjectTemplate } from "./project-types";

const ORG = [
  { id: "org", icon: "home", label: "Overview" },
  { id: "projects", icon: "grid", label: "Workspaces" },
  { id: "costs", icon: "coins", label: "Costs" },
];

describe("level tabs", () => {
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
