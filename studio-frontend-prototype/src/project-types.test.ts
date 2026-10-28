import { describe, expect, it } from "vitest";

import {
  BUILTIN_TYPES,
  PRESETS,
  keyFor,
  landingTab,
  parseTypes,
  typeOfProject,
  typesProblem,
  visibleTabs,
} from "./project-types";
import type { ProjectType } from "./project-types";

const TABS = ["overview", "specs", "components", "parts", "builds", "sources", "people"] as const;
const BAR = TABS.map((id) => ({ id, label: id }));

const learning = PRESETS.find((p) => p.id === "learning")!.types;

describe("reading a stored list", () => {
  it("falls back to the built-in types when nothing is set or nothing is readable", () => {
    expect(parseTypes(null, TABS)).toBe(BUILTIN_TYPES);
    expect(parseTypes({ types: "no" }, TABS)).toBe(BUILTIN_TYPES);
    expect(parseTypes({ types: [{ key: "x" }] }, TABS)).toBe(BUILTIN_TYPES);
  });

  it("keeps the well-formed entries and drops the rest", () => {
    const types = parseTypes(
      {
        types: [
          { key: "a", title: "A", recipe: "product", tabs: ["overview", "nope", "sources"], first_tab: "sources" },
          { key: "a", title: "Duplicate", recipe: "product" },
          { key: "b", title: "B", recipe: "deploy-everything" },
          { key: "c", title: "C", recipe: "existing", first_tab: "nope", kits: ["sdlc", 3] },
        ],
      },
      TABS,
    );
    expect(types.map((t) => t.key)).toEqual(["a", "c"]);
    expect(types[0]).toMatchObject({ tabs: ["overview", "sources"], first_tab: "sources", description: "" });
    expect(types[1].first_tab).toBeUndefined();
    expect(types[1].kits).toEqual(["sdlc"]);
  });

  it("reads every preset back as it was written", () => {
    for (const preset of PRESETS) {
      expect(parseTypes({ types: preset.types }, ["overview", "issues", "specs", "model", "components", "parts", "builds", "tests", "deploys", "kits", "artifacts", "sources", "activity", "timeline", "people", "automation"]), preset.id).toEqual(preset.types);
      expect(typesProblem(preset.types), preset.id).toBeNull();
    }
  });
});

describe("what the editor refuses to save", () => {
  const ok: ProjectType = { key: "ok", title: "Ok", description: "", recipe: "existing" };
  it("names the first problem", () => {
    expect(typesProblem([])).toMatch(/at least one/);
    expect(typesProblem([{ ...ok, title: " " }])).toMatch(/title/);
    expect(typesProblem([{ ...ok, key: "Has Space" }])).toMatch(/key/);
    expect(typesProblem([ok, { ...ok, title: "Again" }])).toMatch(/share the key/);
    expect(typesProblem([{ ...ok, tabs: [] }])).toMatch(/no tab/);
    expect(typesProblem([{ ...ok, tabs: ["overview"], first_tab: "sources" }])).toMatch(/does not show/);
    expect(typesProblem([ok])).toBeNull();
  });

  it("makes a free key from a title", () => {
    expect(keyFor("Build Something!", [])).toBe("build-something");
    expect(keyFor("New type", ["new-type", "new-type-2"])).toBe("new-type-3");
    expect(keyFor("!!!", [])).toBe("type");
  });
});

describe("a project's type", () => {
  it("is the one it was created as", () => {
    expect(typeOfProject({ type: "write-a-gear", kind: "new_gears" }, learning)?.key).toBe("write-a-gear");
  });

  it("is the built-in one of its recipe when it has no type or its type was removed", () => {
    expect(typeOfProject({ kind: "product" }, learning)?.key).toBe("product");
    expect(typeOfProject({ type: "gone", kind: "existing" }, learning)?.key).toBe("existing");
    expect(typeOfProject(null, learning)).toBeNull();
  });

  it("shows its tabs in the bar's order, and every tab when it names none", () => {
    const t: ProjectType = { key: "t", title: "T", description: "", recipe: "product", tabs: ["sources", "overview"] };
    expect(visibleTabs(BAR, t).map((x) => x.id)).toEqual(["overview", "sources"]);
    expect(visibleTabs(BAR, BUILTIN_TYPES[0])).toHaveLength(BAR.length);
    expect(visibleTabs(BAR, null)).toHaveLength(BAR.length);
  });

  it("opens on its first tab, or the first it shows", () => {
    const t: ProjectType = { key: "t", title: "T", description: "", recipe: "product", tabs: ["builds", "sources"] };
    expect(landingTab(BAR, t)).toBe("builds");
    expect(landingTab(BAR, { ...t, first_tab: "sources" })).toBe("sources");
    expect(landingTab(BAR, null)).toBe("overview");
  });
});
