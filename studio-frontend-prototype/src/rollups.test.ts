/* What is left to test here after the counting moved to the server.
 *
 * The rules this file used to prove — a count that is not known is null and
 * never 0, one dead gear costs one number rather than the row, a total comes
 * from the store and not from `length` — did not disappear. They moved with the
 * code that enforces them, to `studio-backend/src/organizations/rollups.rs`,
 * and are proved there. A rule whose test stays behind on the side that no
 * longer owns it is a rule nobody is checking.
 *
 * What remains on this side is the mapping of the server's answer onto the two
 * shapes these screens want, and the one line that renders a count. Both can be
 * wrong on their own, so both are still tested.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { portfolioRollups, projectRollup, rollupText } from "./rollups";
import { api } from "./api";

describe("rollupText", () => {
  it("renders a dash for unknown and the digits for a known count", () => {
    expect(rollupText(null)).toBe("—");
    expect(rollupText(7)).toBe("7");
  });

  it("renders a real zero as 0, not as unknown", () => {
    expect(rollupText(0)).toBe("0");
  });
});

describe("portfolioRollups", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("splits the one answer into workspaces and projects", async () => {
    vi.spyOn(api, "rollups").mockResolvedValue({
      total: 3,
      items: [
        { id: "ws", name: "Workspace", kind: "workspace", projects: 2 },
        { id: "p1", name: "One", kind: "project", parent_id: "ws", documents: 4, findings: 0, repos: 1 },
        { id: "p2", name: "Two", kind: "project", parent_id: "ws", documents: null, findings: 2, repos: 0 },
      ],
    });

    const { workspaces, projects } = await portfolioRollups("t");

    expect(workspaces.get("ws")).toEqual({ name: "Workspace", projects: 2 });
    expect(projects.get("p1")?.documents).toBe(4);
    // The parentage comes back with the counts, so a tree needs no second ask.
    expect(projects.get("p2")?.parentId).toBe("ws");
  });

  it("asks for one workspace when the table shows one", async () => {
    const spy = vi.spyOn(api, "rollups").mockResolvedValue({ total: 0, items: [] });

    await portfolioRollups("t", "ws");

    expect(spy).toHaveBeenCalledWith("t", undefined, "ws");
  });

  it("keeps a missing count as null and a real zero as zero", async () => {
    vi.spyOn(api, "rollups").mockResolvedValue({
      total: 1,
      items: [
        { id: "p", name: "P", kind: "project", parent_id: "ws", documents: null, findings: 0, repos: 0 },
      ],
    });

    const { projects } = await portfolioRollups("t");

    // The distinction the whole design turns on: one of these means "nobody
    // could tell me" and the other means "there are none".
    expect(projects.get("p")?.documents).toBeNull();
    expect(projects.get("p")?.findings).toBe(0);
  });
});

describe("projectRollup", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reads the single row the server returns for one project", async () => {
    vi.spyOn(api, "rollups").mockResolvedValue({
      total: 1,
      items: [
        { id: "p", name: "P", kind: "project", parent_id: "ws", documents: 42, findings: 1, repos: 3 },
      ],
    });

    expect(await projectRollup("t", "p")).toEqual({ documents: 42, findings: 1, repos: 3 });
  });

  it("reports every column as unknown when the call fails", async () => {
    vi.spyOn(api, "rollups").mockRejectedValue(new Error("gateway"));

    // Not an empty project — a project nobody could count. Rendering zeroes
    // here would tell somebody there is nothing to look at.
    expect(await projectRollup("t", "p")).toEqual({
      documents: null,
      findings: null,
      repos: null,
    });
  });

  it("reports unknown when the project has no row at all", async () => {
    vi.spyOn(api, "rollups").mockResolvedValue({ total: 0, items: [] });

    expect(await projectRollup("t", "gone")).toEqual({
      documents: null,
      findings: null,
      repos: null,
    });
  });
});
