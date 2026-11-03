import { describe, expect, it } from "vitest";

import type { DeployEnvironment } from "./api";
import {
  FRONTX_SHELL_TEMPLATE,
  PRODUCT_SECTIONS,
  comesWith,
  hasFrontend,
  infrastructureOf,
  openingSection,
  productSummary,
  sectionFromPath,
  newFrontend,
  withoutFrontend,
} from "./product-sections";

describe("the product's parts", () => {
  it("are infrastructure, backend and frontend, in that order", () => {
    expect(PRODUCT_SECTIONS.map((s) => s.id)).toEqual(["parts", "infrastructure", "backend", "frontend"]);
  });
});

describe("a product's frontend", () => {
  it("is optional: a product that records none, in a configuration that names none, has none", () => {
    expect(hasFrontend(null)).toBe(false);
    expect(hasFrontend({}, { frontend: null })).toBe(false);
    expect(hasFrontend({}, { frontend: newFrontend() })).toBe(true);
    // A project that picked before the product kept its frontend.
    expect(hasFrontend({ frontend: { mfes: [] } })).toBe(true);
  });

  it("is added from FrontX's shell template, nothing mounted yet", () => {
    expect(newFrontend()).toEqual({
      shell: { repo: "constructorfabric/gears-frontx-templates", path: "template-shell", ref: "main" },
      mfes: [],
    });
    expect(FRONTX_SHELL_TEMPLATE).toBe("github:constructorfabric/gears-frontx-templates//template-shell@main");
  });

  it("recorded in the configuration before is removed whole, leaving the rest", () => {
    expect(withoutFrontend({ kind: "product", frontend: { mfes: ["a"] } })).toEqual({ kind: "product" });
  });

  it("is where the old Frontend tab's address lands", () => {
    expect(sectionFromPath("/workspaces/ws1/projects/p1/frontend")).toBe("frontend");
    expect(sectionFromPath("/workspaces/ws1/projects/p1/components")).toBeNull();
    expect(sectionFromPath("/")).toBeNull();
  });
});

describe("where the product runs", () => {
  const env = (id: string, name: string, database: DeployEnvironment["database"], database_image?: string) =>
    ({ id, name, database, database_image }) as DeployEnvironment;

  const check = { ok: true, errors: 0, warnings: 0, applications: ["api-gateway"], gears: [], gdl_sha256: "now" };

  it("names each environment with the profile it runs, that profile's verdict, and its database", () => {
    const infra = infrastructureOf(
      { checks: { prod: check }, last_preview: { ...check, profile: "prod" } },
      {
        environments: [
          { environment: env("e1", "dev", "shared"), namespace: "shop-dev" },
          { environment: env("e2", "prod", "namespace", "postgres:17"), namespace: "shop-prod" },
          { environment: env("e3", "lab", "none"), namespace: "shop-lab" },
        ],
        bindings: [{ profile: "prod", environment_id: "e2" }],
      },
    );
    expect(infra.profileLabel).toBe("Kubernetes · prod");
    expect(infra.runsIn).toEqual([
      {
        environment: "dev",
        namespace: "shop-dev",
        profile: null,
        profileLabel: null,
        verdict: null,
        needs: null,
        database: "none: a shared Postgres is recorded, and deploys get nothing from it",
        missing: [],
        unchecked: null,
      },
      {
        environment: "prod",
        namespace: "shop-prod",
        profile: "prod",
        profileLabel: "Kubernetes · prod",
        verdict: { state: "ok", errors: 0, check },
        needs: null,
        database: "its own Postgres, with each deploy (postgres:17)",
        missing: [],
        unchecked: null,
      },
      {
        environment: "lab",
        namespace: "shop-lab",
        profile: null,
        profileLabel: null,
        verdict: null,
        needs: null,
        database: "its own Postgres, with each deploy",
        missing: [],
        unchecked: null,
      },
    ]);
    expect(infra.needs).toBeNull();
  });

  it("lets two environments run one profile, and says a profile not checked yet, or checked before a change", () => {
    const infra = infrastructureOf(
      // `local` was checked for an older description; `prod` never.
      { checks: { dev: check, local: { ...check, gdl_sha256: "before" } }, last_preview: { ...check, profile: "dev" } },
      {
        environments: [
          { environment: env("e1", "stage", "none"), namespace: "shop-stage" },
          { environment: env("e2", "prod", "none"), namespace: "shop-prod" },
          { environment: env("e3", "lab", "none"), namespace: "shop-lab" },
        ],
        bindings: [
          { profile: "prod", environment_id: "e1" },
          { profile: "prod", environment_id: "e2" },
          { profile: "local", environment_id: "e3" },
        ],
      },
    );
    expect(infra.runsIn.map((r) => [r.environment, r.profile, r.verdict?.state, r.unchecked])).toEqual([
      ["stage", "prod", "unchecked", "not checked yet for prod"],
      ["prod", "prod", "unchecked", "not checked yet for prod"],
      ["lab", "local", "stale", "not checked yet for local"],
    ]);
  });

  it("reads a record from before checks were kept per profile", () => {
    const old = { profile: "prod", ok: false, errors: 3, warnings: 0, applications: [], gears: [] };
    const infra = infrastructureOf(
      { last_preview: old },
      { environments: [{ environment: env("e2", "prod", "none"), namespace: "shop-prod" }], bindings: [{ profile: "prod", environment_id: "e2" }] },
    );
    expect(infra.runsIn[0].verdict?.state).toBe("failed");
    expect(infra.runsIn[0].unchecked).toBeNull();
  });

  it("says what the gears need; every environment but a shared one brings the product its Postgres", () => {
    const postgres = { id: "postgres", name: "PostgreSQL", why: "data", gears: ["cf-gears-file-storage"] };
    const infra = infrastructureOf(
      {
        last_preview: {
          profile: "prod",
          ok: true,
          errors: 0,
          warnings: 0,
          applications: ["api-gateway"],
          gears: [],
          infrastructure: [postgres],
        },
      },
      {
        environments: [
          { environment: env("e3", "lab", "none"), namespace: "shop-lab" },
          { environment: env("e1", "dev", "shared"), namespace: "shop-dev" },
        ],
        bindings: [],
      },
    );
    expect(infra.needs).toEqual([postgres]);
    expect(infra.applications).toEqual(["api-gateway"]);
    expect(infra.runsIn.map((r) => r.missing)).toEqual([[], ["PostgreSQL"]]);
    expect(comesWith("postgres").deployed).toBe(true);
    expect(comesWith("keycloak").deployed).toBe(false);
  });

  it("says a product that keeps no data needs no database", () => {
    const infra = infrastructureOf(
      {
        last_preview: { profile: "prod", ok: true, errors: 0, warnings: 0, applications: [], gears: [], infrastructure: [] },
      },
      { environments: [{ environment: env("e3", "lab", "none"), namespace: "shop-lab" }], bindings: [] },
    );
    expect(infra.runsIn[0].database).toBe("none needed");
  });

  it("is nothing yet for a product never composed and never bound", () => {
    expect(infrastructureOf(null, null)).toEqual({ profile: null, profileLabel: null, runsIn: [], needs: null, applications: [] });
  });
});

describe("the Product page's header", () => {
  it("says the product in one line: id, gears, where it was saved, whether it resolved, a frontend", () => {
    const s = productSummary(
      {
        product_id: "studio-web",
        gears: ["a", "b", "c"],
        written: { branch: "product/studio-web-50fdd46f", commit_sha: "abc", pr_url: "https://x/pull/894" },
        last_preview: { profile: "prod", ok: false, errors: 2, warnings: 5, applications: [], gears: [] },
      },
      { frontend: { mfes: [] } },
    );
    expect(s).toEqual({
      id: "studio-web",
      gears: 3,
      saved: { branch: "product/studio-web-50fdd46f", prUrl: "https://x/pull/894" },
      revision: null,
      preview: { ok: false, errors: 2, warnings: 5 },
      frontend: true,
    });
  });

  it("says nothing it does not know before the product is composed", () => {
    expect(productSummary(null, null)).toEqual({
      id: null,
      gears: 0,
      saved: null,
      revision: null,
      preview: null,
      frontend: false,
    });
  });
});

describe("the section the Product page opens on", () => {
  it("is an old Frontend address first, then the one last looked at, else Backend", () => {
    expect(openingSection("frontend", "infrastructure")).toBe("frontend");
    expect(openingSection(null, "infrastructure")).toBe("infrastructure");
    expect(openingSection(null, "nonsense")).toBe("backend");
    expect(openingSection(null, null)).toBe("backend");
  });
});
