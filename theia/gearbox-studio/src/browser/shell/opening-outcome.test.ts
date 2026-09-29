import { sourceRootsOf, sourcesUsable } from "./opening-outcome";

describe("a product's sources", () => {
  const intent = {
    sources: {
      "gears-rust": { kind: "git", url: "https://github.com/o/gears-rust.git", rev: "a".repeat(40), tag: null, branch: null },
      local: { kind: "path", at: "../local" },
    },
  } as never;

  it("takes a git source brought here as a root, and a path source as resolved", () => {
    const sources = sourceRootsOf(intent, (at) => `/p/${at}`, { "gears-rust": "/cache/gears-rust" });
    expect(sources).toEqual({ roots: ["/cache/gears-rust", "/p/../local"], refused: [] });
    expect(sourcesUsable("shop", sources).ok).toBe(true);
  });

  it("refuses a git source that could not be fetched, with git's reason and no word of it being unbuilt", () => {
    const sources = sourceRootsOf(intent, (at) => `/p/${at}`);
    expect(sources.refused).toEqual(["gears-rust"]);
    const outcome = sourcesUsable("shop", sources, { "gears-rust": "https://github.com/o/gears-rust.git could not be fetched: Repository not found." });
    expect(outcome.ok).toBe(false);
    const reason = outcome.ok ? "" : outcome.reason;
    expect(reason).toContain("gears-rust");
    expect(reason).toContain("Repository not found");
    expect(reason).not.toContain("not built");
  });

  it("still says what to check when git gave no reason", () => {
    const outcome = sourcesUsable("shop", { roots: [], refused: ["gears-rust"] });
    expect(outcome.ok ? "" : outcome.reason).toContain("Check its URL and revision");
  });

  it("refuses a product with no sources at all", () => {
    expect(sourcesUsable("shop", { roots: [], refused: [] })).toEqual({
      ok: false,
      reason: "shop declares no source roots, so there are no gears to compose.",
    });
  });
});
