import { describe, expect, it } from "vitest";

import type { Deployment, DeployEnvironment } from "./api";
import type { IdeBuild } from "./builds";
import {
  deployableBuilds,
  expiresIn,
  isSecretKey,
  latestByEnvironment,
  lifetimeLabel,
  livePreviews,
  previewLifetimes,
  previewNameFor,
  parseValues,
  productUrls,
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
  descriptionRevision: null,
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
  url: null,
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

describe("a Constructor Research environment's deploys (ADR-0049)", () => {
  const research = { kind: "research" as const };
  const made = build({ buildId: "research-1", where: "research", chartRef: null, chartVersion: null });
  const charted = build({});

  it("take only builds made in Research, and a cluster only charted ones", () => {
    expect(deployableBuilds([made, charted], research).map((b) => b.buildId)).toEqual(["research-1"]);
    expect(deployableBuilds([made, charted], { kind: "kubernetes" }).map((b) => b.buildId)).toEqual(["ci-run-1"]);
    expect(deployableBuilds([made, charted])).toHaveLength(2);
    expect(deployableBuilds([{ ...made, status: "failed" }], research)).toEqual([]);
  });

  it("roll back to another build, since Research keeps no chart", () => {
    const at = (id: string, b: string) => ({ ...dep(id, "ml", "succeeded"), build: b });
    expect(rollbackTarget([at("3", "research-2"), at("2", "research-2"), at("1", "research-1")], "ml")?.id).toBe("1");
    expect(rollbackTarget([at("2", "research-2"), at("1", "research-2")], "ml")).toBeNull();
  });

  it("open the product where the deploy says it runs", () => {
    expect(productUrls("shop-ml runs in Constructor Research (revision r3): https://shop.research.example, https://b.example")).toEqual([
      "https://shop.research.example",
      "https://b.example",
    ]);
    expect(productUrls("studio-web installed into studio-web-dev")).toEqual([]);
    expect(productUrls(null)).toEqual([]);
  });
});

describe("a project's previews (ADR-0055)", () => {
  const preview = (id: string, name: string, removed_at: string | null = null): Deployment => ({
    ...dep(id, "dev", "succeeded"),
    namespace: `studio-web-dev-pv-${name}`,
    preview: { name, expires_at: "2026-10-31T10:00:00Z", host: null, removed_at },
  });

  it("are not what runs in the environment, nor what a rollback or a promotion counts", () => {
    const history = [preview("3", "pr-1"), dep("2", "dev", "succeeded"), dep("1", "dev", "succeeded")];
    expect(latestByEnvironment(history).get("dev")?.id).toBe("2");
    expect(rollbackTarget([preview("9", "pr-1"), ...history], "dev")?.id).not.toBe("9");
    const prod = { id: "prod", promote_from: "dev" } as DeployEnvironment;
    const built = { buildId: "b1" } as IdeBuild;
    const tried = { ...preview("4", "pr-2"), build: "b1" };
    expect(promotionGap(prod, built, [tried], (id) => id)).toMatch(/deploy it there first/);
  });

  it("list the ones not removed, in one environment", () => {
    const list = [preview("3", "pr-1"), preview("2", "pr-0", "2026-10-30T10:00:00Z"), dep("1", "dev", "succeeded")];
    expect(livePreviews(list, "dev").map((d) => d.id)).toEqual(["3"]);
    expect(livePreviews(list, "prod")).toEqual([]);
  });

  it("are named after the build, as a namespace takes it", () => {
    expect(previewNameFor({ chartVersion: "0.1.0-sha.3f2a9c1", buildId: "b" })).toBe("0-1-0-sha-3f2a9c1");
    expect(previewNameFor({ chartVersion: null, buildId: "ci-run-18234567890" })).toBe("ci-run-18234567890");
    expect(previewNameFor({ chartVersion: "0.1.0-sha.3f2a9c1deadbeef0123", buildId: "b" })).toBe("3f2a9c1deadbeef0123");
    expect(previewNameFor({ chartVersion: null, buildId: "" })).toBe("preview");
  });

  it("say how long they have", () => {
    const now = Date.parse("2026-10-30T10:00:00Z");
    expect(expiresIn("2026-11-02T10:00:00Z", now)).toBe("expires in 3 d");
    expect(expiresIn("2026-10-30T15:00:00Z", now)).toBe("expires in 5 h");
    expect(expiresIn("2026-10-30T10:20:00Z", now)).toBe("expires in 20 min");
    expect(expiresIn("2026-10-30T09:00:00Z", now)).toBe("expiring");
  });
});

describe("a preview's lifetime", () => {
  it("offers the usual steps up to the environment's most, and the most itself", () => {
    expect(previewLifetimes(72)).toEqual([4, 24, 72]);
    expect(previewLifetimes(48)).toEqual([4, 24, 48]);
    expect(previewLifetimes(2)).toEqual([2]);
    expect(previewLifetimes(336)).toEqual([4, 24, 72, 168, 336]);
  });

  it("reads in days once it is whole days past two", () => {
    expect(lifetimeLabel(4)).toBe("4 h");
    expect(lifetimeLabel(24)).toBe("24 h");
    expect(lifetimeLabel(72)).toBe("3 d");
    expect(lifetimeLabel(50)).toBe("50 h");
  });
});
