import { describe, expect, it } from "vitest";

import type { FrontendPick, ProductTechnology } from "./api";
import type { Mfe, Shell } from "./frontend-constructor";
import {
  authGear,
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
  runsIn: [{ environment: "dev", namespace: "studio", profile: "prod", database: "its own Postgres", missing: [], unchecked: false }],
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
    expect(m.nodes.filter((n) => n.layer === "infrastructure").map((n) => n.label)).toEqual(["PostgreSQL"]);
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
          runsIn: [{ environment: "test", namespace: "t", profile: "prod", database: "none", missing: ["PostgreSQL"], unchecked: false }],
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
