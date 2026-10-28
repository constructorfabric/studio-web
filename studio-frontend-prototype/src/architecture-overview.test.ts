import { describe, expect, it } from "vitest";

import { TABS, tabFromHash } from "./architecture-overview";

describe("tabFromHash", () => {
  it("opens the view a link names", () => {
    expect(tabFromHash("#data")).toBe("data");
    expect(tabFromHash("#flow")).toBe("flow");
  });

  it("leaves a gear or a place to the selection, and anything else to the default", () => {
    expect(tabFromHash("#gear=studio-documents")).toBeNull();
    expect(tabFromHash("#surface=home")).toBeNull();
    expect(tabFromHash("")).toBeNull();
  });

  it("has one tab per view, each with a hint", () => {
    expect(new Set(TABS.map((t) => t.id)).size).toBe(TABS.length);
    for (const t of TABS) expect(t.hint.length).toBeGreaterThan(10);
  });
});
