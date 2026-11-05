import { describe, expect, it } from "vitest";

import type { ProjectSource } from "./project-sources";
import {
  componentsIn,
  descriptionHome,
  pinnedCommit,
  protectedReady,
  releaseSources,
  shortCommit,
  withFlag,
  type LockedSource,
} from "./source-roles";

const src = (full_path: string, extra: Partial<ProjectSource> = {}): ProjectSource => ({
  connection_id: "c1",
  full_path,
  clone_url: `https://github.com/${full_path}.git`,
  branch: "main",
  ...extra,
});

const SHA = "f83375c1586330aa12597ee999641de4be3799e8";

describe("source roles", () => {
  it("marks one source per flag, and clears it on the others", () => {
    const sources = [src("acme/app", { gears_here: true }), src("acme/gears")];
    const moved = withFlag(sources, "gears", "gears_here", true);
    expect(moved.map((s) => !!s.gears_here)).toEqual([false, true]);
    const cleared = withFlag(moved, "gears", "gears_here", false);
    expect(cleared.some((s) => s.gears_here)).toBe(false);
    expect("gears_here" in cleared[0]).toBe(false);
  });

  it("finds the home source as the backend does", () => {
    expect(descriptionHome([src("acme/app"), src("acme/release", { publish_here: true })])).toBe("release");
    expect(descriptionHome([src("acme/docs", { connection_id: "" }), src("acme/app")])).toBe("app");
    expect(descriptionHome([])).toBeNull();
  });

  it("reads the pinned commit, components and release lines of a source", () => {
    const lock: LockedSource[] = [
      { id: "studio-web", kind: "path", repository: "AndrejK666/studio-web", url: "https://github.com/AndrejK666/studio-web.git", branch: "gdl", commit: "a".repeat(40) },
      { id: "studio-web-2", kind: "path", repository: "AndrejK666/studio-web", url: "https://github.com/AndrejK666/studio-web.git", branch: "gdl", commit: "a".repeat(40) },
      { id: "gears-rust", kind: "git", url: "https://github.com/MikeFalcon77/gears-rust.git", commit: SHA },
    ];
    const studio = src("AndrejK666/studio-web");
    expect(pinnedCommit(lock, studio)).toBe("a".repeat(40));
    expect(pinnedCommit(lock, src("acme/other"))).toBeUndefined();
    expect(pinnedCommit([{ ...lock[0], commit: null }], studio)).toBeNull();
    expect(componentsIn([{ repo: "andrejk666/studio-web" }, { repo: "x/y" }], studio)).toBe(1);
    expect(componentsIn(null, studio)).toBeNull();
    const lines = releaseSources(lock);
    expect(lines.map((l) => l.repository)).toEqual(["AndrejK666/studio-web", "MikeFalcon77/gears-rust"]);
    expect(lines[1].external).toBe(true);
    expect(protectedReady(lines)).toBe(true);
    expect(protectedReady(releaseSources([{ ...lock[0], commit: null }]))).toBe(false);
    expect(shortCommit(SHA)).toBe("f83375c1");
    expect(shortCommit(null)).toBe("—");
  });
});
