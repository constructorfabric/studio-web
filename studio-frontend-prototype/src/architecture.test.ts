import { describe, expect, it } from "vitest";

import { buildPrototypeMap, prototypeSrcDir } from "../../scripts/prototype-api-map.mjs";
import {
  COMPONENT_GEAR,
  DOMAINS,
  SURFACES,
  apiDocsUrl,
  capabilityWords,
  commitsDiffer,
  designDocUrl,
  domainLinks,
  domainOf,
  edgeCounts,
  edgesOf,
  gearCounts,
  gearsOfPaths,
  groupPlatform,
  groupStudio,
  leaks,
  normaliseVia,
  pathOwner,
  platformGroupOf,
  reportsUses,
  restComponentsIn,
  restSurfaces,
  summary,
  surfacesOf,
  usedBy,
  usesOf,
} from "./architecture";
import type { ManifestGear } from "./architecture";

const gear = (name: string, extra: Partial<ManifestGear> = {}): ManifestGear => ({
  name,
  origin: name.startsWith("studio-") || name.endsWith("-connector-plugin") ? "studio" : "platform",
  role: name.endsWith("-plugin") ? "plugin" : "gear",
  depends_on: [],
  capabilities: [],
  order: 0,
  ...extra,
});

/* ── Domains ── */

describe("domains", () => {
  it("places every gear the brief names, each in one domain", () => {
    const all = DOMAINS.flatMap((d) => d.gears);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(26);
  });

  it("puts a Studio gear by the table, a plugin with its host, an unknown one in Other", () => {
    expect(domainOf(gear("studio-tasks"))).toBe("background");
    expect(domainOf(gear("github-connector-plugin", { extends: "studio-connector" }))).toBe("repos");
    expect(domainOf(gear("studio-brand-new"))).toBe("other");
    expect(domainOf(gear("account-management"))).toBe("platform");
  });

  it("groups Studio gears in table order and folds plugins under their host", () => {
    const groups = groupStudio([
      gear("studio-git", { order: 1 }),
      gear("studio-connector", { order: 2 }),
      gear("gitlab-connector-plugin", { extends: "studio-connector", order: 3 }),
      gear("studio-authz-plugin", { order: 4 }),
      gear("studio-brand-new", { order: 5 }),
      gear("account-management", { order: 6 }),
    ]);
    expect(groups.map((g) => g.domain.id)).toEqual(["repos", "people", "other"]);
    expect(groups[0].gears.map((g) => g.name)).toEqual(["studio-connector", "studio-git"]);
    expect(groups[0].plugins.get("studio-connector")?.map((g) => g.name)).toEqual(["gitlab-connector-plugin"]);
    // A plugin the table names is a gear of its domain, not folded away.
    expect(groups[1].gears.map((g) => g.name)).toEqual(["studio-authz-plugin"]);
  });

  it("rows the platform by job, a plugin beside its host, the unknown last", () => {
    expect(platformGroupOf({ name: "credstore" })).toBe("Storage");
    expect(platformGroupOf({ name: "static-authn-plugin", extends: "authn-resolver" })).toBe("Sign-in & access");
    expect(platformGroupOf({ name: "keycloak-idp-plugin" })).toBe("Sign-in & access");
    expect(platformGroupOf({ name: "brand-new" })).toBe("Other platform gears");
    expect(platformGroupOf({ name: "brand-new-plugin" })).toBe("Other platform gears");
    const rows = groupPlatform([
      gear("brand-new"),
      gear("static-authn-plugin", { extends: "authn-resolver", order: 1 }),
      gear("authn-resolver", { order: 2 }),
      gear("types-registry", { order: 3 }),
      gear("studio-tasks"),
    ]);
    expect(rows.map((r) => [r.title, r.gears.map((g) => g.name)])).toEqual([
      ["Runtime", ["types-registry"]],
      ["Sign-in & access", ["authn-resolver", "static-authn-plugin"]],
      ["Other platform gears", ["brand-new"]],
    ]);
  });

  it("counts gears the way the header says them", () => {
    expect(
      summary([
        gear("studio-tasks"),
        gear("studio-authz-plugin"),
        gear("github-connector-plugin", { extends: "studio-connector" }),
        gear("credstore"),
      ]),
    ).toEqual({ total: 4, studio: 2, platform: 1, connectorPlugins: 1, domains: 3 });
  });
});

/* ── Who uses whom ── */

describe("uses", () => {
  const GEARS: ManifestGear[] = [
    gear("studio-documents", {
      uses: [
        { gear: "studio-spec-quality", via: "internal", items: ["record"] },
        { gear: "studio-tasks", via: "port", items: ["port"] },
        { gear: "studio-tasks", via: "internal", items: ["registry"] },
        { gear: "studio-documents", via: "internal", items: ["self"] },
      ],
    }),
    gear("studio-reports", {
      uses: [
        { gear: "studio-tasks", via: "internal", items: ["registry", "service"] },
        { gear: "studio-user", via: "surface", items: ["Profile"] },
      ],
    }),
    gear("studio-spec-quality", { uses: [{ gear: "studio-tasks", via: "port" }] }),
    gear("studio-tasks", { uses: [] }),
    gear("studio-user"),
  ];
  const edges = edgesOf(GEARS);

  it("knows whether the backend reports uses", () => {
    expect(reportsUses(GEARS)).toBe(true);
    expect(reportsUses([gear("studio-tasks")])).toBe(false);
  });

  it("keeps one edge per pair with the worst via, and drops self-use", () => {
    expect(edges).toEqual([
      { from: "studio-documents", to: "studio-spec-quality", via: "internal", items: ["record"] },
      { from: "studio-documents", to: "studio-tasks", via: "internal", items: ["port", "registry"] },
      { from: "studio-reports", to: "studio-tasks", via: "internal", items: ["registry", "service"] },
      { from: "studio-reports", to: "studio-user", via: "surface", items: ["Profile"] },
      { from: "studio-spec-quality", to: "studio-tasks", via: "port", items: [] },
    ]);
    expect(edgeCounts(edges)).toEqual({ total: 5, port: 1, surface: 1, internal: 3 });
  });

  it("reads an unknown via as surface", () => {
    expect(normaliseVia("telepathy")).toBe("surface");
    expect(normaliseVia("internal")).toBe("internal");
  });

  it("lists both directions, worst first", () => {
    expect(usesOf(edges, "studio-reports").map((e) => e.to)).toEqual(["studio-tasks", "studio-user"]);
    expect(usedBy(edges, "studio-tasks").map((e) => [e.from, e.via])).toEqual([
      ["studio-documents", "internal"],
      ["studio-reports", "internal"],
      ["studio-spec-quality", "port"],
    ]);
    expect(gearCounts(edges, "studio-tasks")).toEqual({ uses: 0, usedBy: 3, reachedInto: 2, reachesInto: 0 });
    expect(gearCounts(edges, "studio-documents")).toEqual({ uses: 2, usedBy: 0, reachedInto: 0, reachesInto: 2 });
  });

  it("ranks the leaks by how many gears reach in, then by module", () => {
    expect(leaks(edges)).toEqual([
      {
        gear: "studio-tasks",
        users: ["studio-documents", "studio-reports"],
        modules: [
          { item: "registry", users: ["studio-documents", "studio-reports"] },
          { item: "port", users: ["studio-documents"] },
          { item: "service", users: ["studio-reports"] },
        ],
      },
      { gear: "studio-spec-quality", users: ["studio-documents"], modules: [{ item: "record", users: ["studio-documents"] }] },
    ]);
  });

  it("sums uses between domains, leaving uses inside one domain out", () => {
    expect(domainLinks(edges, GEARS)).toEqual([
      { from: "specs", to: "background", total: 2, internal: 1 },
      { from: "reporting", to: "background", total: 1, internal: 1 },
      { from: "reporting", to: "people", total: 1, internal: 0 },
    ]);
  });
});

/* ── The application map, held to the code ── */

// Every source file of the prototype, as text — tests and generated code aside.
const SOURCES = Object.entries(
  import.meta.glob<string>("./**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }),
).filter(([path]) => !/\.test\.tsx?$|\.gen\.ts$|\/_to_delete\//.test(path));

// The IDE's Studio extension, where the repository has it beside the prototype.
const THEIA = Object.entries(
  import.meta.glob<string>("../../theia/studio/src/{browser,node}/**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).filter(([path]) => !/\.(test|spec)\.tsx?$/.test(path));

const MAP = buildPrototypeMap({ srcDir: prototypeSrcDir() });

describe("the application map", () => {
  it("finds the prototype's sources and its map", () => {
    expect(SOURCES.length).toBeGreaterThan(20);
    expect(MAP.screens.length).toBeGreaterThan(20);
  });

  it("maps every REST component the prototype's code names to a gear", () => {
    const named = [...new Set(SOURCES.flatMap(([, text]) => restComponentsIn(text)))].sort();
    const unmapped = named.filter((c) => !(c in COMPONENT_GEAR));
    // A new prefix in api.ts (or anywhere in src/) lands here: add it to
    // COMPONENT_GEAR and to the surfaces that call it.
    expect(unmapped).toEqual([]);
  });

  it("lists, for each portal surface, exactly the gears its components call", () => {
    const byName = new Map<string, string[]>();
    for (const s of MAP.screens) byName.set(s.name, [...(byName.get(s.name) ?? []), ...s.paths]);
    const wrong: Record<string, { table: string[]; code: string[] }> = {};
    for (const surface of SURFACES.filter((s) => s.components)) {
      const code = gearsOfPaths(surface.components!.flatMap((c) => byName.get(c) ?? []));
      if (JSON.stringify(code) !== JSON.stringify(surface.gears)) wrong[surface.id] = { table: surface.gears, code };
    }
    expect(wrong).toEqual({});
  });

  it("names only components that exist and call the backend", () => {
    const known = new Set(MAP.screens.map((s) => s.name));
    const missing = SURFACES.flatMap((s) => (s.components ?? []).filter((c) => !known.has(c)));
    expect(missing).toEqual([]);
  });

  it("places every component that calls the backend on some surface", () => {
    const placed = new Set(SURFACES.flatMap((s) => s.components ?? []));
    const unplaced = [...new Set(MAP.screens.map((s) => s.name))].filter((n) => !placed.has(n)).sort();
    // A new screen lands here: add it to the SURFACES entry a person reaches it from.
    expect(unplaced).toEqual([]);
  });

  it("keeps every gear list sorted and every gear known to the REST table", () => {
    const gears = new Set(Object.values(COMPONENT_GEAR));
    for (const s of SURFACES) {
      expect([...s.gears].sort(), s.id).toEqual(s.gears);
      expect(s.gears.filter((g) => !gears.has(g) && !(s.hostedBy ?? []).includes(g)), s.id).toEqual([]);
    }
  });

  it.skipIf(THEIA.length === 0)("lists, for the IDE and the desktop app, the gears their code calls", () => {
    const gearsOf = (files: [string, string][]) =>
      [...new Set(files.flatMap(([, text]) => restComponentsIn(text)).map((c) => COMPONENT_GEAR[c] ?? c))].sort();
    const desktopOnly = (path: string) => /\/(desktop-|gearbox-)[^/]*$/.test(path);
    const ide = SURFACES.find((s) => s.id === "ide")!;
    const desktop = SURFACES.find((s) => s.id === "desktop")!;
    const without = (s: typeof ide) => s.gears.filter((g) => !(s.hostedBy ?? []).includes(g));
    expect(without(ide)).toEqual(gearsOf(THEIA.filter(([p]) => !desktopOnly(p))));
    expect(without(desktop)).toEqual(gearsOf(THEIA.filter(([p]) => desktopOnly(p))));
  });

  it("answers which surfaces rely on a gear", () => {
    expect(surfacesOf("studio-scheduler").map((s) => s.id)).toEqual(["background-work"]);
    expect(surfacesOf("studio-git").map((s) => s.id)).toEqual(["desktop"]);
  });

  it("reads REST components out of source text", () => {
    expect(
      restComponentsIn('request("/studio-tasks/v1/runs"); `/cf/studio-presence/v1/me`; "/api/file-storage/v1/files"; "/not/a/path"'),
    ).toEqual(["file-storage", "studio-presence", "studio-tasks"]);
  });
});

/* ── REST and links ── */

describe("pathOwner and restSurfaces", () => {
  const NAMES = ["studio-tasks", "studio-identity-directory", "file-storage", "studio-llm-proxy"];
  it("finds the gear by name, by the table, or by the one gear the segment starts", () => {
    expect(pathOwner("/studio-tasks/v1/runs", NAMES)).toBe("studio-tasks");
    expect(pathOwner("/api/file-storage/v1/files", NAMES)).toBe("file-storage");
    expect(pathOwner("/studio-identity/v1/users", NAMES)).toBe("studio-identity-directory");
    expect(pathOwner(`/studio-${"llm"}/v1/providers`, NAMES)).toBe("studio-llm-proxy");
    expect(pathOwner("/mini-chat/v1/chats", NAMES)).toBeNull();
    expect(pathOwner("/studio/v1/x", ["studio-a", "studio-b"])).toBeNull();
  });
  it("counts operations per gear", () => {
    const byGear = restSurfaces(
      {
        paths: {
          "/studio-tasks/v1/runs": { get: {}, post: {} },
          "/studio-tasks/v1/task-types": { get: {}, parameters: [] },
          "/oagw/v1/upstreams": { get: {} },
        },
      },
      NAMES,
    );
    expect(byGear.get("studio-tasks")).toEqual({ prefixes: ["/studio-tasks/v1"], component: "studio-tasks", operations: 3 });
    expect(byGear.has("oagw")).toBe(false);
  });
});

describe("words and links", () => {
  it("says capabilities plainly", () => {
    expect(capabilityWords("db")).toBe("owns tables in Postgres");
    expect(capabilityWords("odd")).toBe("odd");
  });
  it("warns only when both commits are known and differ", () => {
    expect(commitsDiffer("a", "b")).toBe(true);
    expect(commitsDiffer("a", "a")).toBe(false);
    expect(commitsDiffer(null, "b")).toBe(false);
  });
  it("links a design at the backend's commit, or main", () => {
    expect(designDocUrl("docs/design/studio-tasks.md", "abc")).toBe(
      "https://github.com/constructorfabric/studio-web/blob/abc/docs/design/studio-tasks.md",
    );
    expect(designDocUrl("docs/design/studio-tasks.md", null)).toContain("/blob/main/");
    expect(apiDocsUrl("studio-identity")).toBe("/api-docs/?component=studio-identity");
  });
});
