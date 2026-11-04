import { describe, expect, it } from "vitest";

import type { ArtifactNode } from "./api";
import {
  BUILD_REFUSALS,
  buildRefusalCode,
  buildRefusalText,
  placeLines,
  placeOf,
  buildDuration,
  stepToShow,
  buildStatus,
  buildWorkflowOf,
  buildsHeadline,
  buildsOf,
  ciReadFailures,
  failureLine,
  ideBuildDuration,
  ideBuildsOf,
  isBuildWorkflow,
  latestFinished,
  mainBranch,
  productBuildsOf,
  repoPathsOf,
  workflowFile,
  workflowsOf,
} from "./builds";

const node = (id: string, v: Record<string, unknown>): ArtifactNode => ({
  type_id: "gts.cf.studio.artifact.workflow_run.v1~",
  instance_id: id,
  value: v,
});

const runs = buildsOf([
  node("a", { workflow: "Delivery", branch: "main", sha: "aaaaaaa1", status: "completed", conclusion: "failure", created_at: "2026-10-14T08:00:00Z" }),
  node("b", { workflow: "Delivery", branch: "main", sha: "bbbbbbb2", status: "in_progress", created_at: "2026-10-14T09:00:00Z" }),
  node("c", { workflow: "Delivery", branch: "feat/x", sha: "ccccccc3", status: "completed", conclusion: "success", created_at: "2026-10-14T07:00:00Z" }),
  node("d", { workflow: "Docs", branch: "main", sha: "ddddddd4", status: "completed", conclusion: "success", created_at: "2026-10-13T07:00:00Z" }),
]);

describe("builds", () => {
  it("reads a run's status from the provider's status and conclusion", () => {
    expect(buildStatus("in_progress", null)).toBe("running");
    expect(buildStatus("queued", null)).toBe("queued");
    expect(buildStatus("waiting", null)).toBe("queued");
    expect(buildStatus("completed", "success")).toBe("passed");
    expect(buildStatus("completed", "cancelled")).toBe("cancelled");
    expect(buildStatus("completed", "skipped")).toBe("skipped");
    expect(buildStatus("completed", "timed_out")).toBe("failed");
    expect(buildStatus(null, null)).toBe("unknown");
    expect(buildStatus("completed", null)).toBe("unknown");
  });

  it("orders runs newest first and counts workflows, most runs first", () => {
    expect(runs.map((r) => r.id)).toEqual(["b", "a", "c", "d"]);
    expect(runs[0].shortSha).toBe("bbbbbbb");
    expect(workflowsOf(runs)).toEqual([
      { name: "Delivery", runs: 3 },
      { name: "Docs", runs: 1 },
    ]);
  });

  it("answers whether main builds from its newest finished run", () => {
    expect(mainBranch(runs)).toBe("main");
    expect(latestFinished(runs, "main")?.id).toBe("a");
    expect(buildsHeadline(runs, "Delivery")).toBe("Delivery on main: failed at aaaaaaa.");
    expect(buildsHeadline(runs, "Docs")).toBe("Docs on main: passed at ddddddd.");
    expect(buildsHeadline(runs, "Delivery", "feat/x")).toBe("Delivery on feat/x: passed at ccccccc.");
    expect(buildsHeadline(runs, "Docs", "feat/x")).toBe("1 run; none finished on feat/x yet.");
    expect(buildsHeadline([], null)).toBe("No CI runs yet.");
    expect(mainBranch(buildsOf([node("x", { branch: "dev" }), node("y", { branch: "dev" }), node("z", { branch: "x" })]))).toBe("dev");
  });

  it("says how long a run took, or has been running", () => {
    expect(buildDuration({ status: "passed", startedAt: "2026-10-14T08:00:00Z", updatedAt: "2026-10-14T08:06:10Z" })).toBe("6 min");
    expect(buildDuration({ status: "failed", startedAt: "2026-10-14T08:00:00Z", updatedAt: "2026-10-14T08:00:40Z" })).toBe("40 s");
    expect(
      buildDuration({ status: "running", startedAt: "2026-10-14T08:00:00Z", updatedAt: null }, Date.parse("2026-10-14T09:05:00Z")),
    ).toBe("1 h 5 min");
    // Time in the queue is not build time.
    expect(buildDuration({ status: "queued", startedAt: "2026-10-14T08:00:00Z", updatedAt: null })).toBeNull();
    expect(buildDuration({ status: "passed", startedAt: null, updatedAt: "2026-10-14T08:06:10Z" })).toBeNull();
  });

  it("names the repositories whose CI could not be read", () => {
    expect(
      ciReadFailures([
        node("r1", { full_path: "o/a", ci_error: "GitHub 403 Forbidden" }),
        node("r2", { full_path: "o/b", ci_runs: 12 }),
      ]),
    ).toEqual([{ repo: "o/a", error: "GitHub 403 Forbidden" }]);
  });

  it("names the workflow Build starts by its file, in the repository its runs come from", () => {
    expect(workflowFile(".github/workflows/studio-delivery.yml")).toBe("studio-delivery.yml");
    expect(workflowFile("dynamic/pages")).toBeNull();
    expect(workflowFile(null)).toBeNull();
    const repos = repoPathsOf([node("r1", { full_path: "acme/shop" }), node("r2", {})]);
    expect([...repos.entries()]).toEqual([["r1", "acme/shop"]]);
    const withPath = buildsOf([
      node("x", { workflow: "Delivery", workflow_path: ".github/workflows/delivery.yml", repo: "r1", sha: "1234567" }),
      node("y", { workflow: "Pages", workflow_path: "dynamic/pages", repo: "r1", sha: "1234567" }),
    ]);
    const delivery = buildWorkflowOf(withPath, "Delivery", repos);
    expect(delivery).toEqual({ repo: "acme/shop", workflow: "delivery.yml" });
    expect(buildWorkflowOf(withPath, "Pages", repos)).toBeNull();
    expect(isBuildWorkflow({ repo: "Acme/Shop", workflow: "delivery.yml" }, delivery)).toBe(true);
    expect(isBuildWorkflow({ repo: "acme/shop", workflow: "other.yml" }, delivery)).toBe(false);
    expect(isBuildWorkflow(null, delivery)).toBe(false);
  });

  it("reads the IDE's builds, newest first, with their first error and how long they took", () => {
    const builds = ideBuildsOf([
      node("1", {
        build_id: "b-1",
        where: "desktop",
        status: "failed",
        product: "shop",
        profile: "local",
        short_sha: "abcdef1",
        started_at: "2026-10-15T10:00:00Z",
        finished_at: "2026-10-15T10:06:10Z",
        duration_ms: 370000,
        failure: "Could not find `protoc`",
        failure_step: "protoc",
      }),
      node("2", { build_id: "b-2", where: "session", status: "running", started_at: "2026-10-15T11:00:00Z", outputs: ["shop:1", 3] }),
      node("3", { build_id: "b-3", status: "odd" }),
    ]);
    expect(builds.map((b) => b.buildId)).toEqual(["b-2", "b-1", "b-3"]);
    expect(builds[1]).toMatchObject({ status: "failed", failure: "Could not find `protoc`", failureStep: "protoc", where: "desktop" });
    expect(builds[0].outputs).toEqual(["shop:1"]);
    expect(builds[2].status).toBe("unknown");
    expect(ideBuildDuration(builds[1])).toBe("6 min");
    expect(ideBuildDuration(builds[0], Date.parse("2026-10-15T11:00:40Z"))).toBe("40 s");
  });

  it("reads what a build published: its chart and its images by application", () => {
    const [b] = ideBuildsOf([
      node("1", {
        build_id: "ci-run-7",
        where: "ci",
        status: "passed",
        chart: { reference: "oci://ghcr.io/acme/charts/shop", version: "0.1.0-sha.1" },
        images: [{ app: "api", image: "ghcr.io/acme/gbx-api:sha-1@sha256:ab" }, { app: 3 }],
      }),
    ]);
    expect(b).toMatchObject({ chartRef: "oci://ghcr.io/acme/charts/shop", chartVersion: "0.1.0-sha.1", where: "ci" });
    expect(b.images).toEqual([{ app: "api", image: "ghcr.io/acme/gbx-api:sha-1@sha256:ab" }]);
    expect(ideBuildsOf([node("2", { build_id: "b" })])[0].chartRef).toBeNull();
  });

  it("puts the build workflow's CI runs among the product's builds, and links a pipeline's build to its run", () => {
    const ci = buildsOf([
      node("r7", { workflow: "Build", workflow_path: ".github/workflows/build.yml", repo: "repo-1", external_id: "7", status: "completed", conclusion: "success", url: "https://ci/7", branch: "main", started_at: "2026-10-15T09:00:00Z" }),
      node("r8", { workflow: "Build", workflow_path: ".github/workflows/build.yml", repo: "repo-1", external_id: "8", status: "completed", conclusion: "failure", url: "https://ci/8", sha: "8888888abc", started_at: "2026-10-15T10:00:00Z" }),
      node("r9", { workflow: "Docs", workflow_path: ".github/workflows/docs.yml", repo: "repo-1", external_id: "9", status: "completed", conclusion: "failure", started_at: "2026-10-15T11:00:00Z" }),
    ]);
    const recorded = ideBuildsOf([
      node("b7", { build_id: "ci-run-7", where: "ci", status: "passed", chart: { reference: "oci://r/charts/shop", version: "0.1.0" } }),
    ]);
    const paths = new Map([["repo-1", "acme/shop"]]);
    const all = productBuildsOf(recorded, ci, { repo: "Acme/Shop", workflow: "build.yml" }, paths);
    // The docs workflow is not the build; the passed run is its recorded build.
    expect(all.map((b) => [b.buildId, b.status, b.url])).toEqual([
      ["ci-run-8", "failed", "https://ci/8"],
      ["ci-run-7", "passed", "https://ci/7"],
    ]);
    expect(all[0]).toMatchObject({ where: "ci", shortSha: "8888888", chartVersion: null });
    // Without a build workflow set, only what CI recorded is a build.
    expect(productBuildsOf(recorded, ci, null, paths).map((b) => b.buildId)).toEqual(["ci-run-7"]);
  });

  it("keeps a failure's first line short and without gearbox's help", () => {
    expect(failureLine("error [GBX1] gear `a` is wrong · help: fix it\nmore")).toBe("error [GBX1] gear `a` is wrong.");
    expect(failureLine("x".repeat(300))).toHaveLength(241);
  });
});

describe("stepToShow", () => {
  const s = (step: string, state: string) => ({ step, state });
  it("opens a build's log on the step that failed, else the one running", () => {
    expect(stepToShow([s("prepare", "failed"), s("build", "waiting"), s("publish", "waiting")])).toBe("prepare");
    expect(stepToShow([s("prepare", "passed"), s("build", "running"), s("publish", "waiting")])).toBe("build");
    expect(stepToShow([s("prepare", "passed"), s("build", "passed"), s("publish", "passed")])).toBe("publish");
  });

  it("is nothing before any step started", () => {
    expect(stepToShow([s("prepare", "waiting")])).toBeNull();
    expect(stepToShow([])).toBeNull();
  });
});

describe("where a Studio build ran, and why one was refused", () => {
  it("reads the record's place and leaves an older record without one", () => {
    const place = placeOf({
      environment_id: "e1",
      environment: "dev",
      namespace: "shop-dev",
      git_ref: "main",
      repository: "acme/shop",
      source_connection: "GitHub (acme)",
      builder_image: "ghcr.io/acme/studio-backend:sha-1",
      gearbox_version: "361e703",
    });
    expect(place?.namespace).toBe("shop-dev");
    expect(placeLines(place!).map((l) => l.label)).toEqual(["where", "code", "cloned through", "builder", "Gearbox"]);
    expect(placeLines(place!)[0].value).toBe("dev · namespace shop-dev");
    expect(placeOf({ repository: "acme/shop", status: "passed" })).toBeUndefined();
  });

  it("names a refusal by its code with what to do, and leaves any other failure to errText", () => {
    const refused = {
      status: 400,
      problem: {
        context: {
          violations: [
            { type: "environment", subject: "REPOSITORY_CONNECTION_PERSONAL", description: "connection 'GitHub (alice)' is personal" },
          ],
        },
      },
    };
    expect(buildRefusalCode(refused)).toBe("REPOSITORY_CONNECTION_PERSONAL");
    const text = buildRefusalText(refused, () => "fallback");
    expect(text).toContain("personal connection");
    expect(text).toContain("GitHub (alice)");
    expect(text).toContain("workspace or organization connection");
    expect(buildRefusalCode({ status: 500 })).toBeNull();
    expect(buildRefusalText({ status: 500 }, () => "fallback")).toBe("fallback");
  });

  it("names the bootstrap manifest when the namespace cannot be made", () => {
    expect(BUILD_REFUSALS.CLUSTER_CANNOT_CREATE_NAMESPACE.next).toContain("deploy/k8s/studio-environments/bootstrap.yaml");
  });
});
