import { describe, expect, it } from "vitest";

import type { DeployEnvironment } from "./api";
import {
  FRONTX_SHELL_TEMPLATE,
  PRODUCT_SECTIONS,
  hasFrontend,
  infrastructureOf,
  openingSection,
  productSummary,
  sectionFromPath,
  withFrontend,
  withoutFrontend,
} from "./product-sections";

describe("the product's parts", () => {
  it("are infrastructure, backend and frontend, in that order", () => {
    expect(PRODUCT_SECTIONS.map((s) => s.id)).toEqual(["parts", "infrastructure", "backend", "frontend"]);
  });
});

describe("a product's frontend", () => {
  it("is optional: a configuration that names none has none", () => {
    expect(hasFrontend(null)).toBe(false);
    expect(hasFrontend({})).toBe(false);
    expect(hasFrontend({ frontend: { mfes: [] } })).toBe(true);
  });

  it("is added from FrontX's shell template, keeping what was picked", () => {
    expect(withFrontend({ kind: "product" })).toEqual({
      kind: "product",
      frontend: { mfes: [], shell: FRONTX_SHELL_TEMPLATE },
    });
    expect(withFrontend({ frontend: { mfes: ["@x/people-mfe"], shell: "github:o/r//s@v1" } }).frontend).toEqual({
      mfes: ["@x/people-mfe"],
      shell: "github:o/r//s@v1",
    });
    expect(FRONTX_SHELL_TEMPLATE).toBe("github:constructorfabric/gears-frontx-templates//template-shell@main");
  });

  it("is removed whole, leaving the rest of the configuration", () => {
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

  it("names the profile, and each environment with its binding and database", () => {
    const infra = infrastructureOf(
      { profile: "prod" },
      {
        environments: [
          { environment: env("e1", "dev", "shared"), namespace: "shop-dev" },
          { environment: env("e2", "prod", "namespace", "postgres:17"), namespace: "shop-prod" },
          { environment: env("e3", "lab", "none"), namespace: "shop-lab" },
        ],
        bindings: [{ profile: "prod", environment_id: "e2" }],
      },
    );
    expect(infra.profileLabel).toBe("prod · Kubernetes");
    expect(infra.runsIn).toEqual([
      { environment: "dev", namespace: "shop-dev", profile: null, database: "the environment's shared Postgres", missing: [] },
      {
        environment: "prod",
        namespace: "shop-prod",
        profile: "prod",
        database: "a Postgres of its own in its namespace (postgres:17)",
        missing: [],
      },
      { environment: "lab", namespace: "shop-lab", profile: null, database: "no database", missing: [] },
    ]);
    expect(infra.needs).toBeNull();
  });

  it("says what the gears need, and the environment that does not give it", () => {
    const postgres = { id: "postgres", name: "PostgreSQL", why: "data", gears: ["cf-gears-file-storage"] };
    const infra = infrastructureOf(
      {
        profile: "prod",
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
      { environments: [{ environment: env("e3", "lab", "none"), namespace: "shop-lab" }], bindings: [] },
    );
    expect(infra.needs).toEqual([postgres]);
    expect(infra.applications).toEqual(["api-gateway"]);
    expect(infra.runsIn[0].missing).toEqual(["PostgreSQL"]);
  });

  it("is nothing yet for a product never composed and never bound", () => {
    expect(infrastructureOf(null, null)).toEqual({ profile: null, profileLabel: null, runsIn: [], needs: null, applications: [] });
  });
});

describe("the Product page's header", () => {
  it("says the product in one line: id, profile, gears, where it was saved, whether it resolved, a frontend", () => {
    const s = productSummary(
      {
        product_id: "studio-web",
        profile: "prod",
        gears: ["a", "b", "c"],
        written: { branch: "product/studio-web-50fdd46f", commit_sha: "abc", pr_url: "https://x/pull/894" },
        last_preview: { profile: "prod", ok: false, errors: 2, warnings: 5, applications: [], gears: [] },
      },
      { frontend: { mfes: [] } },
    );
    expect(s).toEqual({
      id: "studio-web",
      profile: "prod · Kubernetes",
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
      profile: null,
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
