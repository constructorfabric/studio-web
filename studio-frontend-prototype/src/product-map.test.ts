import { describe, expect, it } from "vitest";

import type { FrontendPick, InfraPlan, InfraService, ProductTechnology } from "./api";
import type { Mfe, Shell } from "./frontend-constructor";
import {
  authGear,
  databaseName,
  databaseOwners,
  describedConfigs,
  flattenParams,
  gearConfigOf,
  gearParams,
  postgresServers,
  secretField,
  serviceParams,
  frontendAbsence,
  frontendWith,
  frontendWithout,
  gearsWith,
  gearsWithout,
  groupsOf,
  linksOf,
  MISSING_GROUP,
  problemsOf,
  productGdlLines,
  productMap,
  withRequires,
  type MapFacts,
} from "./product-map";
import { indexCatalogue } from "./product-configurator";
import type { Infrastructure } from "./product-sections";

const mfe = (name: string, path: string, calls: string[], extra: Partial<Mfe> = {}): Mfe => ({
  name,
  description: "",
  version: "0.1.0",
  repo: "acme/web",
  placements: [{ id: `${name}~screen`, domain: "screen", label: name.replace(/-mfe$/, ""), icon: null, route: null, order: null, level: null }],
  calls,
  via: {},
  path,
  ...extra,
});

const people = mfe("people-mfe", "web/mfe/people", ["account-management"]);
const docs = mfe("docs-mfe", "web/mfe/docs", ["studio-documents", "studio-tasks"], { via: { "studio-tasks": "shared" } });

const shell: Shell = {
  name: "studio-frontend",
  repo: "acme/web",
  path: "web",
  version: "1.0.0",
  carries: {},
  signsIn: true,
  runtimeEnv: true,
};

const frontend: FrontendPick = {
  shell: { repo: "acme/web", path: "web", ref: "main" },
  mfes: [
    { repo: "acme/web", path: "web/mfe/people", package: "people-mfe", requires: ["account-management"] },
    { repo: "acme/web", path: "web/mfe/docs", package: "docs-mfe", requires: ["studio-documents"] },
  ],
};

const postgres: ProductTechnology = {
  id: "postgres",
  name: "PostgreSQL",
  why: "keeps the gears' data",
  gears: ["cf-gears-account-management", "cf-studio-documents"],
};

const infra = (over: Partial<Infrastructure> = {}): Infrastructure => ({
  profile: "prod",
  profileLabel: "Kubernetes",
  runsIn: [{ environment: "dev", namespace: "studio", profile: "prod", database: "its own Postgres", missing: [], unchecked: null, profileLabel: null, verdict: null, needs: null }],
  needs: [postgres],
  applications: [],
  ...over,
});

const facts = (over: Partial<MapFacts> = {}): MapFacts => ({
  product: {
    gears: ["cf-gears-account-management", "cf-studio-documents", "cf-studio-kits"],
    last_preview: {
      profile: "prod",
      ok: true,
      errors: 0,
      warnings: 0,
      applications: [],
      gears: ["cf-gears-account-management", "cf-studio-documents", "cf-studio-kits", "cf-gears-api-gateway"],
      infrastructure: [postgres],
    },
    frontend,
  },
  infra: infra(),
  mfes: [people, docs],
  shells: [shell],
  ...over,
});

const byId = (m: ReturnType<typeof productMap>, id: string) => m.nodes.find((n) => n.id === id);

describe("the map's nodes", () => {
  it("draws the shell and its screens, every gear once, and what they run on", () => {
    const m = productMap(facts());
    expect(m.nodes.filter((n) => n.layer === "frontend").map((n) => n.id)).toEqual(["shell", "mfe:web/mfe/people", "mfe:web/mfe/docs"]);
    expect(m.nodes.filter((n) => n.layer === "backend").map((n) => n.id).sort()).toEqual([
      "gear:account-management",
      "gear:api-gateway",
      "gear:studio-documents",
      "gear:studio-kits",
      "gear:studio-tasks",
    ]);
    expect(m.nodes.filter((n) => n.layer === "infrastructure" && !n.parent).map((n) => n.label)).toEqual(["PostgreSQL"]);
    expect(m.nodes.filter((n) => n.parent === "infra:postgres").map((n) => n.label)).toEqual(["account_management", "studio_documents"]);
  });

  it("says where a gear came from: picked, or pulled in by the engine", () => {
    const m = productMap(facts());
    expect(byId(m, "gear:studio-kits")?.detail.picked).toBe(true);
    expect(byId(m, "gear:api-gateway")?.detail.picked).toBe(false);
    expect(byId(m, "gear:api-gateway")?.detail.facts[0]).toMatch(/Pulled in by the engine/);
    expect(byId(m, "gear:api-gateway")?.group).toBe("Pulled in by the engine");
  });

  it("groups gears by subsystem when the engine's catalogue was read", () => {
    const catalogue = indexCatalogue({
      gears: {
        "account-management": { id: "account-management", category: "core-functionality", package: { crate_name: "cf-gears-account-management" } },
        "studio-documents": {
          id: "studio-documents",
          category: "studio",
          display_name: "Documents",
          package: { crate_name: "cf-studio-documents" },
          colocated_deps: ["account-management"],
        },
      },
    });
    const m = productMap(facts({ catalogue }));
    expect(byId(m, "gear:account-management")?.group).toBe("Core");
    expect(byId(m, "gear:studio-documents")?.label).toBe("Documents");
    expect(byId(m, "gear:studio-kits")?.group).toBe("Other");
    expect(m.links.find((l) => l.kind === "depends")).toMatchObject({
      from: "gear:studio-documents",
      to: "gear:account-management",
    });
    expect(groupsOf(m.nodes, "backend")[0].group).toBe(MISSING_GROUP);
  });
});

describe("the map's links", () => {
  it("links a screen to each gear it calls, saying where the call was read", () => {
    const m = productMap(facts());
    const toDocs = m.links.find((l) => l.from === "mfe:web/mfe/docs" && l.to === "gear:studio-documents");
    expect(toDocs).toMatchObject({ kind: "calls", state: "ok" });
    expect(toDocs?.why).toBe("docs-mfe calls /cf/studio-documents; the frontend pick records it as required.");
    const viaShared = m.links.find((l) => l.to === "gear:studio-tasks");
    expect(viaShared?.why).toMatch(/calls \/cf\/studio-tasks through shared/);
  });

  it("takes a screen the catalogue does not list from its recorded requires", () => {
    const m = productMap(facts({ mfes: [] }));
    const l = m.links.find((x) => x.from === "mfe:web/mfe/people");
    expect(l).toMatchObject({ to: "gear:account-management", state: "ok" });
    expect(l?.why).toBe("people-mfe requires account-management: the frontend pick records it.");
  });

  it("links the gears that keep data to Postgres", () => {
    const m = productMap(facts());
    expect(linksOf(m, "infra:postgres").map((l) => l.why)).toEqual([
      "account-management keeps data → PostgreSQL: keeps the gears' data",
      "studio-documents keeps data → PostgreSQL: keeps the gears' data",
    ]);
  });

  it("links a shell that signs in to the gear that signs users in", () => {
    const m = productMap(facts());
    expect(m.links.find((l) => l.kind === "signs-in")).toMatchObject({ from: "shell", to: "gear:account-management" });
  });

  it("prefers an identity provider the gears run on", () => {
    const oidc = { id: "oidc", name: "OIDC provider", why: "signs users in", gears: ["cf-gears-account-management"] };
    const base = facts();
    const m = productMap(
      facts({ product: { ...base.product!, last_preview: { ...base.product!.last_preview!, infrastructure: [postgres, oidc] } }, infra: null }),
    );
    expect(m.links.find((l) => l.kind === "signs-in")?.to).toBe("infra:oidc");
  });

  it("knows the gears that sign users in", () => {
    expect(authGear(["api-gateway", "authn-resolver", "account-management"])).toBe("account-management");
    expect(authGear(["oidc-authn-plugin", "account-management"])).toBe("oidc-authn-plugin");
    expect(authGear(["api-gateway"])).toBeNull();
  });
});

describe("the map's problems", () => {
  it("draws a gear a screen calls and the product lacks as missing, with a red link", () => {
    const m = productMap(facts());
    expect(byId(m, "gear:studio-tasks")).toMatchObject({ state: "missing", group: MISSING_GROUP });
    expect(m.links.find((l) => l.to === "gear:studio-tasks")?.state).toBe("bad");
    expect(byId(m, "mfe:web/mfe/docs")?.state).toBe("missing");
    expect(byId(m, "gear:studio-tasks")?.detail.problem).toBe("docs-mfe calls it, and the product does not have it.");
  });

  it("turns Postgres and its links red where an environment gives no database", () => {
    const m = productMap(
      facts({
        infra: infra({
          runsIn: [{ environment: "test", namespace: "t", profile: "prod", database: "none", missing: ["PostgreSQL"], unchecked: null, profileLabel: null, verdict: null, needs: null }],
        }),
      }),
    );
    expect(byId(m, "infra:postgres")?.state).toBe("bad");
    expect(byId(m, "infra:postgres")?.detail.problem).toMatch(/A deploy to test will stop/);
    expect(linksOf(m, "infra:postgres").every((l) => l.state === "bad")).toBe(true);
  });

  it("greys a gear no screen uses, but not platform plumbing", () => {
    const m = productMap(facts());
    expect(byId(m, "gear:studio-kits")?.state).toBe("unused");
    expect(byId(m, "gear:api-gateway")?.state).toBe("ok");
    expect(byId(m, "gear:account-management")?.state).toBe("ok");
  });

  it("asks nothing of a product without a frontend", () => {
    const base = facts();
    const m = productMap(facts({ product: { ...base.product!, frontend: null } }));
    expect(m.nodes.some((n) => n.state === "unused" || n.state === "missing")).toBe(false);
    expect(m.links.some((l) => l.kind === "calls")).toBe(false);
  });

  it("warns of a shell that signs in when no gear signs users in", () => {
    const base = facts();
    const m = productMap(facts({ product: { ...base.product!, gears: ["cf-studio-documents"], last_preview: undefined } }));
    expect(byId(m, "shell")?.state).toBe("warn");
    expect(problemsOf(m).map((p) => p.node.id)).toEqual(["gear:account-management", "mfe:web/mfe/docs", "mfe:web/mfe/people", "gear:studio-tasks", "shell"]);
  });
});

describe("what an add writes", () => {
  it("adds a gear once, by its key", () => {
    expect(gearsWith(["cf-gears-api-gateway"], "cf-studio-tasks")).toEqual(["cf-gears-api-gateway", "cf-studio-tasks"]);
    expect(gearsWith(["cf-gears-api-gateway"], "api-gateway")).toEqual(["cf-gears-api-gateway"]);
    expect(gearsWithout(["cf-gears-api-gateway", "cf-studio-tasks"], "studio-tasks")).toEqual(["cf-gears-api-gateway"]);
  });

  it("mounts a screen in the kept frontend, with the gears it calls that the product has", () => {
    const tasks = mfe("tasks-mfe", "web/mfe/tasks", ["studio-tasks", "studio-documents"]);
    const { pick, error } = frontendWith(frontend, tasks, [], ["cf-studio-documents"]);
    expect(error).toBeNull();
    expect(pick?.mfes.map((m) => m.path)).toEqual(["web/mfe/people", "web/mfe/docs", "web/mfe/tasks"]);
    expect(pick?.mfes[2]).toEqual({ repo: "acme/web", path: "web/mfe/tasks", package: "tasks-mfe", ref: "main", requires: ["studio-documents"] });
  });

  it("starts a product without a frontend from the shell template", () => {
    const blank = mfe("blank-mfe", "blank-mfe", [], { repo: "constructorfabric/gears-frontx-templates" });
    const { pick } = frontendWith(null, blank, [], []);
    expect(pick?.shell.path).toBe("template-shell");
    expect(pick?.mfes).toHaveLength(1);
  });

  it("adds nothing the catalogue cannot place", () => {
    const nowhere = mfe("lost-mfe", "", [], { path: null });
    expect(frontendWith(frontend, nowhere, [], [])).toEqual({
      pick: null,
      error: "The catalogue does not say where lost-mfe is yet; sync the catalogue, then add it.",
    });
  });

  it("unmounts a screen", () => {
    expect(frontendWithout(frontend, "web/mfe/people").mfes.map((m) => m.path)).toEqual(["web/mfe/docs"]);
  });

  it("brings requires up to the gears after a gear is added, and says when nothing changes", () => {
    expect(withRequires(frontend, [people, docs], ["cf-gears-account-management", "cf-studio-documents"])).toBeNull();
    const next = withRequires(frontend, [people, docs], ["cf-gears-account-management", "cf-studio-documents", "cf-studio-tasks"]);
    expect(next?.mfes[1].requires).toEqual(["studio-documents", "studio-tasks"]);
    expect(next?.mfes[0]).toBe(frontend.mfes[0]);
  });
});

describe("product.gdl as the map's other view", () => {
  const gdl = `gdl_version = "1.5"

product(
    id = "web",
    profiles = [
        embedded(id = "dev", development = True,
                 database = postgres(host = "127.0.0.1")),
        kubernetes(id = "prod", discovery = "static", namespace = "web",
                   database = postgres(host = "postgres")),
    ],
    # The product's screens (GDL 1.5)
    frontend = frontx_product(
        source = "frontx-web",
        shell = path("web"),
        mfes = [
            frontx_mfe(package = path("web/mfe/people"), source = "frontx-web", requires = ["account-management"]),
        ],
    ),
    gears = [
        use_gear("account-management", source = "gears-rust", plugins = [plugin("static-idp-plugin")]),
        use_gear("studio-documents", source = "studio"),
    ],
)
`;
  const ids = ["shell", "mfe:web/mfe/people", "gear:account-management", "gear:static-idp-plugin", "gear:studio-documents", "infra:postgres"];

  it("finds each node's lines", () => {
    const { byNode } = productGdlLines(gdl, ids);
    expect(Object.fromEntries(byNode)).toEqual({
      "infra:postgres": [7, 9],
      shell: [14],
      "mfe:web/mfe/people": [16],
      "gear:account-management": [20],
      "gear:static-idp-plugin": [20],
      "gear:studio-documents": [21],
    });
  });

  it("gives a line to the gear before the plugins written on it", () => {
    expect(productGdlLines(gdl, ids).byLine.get(20)).toBe("gear:account-management");
  });

  it("finds no frontend lines in a description without one, and ignores nodes the map lacks", () => {
    const plain = gdl.replace(/ {4}frontend = frontx_product\([\s\S]*?\n {4}\),\n/, "");
    const { byNode } = productGdlLines(plain, ["shell", "gear:studio-documents"]);
    expect([...byNode.keys()]).toEqual(["gear:studio-documents"]);
  });
});

describe("a gear the engine's corpus does not hold", () => {
  const own = {
    type_id: "gts.cf.studio.catalog.gear.v1~",
    instance_id: "kits",
    value: {
      name: "cf-studio-kits",
      kind: "gear",
      description: "Kits a project installs.",
      category: "studio",
      tier: "project" as const,
      synced_from: "acme/studio-web",
      repo_path: "studio-backend/src/kits",
      declared_in: "gear.gdl",
      version: "0.4.0",
    },
  };

  it("is described from the project's catalogue: its description, subsystem and version", () => {
    const m = productMap(facts({ catalogue: indexCatalogue({ gears: [] } as never), components: [own] }));
    const kits = byId(m, "gear:studio-kits")!;
    expect(kits.detail.what).toBe("Kits a project installs.");
    expect(kits.group).toBe("Studio");
    expect(kits.detail.facts.join(" ")).toMatch(/gear\.gdl in acme\/studio-web, studio-backend\/src\/kits: this project's catalogue/);
    expect(kits.detail.facts).toContain("Version 0.4.0.");
  });

  it("keeps the crate name alone when nothing describes it", () => {
    const m = productMap(facts({ components: [] }));
    expect(byId(m, "gear:studio-kits")!.detail.facts).toContain("Crate cf-studio-kits.");
  });
});

describe("an empty Frontend lane", () => {
  it("says there is no frontend only when nothing says there is one", () => {
    expect(frontendAbsence({ picked: false, described: null }).tone).toBe("none");
    expect(frontendAbsence({ picked: false, described: { revision: 3, text: 'use_gear("x")' } }).tone).toBe("none");
  });

  it("names a frontend the saved description has and the record lost", () => {
    const a = frontendAbsence({ picked: false, described: { revision: 4, text: "frontend = frontx_product(shell = path(...))" } });
    expect(a.tone).toBe("warn");
    expect(a.text).toMatch(/Revision 4 of product.gdl has a FrontX frontend/);
  });

  it("names a frontend picked before the product kept it", () => {
    expect(frontendAbsence({ picked: true, described: null }).text).toMatch(/picked before the product kept it/);
  });
});

describe("the databases under PostgreSQL", () => {
  it("names each the way generation does: the gear's id, - as _", () => {
    expect(databaseName("cf-gears-account-management")).toBe("account_management");
    expect(databaseName("studio-credstore-pg")).toBe("studio_credstore_pg");
    expect(databaseName("credstore")).toBe("credstore");
  });

  it("takes the gears the check names and those that declare db, but not a crate of several gears", () => {
    const owners = databaseOwners({
      need: ["cf-gears-credstore", "cf-studio-backend", "studio-documents"],
      gears: [
        { key: "credstore", name: "credstore", picked: true, id: "credstore", caps: [] },
        { key: "studio-backend", name: "cf-studio-backend", picked: false, id: "studio-assembly", caps: ["db"] },
        { key: "studio-documents", name: "studio-documents", picked: true, id: null, caps: ["db", "rest"] },
        { key: "studio-product", name: "studio-product", picked: true, id: "studio-product", caps: ["db"] },
        { key: "studio-kits", name: "studio-kits", picked: true, id: "studio-kits", caps: ["rest"] },
        { key: "tenant-resolver", name: "cf-gears-tenant-resolver", picked: false, id: "tenant-resolver", caps: ["db"] },
      ],
    });
    expect(owners.map((o) => o.database)).toEqual(["credstore", "studio_documents", "studio_product", "tenant_resolver"]);
    expect(owners.find((o) => o.key === "studio-documents")?.why).toBe("the engine's check says it needs PostgreSQL, and it declares db");
  });

  it("draws each under PostgreSQL, linked to its gear", () => {
    const m = productMap(facts());
    const db = byId(m, "db:studio_documents");
    expect(db).toMatchObject({ layer: "infrastructure", parent: "infra:postgres", group: "Runs with the product" });
    expect(db?.detail.kind).toBe("database");
    expect(db?.detail.params?.[0]).toEqual({ key: "database", value: "studio_documents", note: "the gear's id, - as _" });
    expect(linksOf(m, "db:studio_documents")).toEqual([
      { from: "gear:studio-documents", to: "db:studio_documents", kind: "stores-in", state: "ok", why: "studio-documents keeps its data in studio_documents." },
    ]);
  });

  it("says when the check names a crate in place of the gears that keep data", () => {
    const pg = { ...postgres, gears: [...postgres.gears, "cf-studio-backend"] };
    const m = productMap(facts({ infra: infra({ needs: [pg] }) }));
    expect(byId(m, "infra:postgres")?.detail.facts.at(-1)).toMatch(/^The check also names cf-studio-backend, which is not one gear/);
    expect(m.nodes.filter((n) => n.parent).map((n) => n.id)).toEqual(["db:account_management", "db:studio_documents"]);
  });

  it("reads each profile's server from product.gdl, the password only as the secret it comes from", () => {
    const servers = postgresServers(GDL);
    expect(servers).toEqual([
      { profile: "dev", host: "127.0.0.1", user: "app", password: "${GEARS_PG_PASSWORD}", existingSecret: null },
      { profile: "prod", host: "postgres", user: "app", password: "${GEARS_PG_PASSWORD}", existingSecret: "studioweb-db" },
    ]);
    const m = productMap(facts({ description: { revision: 8, text: GDL } }));
    const params = byId(m, "infra:postgres")?.detail.params ?? [];
    expect(params.find((p) => p.key === "prod password")).toEqual({ key: "prod password", value: "set via a secret", secret: true, note: "GEARS_PG_PASSWORD" });
    expect(JSON.stringify(params)).not.toMatch(/\$\{GEARS/);
  });
});

const GDL = `product(
    id = "studioweb",
    profiles = [
        embedded(id = "dev", development = True,
                 database = postgres(host = "127.0.0.1", user = "app", password = "\${GEARS_PG_PASSWORD}")),
        kubernetes(id = "prod", discovery = "static",
                   database = postgres(host = "postgres", user = "app", password = "\${GEARS_PG_PASSWORD}",
                                       existing_secret = "studioweb-db")),
    ],
    gears = [
        use_gear("oagw", source = "gears-rust", config = {"proxy_timeout_secs": 120}),
        use_gear("authn-resolver", config = {"vendor": "cf"}, plugins = [plugin("oidc-authn-plugin", config = {"jwt": {"require_audience": False, "trusted_issuers": [{"issuer": "http://keycloak:8080/realms/product"}]}, "note": "a ) in a string"})]),
        use_gear("grpc-hub", source = "gears-rust"),  # config = {"not": "this"}
    ],
)`;

describe("an infra service on the map (ADR-0064)", () => {
  const keycloak: InfraService = {
    passport: {
      name: "keycloak",
      version: "26.0.7",
      image: "quay.io/keycloak/keycloak:26.0.7",
      ports: { http: 8080 },
      health: "/health/ready",
      args: ["start-dev"],
      config: { KC_BOOTSTRAP_ADMIN_USERNAME: "admin", KC_DB_PASSWORD: "hunter2" },
      secrets: ["KC_BOOTSTRAP_ADMIN_PASSWORD"],
      provides: { "keycloak.admin_url": "http://{host}:{port.http}", "oidc.issuer": "{public_url}/realms/product" },
      stateful: false,
    },
    image: "ghcr.io/acme/mirror/keycloak:26.0.7@sha256:abc",
  };
  const plan: InfraPlan = {
    environment_id: "e1",
    environment_name: "dev",
    placement: "with_product",
    namespace: "studioweb-dev",
    items: [{ service: "keycloak", placement: "with_product", install: "generated", image: keycloak.image, provides: [{ capability: "oidc.issuer", variable: "OIDC_ISSUER" }] }],
  };
  const oidc: ProductTechnology = { id: "oidc", name: "OIDC identity provider", why: "signs people in", gears: ["oidc-authn-plugin"] };

  it("runs with the product when the project has a service that provides it", () => {
    const beside = productMap(facts({ infra: infra({ needs: [postgres, oidc] }) }));
    expect(byId(beside, "infra:oidc")?.group).toBe("Runs beside it, outside Studio");
    const m = productMap(facts({ infra: infra({ needs: [postgres, oidc] }), services: [keycloak], plans: [plan] }));
    const n = byId(m, "infra:oidc");
    expect(n?.group).toBe("Runs with the product");
    expect(n?.detail.facts).toContain("dev (studioweb-dev): keycloak: installed from a chart generated from its passport (ghcr.io/acme/mirror/keycloak:26.0.7@sha256:abc).");
  });

  it("lists its passport, secrets by name only", () => {
    const params = serviceParams(keycloak, [plan]);
    const at = (k: string) => params.find((p) => p.key === k);
    expect(at("image")).toEqual({ key: "image", value: keycloak.image, note: "imported into the project's path" });
    expect(at("config.KC_BOOTSTRAP_ADMIN_USERNAME")?.value).toBe("admin");
    expect(at("config.KC_DB_PASSWORD")).toMatchObject({ value: "set via a secret", secret: true });
    expect(at("secrets.KC_BOOTSTRAP_ADMIN_PASSWORD")).toMatchObject({ value: "set via a secret", secret: true });
    expect(at("dev OIDC_ISSUER")?.value).toBe("oidc.issuer");
    expect(JSON.stringify(params)).not.toMatch(/hunter2/);
  });
});

describe("a node's configuration", () => {
  it("tells a secret by its field's last name", () => {
    expect(secretField("admin_password")).toBe("value");
    expect(secretField("auth.client_secret")).toBe("value");
    expect(secretField("api_key")).toBe("value");
    expect(secretField("KC_BOOTSTRAP_ADMIN_PASSWORD")).toBe("value");
    expect(secretField("auth_config.secret_ref")).toBe("reference");
    expect(secretField("embedding_remote_api_key_env")).toBe("reference");
    expect(secretField("existing_secret")).toBe("reference");
    expect(secretField("claim_mapping.token_scopes")).toBeNull();
    expect(secretField("token_cache_ttl_secs")).toBeNull();
    expect(secretField("proxy_timeout_secs")).toBeNull();
  });

  it("reads each gear's and plugin's config from product.gdl, not a comment's", () => {
    const configs = describedConfigs(GDL);
    expect(configs.get("oagw")).toEqual({ proxy_timeout_secs: 120 });
    expect(configs.get("authn-resolver")).toEqual({ vendor: "cf" });
    expect(configs.get("oidc-authn-plugin")).toEqual({
      jwt: { require_audience: false, trusted_issuers: [{ issuer: "http://keycloak:8080/realms/product" }] },
      note: "a ) in a string",
    });
    expect(configs.has("grpc-hub")).toBe(false);
  });

  it("takes the product's config over the saved description's, field by field", () => {
    const c = gearConfigOf("cf-gears-oidc-authn-plugin", { "oidc-authn-plugin": { jwt: { require_audience: true } } }, describedConfigs(GDL));
    expect(c.values).toEqual({ jwt: { require_audience: true }, note: "a ) in a string" });
    expect(c.from).toEqual({ jwt: "product", note: "product.gdl" });
  });

  it("merges the config with the gear's schema: set, default, required and unset", () => {
    const params = gearParams(
      "oagw",
      {
        gear: "oagw",
        id: "oagw",
        fields: [
          { name: "proxy_timeout_secs", required: false, default: 30, derived: false },
          { name: "allow_http_upstream", required: false, default: false, derived: false },
          { name: "upstream", required: true, default: null, derived: false },
          { name: "bind_addr", required: false, derived: true },
          { name: "ssrf_policy", required: false, default: null, derived: false },
        ],
      },
      { values: { proxy_timeout_secs: 120, client_secret: "s3cret", auth: { header: "Authorization", api_key: "${OAGW_KEY}" } }, from: { proxy_timeout_secs: "product.gdl" } },
    );
    expect(params).toEqual([
      { key: "proxy_timeout_secs", value: "120", note: "set in the product.gdl" },
      { key: "allow_http_upstream", value: "false", note: "default" },
      { key: "upstream", value: "not set", note: "required", missing: true },
      { key: "bind_addr", value: "written by generation", note: "from the topology" },
      { key: "ssrf_policy", value: "not set", note: "optional" },
      { key: "client_secret", value: "set via a secret", secret: true, note: "not in the schema" },
      { key: "auth.header", value: "Authorization", note: "not in the schema" },
      { key: "auth.api_key", value: "set via a secret", secret: true, note: "OAGW_KEY" },
    ]);
  });

  it("says what a gear without a schema sets, and cuts a long value short", () => {
    const long = Array.from({ length: 40 }, (_, i) => `item-${i}`);
    const [p] = flattenParams("entities", long);
    expect(p.value.length).toBe(141);
    expect(p.full).toBe(long.join(", "));
    expect(gearParams("studio-product", { gear: "studio-product", id: null, fields: [] }, { values: { mode: "x" }, from: {} })).toEqual([
      { key: "mode", value: "x" },
    ]);
  });
});
