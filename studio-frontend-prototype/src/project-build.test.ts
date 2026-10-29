import { describe, expect, it } from "vitest";

import { ON_GEARS, firstImage, isRepoPath, ownBuildProblem, ownBuildSummary } from "./project-build";

describe("how a project builds", () => {
  it("on gears needs nothing more", () => {
    expect(ownBuildProblem(ON_GEARS)).toBeNull();
  });

  it("from its own Dockerfiles names them and a chart inside the repository", () => {
    const ok = { kind: "own" as const, images: [firstImage("C# Hello")], chart: "chart/csharp-hello" };
    expect(ok.images[0]).toEqual({ app: "app", name: "c-hello", dockerfile: "Dockerfile", context: "." });
    expect(ownBuildProblem(ok)).toBeNull();
    expect(ownBuildSummary(ok)).toBe("the Dockerfile Dockerfile and the chart chart/csharp-hello");
    expect(ownBuildProblem({ ...ok, images: [] })).toMatch(/at least one/);
    expect(ownBuildProblem({ ...ok, chart: "../chart" })).toMatch(/Helm chart/);
    expect(ownBuildProblem({ ...ok, images: [{ ...ok.images[0], dockerfile: "../Dockerfile" }] })).toMatch(/Dockerfile/);
    expect(ownBuildProblem({ ...ok, images: [{ ...ok.images[0], app: "App" }] })).toMatch(/values key/);
    expect(ownBuildProblem({ ...ok, images: [ok.images[0], { ...ok.images[0], dockerfile: "x/Dockerfile" }] })).toMatch(/twice/);
  });

  it("keeps paths in the repository", () => {
    expect(isRepoPath("./api/Dockerfile")).toBe(true);
    expect(isRepoPath("/etc/passwd")).toBe(false);
    expect(isRepoPath("a/../b")).toBe(false);
    expect(isRepoPath("C:\\x")).toBe(false);
  });
});
