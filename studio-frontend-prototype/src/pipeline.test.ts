import { describe, expect, it } from "vitest";

import type { Deployment } from "./api";
import { anyRunning, buildStages, isLost, openingScenario, stageOf, type IdeBuild } from "./builds";
import { buildsHint, deploysHint } from "./pipeline";

const build = (over: Partial<IdeBuild>): IdeBuild => ({
  id: "n",
  buildId: "studio-1",
  where: "studio",
  action: "build",
  status: "passed",
  product: "shop",
  profile: "prod",
  commit: null,
  shortSha: null,
  branch: null,
  by: null,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  failure: null,
  failureStep: null,
  outputs: [],
  chartRef: "oci://ghcr.io/acme/charts/shop",
  chartVersion: "0.1.0-sha.1",
  images: [],
  step: null,
  ...over,
});

const deployment = (over: Partial<Deployment>): Deployment =>
  ({
    id: "d",
    project_id: "p",
    project_name: "shop",
    environment_id: "e",
    environment_name: "dev",
    profile: "prod",
    product: "shop",
    images: [],
    namespace: "shop-dev",
    chart_sha256: "",
    state: "succeeded",
    requested_by: "u",
    requested_by_name: "U",
    requested_at: "2026-10-28T10:00:00Z",
    ...over,
  }) as Deployment;

describe("a build's stages", () => {
  it("names the Job's containers and an IDE's steps as stages", () => {
    expect(stageOf("prepare")).toBe("prepare");
    expect(stageOf("build")).toBe("images");
    expect(stageOf("protoc")).toBe("images");
    expect(stageOf("publish")).toBe("publish");
    expect(stageOf(null)).toBeNull();
  });

  it("has a passed build done with all three", () => {
    expect(buildStages(build({}))).toEqual({ prepare: "done", images: "done", publish: "done" });
  });

  it("has a failed build done before the stage it failed in, and waiting after", () => {
    expect(buildStages(build({ status: "failed", failureStep: "build" }))).toEqual({
      prepare: "done",
      images: "failed",
      publish: "waiting",
    });
    expect(buildStages(build({ status: "failed", failureStep: "prepare" })).prepare).toBe("failed");
  });

  it("has a running build in the step it reports, or the first when it reports none", () => {
    expect(buildStages(build({ status: "running", step: "publish" }))).toEqual({
      prepare: "done",
      images: "done",
      publish: "running",
    });
    expect(buildStages(build({ status: "running" }))).toEqual({ prepare: "running", images: "waiting", publish: "waiting" });
  });
});

describe("where the Builds tab stands", () => {
  it("says how to build when nothing is built", () => {
    expect(buildsHint([], true).text).toMatch(/Build in Studio/);
    expect(buildsHint([], false).text).toMatch(/registry connection/);
  });

  it("sends a published build on to Deploys", () => {
    expect(buildsHint([build({})], true)).toMatchObject({ tone: "done", go: "deploys" });
  });

  it("says what failed, and that a rebuild comes next", () => {
    const hint = buildsHint([build({ status: "failed", failureStep: "prepare", failure: "error [GBX0511] no plugin\nmore" })], true);
    expect(hint.tone).toBe("failed");
    expect(hint.text).toBe("The last build failed while preparing: error [GBX0511] no plugin. Fix it and build again.");
  });

  it("follows a running build, and skips runs", () => {
    const hint = buildsHint([build({ action: "run", status: "failed" }), build({ status: "running", step: "build" })], true);
    expect(hint.text).toBe("Build studio-1 is building the images; this page follows it.");
  });

  it("calls a Studio build lost once its Job's hour is long past, and says to build again", () => {
    const now = Date.parse("2026-10-28T16:00:00Z");
    const stuck = build({ status: "running", step: "prepare", startedAt: "2026-10-28T14:00:00Z" });
    const hint = buildsHint([stuck], true, now);
    expect(hint.tone).toBe("failed");
    expect(hint.text).toMatch(/^Build studio-1 is lost: no word from its Job since .+\. Build again\.$/);
  });

  it("does not send a build without a chart to Deploys", () => {
    expect(buildsHint([build({ chartRef: null, chartVersion: null })], true).go).toBeUndefined();
  });
});

describe("where the Deploys tab stands", () => {
  const ready = { environments: 1, bound: 1, deployable: 1, deployments: [] };

  it("asks for an environment, then a binding, then a build", () => {
    expect(deploysHint({ ...ready, environments: 0 }).text).toMatch(/Organization › Environments/);
    expect(deploysHint({ ...ready, bound: 0 }).text).toMatch(/Bind/);
    expect(deploysHint({ ...ready, deployable: 0 })).toMatchObject({ go: "builds" });
    expect(deploysHint(ready).text).toMatch(/Deploy a build/);
  });

  it("says where the newest deploy runs, or why it failed", () => {
    const older = deployment({ requested_at: "2026-10-27T10:00:00Z", state: "failed" });
    const newer = deployment({ chart_version: "0.1.0-sha.2" });
    expect(deploysHint({ ...ready, deployments: [older, newer] })).toEqual({
      text: "Runs in dev (shop-dev): 0.1.0-sha.2.",
      tone: "done",
    });
    expect(deploysHint({ ...ready, deployments: [deployment({ state: "failed", reason: "helm timed out" })] }).text).toBe(
      "The last deploy to dev (shop-dev) failed: helm timed out.",
    );
    expect(deploysHint({ ...ready, deployments: [deployment({ state: "running" })] }).text).toBe("Deploying: dev (shop-dev).");
  });
});

describe("a lost build", () => {
  const now = Date.parse("2026-10-28T16:00:00Z");

  it("is a Studio build running past its Job's deadline", () => {
    expect(isLost(build({ status: "running", startedAt: "2026-10-28T14:00:00Z" }), now)).toBe(true);
    expect(isLost(build({ status: "running", startedAt: "2026-10-28T15:30:00Z" }), now)).toBe(false);
    // The desktop says when its build ends; an hour is nothing to it.
    expect(isLost(build({ where: "desktop", status: "running", startedAt: "2026-10-28T14:00:00Z" }), now)).toBe(false);
    expect(isLost(build({ status: "failed", startedAt: "2026-10-28T14:00:00Z" }), now)).toBe(false);
    expect(isLost(build({ status: "running", startedAt: null }), now)).toBe(false);
  });

  it("is not followed: only a build really running keeps the page refreshing", () => {
    const lost = build({ status: "running", startedAt: "2026-10-28T14:00:00Z" });
    expect(anyRunning([lost], now)).toBe(false);
    expect(anyRunning([lost, build({ status: "running", startedAt: "2026-10-28T15:55:00Z" })], now)).toBe(true);
  });
});

describe("the scenario the Builds tab opens on", () => {
  it("is the one chosen before, else Studio when it can build, else the desktop", () => {
    expect(openingScenario("ci", true)).toBe("ci");
    expect(openingScenario(null, true)).toBe("studio");
    expect(openingScenario(null, false)).toBe("desktop");
    expect(openingScenario("nonsense", true)).toBe("studio");
  });
});
