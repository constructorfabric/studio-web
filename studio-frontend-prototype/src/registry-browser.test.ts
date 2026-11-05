import { describe, expect, it } from "vitest";

import type { RegistryOrphan } from "./api";
import { orphanGroups, orphanSummary, repositoryRows, roleWords, sortTags, versionDeletion } from "./registry-browser";

const orphan = (repository: string, reason: RegistryOrphan["reason"]): RegistryOrphan => ({ repository, reason, tags: [] });

describe("a registry's repositories and versions", () => {
  it("lists repositories by name with whose they are", () => {
    const rows = repositoryRows([
      { name: "acme/web/api", project_id: "11111111-aaaa", project_name: "Web", recorded: 3 },
      { name: "acme/legacy", recorded: 0 },
      { name: "acme/ml/model", project_id: "22222222-bbbb", recorded: 1 },
    ]);
    expect(rows.map((r) => [r.name, r.owner])).toEqual([
      ["acme/legacy", "no project"],
      ["acme/ml/model", "22222222"],
      ["acme/web/api", "Web"],
    ]);
  });

  it("puts the newest version first and one with no push time last", () => {
    const tags = sortTags([
      { digest: "a", tags: [], pushed_at: "2026-10-01T00:00:00Z", running_in: [] },
      { digest: "b", tags: [], running_in: [] },
      { digest: "c", tags: [], pushed_at: "2026-11-01T00:00:00Z", running_in: [] },
    ]);
    expect(tags.map((t) => t.digest)).toEqual(["c", "a", "b"]);
  });

  it("refuses to delete a version that runs, saying where", () => {
    expect(versionDeletion({ running_in: [], digest: "sha256:a" })).toEqual({ allowed: true, reason: null });
    // A listing that gives no digest has nothing to delete by.
    expect(versionDeletion({ running_in: [], digest: null }).allowed).toBe(false);
    const r = versionDeletion({
      running_in: [{ environment_id: "e", environment_name: "prod", deployment_id: "d", namespace: "web-prod", deployed_at: "" }],
    });
    expect(r).toEqual({ allowed: false, reason: "Runs in prod. Deploy something else there first." });
  });

  it("says what the environments do with it", () => {
    expect(roleWords("pull")).toBe("clusters pull from it");
    expect(roleWords("push_pull")).toBe("builds push to it and clusters pull from it");
  });
});

describe("orphans", () => {
  const orphans = [orphan("b", "undeployed"), orphan("a", "undeployed"), orphan("x", "missing"), orphan("y", "unowned")];

  it("groups them by what breaks a deploy first", () => {
    expect(orphanGroups(orphans).map((g) => [g.reason, g.items.map((o) => o.repository)])).toEqual([
      ["missing", ["x"]],
      ["unowned", ["y"]],
      ["undeployed", ["a", "b"]],
    ]);
  });

  it("sums them up in a line", () => {
    expect(orphanSummary([])).toBe("Nothing: everything in it is accounted for.");
    expect(orphanSummary(orphans)).toBe("1 missing · 1 of no project · 2 never deployed");
  });
});
