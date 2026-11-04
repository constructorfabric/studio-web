import { describe, expect, it } from "vitest";
import type { CatalogNode, InfraPlan } from "./api";
import {
  bindNeeds,
  deployable,
  importedFrom,
  offeredInfra,
  parseShared,
  passportOf,
  placementText,
  planItemText,
  planRefusals,
  providedVariables,
  serviceFrom,
  sharedAllowed,
  sharedText,
  sourceText,
  variableOf,
} from "./infra-services";

const keycloakNode = {
  type_id: "gts.cf.studio.catalog.service.v1~",
  instance_id: "k",
  value: {
    name: "keycloak",
    kind: "service",
    service_kind: "infra",
    version: "26.0.7",
    image: "quay.io/keycloak/keycloak:26.0.7",
    ports: { http: 8080, management: 9000 },
    health: "/health/ready",
    infra: {
      args: ["start-dev"],
      config: { KC_HEALTH_ENABLED: "true" },
      secrets: ["KC_BOOTSTRAP_ADMIN_PASSWORD"],
      provides: { "oidc.issuer": "{public_url}/realms/product" },
      stateful: false,
      chart: "oci://registry-1.docker.io/bitnamicharts/keycloak",
      chart_version: "24.4.0",
    },
  },
} as unknown as CatalogNode;

const postgresNode = {
  type_id: "gts.cf.studio.catalog.service.v1~",
  instance_id: "p",
  value: {
    name: "postgresql",
    kind: "service",
    service_kind: "infra",
    image: "pgvector/pgvector:pg18",
    ports: { postgres: 5432 },
    infra: { provides: { postgres: "{host}:{port.postgres}" }, stateful: true, data_path: "/var/lib/postgresql/data" },
  },
} as unknown as CatalogNode;

const ownNode = {
  type_id: "gts.cf.studio.catalog.service.v1~",
  instance_id: "o",
  value: { name: "studio-keycloak", kind: "service", service_kind: "own" },
} as unknown as CatalogNode;

describe("infra services", () => {
  it("reads only infra passports from the catalogue", () => {
    expect(passportOf(ownNode)).toBeNull();
    const p = passportOf(keycloakNode)!;
    expect(p.provides["oidc.issuer"]).toBe("{public_url}/realms/product");
    expect(p.secrets).toEqual(["KC_BOOTSTRAP_ADMIN_PASSWORD"]);
    expect(offeredInfra([postgresNode, ownNode, keycloakNode]).map((x) => x.name)).toEqual(["keycloak", "postgresql"]);
  });

  it("binds each need to the service that provides its capability", () => {
    const offered = offeredInfra([keycloakNode, postgresNode]);
    const pg = serviceFrom(offered[1]);
    const bound = bindNeeds(
      [
        { id: "postgres", name: "PostgreSQL", why: "", gears: ["a"] },
        { id: "oidc", name: "OIDC", why: "", gears: ["oidc-authn-plugin"] },
        { id: "clickhouse", name: "ClickHouse", why: "", gears: ["c"] },
      ],
      [pg],
      offered,
    );
    expect(bound[0].service?.passport.name).toBe("postgresql");
    expect(bound[1].service).toBeNull();
    expect(bound[1].offer?.name).toBe("keycloak");
    expect(bound[2].offer).toBeNull();
    expect(bound[2].capability).toBe("clickhouse.url");
  });

  it("says how a service comes and whether it can be deployed", () => {
    const s = serviceFrom(passportOf(keycloakNode)!);
    expect(deployable(s)).toBe(false);
    expect(sourceText(s)).toContain("not imported");
    const imported = { ...s, image: "ghcr.io/acme/shop/mirror/keycloak@sha256:abc" };
    expect(deployable(imported)).toBe(true);
    expect(sourceText(imported)).toContain("generated");
    expect(sourceText({ ...s, chart_ref: "oci://ghcr.io/acme/shop/mirror/charts/keycloak", chart_version: "24.4.0" })).toBe(
      "ready chart oci://ghcr.io/acme/shop/mirror/charts/keycloak:24.4.0",
    );
    expect(providedVariables([s])).toEqual(["OIDC_ISSUER"]);
    expect(variableOf("database.url")).toBe("DATABASE_URL");
  });

  it("places infra with the product in dev, and lets prod choose", () => {
    expect(sharedAllowed({ protected: false })).toBe(false);
    expect(sharedAllowed({ protected: true })).toBe(true);
    expect(sharedAllowed({ protected: true, strictness: "dev" })).toBe(false);
    expect(placementText(null)).toContain("with the product");
    expect(placementText({ placement: "shared", shared: [{ service: "keycloak", provides: {} }] })).toContain("keycloak");
  });

  it("reads a plan as lines and refusals", () => {
    const plan: InfraPlan = {
      environment_id: "e",
      environment_name: "dev",
      placement: "with_product",
      namespace: "shop-dev",
      items: [
        {
          service: "keycloak",
          placement: "with_product",
          install: "generated",
          image: "ghcr.io/acme/shop/mirror/keycloak@sha256:abc",
          provides: [{ capability: "oidc.issuer", variable: "OIDC_ISSUER" }],
        },
        {
          service: "postgresql",
          placement: "with_product",
          install: "database",
          provides: [],
          refusal_code: "INFRA_IMAGE_NOT_IMPORTED",
          refusal: "import it first",
        },
      ],
    };
    expect(planItemText(plan.items[0])).toBe(
      "keycloak: installed from a chart generated from its passport (ghcr.io/acme/shop/mirror/keycloak@sha256:abc)",
    );
    expect(planRefusals(plan)).toEqual(["INFRA_IMAGE_NOT_IMPORTED: import it first"]);
    expect(planRefusals(null)).toEqual([]);
  });
});

describe("shared places and imports", () => {
  it("writes and reads the shared places", () => {
    const list = [{ service: "keycloak", namespace: "identity", provides: { "oidc.issuer": "https://id.acme.example/realms/shop" } }];
    const text = sharedText(list);
    expect(text).toBe("keycloak @identity oidc.issuer=https://id.acme.example/realms/shop");
    expect(parseShared(`${text}\n\n`)).toEqual(list);
  });

  it("finds what an import left", () => {
    const records = [
      { source_ref: "docker.io/pgvector/pgvector:pg18", digest: "sha256:a", pushed_at: "2026-11-01T00:00:00Z", reference: "x@sha256:a" },
      { source_ref: "pgvector/pgvector:pg18", digest: "sha256:b", pushed_at: "2026-11-03T00:00:00Z", reference: "x@sha256:b" },
      { source_ref: "pgvector/pgvector:pg18", digest: "", pushed_at: "2026-11-04T00:00:00Z", reference: "x:pg18" },
      { source_ref: "other:1", digest: "sha256:c", pushed_at: "2026-11-04T00:00:00Z", reference: "y@sha256:c" },
    ];
    expect(importedFrom(records, "pgvector/pgvector:pg18").map((r) => r.digest)).toEqual(["sha256:b", "sha256:a"]);
    expect(importedFrom(records, null)).toEqual([]);
  });
});
