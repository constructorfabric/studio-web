import { describe, expect, it } from "vitest";

import type { ProjectSource } from "./project-sources";
import {
  componentsIn,
  descriptionHome,
  pinnedCommit,
  protectedReady,
  releaseSources,
  shortCommit,
  sourceWarning,
  PROJECT_CONFIG_SOURCE,
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

const SHA = "75f5d9eaffe1a78552e004dfed0aab14cbb266d7";

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
    expect(shortCommit(SHA)).toBe("75f5d9ea");
    expect(shortCommit(null)).toBe("—");
  });
});

describe("a source that cannot be read", () => {
  const conns = new Set(["c1"]);
  it("says the server's reason on its row", () => {
    const why = "the token for connection 'X' is not readable — it may belong to another user (personal scope)";
    expect(sourceWarning(src("acme/api"), [{ source: "Acme/API", reason: why }], conns)).toBe(
      `source acme/api unreadable: ${why}`,
    );
    expect(sourceWarning(src("acme/web"), [{ source: "acme/api", reason: why }], conns)).toBeNull();
  });

  it("says a deleted connection, but only when the connections were read", () => {
    const gone = src("acme/api", { connection_id: "deleted" });
    expect(sourceWarning(gone, [], conns)).toMatch(/connection was deleted/);
    expect(sourceWarning(gone, [], null)).toBeNull();
  });

  it("says an unreadable list of sources on every row", () => {
    expect(sourceWarning(src("acme/api"), [{ source: PROJECT_CONFIG_SOURCE, reason: "503" }], conns)).toBe(
      "the project's sources could not be read: 503",
    );
    expect(sourceWarning(undefined, [{ source: PROJECT_CONFIG_SOURCE, reason: "503" }], conns)).toBeNull();
  });
});
