import { describe, expect, it } from "vitest";

import { type PathFacts, TAB_HOWTO, pathProgress, projectPath, specQueues } from "./project-path";

const empty: PathFacts = {
  repositories: 0,
  specs: { bound: 0, needsReview: 0, notScanned: 0 },
  model: { documents: 0, extracted: 0, facts: 0, running: false },
  findings: { open: 0, high: 0 },
  product: { gears: 0, resolves: null, errors: 0, written: false },
  build: "none",
};

const finished: PathFacts = {
  repositories: 2,
  specs: { bound: 75, needsReview: 0, notScanned: 0 },
  model: { documents: 75, extracted: 75, facts: 512, running: false },
  findings: { open: 3, high: 0 },
  product: { gears: 5, resolves: true, errors: 0, written: true },
  build: { status: "passed", sha: "abc1234" },
};

const states = (f: PathFacts) => projectPath(f).map((s) => s.state);

describe("projectPath", () => {
  it("starts a new project at connecting a repository", () => {
    const steps = projectPath(empty);
    expect(steps.map((s) => s.id)).toEqual(["repos", "types", "model", "findings", "product", "build"]);
    // No findings is "done" even on an empty project: there is nothing to resolve.
    expect(states(empty)).toEqual(["current", "todo", "todo", "done", "todo", "todo"]);
    expect(steps[0].status).toBe("No repository yet. Attach one so Studio can read its documents.");
  });

  it("marks every step done on a project whose build passed", () => {
    expect(states(finished)).toEqual(["done", "done", "done", "done", "done", "done"]);
    expect(pathProgress(projectPath(finished))).toEqual({ done: 6, total: 6 });
    expect(projectPath(finished).map((s) => s.status)).toEqual([
      "2 repositories attached.",
      "75 of 75 documents typed.",
      "75 of 75 documents read, 512 facts.",
      "3 open findings, none high.",
      "5 gears, resolves, saved to the repository.",
      "Last build passed at abc1234.",
    ]);
  });

  it("counts the documents still to type", () => {
    const steps = projectPath({ ...finished, specs: { bound: 74, needsReview: 1, notScanned: 0 } });
    expect(steps[1]).toMatchObject({ state: "current", status: "74 of 75 documents typed (1 need review).", tab: "specs" });
  });

  it("blocks on an open high finding only", () => {
    const steps = projectPath({ ...finished, findings: { open: 2, high: 1 } });
    expect(steps[3]).toMatchObject({ state: "current", status: "2 open findings, 1 high.", tab: "model" });
  });

  it("says a model build is running", () => {
    const steps = projectPath({ ...finished, model: { documents: 10, extracted: 4, facts: 20, running: true } });
    expect(steps[2]).toMatchObject({ state: "current", status: "Building: 4 of 10 documents read." });
  });

  it("names a product that does not resolve, and one never previewed", () => {
    expect(projectPath({ ...finished, product: { gears: 3, resolves: false, errors: 2, written: false } })[4].status).toBe(
      "3 gears, does not resolve (2 errors).",
    );
    expect(projectPath({ ...finished, product: { gears: 1, resolves: null, errors: 0, written: false } })[4]).toMatchObject({
      state: "current",
      status: "1 gear picked, not previewed yet.",
    });
  });

  it("keeps a failed build current", () => {
    expect(projectPath({ ...finished, build: { status: "failed", sha: "def5678" } })[5]).toMatchObject({
      state: "current",
      status: "Last build failed at def5678.",
    });
  });

  it("shows a failed read as unknown and never makes it current", () => {
    const f: PathFacts = { ...empty, repositories: null, specs: null };
    expect(states(f)).toEqual(["unknown", "unknown", "current", "done", "todo", "todo"]);
    expect(projectPath(f)[0].status).toBe("Could not read the project's sources.");
  });
});

describe("specQueues", () => {
  it("picks the three queues and treats a missing one as zero", () => {
    expect(
      specQueues([
        { queue: "bound", count: 74 },
        { queue: "needs-review", count: 1 },
        { queue: "all", count: 90 },
      ]),
    ).toEqual({ bound: 74, needsReview: 1, notScanned: 0 });
  });
});

describe("TAB_HOWTO", () => {
  it("has a line for the tabs a new member needs", () => {
    for (const tab of ["overview", "sources", "specs", "components", "kits", "people"] as const) {
      expect(TAB_HOWTO[tab]?.lead, tab).toBeTruthy();
    }
  });
});
