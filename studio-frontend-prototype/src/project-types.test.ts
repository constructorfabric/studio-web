import { describe, expect, it } from "vitest";

import {
  BUILTIN_TEMPLATES,
  PRESETS,
  keyFor,
  landingTab,
  parseTemplates,
  templateDefaults,
  templateFills,
  templateOfProject,
  templatesProblem,
  visibleTabs,
} from "./project-types";
import type { ProjectTemplate } from "./project-types";
import type { ProjTab } from "./project-overview";

const TABS = ["overview", "specs", "components", "parts", "releases", "sources", "people"] as const;
const BAR = TABS.map((id) => ({ id, label: id }));

const learning = PRESETS.find((p) => p.id === "learning")!.templates;

describe("reading a stored list", () => {
  it("falls back to the built-in templates when nothing is set", () => {
    expect(parseTemplates(null, TABS)).toBe(BUILTIN_TEMPLATES);
    expect(parseTemplates({ types: "no" }, TABS)).toBe(BUILTIN_TEMPLATES);
  });

  it("reads a list that names none as none: a template is optional", () => {
    expect(parseTemplates({ types: [] }, TABS)).toEqual([]);
    expect(parseTemplates({ types: [{ key: "x" }] }, TABS)).toEqual([]);
  });

  it("keeps the well-formed entries and drops the rest", () => {
    const templates = parseTemplates(
      {
        types: [
          { key: "a", title: "A", repository: "new", tabs: ["overview", "nope", "sources"], first_tab: "sources" },
          { key: "a", title: "Duplicate" },
          { key: "c", title: "C", repository: "elsewhere", starter_gear: true, first_tab: "nope", kits: ["sdlc", 3], brief: " " },
        ],
      },
      TABS,
    );
    expect(templates.map((t) => t.key)).toEqual(["a", "c"]);
    expect(templates[0]).toMatchObject({ repository: "new", tabs: ["overview", "sources"], first_tab: "sources", description: "" });
    // No repository, so no starter gear in it; a blank brief is no brief.
    expect(templates[1]).toEqual({ key: "c", title: "C", description: "", kits: ["sdlc"] });
  });

  it("reads a project type saved with a recipe as the sources that recipe created", () => {
    const [gear, product, existing, odd] = parseTemplates(
      {
        types: [
          { key: "g", title: "G", recipe: "new_gears" },
          { key: "p", title: "P", recipe: "product" },
          { key: "e", title: "E", recipe: "existing" },
          { key: "o", title: "O", recipe: "deploy-everything" },
        ],
      },
      TABS,
    );
    expect(gear).toMatchObject({ repository: "new", starter_gear: true });
    expect(product).toMatchObject({ repository: "new" });
    expect(product.starter_gear).toBeUndefined();
    expect(existing).toMatchObject({ repository: "existing" });
    expect(odd.repository).toBeUndefined();
    expect(Object.keys(gear)).not.toContain("recipe");
  });

  it("reads a template saved with Builds and Deploys as one Releases tab", () => {
    const [t] = parseTemplates(
      { types: [{ key: "a", title: "A", tabs: ["overview", "builds", "deploys"], first_tab: "deploys" }] },
      TABS,
    );
    expect(t).toMatchObject({ tabs: ["overview", "releases"], first_tab: "releases" });
  });

  it("reads every preset back as it was written", () => {
    const all = ["overview", "issues", "specs", "model", "components", "parts", "releases", "tests", "kits", "artifacts", "sources", "activity", "people"];
    for (const preset of PRESETS) {
      expect(parseTemplates({ types: preset.templates }, all), preset.id).toEqual(preset.templates);
      expect(templatesProblem(preset.templates), preset.id).toBeNull();
    }
  });
});

describe("what a template fills in", () => {
  it("fills in nothing without one", () => {
    expect(templateDefaults(null)).toEqual({ road: "none", starterGear: false, brief: "", kits: [] });
  });

  it("fills in its sources, brief and kits", () => {
    const t: ProjectTemplate = { key: "t", title: "T", description: "", repository: "existing", starter_gear: true, brief: "b", kits: ["k"] };
    expect(templateDefaults(t)).toEqual({ road: "existing", starterGear: true, brief: "b", kits: ["k"] });
    expect(templateFills(t)).toBe("Fills in a repository attached with a starter gear, a brief, 1 kit.");
  });

  it("never writes a starter gear where there is no repository", () => {
    expect(templateDefaults({ key: "t", title: "T", description: "", starter_gear: true }).starterGear).toBe(false);
  });
});

describe("what the editor refuses to save", () => {
  const ok: ProjectTemplate = { key: "ok", title: "Ok", description: "" };
  it("names the first problem, and saves an empty list", () => {
    expect(templatesProblem([])).toBeNull();
    expect(templatesProblem([{ ...ok, title: " " }])).toMatch(/title/);
    expect(templatesProblem([{ ...ok, key: "Has Space" }])).toMatch(/key/);
    expect(templatesProblem([ok, { ...ok, title: "Again" }])).toMatch(/share the key/);
    expect(templatesProblem([{ ...ok, tabs: [] }])).toMatch(/no tab/);
    expect(templatesProblem([{ ...ok, tabs: ["overview"], first_tab: "sources" }])).toMatch(/does not show/);
    expect(templatesProblem([ok])).toBeNull();
  });

  it("makes a free key from a title", () => {
    expect(keyFor("Build Something!", [])).toBe("build-something");
    expect(keyFor("New template", ["new-template", "new-template-2"])).toBe("new-template-3");
    expect(keyFor("!!!", [])).toBe("template");
  });
});

describe("a project's template", () => {
  it("is the one it was created from", () => {
    expect(templateOfProject({ type: "write-a-gear", kind: "new_gears" }, learning)?.key).toBe("write-a-gear");
  });

  it("is the built-in one of its old kind when its template is gone, and none without either", () => {
    expect(templateOfProject({ kind: "product" }, learning)?.key).toBe("product");
    expect(templateOfProject({ type: "gone", kind: "existing" }, learning)?.key).toBe("existing");
    expect(templateOfProject({}, learning)).toBeNull();
    expect(templateOfProject(null, learning)).toBeNull();
  });

  it("shows its tabs in the bar's order, and every tab when it names none", () => {
    const t: ProjectTemplate = { key: "t", title: "T", description: "", tabs: ["sources", "overview"] };
    expect(visibleTabs(BAR, t).map((x) => x.id)).toEqual(["overview", "sources"]);
    expect(visibleTabs(BAR, BUILTIN_TEMPLATES[0])).toHaveLength(BAR.length - 1);
    expect(visibleTabs(BAR, null)).toHaveLength(BAR.length - 1);
  });

  it("shows Components as Product's Parts where there is Product, and as a tab where there is not", () => {
    const t = (tabs: ProjTab[]): ProjectTemplate => ({ key: "t", title: "T", description: "", tabs });
    expect(visibleTabs(BAR, t(["components", "parts"])).map((x) => x.id)).toEqual(["components"]);
    expect(visibleTabs(BAR, t(["overview", "parts"])).map((x) => x.id)).toEqual(["overview", "parts"]);
  });

  it("opens on its first tab, or the first it shows", () => {
    const t: ProjectTemplate = { key: "t", title: "T", description: "", tabs: ["releases", "sources"] };
    expect(landingTab(BAR, t)).toBe("releases");
    expect(landingTab(BAR, { ...t, first_tab: "sources" })).toBe("sources");
    expect(landingTab(BAR, null)).toBe("overview");
  });
});
