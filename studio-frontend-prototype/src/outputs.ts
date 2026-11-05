/* The project's Artifacts tab: what the project produced and what it holds.
 *
 * Outputs are what the builds produced -- the files CI runs kept, under the
 * build that kept them, and the repositories' releases. Documents & files are
 * the repository files Studio knows the type of, and the files people added
 * by hand or Studio generated.
 *
 * The tab used to be the artifact graph dumped as tables: ~9,000 issues, pull
 * requests, commits and comments, each already shown where it means something
 * (Issues, Activity, the Overview's pull requests). Pure: artifacts-tab.tsx
 * draws it. */

import type { ArtifactNode, BuildOutput, DocBinding } from "./api";
import type { BuildRun } from "./builds";

/** One build with what it kept. `run` is null when the sync has not read
 *  the run (older than the runs it keeps); the artifacts still show. */
export interface OutputBuild {
  runId: string;
  run: BuildRun | null;
  artifacts: BuildOutput[];
}

/** The artifacts under their builds, newest build first, and the releases
 *  newest first. */
export function groupOutputs(
  outputs: readonly BuildOutput[],
  runs: readonly BuildRun[],
): { builds: OutputBuild[]; releases: BuildOutput[] } {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const builds = new Map<string, OutputBuild>();
  const releases: BuildOutput[] = [];
  for (const o of outputs) {
    if (o.kind === "release") {
      releases.push(o);
      continue;
    }
    const runId = o.run ?? `artifact:${o.id}`;
    let b = builds.get(runId);
    if (!b) {
      b = { runId, run: (o.run && byId.get(o.run)) || null, artifacts: [] };
      builds.set(runId, b);
    }
    b.artifacts.push(o);
  }
  const at = (b: OutputBuild) => b.run?.createdAt ?? b.artifacts[0]?.created_at ?? "";
  for (const b of builds.values()) b.artifacts.sort((x, y) => x.title.localeCompare(y.title));
  return {
    builds: [...builds.values()].sort((a, b) => at(b).localeCompare(at(a))),
    releases: releases.sort((a, b) =>
      (b.published_at ?? b.created_at ?? "").localeCompare(a.published_at ?? a.created_at ?? ""),
    ),
  };
}

/** The files of one version of the code -- a commit -- from the builds of
 *  it that kept any. A file is listed once per build that kept it, under the
 *  build's own output (what a download asks for). */
export interface OutputVersion {
  /** The commit: its short sha, or the artifact's own when the run is gone. */
  version: string;
  branch: string | null;
  /** Whether a build of it passed; null when no run of it is known. */
  passed: boolean | null;
  at: string;
  files: BuildOutput[];
}

/** The CI files by version, newest first; `passedOnly` keeps the versions a
 *  build passed for. The runs themselves are Tests' and Releases'. */
export function outputVersions(builds: readonly OutputBuild[], passedOnly: boolean): OutputVersion[] {
  const byVersion = new Map<string, OutputVersion>();
  for (const b of builds) {
    const sha = b.run?.shortSha || (b.artifacts[0]?.sha ?? "").slice(0, 7) || b.runId;
    const at = b.run?.createdAt ?? b.artifacts[0]?.created_at ?? "";
    let v = byVersion.get(sha);
    if (!v) {
      v = { version: sha, branch: b.run?.branch ?? b.artifacts[0]?.branch ?? null, passed: null, at, files: [] };
      byVersion.set(sha, v);
    }
    if (b.run) v.passed = v.passed === true || b.run.status === "passed";
    if (at > v.at) v.at = at;
    v.files.push(...b.artifacts);
  }
  return [...byVersion.values()]
    .filter((v) => !passedOnly || v.passed === true)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** `84 MB`, `3.1 KB`, `512 B`; a dash when unknown. */
export function formatBytes(n: number | null | undefined): string {
  if (typeof n !== "number" || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** How long the provider keeps an artifact: `expires in 88 d`, `expires
 *  today`, `expired`; null when it did not say. */
export function expiryText(o: Pick<BuildOutput, "expired" | "expires_at">, now: Date): string | null {
  if (o.expired) return "expired";
  if (!o.expires_at) return null;
  const ms = Date.parse(o.expires_at) - now.getTime();
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / 86_400_000);
  return days === 0 ? "expires today" : `expires in ${days} d`;
}

/** A repository file Studio knows the type of: what the project's documents
 *  are. A file it could not type, or ruled not a document, is not one. */
export interface DocumentRow {
  id: string;
  nodeId: string;
  path: string;
  type: string;
  /** Typed by a person, not only detected. */
  confirmed: boolean;
  conforms: boolean | null;
}

export function documentRows(bindings: readonly DocBinding[]): DocumentRow[] {
  return bindings
    .filter((b) => !!b.type_key && b.state !== "not_a_document" && b.state !== "unknown")
    .map((b) => ({
      id: b.id,
      nodeId: b.node_id,
      path: b.path,
      type: b.type_key as string,
      confirmed: b.state === "confirmed" || b.state === "manual",
      conforms: b.conforms ?? null,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** A file kept in Studio rather than in a repository. */
export interface StoredFile {
  id: string;
  path: string;
  origin: "manual" | "generated";
  size: number | null;
  fileId: string | null;
  versionId: string | null;
  updatedAt: string | null;
}

/** The file nodes people added or Studio generated, newest first; a
 *  repository's own files are not among them. */
export function storedFiles(nodes: readonly ArtifactNode[]): StoredFile[] {
  const out: StoredFile[] = [];
  for (const n of nodes) {
    const v = (n.value ?? {}) as Record<string, unknown>;
    if (v.origin !== "manual" && v.origin !== "generated") continue;
    const ref = v.object_ref && typeof v.object_ref === "object" ? (v.object_ref as Record<string, unknown>) : {};
    out.push({
      id: n.instance_id,
      path: typeof v.path === "string" ? v.path : n.instance_id,
      origin: v.origin,
      size: typeof v.size === "number" ? v.size : null,
      fileId: typeof ref.file_id === "string" ? ref.file_id : null,
      versionId: typeof ref.version_id === "string" ? ref.version_id : null,
      updatedAt: typeof v.updated_at === "string" ? v.updated_at : null,
    });
  }
  return out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.path.localeCompare(b.path));
}
