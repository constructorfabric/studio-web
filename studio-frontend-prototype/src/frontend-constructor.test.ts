import { describe, expect, it } from "vitest";

import type { CatalogNode, CatalogRepoSource } from "./api";
import {
  FRONTX_NODE_TYPE,
  SUGGESTED_FRONTX_SOURCE,
  coverage,
  frontxSuggestion,
  gearKey,
  mfesFrom,
  offersFor,
  placementLabel,
  splitTemplates,
  withFrontxSource,
  withSuggestedFrontx,
  zonesOf,
  type Mfe,
} from "./frontend-constructor";

const node = (name: string, value: Record<string, unknown> = {}, type = FRONTX_NODE_TYPE): CatalogNode =>
  ({ type_id: type, instance_id: name, value: { name, ...value } }) as unknown as CatalogNode;

const people: Mfe = {
  name: "@cs/people-mfe",
  description: "",
  version: null,
  repo: null,
  placements: [
    { id: "p.main", domain: "screen", label: "People", icon: "lucide:users", route: "/people", order: 30, level: "organization" },
    { id: "p.card", domain: "sidebar", label: "Who is online", icon: null, route: null, order: null, level: null },
  ],
  calls: ["studio-user", "account-management"],
  via: {},
};
const specs: Mfe = {
  name: "@cs/projects-mfe",
  description: "",
  version: null,
  repo: null,
  placements: [
    { id: "s.main", domain: "screen", label: "Projects", icon: null, route: "/projects", order: 10, level: null },
    { id: "s.dlg", domain: "popup", label: null, icon: null, route: null, order: null, level: null },
    { id: "s.x", domain: "toolbar", label: "Tools", icon: null, route: null, order: null, level: null },
  ],
  calls: ["studio-documents"],
  via: {},
};

describe("reading the catalogue", () => {
  it("keeps the micro-frontends, with what their profiles recorded", () => {
    const mfes = mfesFrom(
      [
        node("@cs/people-mfe", { component_kind: "micro-frontend", description: "People screens" }),
        node("@gears-frontx/ui-kit", { component_kind: "frontend-library" }),
        node("cf-gears-file-storage", { component_kind: "gear" }, "gts.cf.studio.catalog.gear.v1~"),
        node("@cs/shell-only", {}),
      ],
      {
        "@cs/people-mfe": {
          auto: {
            mfe_extensions: [{ id: "x", domain: "screen", label: "People", order: 3 }, { domain: "no id" }],
            mfe_calls: ["studio-user", "studio-user", 7],
          },
        },
        "@cs/shell-only": { auto: { mfe_extensions: [] } },
      },
    );
    expect(mfes.map((m) => m.name)).toEqual(["@cs/people-mfe", "@cs/shell-only"]);
    expect(mfes[0]).toMatchObject({ description: "People screens", calls: ["studio-user"] });
    expect(mfes[0].placements).toEqual([
      { id: "x", domain: "screen", label: "People", icon: null, route: null, order: 3, level: null },
    ]);
  });
});

describe("calls through a shared package", () => {
  it("counts what a dependency calls, and says through which package", () => {
    const [m] = mfesFrom(
      [
        node("@cs/org-mfe", { component_kind: "micro-frontend" }),
        node("@cs/mfe-shared", { component_kind: "frontend-library" }),
      ],
      {
        "@cs/org-mfe": { auto: { mfe_calls: ["studio-organizations"], deps_names: ["@cs/mfe-shared", "react"] } },
        "@cs/mfe-shared": { auto: { mfe_calls: ["studio-tasks", "studio-organizations"] } },
      },
    );
    expect(m.calls).toEqual(["studio-organizations", "studio-tasks"]);
    expect(m.via).toEqual({ "studio-tasks": "@cs/mfe-shared" });
  });
});

describe("the shell", () => {
  it("fills each zone in the shell's order, and keeps a domain it has no name for", () => {
    const zones = zonesOf([people, specs]);
    expect(zones.map((z) => z.domain)).toEqual(["screen", "sidebar", "overlay", "popup", "toolbar"]);
    expect(zones[0].items.map((x) => x.placement.label)).toEqual(["Projects", "People"]);
    expect(zones[2].items).toEqual([]);
    expect(placementLabel(zones[3].items[0].placement)).toBe("s.dlg");
  });
});

describe("whether the product has the gears its screens call", () => {
  it("matches a route segment to the catalogue's gear name", () => {
    expect(gearKey("cf-gears-account-management")).toBe("account-management");
    expect(gearKey("cf-studio-documents")).toBe("studio-documents");
    expect(gearKey("studio-user")).toBe("studio-user");
  });

  it("names what each screen lacks, and the product's gears no screen calls", () => {
    const c = coverage([people, specs], ["cf-gears-account-management", "studio-user", "api-gateway", "studio-reports"]);
    expect(c.missing.get("@cs/projects-mfe")).toEqual(["studio-documents"]);
    expect(c.missing.has("@cs/people-mfe")).toBe(false);
    expect(c.unseen).toEqual(["studio-reports"]);
  });

  it("finds the packages that could show a gear", () => {
    expect(offersFor("cf-gears-account-management", [people, specs]).map((m) => m.name)).toEqual(["@cs/people-mfe"]);
  });
});

describe("the suggested FrontX source", () => {
  const src = (repo: string, mode = "frontx", git_ref: string | null = "main"): CatalogRepoSource => ({
    tenant: "t",
    connection_id: null,
    repo,
    git_ref,
    mode,
  });

  it("is FrontX's templates, read as micro-frontends", () => {
    expect(SUGGESTED_FRONTX_SOURCE).toEqual({ repo: "constructorfabric/gears-frontx-templates", git_ref: "main", mode: "frontx" });
  });

  it("is added after the organization's own sources, through the organization's connection", () => {
    const own = [src("constructorfabric/gears-rust", "gears", null)];
    const next = withSuggestedFrontx(own);
    expect(next).toHaveLength(2);
    expect(next?.[0]).toBe(own[0]);
    expect(next?.[1]).toEqual({
      tenant: "00000000-0000-0000-0000-000000000000",
      connection_id: null,
      repo: "constructorfabric/gears-frontx-templates",
      git_ref: "main",
      mode: "frontx",
    });
  });

  it("is not added twice, whatever its spelling or ref", () => {
    expect(withSuggestedFrontx([src("Constructorfabric/Gears-Frontx-Templates.git", "frontx", "develop")])).toBeNull();
  });

  it("is still added when the repository is read only in another mode", () => {
    expect(withSuggestedFrontx([src("constructorfabric/gears-frontx-templates", "gears")])).toHaveLength(2);
  });
});

describe("templates and the screens a product adds", () => {
  const repo = "constructorfabric/gears-frontx-templates";
  it("reads FrontX's templates as where a new micro-frontend starts, not as screens", () => {
    const mfes = mfesFrom(
      [
        node("@cs/people-mfe", { component_kind: "micro-frontend", repository: "constructorfabric/studio-web" }),
        node("_blank-mfe", { component_kind: "template", repository: repo }),
        node("demo-mfe", { component_kind: "example", repository: repo }),
        // A template that is no micro-frontend (the shell's packages) is neither.
        node("@frontx/auth", { component_kind: "template", repository: repo }),
      ],
      {},
    );
    const { addable, templates } = splitTemplates(mfes);
    expect(addable.map((m) => m.name)).toEqual(["@cs/people-mfe"]);
    expect(templates.map((m) => m.name)).toEqual(["_blank-mfe", "demo-mfe"]);
  });

  it("calls anything from the templates repository a template, whatever its kind", () => {
    const fixture: Mfe = { ...people, name: "widgets-fixture-a", kind: "micro-frontend", repo };
    expect(splitTemplates([fixture]).templates).toHaveLength(1);
  });
});

describe("the repository to read micro-frontends from", () => {
  const src = (r: string, mode = "frontx"): CatalogRepoSource => ({ tenant: "t", connection_id: null, repo: r, git_ref: "main", mode });

  it("is the project's own first repository the catalogue does not read as FrontX", () => {
    expect(frontxSuggestion(["constructorfabric/studio-web"], [src("constructorfabric/gears-frontx-templates")])).toBe(
      "constructorfabric/studio-web",
    );
    expect(frontxSuggestion(["acme/a", "acme/b"], [src("Acme/A.git")])).toBe("acme/b");
    // Read only as gears, it still has its micro-frontends to give.
    expect(frontxSuggestion(["acme/a"], [src("acme/a", "gears")])).toBe("acme/a");
  });

  it("is nothing once every repository is read, or the project has none", () => {
    expect(frontxSuggestion(["acme/a"], [src("acme/a")])).toBeNull();
    expect(frontxSuggestion([], [])).toBeNull();
  });

  it("is added as a FrontX source through the organization's connection", () => {
    expect(withFrontxSource([], "constructorfabric/studio-web")).toEqual([
      { tenant: "00000000-0000-0000-0000-000000000000", connection_id: null, repo: "constructorfabric/studio-web", git_ref: "main", mode: "frontx" },
    ]);
    expect(withFrontxSource([src("constructorfabric/studio-web")], "constructorfabric/studio-web")).toBeNull();
  });
});
