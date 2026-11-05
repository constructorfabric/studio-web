/* The New project card no longer asks what kind of project it is: what the
 * product is gets proposed from its specs (product-kind.ts). It asks where
 * the code starts and whether a starter gear goes there. These pin which
 * pages and sections follow from those answers, because the only way to see
 * them in the card is to open it and change the radio -- which is exactly the
 * check nobody repeats for every combination.
 */
import { describe, expect, it } from "vitest";

import {
  clampStep,
  createFormLayout,
  createMode,
  createSteps,
  pluginBlocker,
  repoBlocker,
  repoKey,
  stepBlocker,
  type CreateChoices,
  type RepoRoad,
} from "./project-form";

const ROADS: RepoRoad[] = ["none", "new", "existing"];
const all: CreateChoices[] = ROADS.flatMap((road) => [false, true].map((starterGear) => ({ road, starterGear })));

describe("createFormLayout", () => {
  it("asks for a repository unless the project starts without one", () => {
    expect(createFormLayout({ road: "none", starterGear: false }).repository).toBe(false);
    expect(createFormLayout({ road: "new", starterGear: false }).repository).toBe(true);
    expect(createFormLayout({ road: "existing", starterGear: false }).repository).toBe(true);
  });

  it("asks about the starter gear only when there is a repository to put it in", () => {
    expect(createFormLayout({ road: "none", starterGear: true }).starterGear).toBe(false);
    expect(createFormLayout({ road: "new", starterGear: true }).starterGear).toBe(true);
    expect(createFormLayout({ road: "existing", starterGear: false }).starterGear).toBe(false);
  });

  it("does not offer a kit for a gear going into a shared store, and says why instead", () => {
    // A kit installs with `copy` across every repository the project has, and
    // that one already belongs to the gears in it.
    const shared = createFormLayout({ road: "existing", starterGear: true });
    expect(shared.components).toBe(false);
    expect(shared.componentsNote).toBe(true);
  });

  it("still offers a kit for a repository created a moment ago, or one attached as it is", () => {
    expect(createFormLayout({ road: "new", starterGear: true }).components).toBe(true);
    expect(createFormLayout({ road: "existing", starterGear: false }).components).toBe(true);
  });

  it("never shows both the kit picker and the note explaining its absence", () => {
    for (const c of all) {
      const l = createFormLayout(c);
      expect(l.components, JSON.stringify(c)).not.toBe(l.componentsNote);
    }
  });
});

describe("repoBlocker", () => {
  it("blocks nothing when a repository is created, or none is wanted", () => {
    // The backend resolves the first GitHub connection itself and names the
    // repository after the project, so neither field is required here.
    expect(repoBlocker("new", "", false)).toBeNull();
    expect(repoBlocker("none", "", false)).toBeNull();
  });

  it("names the missing connection before the missing repository", () => {
    expect(repoBlocker("existing", "", false)).toBe("Pick the connection that holds the repository.");
    expect(repoBlocker("existing", "conn-1", false)).toBe("Pick the repository.");
    expect(repoBlocker("existing", "conn-1", true)).toBeNull();
  });
});

describe("createSteps", () => {
  it("walks the same four pages whatever the road, with Sources second", () => {
    expect(createSteps({ road: "none", starterGear: false }).map((s) => s.key)).toEqual([
      "project",
      "repository",
      "brief",
      "components",
    ]);
    expect(createSteps({ road: "new", starterGear: true }).find((s) => s.key === "repository")!.label).toBe("Sources");
  });

  it("does not give a gear going into a shared store a kit page", () => {
    // There is no kit picker for that road, so there is nothing on the page.
    expect(createSteps({ road: "existing", starterGear: true }).map((s) => s.key)).toEqual([
      "project",
      "repository",
      "brief",
    ]);
  });

  it("does not ask what kind of project it is", () => {
    for (const c of all) {
      const first = createSteps(c)[0];
      expect(first.key).toBe("project");
      expect(first.hint).toMatch(/template/);
      expect(first.hint).toMatch(/decided later, from its specs/);
    }
  });

  it("gives every page a hint, because a numbered page says nothing", () => {
    for (const c of all) {
      for (const step of createSteps(c)) expect(step.hint.length, `${JSON.stringify(c)}/${step.key}`).toBeGreaterThan(0);
    }
  });

  it("says where the brief lands: the starter gear's PRD, else the project's", () => {
    const hint = (c: CreateChoices) => createSteps(c).find((s) => s.key === "brief")!.hint;
    expect(hint({ road: "new", starterGear: true })).toMatch(/starter gear's PRD/);
    expect(hint({ road: "none", starterGear: false })).toMatch(/PRD's first answer/);
  });
});

describe("createMode", () => {
  it("is a modernization only when an existing repository is attached as it is", () => {
    expect(createMode({ road: "existing", starterGear: false })).toBe("modernize");
    expect(createMode({ road: "existing", starterGear: true })).toBe("greenfield");
    expect(createMode({ road: "new", starterGear: false })).toBe("greenfield");
    expect(createMode({ road: "none", starterGear: false })).toBe("greenfield");
  });
});

describe("clampStep", () => {
  it("keeps a page index inside a list that just got shorter", () => {
    // Writing a gear into a shared store drops the kit page while the card is on it.
    const shorter = createSteps({ road: "existing", starterGear: true });
    expect(clampStep(3, shorter)).toBe(shorter.length - 1);
  });

  it("leaves a valid index alone and floors a negative one", () => {
    const steps = createSteps({ road: "new", starterGear: false });
    expect(clampStep(2, steps)).toBe(2);
    expect(clampStep(-1, steps)).toBe(0);
  });

  it("answers 0 for an empty list rather than -1", () => {
    expect(clampStep(3, [])).toBe(0);
  });
});

describe("stepBlocker", () => {
  const form = { name: "", road: "none" as RepoRoad, starterGear: false, connectionId: "", repoPicked: false };

  it("will not leave the first page unnamed", () => {
    expect(stepBlocker("project", form)).toBe("Name the project.");
    expect(stepBlocker("project", { ...form, name: "  x  " })).toBeNull();
  });

  it("carries the repository's own rule onto the Sources page", () => {
    const attach = { ...form, name: "x", road: "existing" as const };
    expect(stepBlocker("repository", attach)).toBe("Pick the connection that holds the repository.");
    expect(stepBlocker("repository", { ...attach, connectionId: "c", repoPicked: true })).toBeNull();
  });

  it("asks a plugin starter gear for its host, and nobody else", () => {
    const plugin = { ...form, name: "x", road: "new" as const, pluginProblem: "Pick the host." };
    expect(stepBlocker("repository", { ...plugin, starterGear: true })).toBe("Pick the host.");
    expect(stepBlocker("repository", plugin)).toBeNull();
  });

  it("blocks nothing on the optional pages", () => {
    expect(stepBlocker("brief", form)).toBeNull();
    expect(stepBlocker("components", form)).toBeNull();
  });
});

// A plugin names its point by spec, which the engine joins across sources, so
// the repository it goes into does not matter -- only that there is a host.
describe("pluginBlocker", () => {
  const corpusUrl = "https://github.com/MikeFalcon77/gears-rust.git";

  it("writes a plugin into a new repository as readily as into the corpus", () => {
    expect(pluginBlocker({ repoMode: "new", storeRepo: null, corpusUrl, host: "cf-gears-authn-resolver::x" })).toBeNull();
    expect(
      pluginBlocker({ repoMode: "existing", storeRepo: "acme/gears", corpusUrl, host: "cf-gears-authn-resolver::x" }),
    ).toBeNull();
  });

  it("still asks for the host, and says so when there is no engine", () => {
    expect(pluginBlocker({ repoMode: "existing", storeRepo: "MikeFalcon77/gears-rust", corpusUrl, host: "" })).toMatch(
      /Pick the host/,
    );
    expect(pluginBlocker({ repoMode: "existing", storeRepo: "x/y", corpusUrl: null, host: "h" })).toMatch(/not configured/);
  });

  it("agrees with the backend on what one repository is", () => {
    expect(repoKey(corpusUrl)).toBe("mikefalcon77/gears-rust");
    expect(repoKey("MikeFalcon77/gears-rust/")).toBe("mikefalcon77/gears-rust");
  });
});
