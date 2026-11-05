import { describe, expect, it } from "vitest";

import type { ScreenPreview } from "./api";
import { pictureOf, previewBuild, shortCommit } from "./screen-previews";

const shot = (commit: string, route: string, order: number, version: string | null = "0.1.0", at = "2026-11-01T00:00:00Z"): ScreenPreview => ({
  component: "@constructor-studio/projects-mfe",
  version,
  commit,
  route,
  label: route.slice(1),
  order,
  image: "data:image/webp;base64,AAAA",
  width: 960,
  height: 600,
  captured_at: at,
});

describe("previewBuild", () => {
  it("shows the newest build's screens in the build's order", () => {
    const b = previewBuild([shot("new", "/b", 1), shot("new", "/a", 0), shot("old", "/a", 0)], null);
    expect(b?.commit).toBe("new");
    expect(b?.screens.map((s) => s.route)).toEqual(["/a", "/b"]);
  });

  it("shows only a build of the version the catalogue lists", () => {
    const items = [shot("new", "/a", 0, "0.2.0"), shot("old", "/a", 0, "0.1.0")];
    expect(previewBuild(items, "0.1.0")?.commit).toBe("old");
    expect(previewBuild(items, "0.3.0")).toBeNull();
  });

  it("has nothing to show without a picture", () => {
    expect(previewBuild([], null)).toBeNull();
    expect(previewBuild([{ ...shot("c", "/a", 0), image: "" }], null)).toBeNull();
  });
});

describe("shortCommit", () => {
  it("cuts a hash and keeps a name", () => {
    expect(shortCommit("a30193a2d640")).toBe("a30193a");
    expect(shortCommit("local")).toBe("local");
  });
});

describe("pictureOf", () => {
  const build = previewBuild([shot("c", "/projects", 0), shot("c", "/projects/activity", 1)], null);

  it("finds a place's picture by its route", () => {
    expect(pictureOf(build, { route: "/projects/activity", label: "Activity" })?.route).toBe("/projects/activity");
  });

  it("has none for a place the build did not open", () => {
    expect(pictureOf(build, { route: "/projects/new", label: "projects" })).toBeNull();
    expect(pictureOf(null, { route: "/projects", label: null })).toBeNull();
  });

  it("finds a place without a route by its label", () => {
    expect(pictureOf(build, { route: null, label: "Projects/Activity" })?.route).toBe("/projects/activity");
    expect(pictureOf(build, { route: null, label: null })).toBeNull();
  });
});
