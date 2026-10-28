import { describe, expect, it } from "vitest";
import { pathToPlace, placeToPath, type UrlPlace } from "./place-url";

const KNOWN = {
  projectTabs: ["overview", "specs", "components", "kits"],
  workspaceTabs: ["projects", "types", "process"],
  adminViews: ["people", "access", "secrets"],
};

const base: UrlPlace = {
  view: "projects",
  crumb: {},
  projectTab: "overview",
  workspaceTab: "projects",
  activeOrgId: null,
  adminOpen: false,
  adminView: "people",
};

describe("the portal's address", () => {
  it("writes each place as a path", () => {
    expect(placeToPath(base)).toBe("/workspaces");
    expect(placeToPath({ ...base, view: "gears" })).toBe("/components");
    expect(placeToPath({ ...base, view: "connectors" })).toBe("/connections");
    expect(placeToPath({ ...base, crumb: { projectId: "ws1" } })).toBe("/workspaces/ws1");
    expect(placeToPath({ ...base, crumb: { projectId: "ws1" }, workspaceTab: "types" })).toBe("/workspaces/ws1/types");
    expect(placeToPath({ ...base, crumb: { projectId: "ws1", nestedId: "p1" } })).toBe("/workspaces/ws1/projects/p1");
    expect(placeToPath({ ...base, crumb: { projectId: "ws1", nestedId: "p1" }, projectTab: "kits" })).toBe(
      "/workspaces/ws1/projects/p1/kits",
    );
    expect(placeToPath({ ...base, adminOpen: true, adminView: "secrets" })).toBe("/admin/secrets");
    expect(placeToPath({ ...base, activeOrgId: "org-9" })).toBe("/workspaces?org=org-9");
  });

  it("reads back every path it writes", () => {
    const places: UrlPlace[] = [
      { ...base, view: "gears" },
      { ...base, crumb: { projectId: "ws1" }, workspaceTab: "process" },
      { ...base, crumb: { projectId: "ws1", nestedId: "p1" }, projectTab: "specs", activeOrgId: "org-9" },
      { ...base, adminOpen: true, adminView: "access" },
    ];
    for (const place of places) {
      const url = new URL(placeToPath(place), "http://portal");
      const back = pathToPlace(url.pathname, url.search, KNOWN)!;
      expect(placeToPath({ ...base, ...back, crumb: back.crumb ?? place.crumb })).toBe(placeToPath(place));
    }
  });

  it("opens a place on its default tab when the address names none", () => {
    expect(pathToPlace("/workspaces/ws1/projects/p1", "", KNOWN)).toMatchObject({ projectTab: "overview" });
    expect(pathToPlace("/workspaces/ws1", "", KNOWN)).toMatchObject({ workspaceTab: "projects" });
  });

  it("opens the Frontend tab's old address on Product, which now holds it", () => {
    expect(pathToPlace("/workspaces/ws1/projects/p1/frontend", "", KNOWN)).toMatchObject({
      crumb: { projectId: "ws1", nestedId: "p1" },
      projectTab: "components",
    });
  });

  it("answers nothing for an address that is not a place of ours", () => {
    for (const path of ["/", "/space/5f6c1c9e-0000-4000-8000-000000000000", "/cf/studio-kits/v1/catalog", "/studio/abc", "/nowhere", "/components/extra", "/workspaces/ws1/projects/p1/unknown-tab", "/admin/nothing", "/workspaces/%E0%A4%A"]) {
      expect(pathToPlace(path, "", KNOWN), path).toBeUndefined();
    }
  });

  it("ignores an organization id that could not be one", () => {
    expect(pathToPlace("/workspaces", "?org=%3Cscript%3E", KNOWN)).not.toHaveProperty("activeOrgId");
    expect(pathToPlace("/workspaces", "?org=org-9", KNOWN)).toMatchObject({ activeOrgId: "org-9" });
  });
});

describe("sections that moved into administration", () => {
  it("still land a kept link on the same screen, now under /admin/", () => {
    expect(pathToPlace("/objects", "", KNOWN)).toEqual({ adminOpen: true, adminView: "objects" });
    expect(pathToPlace("/views", "?org=org-1", KNOWN)).toEqual({
      adminOpen: true,
      adminView: "views",
      activeOrgId: "org-1",
    });
  });

  it("are written under /admin/", () => {
    expect(placeToPath({ ...base, adminOpen: true, adminView: "objects" })).toBe("/admin/objects");
  });
});
