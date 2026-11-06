import { describe, expect, it } from "vitest";
import type { CatalogNode, InfraPassport, InfraPlan, ProductTechnology } from "./api";
import { gearKey } from "./frontend-constructor";
import {
  bindNeeds,
  candidatesFor,
  infraRows,
  servicePill,
  unmetNeeds,
  configLines,
  configVariable,
  linkedConfig,
  mirrorIn,
  parseConfigLines,
  patchPassport,
  deployable,
  fieldsNaming,
  linkRows,
  needRows,
  needsMet,
  offersFor,
  patchService,
  unmetWithout,
  valuesAt,
  withService,
  withoutService,
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
  fileProblems,
  isKeycloak,
  MAX_FILES_BYTES,
  planAllRefusals,
  planNotes,
  planWarnings,
  realmClientsText,
  realmNameOf,
  withRealmFile,
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

describe("the Infrastructure editor", () => {
  const keycloak = passportOf(keycloakNode)!;
  const postgres = passportOf(postgresNode)!;
  const kc: InfraPassport = { ...keycloak, provides: { ...keycloak.provides, "keycloak.admin_url": "http://{host}:{port.http}" } };
  const dex: InfraPassport = { ...keycloak, name: "dex", provides: { "oidc.issuer": "{public_url}" }, chart: null };
  const needs: ProductTechnology[] = [
    { id: "postgres", name: "PostgreSQL", why: "data", gears: ["cf-gears-file-storage"] },
    { id: "oidc", name: "OIDC identity provider", why: "signs in", gears: ["cf-gears-oidc-authn-plugin"] },
    { id: "keycloak", name: "Keycloak", why: "tenants", gears: ["cf-gears-keycloak-idp-plugin"] },
  ];

  it("says which needs a passport meets", () => {
    expect(needsMet(kc)).toEqual(["oidc", "keycloak"]);
    expect(needsMet(postgres)).toEqual(["postgres"]);
  });

  it("offers what meets an unmet need first, and says what an addition replaces", () => {
    const offers = offersFor([dex, kc, postgres], [serviceFrom(postgres)], needs);
    expect(offers.map((o) => o.passport.name)).toEqual(["keycloak", "dex"]);
    expect(offers[0].unmet).toEqual(["oidc", "keycloak"]);
    expect(offersFor([dex, kc], [serviceFrom(kc)], needs)).toEqual([{ passport: dex, meets: ["oidc"], unmet: [], replaces: ["keycloak"] }]);
  });

  it("lists every passport that could meet a need, the project's first", () => {
    expect(candidatesFor({ id: "oidc" }, [serviceFrom(dex)], [kc, dex]).map((p) => p.name)).toEqual(["dex", "keycloak"]);
    expect(candidatesFor({ id: "nope" }, [], [kc])).toEqual([]);
  });

  it("edits the list without dropping what it does not touch", () => {
    const own = { ...serviceFrom(kc), image: "ghcr.io/a/p/mirror/keycloak@sha256:1", public_url: "https://id.example" };
    const list = [serviceFrom(postgres), own];
    expect(withService(list, kc)).toEqual({ next: list, dropped: [] });
    const swapped = withService(list, dex);
    expect(swapped.dropped).toEqual(["keycloak"]);
    expect(swapped.next.map((s) => s.passport.name)).toEqual(["postgresql", "dex"]);
    expect(withoutService(list, "postgresql")).toEqual([own]);
    const patched = patchService(list, "keycloak", { chart_ref: "oci://ghcr.io/a/p/mirror/charts/keycloak", chart_version: "24.4.0" });
    expect(patched[1]).toEqual({ ...own, chart_ref: "oci://ghcr.io/a/p/mirror/charts/keycloak", chart_version: "24.4.0" });
    expect(patched[0]).toBe(list[0]);
  });

  it("says which needs a removal leaves unmet", () => {
    const list = [serviceFrom(postgres), serviceFrom(kc)];
    expect(unmetWithout(needs, list, "keycloak").map((n) => n.id)).toEqual(["oidc", "keycloak"]);
    expect(unmetWithout(needs, list, "postgresql").map((n) => n.id)).toEqual(["postgres"]);
    expect(unmetWithout(needs, list, "nothing")).toEqual([]);
  });

  it("joins each need with what meets it in each environment", () => {
    const own = { ...serviceFrom(kc), image: "ghcr.io/a/p/mirror/keycloak@sha256:1" };
    const plan: InfraPlan = {
      environment_id: "e",
      environment_name: "dev",
      placement: "with_product",
      namespace: "p-dev",
      items: [{ service: "keycloak", placement: "with_product", install: "generated", image: own.image, provides: [] }],
    };
    const places = [{ environment: "dev", database: "its own Postgres, with each deploy", missing: [] }];
    const rows = needRows(needs, [own], [kc, dex, postgres], [plan], places);
    expect(rows.map((r) => r.met)).toEqual(["database", "service", "service"]);
    expect(rows[0].where).toEqual([{ environment: "dev", text: "its own Postgres, with each deploy", tone: "ok" }]);
    expect(rows[0].offer?.name).toBe("postgresql");
    expect(rows[1].where).toEqual([
      {
        environment: "dev",
        text: "keycloak: installed from a chart generated from its passport (ghcr.io/a/p/mirror/keycloak@sha256:1)",
        tone: "ok",
      },
    ]);
    expect(rows[1].candidates.map((c) => c.name)).toEqual(["keycloak", "dex"]);
    const bare = needRows(needs.slice(1, 2), [], [], [], places);
    expect(bare[0].met).toBe("outside");
    expect(bare[0].where[0].tone).toBe("warn");
    const refusing = { ...plan, items: [{ ...plan.items[0], refusal_code: "INFRA_IMAGE_NOT_IMPORTED", refusal: "import it" }] };
    expect(needRows(needs.slice(1, 2), [own], [], [refusing], [])[0].where).toEqual([
      { environment: "dev", text: "INFRA_IMAGE_NOT_IMPORTED: import it", tone: "danger" },
    ]);
  });

  it("names the variable a gear field is set from, except inside a list", () => {
    expect(configVariable("oidc-authn-plugin", "s2s_oauth.discovery_url")).toBe(
      "APP__GEARS__OIDC_AUTHN_PLUGIN__CONFIG__S2S_OAUTH__DISCOVERY_URL",
    );
    expect(configVariable("oidc-authn-plugin", "jwt.trusted_issuers[].issuer")).toBeNull();
  });

  it("reads values and references in a configuration", () => {
    const ref = "$" + "{OIDC_ISSUER}";
    const config = { jwt: { trusted_issuers: [{ issuer: "a" }, { issuer: ref }] }, s2s_oauth: { discovery_url: "b" } };
    expect(valuesAt(config, "jwt.trusted_issuers[].issuer")).toEqual(["a", ref]);
    expect(valuesAt(config, "s2s_oauth.discovery_url")).toEqual(["b"]);
    expect(valuesAt(config, "nope.x")).toEqual([]);
    expect(fieldsNaming(config, "OIDC_ISSUER")).toEqual(["jwt.trusted_issuers[].issuer"]);
  });

  it("links what a service provides to the gear fields that hold it", () => {
    const configs: Record<string, Record<string, unknown>> = {
      "oidc-authn-plugin": {
        jwt: { trusted_issuers: [{ issuer: "https://studio.example/realms/x" }] },
        s2s_oauth: { discovery_url: "$" + "{OIDC_ISSUER}" },
      },
    };
    const rows = linkRows(needs, [serviceFrom(kc)], (k) => configs[k] ?? {}, gearKey);
    expect(rows.map((r) => `${r.capability}|${r.gear}|${r.field}|${r.state}|${r.env}`)).toEqual([
      "postgres|cf-gears-file-storage|database|database|null",
      "oidc.issuer|cf-gears-oidc-authn-plugin|jwt.trusted_issuers[].issuer|literal|null",
      "oidc.issuer|cf-gears-oidc-authn-plugin|s2s_oauth.discovery_url|reference|APP__GEARS__OIDC_AUTHN_PLUGIN__CONFIG__S2S_OAUTH__DISCOVERY_URL",
      "keycloak.admin_url|cf-gears-keycloak-idp-plugin|keycloak.base_url|unset|APP__GEARS__KEYCLOAK_IDP_PLUGIN__CONFIG__KEYCLOAK__BASE_URL",
    ]);
    expect(rows[1].service).toBe("keycloak");
    expect(rows[0].service).toBeNull();
    // The database step wires every gear alike: one row lists them all.
    expect(linkRows([{ ...needs[0], gears: ["a", "b"] }], [], () => ({}), gearKey).map((r) => r.gears)).toEqual([["a", "b"]]);
    // A capability no gear needs is listed too, without a gear.
    expect(linkRows([], [serviceFrom(postgres)], () => ({}), gearKey).map((r) => [r.capability, r.gear, r.state])).toEqual([
      ["postgres", null, "unknown"],
    ]);
  });

  it("finds an environment's copy of the publisher's image", () => {
    const rec = (o: Partial<{ source_ref: string; digest: string; pushed_at: string; registry_host: string; repository: string; state: string }>) => ({
      source_ref: "quay.io/keycloak/keycloak:26.0.7",
      digest: "sha256:1",
      pushed_at: "2026-11-01T00:00:00Z",
      registry_host: "ghcr.io",
      repository: "acme/shop/mirror/keycloak",
      state: "present",
      ...o,
    });
    const records = [
      rec({}),
      rec({ digest: "sha256:2", pushed_at: "2026-11-02T00:00:00Z", registry_host: "registry.prod" }),
      rec({ digest: "sha256:3", pushed_at: "2026-11-03T00:00:00Z", state: "deleted" }),
      rec({ digest: "sha256:4", source_ref: "quay.io/keycloak/keycloak:25.0.0" }),
    ];
    expect(mirrorIn(records, "quay.io/keycloak/keycloak:26.0.7", "ghcr.io/acme/")?.digest).toBe("sha256:1");
    expect(mirrorIn(records, "quay.io/keycloak/keycloak:26.0.7", "registry.prod")?.digest).toBe("sha256:2");
    expect(mirrorIn(records, "quay.io/keycloak/keycloak:26.0.7", "ghcr.io/other")).toBeNull();
    expect(mirrorIn(records, "quay.io/keycloak/keycloak:26.0.7", "")).toBeNull();
  });

  it("links a gear field to a capability, in a list too", () => {
    const config = { jwt: { trusted_issuers: [{ issuer: "a", x: 1 }, { issuer: "b" }], other: true }, keep: 2 };
    const ref = "$" + "{OIDC_ISSUER}";
    expect(linkedConfig(config, "jwt.trusted_issuers[].issuer", "OIDC_ISSUER")).toEqual({
      jwt: { trusted_issuers: [{ issuer: ref, x: 1 }, { issuer: ref }], other: true },
      keep: 2,
    });
    expect(config.jwt.trusted_issuers[0].issuer).toBe("a");
    expect(linkedConfig({}, "s2s_oauth.discovery_url", "OIDC_ISSUER")).toEqual({ s2s_oauth: { discovery_url: ref } });
    expect(linkedConfig({}, "jwt.trusted_issuers[].issuer", "OIDC_ISSUER")).toEqual({ jwt: { trusted_issuers: [{ issuer: ref }] } });
  });

  it("edits a passport's settings as lines", () => {
    expect(configLines({ A: "1", B: "x=y" })).toBe("A=1\nB=x=y");
    expect(parseConfigLines("A=1\n\nB = x=y\nnot a line\nKC_PASSWORD=z", ["KC_PASSWORD"])).toEqual({
      config: { A: "1", B: "x=y" },
      problems: ['"not a line" is not KEY=value', "KC_PASSWORD is a secret: the environment keeps it"],
    });
  });

  it("changes a passport without dropping the rest", () => {
    const own = { ...serviceFrom(kc), image: "ghcr.io/a/p/mirror/keycloak@sha256:1", public_url: "https://id.example" };
    const [next] = patchPassport([own], "keycloak", { image: "quay.io/keycloak/keycloak:26.1.0", version: "26.1.0" });
    expect(next).toEqual({ ...own, passport: { ...own.passport, image: "quay.io/keycloak/keycloak:26.1.0", version: "26.1.0" } });
  });

  it("puts what runs beside the gears in one table", () => {
    const own = { ...serviceFrom(kc), image: "ghcr.io/a/p/mirror/keycloak@sha256:1" };
    const plan: InfraPlan = {
      environment_id: "e1",
      environment_name: "dev",
      placement: "with_product",
      namespace: "p-dev",
      items: [{ service: "keycloak", placement: "with_product", install: "generated", image: own.image, provides: [] }],
    };
    const envs = [
      { id: "e1", name: "dev", registry: "ghcr.io/a", database: "its own Postgres, with each deploy", missing: [] },
      { id: "e2", name: "prod", registry: "ghcr.io/a", database: "none", missing: ["PostgreSQL"] },
    ];
    const links = linkRows(needs, [own], () => ({}), gearKey);
    const rows = infraRows(needs, [own], [plan], envs, links);
    expect(rows.map((r) => [r.id, r.gives, r.usedBy])).toEqual([
      ["database", ["postgres"], ["cf-gears-file-storage"]],
      ["keycloak", ["oidc", "keycloak"], ["cf-gears-oidc-authn-plugin", "cf-gears-keycloak-idp-plugin"]],
    ]);
    expect(rows[0].envs.map((e) => [e.text, e.tone])).toEqual([
      ["dev ✓ with the product", "ok"],
      ["prod ⚠ no database", "danger"],
    ]);
    expect(rows[1].envs.map((e) => [e.text, e.tone])).toEqual([
      ["dev ✓ with the product", "ok"],
      ["prod ⚠ not planned", "warn"],
    ]);
    expect(rows[0].links.map((l) => l.field)).toEqual(["database"]);
    expect(rows[1].links.map((l) => l.field)).toEqual(["jwt.trusted_issuers[].issuer", "s2s_oauth.discovery_url", "keycloak.base_url"]);
    // A service that gives the database takes the environment's place.
    const pg = serviceFrom(postgres);
    expect(infraRows(needs, [pg], [], envs, []).map((r) => r.id)).toEqual(["postgresql"]);
  });

  it("says a refused plan in a few words", () => {
    const item = { service: "k", placement: "with_product" as const, install: "generated" as const, provides: [] };
    expect(servicePill({ name: "dev" }, { ...item, refusal_code: "INFRA_IMAGE_NOT_IMPORTED", refusal: "import it" })).toEqual({
      environment: "dev",
      tone: "danger",
      text: "dev ⚠ no copy yet",
      detail: "INFRA_IMAGE_NOT_IMPORTED: import it",
    });
    expect(servicePill({ name: "dev" }, { ...item, placement: "shared", install: "shared" }).text).toBe("dev ✓ shared place");
  });

  it("lists the needs nothing meets, with what would", () => {
    const rows = needRows(needs, [serviceFrom(postgres)], [kc], [], []);
    expect(unmetNeeds(rows).map((u) => [u.need.id, u.offer?.name])).toEqual([
      ["oidc", "keycloak"],
      ["keycloak", "keycloak"],
    ]);
  });
});

describe("files, arguments and the address people reach", () => {
  const kc = passportOf(keycloakNode)!;
  const withClientSecret = { ...kc, secrets: ["KC_BOOTSTRAP_ADMIN_PASSWORD", "OIDC_CLIENT_SECRET"] };

  it("checks files as the backend does", () => {
    expect(fileProblems({ "/opt/keycloak/data/import/product.json": "{}" })).toEqual([]);
    for (const bad of ["realm.json", "/opt/../etc", "/opt//x", "/opt/x/", "/"])
      expect(fileProblems({ [bad]: "x" })).toHaveLength(1);
    expect(fileProblems({ "/a": "x".repeat(MAX_FILES_BYTES) })[0]).toMatch(/bytes together/);
  });

  it("names the realm from the issuer", () => {
    expect(realmNameOf(kc)).toBe("product");
    expect(realmNameOf({ provides: { "oidc.issuer": "{public_url}/realms/shop" } })).toBe("shop");
    expect(realmNameOf({ provides: {} })).toBe("product");
  });

  // The server makes the realm (infra_keycloak_realm): the editor lays it on.
  const realm = {
    path: "/opt/keycloak/data/import/product.json",
    content: '{"realm":"product"}',
    args: ["--import-realm"],
    clients: [
      { client_id: "product-portal", kind: "public" as const },
      { client_id: "product-backend", kind: "confidential" as const, secret: "{secret.OIDC_CLIENT_SECRET}" },
      { client_id: "mini-chat", kind: "confidential" as const, gear: "mini-chat", secret: "{env.MINI_CHAT_CLIENT_SECRET}" },
    ],
  };

  it("adds the server's realm and --import-realm once, keeping other files", () => {
    const s = { ...serviceFrom(withClientSecret), files: { "/etc/x": "y" }, args: [] };
    const once = withRealmFile(s, realm);
    expect(Object.keys(once.files).sort()).toEqual(["/etc/x", "/opt/keycloak/data/import/product.json"]);
    expect(once.args).toEqual(["--import-realm"]);
    expect(withRealmFile({ ...s, ...once }, realm).args).toEqual(["--import-realm"]);
    expect(isKeycloak(kc)).toBe(true);
    expect(isKeycloak(passportOf(postgresNode)!)).toBe(false);
  });

  it("says each client of the realm and the secret it is wired to", () => {
    expect(realmClientsText(realm)).toBe(
      "product-portal (public), product-backend (confidential, secret {secret.OIDC_CLIENT_SECRET}), mini-chat (mini-chat's, secret {env.MINI_CHAT_CLIENT_SECRET})",
    );
  });

  it("shows an issuer that is not https as a refusal, and one pods cannot reach as a warning", () => {
    const item = { service: "keycloak", placement: "with_product" as const, install: "generated" as const, provides: [] };
    expect(
      servicePill({ name: "dev" }, { ...item, refusal_code: "INFRA_ISSUER_NOT_HTTPS", refusal: "give it https" }),
    ).toMatchObject({ tone: "danger", text: "dev ⚠ issuer not https" });
    const warned = {
      ...item,
      warnings: [{ code: "INFRA_ISSUER_UNREACHABLE_IN_CLUSTER", message: "id.localtest.me reaches only this machine" }],
    };
    const pill = servicePill({ name: "dev" }, warned);
    expect(pill).toMatchObject({ tone: "warn", text: "dev ⚠ pods cannot reach it" });
    expect(pill.detail).toContain("INFRA_ISSUER_UNREACHABLE_IN_CLUSTER: id.localtest.me");
    const plan: InfraPlan = {
      environment_id: "e",
      environment_name: "dev",
      placement: "with_product",
      namespace: "shop-dev",
      items: [warned],
      configuration: [
        { code: "CONFIG_SECRET_SHADOWED_BY_DESCRIPTION", key: "K", gear: "mini-chat", field: "f", refuses: false, message: "the description wins" },
        { code: "CONFIG_SECRET_CONFLICTS_WITH_DESCRIPTION", key: "L", gear: "mini-chat", field: "g", refuses: true, message: "keep one" },
      ],
    };
    expect(planWarnings(plan)).toEqual([
      "INFRA_ISSUER_UNREACHABLE_IN_CLUSTER: id.localtest.me reaches only this machine",
      "CONFIG_SECRET_SHADOWED_BY_DESCRIPTION: the description wins",
    ]);
    expect(planAllRefusals(plan)).toEqual(["CONFIG_SECRET_CONFLICTS_WITH_DESCRIPTION: keep one"]);
    expect(planWarnings(null)).toEqual([]);
  });

  it("shows the route, the notes and the missing address in the plan", () => {
    const item = {
      service: "keycloak",
      placement: "with_product" as const,
      install: "generated" as const,
      provides: [],
      route: "https://id.shop.example",
    };
    expect(planItemText(item)).toMatch(/reached at https:\/\/id\.shop\.example$/);
    expect(servicePill({ name: "dev" }, item).detail).toMatch(/reached at https:\/\/id\.shop\.example/);
    const plan = {
      environment_id: "e",
      environment_name: "dev",
      placement: "with_product" as const,
      namespace: "shop-dev",
      items: [{ ...item, install: "chart" as const, route: null, notes: ["its files are not applied: a ready chart …"] }],
    };
    expect(planNotes(plan)).toEqual(["keycloak: its files are not applied: a ready chart …"]);
    expect(
      servicePill({ name: "dev" }, { ...item, refusal_code: "INFRA_PUBLIC_URL_MISSING", refusal: "set its public_url" }).text,
    ).toBe("dev ⚠ no public address");
  });
});
