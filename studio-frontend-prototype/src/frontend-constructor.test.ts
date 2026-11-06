import { describe, expect, it } from "vitest";

import type { CatalogNode, CatalogRepoSource } from "./api";
import {
  FRONTX_NODE_TYPE,
  FRONTX_SHELL_TEMPLATE,
  SUGGESTED_FRONTX_SOURCE,
  assemblySteps,
  chosenShell,
  compareVersions,
  coverage,
  fitOf,
  frontendPick,
  frontxDefaultsOf,
  frontxSuggestion,
  gearKey,
  librariesFrom,
  mfesFrom,
  offersFor,
  ownerRepo,
  parseShellRef,
  picksOf,
  placementLabel,
  productIdp,
  projectRepos,
  satisfies,
  shellRefOf,
  shellsFrom,
  splitTemplates,
  withFrontxSource,
  withSuggestedFrontx,
  zonesOf,
  type Mfe,
  stepsSummary,
  type Step,
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

describe("what a package's frontx.gdl declares", () => {
  const described = (kind: string, more: Record<string, unknown> = {}) => ({
    auto: { frontx_described: true, frontx_kind: { v: kind, b: kind }, ...more },
  });

  it("does not offer a declared library as a screen, though the scan filed it as one", () => {
    // Studio's `shared` sits in `mfe_packages`, which reads as a micro-frontend.
    const nodes = [
      node("@cs/mfe-shared", { component_kind: "micro-frontend" }),
      node("@cs/org-mfe", { component_kind: "micro-frontend" }),
    ];
    const profiles = {
      "@cs/mfe-shared": described("library", { mfe_calls: ["studio-tasks"] }),
      "@cs/org-mfe": { auto: { mfe_extensions: [] } },
    };
    expect(mfesFrom(nodes, profiles).map((m) => m.name)).toEqual(["@cs/org-mfe"]);
    expect(librariesFrom(nodes, profiles).map((l) => l.name)).toEqual(["@cs/mfe-shared"]);
  });

  it("takes a declared requires as the whole list, and adds up only a guess", () => {
    const nodes = [
      node("@cs/org-mfe", { component_kind: "micro-frontend" }),
      node("@cs/legacy-mfe", { component_kind: "micro-frontend" }),
      node("@cs/mfe-shared", { component_kind: "frontend-library" }),
    ];
    const deps = ["@cs/mfe-shared"];
    const [legacy, org] = mfesFrom(nodes, {
      "@cs/org-mfe": described("mfe", { mfe_calls: ["account-management"], deps_names: deps }),
      "@cs/legacy-mfe": { auto: { frontx_described: false, mfe_calls: ["studio-documents"], deps_names: deps } },
      "@cs/mfe-shared": described("library", { mfe_calls: ["studio-tasks"] }),
    });
    expect(org).toMatchObject({ calls: ["account-management"], via: {}, described: true });
    expect(legacy).toMatchObject({
      calls: ["studio-documents", "studio-tasks"],
      via: { "studio-tasks": "@cs/mfe-shared" },
      described: false,
    });
  });

  it("makes a declared shell one even when its workspace carries nothing, and says it was declared", () => {
    const [shell] = shellsFrom([node("@cs/portal")], {
      "@cs/portal": described("shell", { shell_signin: true, shell_runtime_env: true }),
    });
    expect(shell).toMatchObject({ name: "@cs/portal", signsIn: true, runtimeEnv: true, described: true });
    // A file that did not read is a guess, like no file.
    expect(shellsFrom([node("@cs/portal")], { "@cs/portal": { auto: { frontx_described: false, frontx_kind: "shell" } } })).toEqual([]);
  });

  it("reads a shell's passport: where its screens call, what it reads at start, how it is built", () => {
    const [shell] = shellsFrom([node("@cs/portal")], {
      "@cs/portal": described("shell", {
        shell_signin: true,
        shell_runtime_env: true,
        shell_api_prefix: "/cf/",
        shell_build: "npm run build",
        shell_output: "dist",
        shell_node: ">=24",
        shell_env: { apiBase: "gateway.url", oidcIssuer: "oidc.issuer" },
        frontx_passport_drift: { v: "x", b: "x", s: "watch", items: ["version: frontx.gdl says \"1.1.0\", package.json \"1.2.0\""] },
      }),
    });
    expect(shell.passport).toMatchObject({
      apiPrefix: "/cf/",
      build: "npm run build",
      output: "dist",
      node: ">=24",
      env: { apiBase: "gateway.url", oidcIssuer: "oidc.issuer" },
      buildEnv: [],
    });
    expect(shell.drift).toHaveLength(1);
    // A minimal frontx.gdl says nothing more, and a guessed shell has no passport.
    const [minimal] = shellsFrom([node("@cs/portal")], { "@cs/portal": described("shell", { shell_signin: false }) });
    expect(minimal.passport).toBeNull();
    expect(minimal.drift).toEqual([]);
  });

  it("reads the roles a micro-frontend's passport names, and none when it does not say", () => {
    const nodes = [node("@cs/org-mfe", { component_kind: "micro-frontend" }), node("@cs/old-mfe", { component_kind: "micro-frontend" })];
    const [old, org] = mfesFrom(nodes, {
      "@cs/org-mfe": described("mfe", { mfe_calls: ["studio-organizations"], mfe_roles: ["organizations.read"] }),
      "@cs/old-mfe": { auto: { mfe_extensions: [] } },
    });
    expect(org.roles).toEqual(["organizations.read"]);
    expect(old.roles).toBeNull();
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

  it("finds the project's repository where it is recorded, not only among ingested artifacts", () => {
    // A product written to studio-web, a project with no ingested repository.
    expect(
      projectRepos({ writtenPrUrl: "https://github.com/constructorfabric/studio-web/pull/912", artifactRepos: [] }),
    ).toEqual(["constructorfabric/studio-web"]);
    expect(
      projectRepos({
        gearRepo: "acme/gears",
        sources: [{ full_path: "acme/app" }, { full_path: "Acme/Gears.git" }],
        writtenPrUrl: "https://github.com/acme/gears/pull/1",
        artifactRepos: ["acme/app", "acme/docs"],
      }),
    ).toEqual(["acme/gears", "acme/app", "acme/docs"]);
    expect(projectRepos({})).toEqual([]);
  });

  it("is added as a FrontX source through the organization's connection", () => {
    expect(withFrontxSource([], "constructorfabric/studio-web")).toEqual([
      { tenant: "00000000-0000-0000-0000-000000000000", connection_id: null, repo: "constructorfabric/studio-web", git_ref: "main", mode: "frontx" },
    ]);
    expect(withFrontxSource([src("constructorfabric/studio-web")], "constructorfabric/studio-web")).toBeNull();
  });
});

describe("how the frontend gets built", () => {
  const profile = (auto: Record<string, unknown>) => ({ auto });
  // The two shells a hand assembly met: the stock template, which carries
  // newer FrontX and does not sign in, and Studio's portal, a fork of it that
  // does.
  const nodes = [
    node("@gears-frontx/frontx-template-shell", {
      component_kind: "template",
      repository: "https://github.com/constructorfabric/gears-frontx-templates",
      max_version: "0.1.0-alpha.6",
    }),
    node("@cs/studio-portal", {
      repository: "constructorfabric/studio-web",
      max_version: "0.1.0-alpha.2",
    }),
    node("@cs/people-mfe", { component_kind: "micro-frontend" }),
  ];
  const profiles = {
    "@gears-frontx/frontx-template-shell": profile({
      path: { v: "template-shell", b: "template-shell" },
      carries: { "@gears-frontx/framework": "0.2.0-alpha.16", "@gears-frontx/react": "0.2.0-alpha.15" },
      deps_versions: { "@gears-frontx/mfes": "0.4.0", "@gears-frontx/frontx-template-shell": "file:." },
      shell_signin: false,
      shell_runtime_env: false,
    }),
    "@cs/studio-portal": profile({
      path: { v: "studio-frontend", b: "studio-frontend" },
      carries: { "@gears-frontx/framework": "0.2.0-alpha.0", "@gears-frontx/react": "0.2.0-alpha.0" },
      shell_signin: true,
      shell_runtime_env: true,
    }),
    "@cs/people-mfe": profile({
      mfe_extensions: [{ id: "p", domain: "screen", label: "People" }],
      mfe_calls: ["studio-user"],
      deps_versions: {
        "@gears-frontx/react": "0.2.0-alpha.0",
        "@gears-frontx/framework": "0.2.0-alpha.0",
        "@gears-frontx/ui-kit": "0.4.10",
        react: "19.0.0",
      },
    }),
  };
  const shells = shellsFrom(nodes, profiles);
  const [template, portal] = shells;
  const peopleMfe = mfesFrom(nodes, profiles).find((m) => m.name === "@cs/people-mfe")!;

  it("finds the shells: packages whose workspace carries FrontX of its own", () => {
    expect(shells.map((s) => s.name)).toEqual(["@gears-frontx/frontx-template-shell", "@cs/studio-portal"]);
    expect(template.carries).toEqual({
      "@gears-frontx/framework": "0.2.0-alpha.16",
      "@gears-frontx/react": "0.2.0-alpha.15",
      "@gears-frontx/mfes": "0.4.0",
      "@gears-frontx/frontx-template-shell": "0.1.0-alpha.6",
    });
    expect(template.signsIn).toBe(false);
    expect(portal.signsIn).toBe(true);
  });

  it("reads a micro-frontend's FrontX pins and nothing else", () => {
    expect(peopleMfe.wants).toEqual({
      "@gears-frontx/react": "0.2.0-alpha.0",
      "@gears-frontx/framework": "0.2.0-alpha.0",
      "@gears-frontx/ui-kit": "0.4.10",
    });
  });

  it("names the shell a stored reference points at", () => {
    expect(parseShellRef("github:constructorfabric/gears-frontx-templates//template-shell@main")).toEqual({
      repo: "constructorfabric/gears-frontx-templates",
      path: "template-shell",
      ref: "main",
    });
    expect(chosenShell(shells, "github:constructorfabric/gears-frontx-templates//template-shell@main")).toBe(template);
    expect(chosenShell(shells, "github:constructorfabric/studio-web//studio-frontend")).toBe(portal);
    expect(chosenShell(shells, "github:o/r//nowhere@main")).toBeNull();
    expect(shellRefOf(portal)).toBe("github:constructorfabric/studio-web//studio-frontend@main");
    expect(ownerRepo("https://github.com/o/r.git")).toBe("o/r");
  });

  it("orders versions as semver does, prereleases included", () => {
    expect(compareVersions("0.2.0-alpha.16", "0.2.0-alpha.2")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.2.0-alpha.16")).toBeGreaterThan(0);
    expect(satisfies("0.2.0-alpha.0", "0.2.0-alpha.0")).toBe(true);
    expect(satisfies("0.2.0-alpha.0", "0.2.0-alpha.16")).toBe(false);
    expect(satisfies("^0.4.0", "0.4.7")).toBe(true);
    expect(satisfies("^0.4.0", "0.5.0")).toBe(false);
    expect(satisfies(">=0.2.0-0", "0.3.0-alpha.3")).toBe(true);
    expect(satisfies("*", "anything")).toBe(true);
  });

  it("holds the pins against the shell: Studio's screens fit the portal, not the template", () => {
    expect(fitOf(peopleMfe, portal).map((f) => f.verdict)).toEqual(["fits", "fits", "outside"]);
    expect(fitOf(peopleMfe, template)).toEqual([
      { pkg: "@gears-frontx/framework", wants: "0.2.0-alpha.0", has: "0.2.0-alpha.16", verdict: "differs" },
      { pkg: "@gears-frontx/react", wants: "0.2.0-alpha.0", has: "0.2.0-alpha.15", verdict: "differs" },
      { pkg: "@gears-frontx/ui-kit", wants: "0.4.10", has: null, verdict: "outside" },
    ]);
  });

  it("walks the steps, and says which a sign-in product's shell fails", () => {
    const gears = ["cf-gears-api-gateway", "cf-gears-oidc-authn-plugin"];
    expect(productIdp(gears)).toBe("oidc-authn-plugin");
    const onTemplate = assemblySteps({
      shellRef: "github:constructorfabric/gears-frontx-templates//template-shell@main",
      shell: template,
      picked: [peopleMfe],
      productGears: gears,
    });
    const state = Object.fromEntries(onTemplate.map((s) => [s.id, s.state]));
    expect(onTemplate.map((s) => s.id)).toEqual(["shell", "mount", "versions", "signin", "backend", "gears", "build", "ship"]);
    expect(state).toMatchObject({ shell: "ok", versions: "warn", signin: "bad", backend: "warn", gears: "bad", build: "todo" });
    expect(onTemplate.find((s) => s.id === "gears")?.detail).toContain("studio-user");

    const onPortal = assemblySteps({ shellRef: null, shell: portal, picked: [peopleMfe], productGears: [...gears, "studio-user"] });
    expect(Object.fromEntries(onPortal.map((s) => [s.id, s.state]))).toMatchObject({
      versions: "ok",
      signin: "ok",
      backend: "ok",
      gears: "ok",
    });
  });

  it("says when the shell is not in the catalogue, and when nothing is picked", () => {
    const steps = assemblySteps({ shellRef: "github:o/r//shell@main", shell: null, picked: [], productGears: [] });
    expect(steps[0]).toMatchObject({ id: "shell", state: "warn" });
    expect(steps[0].detail).toContain("o/r");
    expect(steps.find((s) => s.id === "mount")?.state).toBe("todo");
    expect(steps.find((s) => s.id === "signin")?.state).toBe("info");
  });
});

describe("what the product keeps of its frontend", () => {
  const studio = "https://github.com/acme/studio-web";
  const org: Mfe = {
    name: "@cs/org-mfe",
    description: "",
    version: null,
    repo: studio,
    path: "studio-frontend/src-app/mfe_packages/org-mfe",
    placements: [],
    calls: ["studio-organizations", "studio-tasks"],
    via: {},
    deps: ["@cs/shared", "@gears-frontx/react"],
  };
  const libraries = librariesFrom(
    [
      node("@cs/shared", { component_kind: "frontend-library", repository: studio }),
      node("@gears-frontx/react", { component_kind: "frontend-library" }),
      node("@cs/org-mfe", { component_kind: "micro-frontend" }),
      node("@cs/portal", { repository: studio }),
    ],
    {
      "@cs/shared": { auto: { path: "studio-frontend/src-app/mfe_packages/shared" } },
      "@cs/portal": { auto: { carries: { "@gears-frontx/react": "0.2.0" } } },
    },
  );

  it("reads the libraries: FrontX packages that are neither screens, shells nor FrontX's own", () => {
    expect(libraries).toEqual([
      { name: "@cs/shared", repo: studio, path: "studio-frontend/src-app/mfe_packages/shared" },
    ]);
  });

  it("places each package by repository and directory, with the product's gears it calls", () => {
    const { pick, unplaced } = frontendPick(
      "github:constructorfabric/gears-frontx-templates//template-shell@v0.6",
      [org],
      libraries,
      ["cf-studio-organizations", "cf-gears-api-gateway"],
    );
    expect(unplaced).toEqual([]);
    expect(pick).toEqual({
      shell: { repo: "constructorfabric/gears-frontx-templates", path: "template-shell", ref: "v0.6" },
      mfes: [
        {
          repo: "acme/studio-web",
          path: "studio-frontend/src-app/mfe_packages/org-mfe",
          package: "@cs/org-mfe",
          requires: ["studio-organizations"],
        },
      ],
      // The template does not have Studio's shared library: it is brought.
      libraries: [{ repo: "acme/studio-web", path: "studio-frontend/src-app/mfe_packages/shared", package: "@cs/shared" }],
    });
  });

  it("brings no library the shell has, and names a package it cannot place", () => {
    const { pick, unplaced } = frontendPick(
      "github:acme/studio-web//studio-frontend@main",
      [org, { ...people, repo: null }],
      libraries,
      [],
    );
    expect(pick?.libraries).toBeUndefined();
    expect(pick?.mfes.map((m) => [m.package, m.ref, m.requires])).toEqual([["@cs/org-mfe", "main", undefined]]);
    expect(unplaced).toEqual(["@cs/people-mfe"]);
    expect(frontendPick("not a ref", [org], libraries, []).pick).toBeNull();
  });

  it("comes back as the shell and the names picked", () => {
    const { pick } = frontendPick("github:acme/studio-web//studio-frontend@main", [org], libraries, []);
    expect(picksOf(pick!, [org])).toEqual({
      shellRef: "github:acme/studio-web//studio-frontend@main",
      picks: ["@cs/org-mfe"],
    });
    // One saved without its npm name is found by where it is.
    const { package: _, ...anonymous } = pick!.mfes[0];
    expect(picksOf({ ...pick!, mfes: [anonymous] }, [org]).picks).toEqual(["@cs/org-mfe"]);
  });
});

describe("the deployment's FrontX starting points", () => {
  it("are what the Gearbox status says, else FrontX's own templates", () => {
    const own = frontxDefaultsOf({
      frontx: { shell_template: "github:acme/ui//shell@v2", source_repo: "acme/ui", source_ref: "v2" },
    });
    expect(own).toEqual({ shellTemplate: "github:acme/ui//shell@v2", source: { repo: "acme/ui", git_ref: "v2" } });
    const builtIn = { shellTemplate: FRONTX_SHELL_TEMPLATE, source: { repo: SUGGESTED_FRONTX_SOURCE.repo, git_ref: "main" } };
    expect(frontxDefaultsOf(null)).toEqual(builtIn);
    expect(frontxDefaultsOf({})).toEqual(builtIn);
    // A shell that does not read is not offered.
    expect(
      frontxDefaultsOf({ frontx: { shell_template: "acme/ui", source_repo: "", source_ref: "" } }),
    ).toEqual(builtIn);
  });

  it("make the deployment's template repository the templates, and suggest it", () => {
    const mfe = (repo: string) => ({ name: "x", repo, kind: "mfe" }) as unknown as Parameters<typeof splitTemplates>[0][number];
    const { templates, addable } = splitTemplates([mfe("acme/ui"), mfe("acme/shop")], "acme/ui");
    expect(templates.map((m) => m.repo)).toEqual(["acme/ui"]);
    expect(addable.map((m) => m.repo)).toEqual(["acme/shop"]);
    expect(withSuggestedFrontx([], { repo: "acme/ui", git_ref: "v2" })?.[0]).toMatchObject({ repo: "acme/ui", git_ref: "v2" });
  });

  it("take only the template repository itself, not one whose name starts with it", () => {
    const mfe = (repo: string) => ({ name: "x", repo, kind: "mfe" }) as unknown as Parameters<typeof splitTemplates>[0][number];
    const { templates, addable } = splitTemplates(
      [mfe("acme/ui"), mfe("acme/ui-shop"), mfe("https://github.com/acme/ui.git"), mfe("git@github.com:acme/ui")],
      "acme/ui",
    );
    expect(templates.map((m) => m.repo)).toEqual(["acme/ui", "https://github.com/acme/ui.git", "git@github.com:acme/ui"]);
    expect(addable.map((m) => m.repo)).toEqual(["acme/ui-shop"]);
  });
});

describe("what the build steps add up to", () => {
  const step = (id: Step["id"], state: Step["state"]): Step => ({ id, title: id, state, detail: "" });

  it("counts what to fix, never the steps the build itself does", () => {
    const s = stepsSummary([step("shell", "warn"), step("mount", "ok"), step("signin", "bad"), step("build", "todo"), step("ship", "todo")]);
    expect(s).toMatchObject({ tone: "danger", text: "2 things to fix" });
    expect(s.fix.map((x) => x.id)).toEqual(["shell", "signin"]);
  });

  it("is ready to build when every check is ok, though build and ship have not run", () => {
    expect(stepsSummary([step("shell", "ok"), step("info" as never, "info"), step("build", "todo"), step("ship", "todo")])).toMatchObject({
      tone: "ok",
      text: "Ready to build",
    });
  });

  it("says how many steps are not ready when nothing is wrong yet", () => {
    expect(stepsSummary([step("shell", "ok"), step("mount", "todo")]).text).toBe("1 step not ready");
  });
});
