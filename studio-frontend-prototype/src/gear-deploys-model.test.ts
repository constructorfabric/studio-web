import { describe, expect, it } from "vitest";

import type { Deployment } from "./api";
import { gearDeployState, productionLike, runningNow, versionOf } from "./gear-deploys-model";

function deploy(id: string, over: Partial<Deployment> = {}): Deployment {
  return {
    id,
    project_id: "p1",
    project_name: "Insight",
    environment_id: "stage",
    environment_name: "stage",
    profile: "k8s",
    product: "insight",
    commit: "abcdef1234567890",
    lock_hash: null,
    images: [],
    namespace: "insight-stage",
    chart_sha256: "",
    state: "succeeded",
    requested_by: "u1",
    requested_by_name: "Ann",
    requested_at: "2026-10-10T09:00:00Z",
    ...over,
  };
}

const ENVS = [
  { id: "stage", name: "stage", protected: false },
  { id: "prod", name: "prod", protected: true },
];

describe("what runs where", () => {
  it("keeps the latest successful deploy per environment, past later failures", () => {
    const running = runningNow(
      [
        deploy("d3", { state: "failed", requested_at: "2026-10-12T09:00:00Z", commit: "bad" }),
        deploy("d2", { requested_at: "2026-10-11T09:00:00Z", commit: "222" }),
        deploy("d1", { requested_at: "2026-10-10T09:00:00Z", commit: "111" }),
        deploy("d4", { environment_id: "prod", environment_name: "prod", state: "awaiting_approval" }),
      ],
      ENVS,
    );
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ environment: "stage", commit: "222", productionLike: false });
  });

  it("leaves out a preview beside the environment and a release taken out", () => {
    const running = runningNow(
      [
        deploy("p", { requested_at: "2026-10-12T09:00:00Z", commit: "pre", preview: { name: "pr-1" } as Deployment["preview"] }),
        deploy("d1", { requested_at: "2026-10-10T09:00:00Z", commit: "111" }),
        deploy("u", { environment_id: "prod", environment_name: "prod", action: "uninstall", requested_at: "2026-10-12T09:00:00Z" }),
        deploy("d0", { environment_id: "prod", environment_name: "prod", requested_at: "2026-10-09T09:00:00Z" }),
      ],
      ENVS,
    );
    expect(running.map((r) => r.commit)).toEqual(["111"]);
  });

  it("dates a run by its decision when there was one", () => {
    const [r] = runningNow(
      [deploy("d1", { environment_id: "prod", environment_name: "prod", decided_at: "2026-10-11T08:00:00Z" })],
      ENVS,
    );
    expect(r).toMatchObject({ since: "2026-10-11T08:00:00Z", productionLike: true });
  });

  it("calls protected or production-named environments production-like", () => {
    expect(productionLike({ name: "customers", protected: true })).toBe(true);
    expect(productionLike({ name: "eu-prod" })).toBe(true);
    expect(productionLike({ name: "Production" })).toBe(true);
    expect(productionLike({ name: "stage" })).toBe(false);
    expect(productionLike({ name: "product-demo" })).toBe(false);
  });

  it("reads a version from a versioned pick", () => {
    expect(versionOf("analytics@0.1.0")).toBe("0.1.0");
    expect(versionOf("cf-gears-api-gateway")).toBeNull();
  });
});

describe("a gear's deploy state", () => {
  const running = runningNow([deploy("d1"), deploy("d2", { environment_id: "prod", environment_name: "prod" })], ENVS);

  it("says nothing when the deployments could not be read", () => {
    expect(gearDeployState({ name: "x", maturity: "stable" }, null)).toBeNull();
  });

  it("says not deployed, and that a stable gear has never run", () => {
    const s = gearDeployState({ name: "x", maturity: "stable" }, []);
    expect(s?.line).toBe("not deployed");
    expect(s?.hint).toMatch(/^Stable, but not deployed anywhere/);
  });

  it("names each environment, since when and at which commit or version", () => {
    expect(gearDeployState({ name: "x" }, running)?.line).toBe(
      "running in prod since 2026-10-10 (abcdef12); stage since 2026-10-10 (abcdef12)",
    );
    expect(gearDeployState({ name: "analytics@0.1.0" }, running.slice(1))?.line).toBe(
      "running in stage since 2026-10-10 (0.1.0)",
    );
  });

  it("flags an experimental gear in a production-like environment", () => {
    const s = gearDeployState({ name: "x", maturity: "experimental" }, running);
    expect(s?.hint).toBe("Experimental, but running in prod: an experimental gear must not ship as stable.");
    expect(gearDeployState({ name: "x", maturity: "experimental" }, running.slice(1))?.hint).toBeNull();
    expect(gearDeployState({ name: "x", maturity: "stable" }, running)?.hint).toBeNull();
  });

  it("marks a deploy from before the product last changed as earlier", () => {
    const later = { commit: "fff000", updatedAt: "2026-10-15T00:00:00Z" };
    const s = gearDeployState({ name: "x", maturity: "experimental" }, running, later);
    expect(s?.runs.every((r) => r.as === "earlier")).toBe(true);
    expect(s?.line).toContain("from an earlier product");
    expect(s?.hint).toMatch(/possibly running in prod/);
    // The same commit as product.gdl's: the current product, whatever the dates.
    const same = gearDeployState({ name: "x" }, running, { commit: "abcdef12", updatedAt: "2026-10-15T00:00:00Z" });
    expect(same?.runs.every((r) => r.as === "current")).toBe(true);
  });
});
