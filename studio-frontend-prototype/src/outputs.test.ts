import { describe, expect, it } from "vitest";
import type { ArtifactNode, BuildOutput, DocBinding } from "./api";
import type { BuildRun } from "./builds";
import { documentRows, expiryText, formatBytes, groupOutputs, outputVersions, storedFiles } from "./outputs";

const output = (o: Partial<BuildOutput> & Pick<BuildOutput, "id" | "kind">): BuildOutput => ({
  title: o.id,
  expired: false,
  draft: false,
  prerelease: false,
  assets: [],
  ...o,
});

const run = (id: string, createdAt: string): BuildRun =>
  ({ id, createdAt, workflow: "CI", status: "passed" }) as BuildRun;

describe("groupOutputs", () => {
  it("hangs artifacts under the build that kept them, newest build first", () => {
    const { builds, releases } = groupOutputs(
      [
        output({ id: "b", kind: "build_artifact", run: "r1", title: "zeta" }),
        output({ id: "a", kind: "build_artifact", run: "r1", title: "alpha" }),
        output({ id: "c", kind: "build_artifact", run: "r2" }),
        output({ id: "rel-old", kind: "release", published_at: "2026-01-01T00:00:00Z" }),
        output({ id: "rel-new", kind: "release", published_at: "2026-10-01T00:00:00Z" }),
      ],
      [run("r1", "2026-10-01T00:00:00Z"), run("r2", "2026-10-18T00:00:00Z")],
    );
    expect(builds.map((b) => b.runId)).toEqual(["r2", "r1"]);
    expect(builds[1].artifacts.map((a) => a.title)).toEqual(["alpha", "zeta"]);
    expect(builds[1].run?.id).toBe("r1");
    expect(releases.map((r) => r.id)).toEqual(["rel-new", "rel-old"]);
  });

  it("keeps an artifact whose run the sync no longer holds, on a build of its own", () => {
    const { builds } = groupOutputs(
      [
        output({ id: "x", kind: "build_artifact", run: "gone" }),
        output({ id: "y", kind: "build_artifact", run: null }),
      ],
      [],
    );
    expect(builds).toHaveLength(2);
    expect(builds.every((b) => b.run === null)).toBe(true);
  });
});

describe("outputVersions", () => {
  const ran = (id: string, sha: string, status: BuildRun["status"], createdAt: string): BuildRun =>
    ({ id, shortSha: sha, status, createdAt, branch: "main", workflow: "CI" }) as BuildRun;

  it("groups the files by the commit built, passed ones only unless asked", () => {
    const { builds } = groupOutputs(
      [
        output({ id: "a", kind: "build_artifact", run: "r1", title: "site" }),
        output({ id: "b", kind: "build_artifact", run: "r2", title: "chart" }),
        output({ id: "c", kind: "build_artifact", run: "r3", title: "site" }),
      ],
      [
        ran("r1", "aaa1111", "passed", "2026-10-01T00:00:00Z"),
        ran("r2", "aaa1111", "failed", "2026-10-02T00:00:00Z"),
        ran("r3", "bbb2222", "cancelled", "2026-10-03T00:00:00Z"),
      ],
    );
    const passed = outputVersions(builds, true);
    expect(passed.map((v) => v.version)).toEqual(["aaa1111"]);
    expect(passed[0].files.map((f) => f.title).sort()).toEqual(["chart", "site"]);
    expect(passed[0].passed).toBe(true);
    const all = outputVersions(builds, false);
    expect(all.map((v) => [v.version, v.passed])).toEqual([
      ["bbb2222", false],
      ["aaa1111", true],
    ]);
  });
});

describe("formatBytes", () => {
  it("reads like a size", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(3_200)).toBe("3.1 KB");
    expect(formatBytes(88_080_384)).toBe("84 MB");
    expect(formatBytes(null)).toBe("—");
  });
});

describe("expiryText", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  it("counts the days the provider still keeps it", () => {
    expect(expiryText({ expired: false, expires_at: "2027-01-15T12:00:00Z" }, now)).toBe("expires in 88 d");
    expect(expiryText({ expired: false, expires_at: "2026-10-19T20:00:00Z" }, now)).toBe("expires today");
    expect(expiryText({ expired: false, expires_at: "2026-10-18T00:00:00Z" }, now)).toBe("expired");
    expect(expiryText({ expired: true, expires_at: null }, now)).toBe("expired");
    expect(expiryText({ expired: false, expires_at: null }, now)).toBeNull();
  });
});

describe("documentRows", () => {
  const binding = (b: Partial<DocBinding>): DocBinding =>
    ({ id: b.path, node_id: `n-${b.path}`, candidates: [], ...b }) as DocBinding;
  it("keeps only the files Studio knows the type of", () => {
    const rows = documentRows([
      binding({ path: "docs/z.md", type_key: "prd", state: "detected", conforms: false }),
      binding({ path: "docs/a.md", type_key: "glossary", state: "confirmed" }),
      binding({ path: "README.md", type_key: null, state: "unknown" }),
      binding({ path: "src/x.rs", type_key: "prd", state: "not_a_document" }),
    ]);
    expect(rows.map((r) => r.path)).toEqual(["docs/a.md", "docs/z.md"]);
    expect(rows[0]).toMatchObject({ type: "glossary", confirmed: true, conforms: null });
    expect(rows[1]).toMatchObject({ confirmed: false, conforms: false });
  });
});

describe("storedFiles", () => {
  const node = (id: string, value: Record<string, unknown>): ArtifactNode =>
    ({ type_id: "file", instance_id: id, value }) as unknown as ArtifactNode;
  it("keeps added and generated files, not a repository's", () => {
    const files = storedFiles([
      node("1", { path: "brief.pdf", origin: "manual", size: 10, object_ref: { file_id: "f", version_id: "v" } }),
      node("2", { path: "diagram.png", origin: "generated" }),
      node("3", { path: "src/main.rs" }),
    ]);
    expect(files.map((f) => f.path)).toEqual(["brief.pdf", "diagram.png"]);
    expect(files[0]).toMatchObject({ origin: "manual", fileId: "f", versionId: "v", size: 10 });
    expect(files[1]).toMatchObject({ origin: "generated", fileId: null, size: null });
  });
});
