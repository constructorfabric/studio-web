/* The project's builds (ADR-0045): the CI runs the artifact sync reads from
 * the project's repositories (phase 1), and the product's builds -- the ones
 * the IDE ran and reported, in a member's desktop or a session (phase 2), and
 * the ones Studio ran as a Job in the organization's cluster (ADR-0048 §9).
 *
 * This is what was built, where, and how it went; a build's stages say how far
 * it got: prepare (the generated tree), images, publish (images and chart in
 * the environment's registry). Build starts one in Studio or in CI. */

import type { ArtifactNode } from "./api";

/** One CI run, as the Builds tab shows it. */
export interface BuildRun {
  id: string;
  workflow: string;
  title: string;
  branch: string | null;
  sha: string;
  shortSha: string;
  event: string | null;
  status: BuildStatus;
  author: string | null;
  url: string | null;
  number: number | null;
  attempt: number | null;
  createdAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  /** `.github/workflows/build.yml`: what Build starts it by. */
  workflowPath: string | null;
  /** The repository node it belongs to. */
  repoNode: string | null;
}

export type BuildStatus = "queued" | "running" | "passed" | "failed" | "cancelled" | "skipped" | "unknown";

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** A run's status in a build's words, from the provider's `status` and
 *  `conclusion`. A run that has not finished is `running` or `queued`; one
 *  the provider said nothing about is `unknown`, never `failed`. */
export function buildStatus(status: string | null, conclusion: string | null): BuildStatus {
  if (status && status !== "completed") {
    return status === "in_progress" ? "running" : "queued";
  }
  if (!conclusion) return "unknown";
  switch (conclusion) {
    case "success":
      return "passed";
    case "cancelled":
      return "cancelled";
    case "skipped":
    case "neutral":
      return "skipped";
    default:
      return "failed";
  }
}

/** The `workflow_run` nodes as runs, newest first. */
export function buildsOf(nodes: readonly ArtifactNode[]): BuildRun[] {
  const runs = nodes.map((n): BuildRun => {
    const v = n.value;
    const sha = str(v.sha) ?? "";
    return {
      id: n.instance_id,
      workflow: str(v.workflow) ?? "workflow",
      title: str(v.title) ?? "",
      branch: str(v.branch),
      sha,
      shortSha: str(v.short_sha) ?? sha.slice(0, 7),
      event: str(v.event),
      status: buildStatus(str(v.status), str(v.conclusion)),
      author: str(v.author),
      url: str(v.url),
      number: num(v.number),
      attempt: num(v.attempt),
      createdAt: str(v.created_at),
      startedAt: str(v.started_at),
      updatedAt: str(v.updated_at),
      workflowPath: str(v.workflow_path),
      repoNode: str(v.repo),
    };
  });
  return runs.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** The workflows the runs belong to, with how many runs each, most first:
 *  the one that runs most is usually the one that builds. */
export function workflowsOf(runs: readonly BuildRun[]): { name: string; runs: number }[] {
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.workflow, (counts.get(r.workflow) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, n]) => ({ name, runs: n }))
    .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
}

/** The branch a product is built from: `main` or `master` when the runs
 *  have one, else the branch with most runs. */
export function mainBranch(runs: readonly BuildRun[]): string | null {
  const branches = new Set(runs.map((r) => r.branch).filter((b): b is string => !!b));
  for (const b of ["main", "master"]) if (branches.has(b)) return b;
  const counts = new Map<string, number>();
  for (const r of runs) if (r.branch) counts.set(r.branch, (counts.get(r.branch) ?? 0) + 1);
  let best: string | null = null;
  for (const [b, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = b;
  return best;
}

/** The newest finished run on `branch`. */
export function latestFinished(runs: readonly BuildRun[], branch: string | null): BuildRun | null {
  return (
    runs.find(
      (r) => r.branch === branch && r.status !== "queued" && r.status !== "running" && r.status !== "unknown",
    ) ?? null
  );
}

/** How long a run took, or has been running: `6 min`, `40 s`, `1 h 5 min`.
 *  Null until it starts: time in the queue is not build time. */
export function buildDuration(r: Pick<BuildRun, "startedAt" | "updatedAt" | "status">, now = Date.now()): string | null {
  if (r.status === "queued") return null;
  const start = Date.parse(r.startedAt ?? "");
  if (Number.isNaN(start)) return null;
  const live = r.status === "running";
  const end = live ? now : Date.parse(r.updatedAt ?? "");
  if (Number.isNaN(end) || end < start) return null;
  const s = Math.round((end - start) / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The line above the table: how the selected workflow's newest finished
 *  run went on the selected branch (the main branch when none is). It
 *  speaks of that workflow only -- which workflow builds the product is not
 *  known yet, so it never says the product "builds". */
export function buildsHeadline(runs: readonly BuildRun[], workflow: string | null, branch: string | null = null): string {
  const shown = workflow ? runs.filter((r) => r.workflow === workflow) : runs;
  if (shown.length === 0) return "No CI runs yet.";
  const on = branch || mainBranch(shown);
  const last = latestFinished(shown, on);
  if (!on || !last) return `${shown.length} run${shown.length === 1 ? "" : "s"}; none finished on ${on ?? "a main branch"} yet.`;
  const what = workflow ?? last.workflow;
  return `${what} on ${on}: ${last.status} at ${last.shortSha}.`;
}

/** What the repositories' sync says about reading their CI: the ones whose
 *  runs could not be read, and why. */
export function ciReadFailures(repos: readonly ArtifactNode[]): { repo: string; error: string }[] {
  return repos.flatMap((n) => {
    const error = str(n.value.ci_error);
    if (!error) return [];
    return [{ repo: str(n.value.full_path) ?? str(n.value.name) ?? n.instance_id, error }];
  });
}

/** The project's build workflow, as `project.config` names it. */
export interface BuildWorkflow {
  repo: string;
  workflow: string;
}

/** A workflow's file name from its path: what GitHub starts it by. */
export function workflowFile(path: string | null): string | null {
  if (!path) return null;
  const name = path.split("/").pop() ?? "";
  return /\.ya?ml$/.test(name) ? name : null;
}

/** The setting that would make `workflow` the project's build workflow:
 *  its file, in the repository its runs come from. Null when its runs name
 *  no file or no repository the project lists. */
export function buildWorkflowOf(
  runs: readonly BuildRun[],
  workflow: string,
  repoPaths: ReadonlyMap<string, string>,
): BuildWorkflow | null {
  const run = runs.find((r) => r.workflow === workflow && workflowFile(r.workflowPath) && r.repoNode);
  if (!run) return null;
  const repo = repoPaths.get(run.repoNode ?? "");
  const file = workflowFile(run.workflowPath);
  return repo && file ? { repo, workflow: file } : null;
}

/** Whether `workflow` (by name) is the project's build workflow. */
export function isBuildWorkflow(
  setting: BuildWorkflow | null | undefined,
  candidate: BuildWorkflow | null,
): boolean {
  return (
    !!setting &&
    !!candidate &&
    setting.workflow === candidate.workflow &&
    setting.repo.toLowerCase() === candidate.repo.toLowerCase()
  );
}

/** The repositories' `owner/repo`, by node id: what a run's `repo` names. */
export function repoPathsOf(repos: readonly ArtifactNode[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of repos) {
    const path = str(n.value.full_path);
    if (path) out.set(n.instance_id, path);
  }
  return out;
}

/** One build the IDE ran and reported (ADR-0045 phase 2). */
export interface IdeBuild {
  id: string;
  buildId: string;
  where: "desktop" | "session" | string;
  action: "build" | "run" | string;
  status: BuildStatus;
  product: string | null;
  profile: string | null;
  commit: string | null;
  shortSha: string | null;
  branch: string | null;
  by: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  failure: string | null;
  failureStep: string | null;
  outputs: string[];
  /** The chart it published, when it published one (ADR-0048). */
  chartRef: string | null;
  chartVersion: string | null;
  /** The images it published, by application. */
  images: { app: string; image: string }[];
  /** The step a Studio build is in while it runs: `prepare`, `build` or
   *  `publish`, the Job's containers. */
  step: string | null;
}

/** The `build` nodes as builds, newest first. */
export function ideBuildsOf(nodes: readonly ArtifactNode[]): IdeBuild[] {
  const statusOf = (s: string | null): BuildStatus =>
    s === "running" || s === "passed" || s === "failed" || s === "cancelled" ? s : "unknown";
  return nodes
    .map((n): IdeBuild => {
      const v = n.value;
      return {
        id: n.instance_id,
        buildId: str(v.build_id) ?? n.instance_id,
        where: str(v.where) ?? "desktop",
        action: str(v.action) ?? "build",
        status: statusOf(str(v.status)),
        product: str(v.product),
        profile: str(v.profile),
        commit: str(v.commit),
        shortSha: str(v.short_sha),
        branch: str(v.branch),
        by: str(v.reported_by),
        startedAt: str(v.started_at),
        finishedAt: str(v.finished_at),
        durationMs: num(v.duration_ms),
        failure: str(v.failure),
        failureStep: str(v.failure_step),
        outputs: Array.isArray(v.outputs) ? v.outputs.filter((o): o is string => typeof o === "string") : [],
        chartRef: str((v.chart as Record<string, unknown> | undefined)?.reference),
        chartVersion: str((v.chart as Record<string, unknown> | undefined)?.version),
        images: Array.isArray(v.images)
          ? v.images.flatMap((i) => {
              const r = i as Record<string, unknown>;
              const app = str(r?.app);
              const image = str(r?.image);
              return app && image ? [{ app, image }] : [];
            })
          : [],
        step: str(v.step),
      };
    })
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

/** A product build's stages, in order. */
export const BUILD_STAGES = ["prepare", "images", "publish"] as const;
export type BuildStage = (typeof BUILD_STAGES)[number];
export type StageState = "done" | "running" | "failed" | "waiting";

/** The stage a step names: the Job's `build` container makes the images; any
 *  step this does not know (an IDE's `protoc`, `compile`) is the images too. */
export function stageOf(step: string | null): BuildStage | null {
  if (!step) return null;
  if (step === "prepare" || step === "publish") return step;
  return "images";
}

/** How far a build got, stage by stage: a passed build did all three; a
 *  failed one did those before the one it failed in; a running one those
 *  before the one it is in (the first, when it does not say). */
export function buildStages(b: Pick<IdeBuild, "status" | "step" | "failureStep">): Record<BuildStage, StageState> {
  const at = (stage: BuildStage | null) => (stage ? BUILD_STAGES.indexOf(stage) : 0);
  const out = {} as Record<BuildStage, StageState>;
  BUILD_STAGES.forEach((stage, i) => {
    if (b.status === "passed") out[stage] = "done";
    else if (b.status === "failed") {
      const failed = at(stageOf(b.failureStep));
      out[stage] = i < failed ? "done" : i === failed ? "failed" : "waiting";
    } else if (b.status === "running") {
      const now = at(stageOf(b.step));
      out[stage] = i < now ? "done" : i === now ? "running" : "waiting";
    } else out[stage] = "waiting";
  });
  return out;
}

/** How long an IDE build took, or has been running. */
export function ideBuildDuration(b: IdeBuild, now = Date.now()): string | null {
  return buildDuration(
    {
      status: b.status,
      startedAt: b.startedAt,
      updatedAt:
        b.durationMs !== null && b.startedAt
          ? new Date(Date.parse(b.startedAt) + b.durationMs).toISOString()
          : b.finishedAt,
    },
    now,
  );
}

/** The badge tone for a status, in the portal's badge classes. */
export function statusTone(s: BuildStatus): string {
  switch (s) {
    case "passed":
      return "ok";
    case "failed":
      return "danger";
    case "running":
    case "queued":
      return "info";
    case "unknown":
      return "neutral";
    default:
      return "neutral";
  }
}
