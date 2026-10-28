import { describe, expect, it } from "vitest";

import type { DeployEnvironment } from "./api";
import {
  FRONTX_SHELL_TEMPLATE,
  PRODUCT_SECTIONS,
  hasFrontend,
  infrastructureOf,
  sectionFromPath,
  withFrontend,
  withoutFrontend,
} from "./product-sections";

describe("the product's parts", () => {
  it("are infrastructure, backend and frontend, in that order", () => {
    expect(PRODUCT_SECTIONS.map((s) => s.id)).toEqual(["infrastructure", "backend", "frontend"]);
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
      { environment: "dev", namespace: "shop-dev", profile: null, database: "the environment's shared Postgres" },
      { environment: "prod", namespace: "shop-prod", profile: "prod", database: "a Postgres of its own in its namespace (postgres:17)" },
      { environment: "lab", namespace: "shop-lab", profile: null, database: "no database" },
    ]);
  });

  it("is nothing yet for a product never composed and never bound", () => {
    expect(infrastructureOf(null, null)).toEqual({ profile: null, profileLabel: null, runsIn: [] });
  });
});
