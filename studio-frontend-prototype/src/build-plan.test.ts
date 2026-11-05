import { describe, expect, it } from "vitest";

import type { BuildPlan } from "./api";
import { planKey, planLines, planRefusalText, sourceConnectionText } from "./build-plan";

const plan = (over: Partial<BuildPlan> = {}): BuildPlan => ({
  environment_id: "e1",
  environment: "dev",
  profile: "dev",
  product_file: "products/web/product.gdl",
  description_revision: 4,
  strictness: "dev",
  namespace: "web-dev",
  build_namespace: "web-build",
  builder_image: `ghcr.io/acme/mirror/builder@sha256:${"0".repeat(64)}`,
  builder_pinned: true,
  gearbox_version: "0.9.1",
  registry_prefix: "ghcr.io/acme",
  image_repositories: ["ghcr.io/acme/web/api"],
  chart_repository: "ghcr.io/acme/web/charts/web",
  sources: [{ id: "product", repository: "acme/web", ref: "main", commit: "abcdef1234", connection_id: "c1", connection_label: "GitHub", connection_scope: "organization" }],
  warnings: [],
  ...over,
});

describe("what a build will do", () => {
  it("says it in lines, in the order the build goes", () => {
    expect(planLines(plan()).map((l) => `${l.label}: ${l.value}`)).toEqual([
      "builds: products/web/product.gdl (revision 4) for profile dev",
      "checked as: a development profile",
      "runs in: dev · namespace web-build",
      `builder: ghcr.io/acme/mirror/builder@sha256:${"0".repeat(64)}`,
      "Gearbox: 0.9.1",
      "code: acme/web at main (abcdef1) · through GitHub (organization)",
      "images: ghcr.io/acme/web/api",
      "chart: ghcr.io/acme/web/charts/web",
      "deploys to: namespace web-dev",
    ]);
  });

  it("marks an unpinned builder and a person's connection", () => {
    const lines = planLines(
      plan({
        builder_pinned: false,
        builder_image: "ghcr.io/acme/builder:latest",
        sources: [{ id: "product", repository: "acme/web", ref: "", connection_label: "mine", connection_scope: "personal", connection_holder: "Ada" }],
      }),
    );
    expect(lines.filter((l) => l.warn).map((l) => l.value)).toEqual([
      "ghcr.io/acme/builder:latest (not pinned by digest)",
      "acme/web at its own branch · through mine, Ada's own",
    ]);
  });

  it("names a public source's lack of a connection", () => {
    expect(sourceConnectionText({ id: "x", repository: "o/r", ref: "main" })).toBe("no connection: the repository is public");
  });
});

describe("a refusal", () => {
  it("is said with what to do when Studio knows it, else as the server said it", () => {
    expect(planRefusalText(null)).toBeNull();
    expect(planRefusalText({ code: "ENVIRONMENT_CLUSTER_UNREACHABLE", message: "dial tcp: timeout" })).toBe(
      "The environment's cluster did not answer. dial tcp: timeout Check the cluster's address and that it is up, then try again.",
    );
    expect(planRefusalText({ code: "SOMETHING_NEW", message: "No." })).toBe("No.");
  });

  it("is asked again only when the request changes", () => {
    expect(planKey({ environment_id: "e1", profile: "dev" })).toBe(planKey({ environment_id: "e1", profile: "dev" }));
    expect(planKey({ environment_id: "e1", ref: "main" })).not.toBe(planKey({ environment_id: "e1" }));
  });
});
