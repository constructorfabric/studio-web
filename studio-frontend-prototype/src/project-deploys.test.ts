import { describe, expect, it } from "vitest";

import type { Deployment, DeployEnvironment } from "./api";
import type { IdeBuild } from "./builds";
import {
  deployableBuilds,
  isSecretKey,
  latestByEnvironment,
  parseValues,
  profilesBoundTo,
  promotionGap,
  rollbackTarget,
  runsNow,
  valuesText,
} from "./project-deploys";

const dep = (id: string, environment_id: string, state: Deployment["state"]): Deployment => ({
  id,
  project_id: "p1",
  project_name: "Studio Web",
  environment_id,
  environment_name: environment_id,
  profile: "k8s",
  product: "studio-web",
  images: [],
  namespace: `studio-web-${environment_id}`,
  chart_sha256: "",
  state,
  requested_by: "u",
  requested_by_name: "U",
  requested_at: "2026-10-16T10:00:00Z",
});

describe("a project's deploys", () => {
  it("keep the newest deployment in each environment, whatever its state", () => {
    const m = latestByEnvironment([dep("3", "dev", "failed"), dep("2", "dev", "succeeded"), dep("1", "test", "awaiting_approval")]);
    expect(m.get("dev")?.id).toBe("3");
    expect(m.get("test")?.id).toBe("1");
    expect(m.get("prod")).toBeUndefined();
  });

  it("say which profiles go to an environment", () => {
    const b = [
      { profile: "k8s", environment_id: "dev" },
      { profile: "k8s-ha", environment_id: "prod" },
    ];
    expect(profilesBoundTo(b, "dev")).toEqual(["k8s"]);
    expect(profilesBoundTo(b, "test")).toEqual([]);
  });
});

const build = (over: Partial<IdeBuild>): IdeBuild => ({
  id: "n",
  buildId: "ci-run-1",
  where: "ci",
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

describe("deploying a build (ADR-0048)", () => {
  it("offers the passed builds that published a chart", () => {
    const list = deployableBuilds([build({}), build({ status: "failed" }), build({ chartRef: null })]);
    expect(list).toHaveLength(1);
  });

  it("rolls back to the newest succeeded install before the latest, with a published chart", () => {
    const at = (id: string, version: string | null, state: Deployment["state"] = "succeeded"): Deployment => ({
      ...dep(id, "prod", state),
      chart_ref: version ? "oci://r/shop" : null,
      chart_version: version,
    });
    expect(rollbackTarget([at("3", "3"), at("2", null), at("1", "1")], "prod")?.id).toBe("1");
    expect(rollbackTarget([at("3", "3"), at("2", "3")], "prod")).toBeNull();
    expect(rollbackTarget([at("4", "4", "failed"), at("3", "3")], "prod")).toBeNull();
    expect(rollbackTarget([], "prod")).toBeNull();
  });

  it("uninstalls only what runs now", () => {
    expect(runsNow(dep("1", "prod", "succeeded"))).toBe(true);
    expect(runsNow({ ...dep("1", "prod", "succeeded"), action: "uninstall" })).toBe(false);
    expect(runsNow(dep("1", "prod", "failed"))).toBe(false);
    expect(runsNow(undefined)).toBe(false);
  });

  it("holds a build back from an environment until it ran where that one takes from", () => {
    const prod = { id: "prod", name: "prod", promote_from: "stage" } as DeployEnvironment;
    const name = (id: string) => id;
    expect(promotionGap(prod, build({}), [], name)).toMatch(/stage/);
    const ran = { ...dep("1", "stage", "succeeded"), build: "ci-run-1" };
    expect(promotionGap(prod, build({}), [ran], name)).toBeNull();
    expect(promotionGap({ ...prod, promote_from: null }, build({}), [], name)).toBeNull();
  });
});

describe("an environment's configuration", () => {
  it("edits chart values as a JSON object", () => {
    expect(parseValues("").values).toBeNull();
    expect(parseValues('{"a": {"b": 1}}').values).toEqual({ a: { b: 1 } });
    expect(parseValues("[1]").error).toMatch(/object/);
    expect(parseValues("{").error).toMatch(/Not JSON/);
    expect(valuesText({ a: 1 })).toContain('"a": 1');
    expect(valuesText(null)).toBe("");
  });

  it("names a secret like an environment variable", () => {
    expect(isSecretKey("SMTP_PASSWORD")).toBe(true);
    expect(isSecretKey("smtp")).toBe(false);
    expect(isSecretKey("1A")).toBe(false);
  });
});
