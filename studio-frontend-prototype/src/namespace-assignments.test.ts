import { describe, expect, it } from "vitest";
import type { DeployEnvironment } from "./api";
import { emptyEnvironment, environmentInput, strictnessOf } from "./environments";
import { assignmentInput, assignmentProblem, assignmentRows, suggestedNamespace } from "./namespace-assignments";

const env = (over: Partial<DeployEnvironment>): DeployEnvironment =>
  ({
    id: "e1",
    name: "dev",
    description: "",
    kind: "kubernetes",
    connection_id: "c1",
    registry: "ghcr.io/acme",
    namespace_pattern: "{project}-{environment}",
    database: "none",
    protected: false,
    updated_by: "u",
    updated_at: "2026-11-04T00:00:00Z",
    ...over,
  }) as DeployEnvironment;

describe("assignmentProblem", () => {
  const ok = { project_id: "p1", environment_id: "e1", namespace: "studio-web-dev", build_namespace: "" };
  const envs = [env({}), env({ id: "r1", name: "research", kind: "research" }), env({ id: "e2", name: "test", namespaces: ["studio-web-test"] })];

  it("passes a well-formed assignment", () => {
    expect(assignmentProblem(ok, envs)).toBeNull();
  });

  it("asks for the project, the environment and the namespace, in that order", () => {
    expect(assignmentProblem({ ...ok, project_id: "" }, envs)).toBe("Pick the project.");
    expect(assignmentProblem({ ...ok, environment_id: "" }, envs)).toBe("Pick the environment.");
    expect(assignmentProblem({ ...ok, namespace: " " }, envs)).toBe("Name the namespace.");
  });

  it("refuses what is not a namespace name, the build's too", () => {
    expect(assignmentProblem({ ...ok, namespace: "Studio_Web" }, envs)).toMatch(/not a namespace name/);
    expect(assignmentProblem({ ...ok, build_namespace: "-build" }, envs)).toMatch(/not a namespace name/);
  });

  it("refuses a Research environment, and a namespace the cluster does not give", () => {
    expect(assignmentProblem({ ...ok, environment_id: "r1" }, envs)).toMatch(/no namespaces/);
    expect(assignmentProblem({ ...ok, environment_id: "e2" }, envs)).toMatch(/only studio-web-test/);
    expect(assignmentProblem({ ...ok, environment_id: "e2", namespace: "studio-web-test" }, envs)).toBeNull();
  });
});

describe("the rows and the form", () => {
  it("names the project and the environment, says a run made it, and shows a build namespace only when it differs", () => {
    const rows = assignmentRows(
      [
        { project_id: "p2", environment_id: "e1", namespace: "b-dev", build_namespace: "b-dev", assigned_by: "studio" },
        { project_id: "p1", environment_id: "e1", namespace: "a-dev", build_namespace: "a-build", assigned_by: "admin@acme" },
      ],
      (id) => ({ p1: "Alpha", p2: "Beta" })[id] ?? id,
      () => "dev",
    );
    expect(rows.map((r) => r.project)).toEqual(["Alpha", "Beta"]);
    expect(rows[0]).toMatchObject({ build: "a-build", by: "admin@acme" });
    expect(rows[1]).toMatchObject({ build: null, by: "a run (Studio made it)" });
  });

  it("suggests what the pattern names, or the one namespace a cluster gives", () => {
    expect(suggestedNamespace(env({}), "Studio Web")).toBe("studio-web-dev");
    expect(suggestedNamespace(env({ namespaces: ["given"] }), "Studio Web")).toBe("given");
    expect(suggestedNamespace(undefined, "x")).toBe("");
  });

  it("opens a row as a form without repeating the namespace as the build's", () => {
    expect(assignmentInput({ project_id: "p", environment_id: "e", namespace: "n", build_namespace: "n" }).build_namespace).toBe("");
    expect(assignmentInput(null)).toEqual({ project_id: "", environment_id: "", namespace: "", build_namespace: "" });
  });
});

describe("an environment's strictness", () => {
  it("follows protection unless it says its own", () => {
    expect(strictnessOf({ protected: true })).toBe("prod");
    expect(strictnessOf({ protected: false })).toBe("dev");
    expect(strictnessOf({ protected: true, strictness: "dev" })).toBe("dev");
  });

  it("is kept through the form, so a save does not reset it", () => {
    expect(environmentInput(env({ strictness: "prod" })).strictness).toBe("prod");
    expect(emptyEnvironment().strictness).toBeNull();
  });
});
