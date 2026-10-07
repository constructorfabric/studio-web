import { describe, expect, it } from "vitest";

import {
  apiDocsUrl,
  commitsDiffer,
  dependents,
  designDocUrl,
  fileTitle,
  joinPrototype,
  layered,
  layers,
  pathOwner,
  restSurfaces,
  screenTitle,
  summary,
} from "./architecture";
import type { ManifestGear, PrototypeMap } from "./architecture";

const gear = (name: string, depends_on: string[] = [], extra: Partial<ManifestGear> = {}): ManifestGear => ({
  name,
  origin: name.startsWith("studio-") ? "studio" : "platform",
  role: "gear",
  depends_on,
  capabilities: [],
  order: 0,
  ...extra,
});

const GEARS: ManifestGear[] = [
  gear("types-registry", [], { role: "system", order: 0 }),
  gear("account-management", ["types-registry"], { order: 1 }),
  gear("studio-presence", [], { order: 2 }),
  gear("studio-tasks", ["account-management"], { order: 3 }),
  gear("studio-identity-directory", ["account-management"], { order: 4 }),
  gear("gitlab-connector-plugin", ["types-registry"], { role: "plugin", origin: "studio", order: 5 }),
  gear("file-storage", [], { order: 6 }),
];
const NAMES = GEARS.map((g) => g.name);

describe("layers", () => {
  it("puts a gear one below the deepest thing it needs", () => {
    const depth = layers(GEARS);
    expect(depth.get("types-registry")).toBe(0);
    expect(depth.get("studio-presence")).toBe(0);
    expect(depth.get("account-management")).toBe(1);
    expect(depth.get("studio-tasks")).toBe(2);
  });

  it("ignores a dependency that is not linked", () => {
    expect(layers([gear("a", ["missing"])]).get("a")).toBe(0);
  });

  it("does not loop on a cycle", () => {
    const depth = layers([gear("a", ["b"]), gear("b", ["a"])]);
    expect(depth.size).toBe(2);
  });

  it("orders each layer by start order", () => {
    const rows = layered(GEARS);
    expect(rows[0].map((g) => g.name)).toEqual(["types-registry", "studio-presence", "file-storage"]);
    expect(rows[2].map((g) => g.name)).toEqual(["studio-tasks", "studio-identity-directory"]);
  });
});

describe("dependents", () => {
  it("lists who needs a gear", () => {
    expect(dependents(GEARS, "account-management")).toEqual(["studio-tasks", "studio-identity-directory"]);
  });
});

describe("pathOwner", () => {
  it("is the gear named by the first segment", () => {
    expect(pathOwner("/studio-tasks/v1/runs", NAMES)).toBe("studio-tasks");
    expect(pathOwner("/api/file-storage/v1/files", NAMES)).toBe("file-storage");
  });
  it("falls back to the one gear whose name starts with the segment", () => {
    expect(pathOwner("/studio-identity/v1/users", NAMES)).toBe("studio-identity-directory");
  });
  it("answers nobody when the segment matches no gear, or two", () => {
    expect(pathOwner("/mini-chat/v1/chats", NAMES)).toBeNull();
    expect(pathOwner("/studio/v1/x", ["studio-a", "studio-b"])).toBeNull();
  });
});

describe("restSurfaces", () => {
  const { byGear, unowned } = restSurfaces(
    {
      paths: {
        "/studio-tasks/v1/runs": { get: { tags: ["StudioTasks"] }, post: { tags: ["StudioTasks"] } },
        "/studio-tasks/v1/task-types": { get: { tags: ["StudioTasks"] } },
        "/studio-identity/v1/users": { get: { tags: ["StudioIdentity"] }, parameters: [] },
        "/oagw/v1/upstreams": { get: {} },
      },
    },
    NAMES,
  );
  it("counts operations and collects prefixes and tags per gear", () => {
    expect(byGear.get("studio-tasks")).toEqual({
      prefixes: ["/studio-tasks/v1"],
      component: "studio-tasks",
      tags: ["StudioTasks"],
      operations: 3,
    });
    expect(byGear.get("studio-identity-directory")?.component).toBe("studio-identity");
  });
  it("keeps what no linked gear serves apart", () => {
    expect(unowned).toEqual(["/oagw/v1"]);
  });
});

describe("joinPrototype", () => {
  const map: PrototypeMap = {
    commit: "abc",
    screens: [
      {
        name: "BackgroundWork",
        file: "src/tasks.tsx",
        paths: ["/studio-tasks/v1/runs", "/studio-tasks/v1/runs/{}"],
      },
      { name: "ChatsView", file: "src/App.tsx", paths: ["/mini-chat/v1/chats", "/studio-presence/v1/me"] },
    ],
  };
  const joined = joinPrototype(map, NAMES);
  it("lists the gears a screen calls, once each", () => {
    expect(joined.gearsOf.get(map.screens[0])).toEqual(["studio-tasks"]);
    expect(joined.gearsOf.get(map.screens[1])).toEqual(["studio-presence"]);
  });
  it("lists the screens that call a gear", () => {
    expect(joined.screensOf.get("studio-tasks")?.map((s) => s.name)).toEqual(["BackgroundWork"]);
  });
  it("keeps calls to gears this backend does not have", () => {
    expect(joined.unowned).toEqual(["/mini-chat/v1/chats"]);
  });
});

describe("the header", () => {
  it("warns only when both commits are known and differ", () => {
    expect(commitsDiffer("a", "b")).toBe(true);
    expect(commitsDiffer("a", "a")).toBe(false);
    expect(commitsDiffer(null, "b")).toBe(false);
    expect(commitsDiffer("a", undefined)).toBe(false);
  });
  it("counts the gears by origin and role", () => {
    expect(summary(GEARS)).toEqual({ total: 7, studio: 4, platform: 3, plugins: 1 });
  });
});

describe("links and names", () => {
  it("reads a design at the backend's commit, or main for a local build", () => {
    expect(designDocUrl("docs/design/studio-tasks.md", "abc")).toBe(
      "https://github.com/constructorfabric/studio-web/blob/abc/docs/design/studio-tasks.md",
    );
    expect(designDocUrl("docs/design/studio-tasks.md", null)).toContain("/blob/main/");
  });
  it("opens /api-docs/ on one component", () => {
    expect(apiDocsUrl("studio-identity")).toBe("/api-docs/?component=studio-identity");
  });
  it("spells code names as words", () => {
    expect(screenTitle("OrgMembersView")).toBe("Org members view");
    expect(screenTitle("StudioAI")).toBe("Studio AI");
    expect(fileTitle("src/org-admin.tsx")).toBe("Org admin");
    expect(fileTitle("src/App.tsx")).toBe("Portal shell (App.tsx)");
  });
});
