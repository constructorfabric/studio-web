import { describe, expect, it } from "vitest";

import type { Deployment, DeployEnvironment } from "./api";
import type { IdeBuild } from "./builds";
import { databaseWord, ladderOrder, ladderSteps, newestRelease, releaseStatus, stepStatus, versionOf, whatRunsWhere } from "./releases";

const env = (id: string, over: Partial<DeployEnvironment> = {}): DeployEnvironment => ({
  id,
  name: id,
  description: "",
  connection_id: "k8s",
  registry: "ghcr.io/acme",
  namespace_pattern: "{project}-{environment}",
  database: "namespace",
  protected: false,
  updated_by: "u",
  updated_at: "2026-11-01T10:00:00Z",
  ...over,
});

const target = (e: DeployEnvironment) => ({ environment: e, namespace: `web-${e.name}` });

let at = 0;
const dep = (environment_id: string, build: string, state: Deployment["state"], over: Partial<Deployment> = {}): Deployment => ({
  id: `d${++at}`,
  project_id: "p1",
  project_name: "Web",
  environment_id,
  environment_name: environment_id,
  profile: "k8s",
  product: "web",
  build,
  chart_version: build.replace("b-", ""),
  images: [],
  namespace: `web-${environment_id}`,
  chart_sha256: "",
  state,
  requested_by: "u",
  requested_by_name: "U",
  // Each one newer than the one before.
  requested_at: new Date(Date.UTC(2026, 10, 1, 10, at)).toISOString(),
  ...over,
});

const build = (buildId: string, over: Partial<IdeBuild> = {}): IdeBuild => ({
  id: buildId,
  buildId,
  where: "studio",
  action: "build",
  status: "passed",
  product: "web",
  profile: "k8s",
  commit: null,
  shortSha: null,
  descriptionRevision: null,
  branch: null,
  by: null,
  startedAt: "2026-11-01T09:00:00Z",
  finishedAt: "2026-11-01T09:10:00Z",
  durationMs: null,
  failure: null,
  failureStep: null,
  outputs: [],
  chartRef: "oci://ghcr.io/acme/web",
  chartVersion: buildId.replace("b-", ""),
  images: [],
  step: null,
  url: null,
  ...over,
});

const dev = env("dev");
const stage = env("stage", { promote_from: "dev" });
const prod = env("prod", { promote_from: "stage", protected: true });

describe("the ladder's order", () => {
  it("puts each environment right after the one it takes from", () => {
    expect(ladderOrder([prod, stage, dev]).map((e) => e.id)).toEqual(["dev", "stage", "prod"]);
  });

  it("keeps a chain together, and environments that take from nobody in the order given", () => {
    const sandbox = env("sandbox");
    const qa = env("qa", { promote_from: "sandbox" });
    expect(ladderOrder([sandbox, prod, dev, qa, stage]).map((e) => e.id)).toEqual(["sandbox", "qa", "dev", "stage", "prod"]);
  });

  it("starts a chain at an environment whose source it cannot see", () => {
    expect(ladderOrder([env("stage", { promote_from: "gone" }), prod]).map((e) => e.id)).toEqual(["stage", "prod"]);
  });

  it("keeps environments in a loop, at the end", () => {
    const a = env("a", { promote_from: "b" });
    const b = env("b", { promote_from: "a" });
    expect(ladderOrder([a, dev, b]).map((e) => e.id)).toEqual(["dev", "a", "b"]);
  });
});

describe("a step of the ladder", () => {
  const targets = [prod, stage, dev].map(target);

  it("says what runs where and promotes what the environment before runs", () => {
    const deployments = [
      dep("dev", "b-0.3.0", "succeeded"),
      dep("stage", "b-0.3.0", "succeeded"),
      dep("dev", "b-0.3.1", "succeeded"),
    ];
    const steps = ladderSteps(targets, deployments, [build("b-0.3.1"), build("b-0.3.0")]);
    expect(steps.map((s) => s.environment.id)).toEqual(["dev", "stage", "prod"]);
    expect(steps.map((s) => s.state)).toEqual(["runs", "runs", "empty"]);
    expect(steps.map((s) => (s.runs ? versionOf(s.runs) : null))).toEqual(["0.3.1", "0.3.0", null]);
    expect(steps[0].promote).toBeNull();
    expect(steps[1].promote?.buildId).toBe("b-0.3.1");
    expect(steps[1].from).toBe("dev");
    expect(steps[2].promote?.buildId).toBe("b-0.3.0");
  });

  it("waits for approval in a protected environment, and does not offer the same promotion again", () => {
    const deployments = [dep("stage", "b-0.3.0", "succeeded"), dep("prod", "b-0.3.0", "awaiting_approval")];
    const [, , p] = ladderSteps(targets, deployments, [build("b-0.3.0")]);
    expect(p.state).toBe("waiting");
    expect(p.waiting?.build).toBe("b-0.3.0");
    expect(p.promote).toBeNull();
    expect(stepStatus(p)).toEqual({ text: "waiting for approval: 0.3.0; runs nothing yet", tone: "warn" });
  });

  it("does not take a waiting deploy for waiting where nobody approves", () => {
    const [d] = ladderSteps([target(dev)], [dep("dev", "b-0.3.0", "awaiting_approval")], []);
    expect(d.waiting).toBeNull();
    expect(d.state).toBe("deploying");
  });

  it("keeps what runs when a later deploy failed, and nothing after an uninstall", () => {
    const failed = ladderSteps(
      [target(dev)],
      [dep("dev", "b-0.3.0", "succeeded"), dep("dev", "b-0.3.1", "failed")],
      [],
    )[0];
    expect(failed.state).toBe("failed");
    expect(failed.runs?.build).toBe("b-0.3.0");
    expect(stepStatus(failed)).toEqual({ text: "the last deploy failed; runs 0.3.0", tone: "bad" });

    const removed = ladderSteps(
      [target(dev)],
      [dep("dev", "b-0.3.0", "succeeded"), dep("dev", "b-0.3.0", "succeeded", { action: "uninstall" })],
      [],
    )[0];
    expect(removed.state).toBe("removed");
    expect(removed.runs).toBeNull();
  });

  it("leaves previews out: they run beside the environment", () => {
    const [d] = ladderSteps([target(dev)], [dep("dev", "b-0.3.0", "succeeded", { preview: { name: "x" } as Deployment["preview"] })], []);
    expect(d.state).toBe("empty");
  });

  it("promotes only a build the environment can take", () => {
    const research = env("research", { kind: "research", promote_from: "dev" });
    const [, r] = ladderSteps([target(dev), target(research)], [dep("dev", "b-0.3.0", "succeeded")], [build("b-0.3.0")]);
    expect(r.promote).toBeNull();
    expect(r.deployable).toEqual([]);
  });

  it("starts from the newest published build", () => {
    const steps = ladderSteps(
      [target(dev)],
      [],
      [build("b-0.3.0"), build("b-0.3.1", { finishedAt: "2026-11-02T09:00:00Z" }), build("b-0.4.0", { status: "failed" })],
    );
    expect(newestRelease(steps)?.buildId).toBe("b-0.3.1");
  });
});

describe("the Releases header's status", () => {
  const targets = [dev, stage, prod].map(target);

  it("says nothing is published when there is no build", () => {
    expect(releaseStatus(ladderSteps(targets, [], []), 0)).toEqual([{ text: "nothing published yet", tone: "neutral" }]);
  });

  it("says a build is ready while nothing is deployed", () => {
    expect(releaseStatus(ladderSteps(targets, [], [build("b-0.3.0")]), 1)).toEqual([
      { text: "1 build ready · nothing deployed yet", tone: "info" },
    ]);
  });

  it("names what runs where, and what waits or failed", () => {
    const deployments = [
      dep("dev", "b-0.3.1", "succeeded"),
      dep("stage", "b-0.3.0", "succeeded"),
      dep("stage", "b-0.3.1", "failed"),
      dep("prod", "b-0.3.0", "awaiting_approval"),
    ];
    expect(releaseStatus(ladderSteps(targets, deployments, [build("b-0.3.1")]), 1)).toEqual([
      { text: "0.3.1 runs in dev", tone: "ok" },
      { text: "0.3.0 runs in stage", tone: "ok" },
      { text: "the last deploy to stage failed", tone: "danger" },
      { text: "0.3.0 waits for approval in prod", tone: "warn" },
    ]);
  });
});

describe("what runs where in the organization", () => {
  it("rows the projects by name, each with what runs in each environment and its newest deploy", () => {
    const rows = whatRunsWhere([
      dep("dev", "b-0.3.0", "succeeded"),
      dep("dev", "b-0.1.0", "succeeded", { project_id: "p2", project_name: "Analytics" }),
      dep("dev", "b-0.3.1", "failed"),
      dep("prod", "b-0.2.0", "awaiting_approval"),
      dep("stage", "b-0.3.0", "succeeded", { preview: { name: "x" } as Deployment["preview"] }),
    ]);
    expect(rows.map((r) => r.projectName)).toEqual(["Analytics", "Web"]);
    const web = rows[1].cells;
    expect(web.get("dev")?.runs?.build).toBe("b-0.3.0");
    expect(web.get("dev")?.latest.state).toBe("failed");
    expect(web.get("prod")?.runs).toBeNull();
    expect(web.get("prod")?.latest.state).toBe("awaiting_approval");
    expect(web.has("stage")).toBe(false);
  });

  it("says how an environment gives the database", () => {
    expect(databaseWord({ database: "shared" })).toBe("a shared Postgres");
    expect(databaseWord({ database: "none" })).toBe("its own, in the namespace");
    expect(databaseWord({ database: "none", kind: "research" })).toBe("its own, in the application");
  });
});
