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
  /** The provider's run id: a pipeline's build is `ci-run-<it>`. */
  externalId: string | null;
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
      externalId: str(v.external_id),
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
  /** The revision of the product description it was built with (ADR-0053 §2). */
  descriptionRevision: number | null;
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
  /** A pipeline's build: its run's page in CI. */
  url: string | null;
  /** Where a build Studio ran and with what; absent from other builds and
   *  from a record written before Studio kept it. */
  place?: BuildPlace;
}

/** Where a build Studio ran, and with what, as its record keeps it. */
export interface BuildPlace {
  environmentId: string | null;
  environment: string | null;
  namespace: string | null;
  /** The branch, tag or commit it built; the repository's branch when none was asked for. */
  gitRef: string | null;
  repository: string | null;
  /** The connection the repository was cloned through. */
  sourceConnectionId: string | null;
  sourceConnection: string | null;
  /** The image its prepare and publish steps ran in. */
  builderImage: string | null;
  /** The Gearbox engine's commit in that image. */
  gearboxVersion: string | null;
}

/** A build node's place, or undefined when it records none. */
export function placeOf(v: Record<string, unknown>): BuildPlace | undefined {
  const place: BuildPlace = {
    environmentId: str(v.environment_id),
    environment: str(v.environment),
    namespace: str(v.namespace),
    gitRef: str(v.git_ref),
    repository: str(v.repository),
    sourceConnectionId: str(v.source_connection_id),
    sourceConnection: str(v.source_connection),
    builderImage: str(v.builder_image),
    gearboxVersion: str(v.gearbox_version),
  };
  const { repository: _repository, ...recorded } = place;
  return Object.values(recorded).some((x) => x !== null) ? place : undefined;
}

/** The place as short labelled lines for a build's detail: what to look at
 *  when a build failed somewhere it should not have. */
export function placeLines(p: BuildPlace): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];
  if (p.environment || p.namespace)
    lines.push({ label: "where", value: [p.environment, p.namespace && `namespace ${p.namespace}`].filter(Boolean).join(" · ") });
  if (p.repository || p.gitRef) lines.push({ label: "code", value: [p.repository, p.gitRef && `at ${p.gitRef}`].filter(Boolean).join(" ") });
  if (p.sourceConnection || p.sourceConnectionId)
    lines.push({ label: "cloned through", value: p.sourceConnection ?? p.sourceConnectionId ?? "" });
  if (p.builderImage) lines.push({ label: "builder", value: p.builderImage });
  if (p.gearboxVersion) lines.push({ label: "Gearbox", value: p.gearboxVersion });
  return lines;
}

/** What Studio refuses a build or deploy with before it queues it, because
 *  the run could only fail (environments/README.md "Before a build or a
 *  deploy is queued"): what it means, and what to do. */
export const BUILD_REFUSALS: Record<string, { title: string; next: string }> = {
  REPOSITORY_CONNECTION_PERSONAL: {
    title: "The repository is reached through a personal connection",
    next: "A build runs as the server, which cannot read a person's token: connect the repository through a workspace or organization connection (Project › Sources), then build again.",
  },
  REPOSITORY_CONNECTION_UNREADABLE: {
    title: "The repository's connection cannot be read by the server",
    next: "Reconnect it, or connect the repository through another shared connection, then build again.",
  },
  REGISTRY_CONNECTION_UNREADABLE: {
    title: "The environment's registry connection cannot be read",
    next: "Fix the registry connection in Organization › Infrastructure, then try again.",
  },
  CLUSTER_CONNECTION_UNREADABLE: {
    title: "The environment's cluster connection cannot be read",
    next: "Fix the cluster connection in Organization › Infrastructure, then try again.",
  },
  CLUSTER_CANNOT_CREATE_NAMESPACE: {
    title: "The project's namespace does not exist, and Studio may not create it",
    next: "A cluster administrator applies deploy/k8s/studio-environments/bootstrap.yaml, or creates the namespace and gives the connection admin in it.",
  },
  CLUSTER_CANNOT_READ_NAMESPACE: {
    title: "Studio may not read the project's namespace",
    next: "A cluster administrator applies deploy/k8s/studio-environments/bootstrap.yaml, or gives the connection admin in the namespace.",
  },
  CLUSTER_NAMESPACE_RIGHTS_MISSING: {
    title: "Studio may not create what a build or deploy needs in the namespace",
    next: "A cluster administrator gives the connection's account admin in the namespace.",
  },
  ENVIRONMENT_CLUSTER_UNREACHABLE: {
    title: "The environment's cluster did not answer",
    next: "Check the cluster's address and that it is up, then try again.",
  },
};

/** The refusal code a failed request carries, when it is one of
 *  [`BUILD_REFUSALS`]: a failed precondition names it in a violation. */
export function buildRefusalCode(e: unknown): string | null {
  const carrier = e as { problem?: { context?: { violations?: unknown[] } }; body?: { context?: { violations?: unknown[] } } } | null;
  const violations = carrier?.problem?.context?.violations ?? carrier?.body?.context?.violations ?? [];
  for (const v of violations) {
    const r = v as Record<string, unknown> | null;
    for (const k of ["type", "type_", "subject"]) {
      const code = r?.[k];
      if (typeof code === "string" && code in BUILD_REFUSALS) return code;
    }
  }
  return null;
}

/** A failed build or deploy request as a person reads it: the refusal's
 *  title, the server's sentence, and what to do; any other failure as
 *  `fallback` says it. */
export function buildRefusalText(e: unknown, fallback: (e: unknown) => string): string {
  const code = buildRefusalCode(e);
  if (!code) return fallback(e);
  const carrier = e as { problem?: { context?: { violations?: { description?: string }[] } } } | null;
  const said = carrier?.problem?.context?.violations?.find((v) => v?.description)?.description?.trim();
  const { title, next } = BUILD_REFUSALS[code];
  return [`${title}.`, said, next].filter(Boolean).join(" ");
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
        descriptionRevision: num(v.description_revision),
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
        url: null,
        place: placeOf(v),
      };
    })
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

/** A product build's stages, in order. */
export const BUILD_STAGES = ["prepare", "images", "publish"] as const;
export type BuildStage = (typeof BUILD_STAGES)[number];
export type StageState = "done" | "running" | "failed" | "waiting";

/** The stage a step names: the Job's `build` container makes the images; any
 *  step this does not know (an IDE's `protoc`, `compile`) is the images too.
 *  Studio's own `start` and `watch` name none: the build never began, or
 *  how far it got is not known. */
export function stageOf(step: string | null): BuildStage | null {
  if (!step || step === "start" || step === "watch") return null;
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

/** A Studio build's Job gives up after an hour; one still `running` this long
 *  after it started has lost its watch, and nothing will say how it ended. */
export const LOST_AFTER_MS = 65 * 60_000;

/** A Studio build whose watch said it lost sight of it (it fails in `watch`),
 *  or one still `running` past its Job's deadline, which a build recorded
 *  before the watch said so can be: lost, not running. */
export function isLost(b: Pick<IdeBuild, "where" | "status" | "startedAt" | "failureStep">, now = Date.now()): boolean {
  if (b.where !== "studio") return false;
  if (b.status === "failed") return b.failureStep === "watch";
  if (b.status !== "running" || !b.startedAt) return false;
  const started = Date.parse(b.startedAt);
  return Number.isFinite(started) && now - started > LOST_AFTER_MS;
}

/** Whether any build is really running and says so as it goes: a lost one
 *  does not, and a CI run changes here only with the next sync of the
 *  project's sources, so the page follows neither. */
export function anyRunning(builds: readonly IdeBuild[], now = Date.now()): boolean {
  return builds.some((b) => b.status === "running" && b.where !== "ci" && !isLost(b, now));
}

/** The words for where a build ran. */
export const WHERE_WORD: Record<string, string> = { studio: "Studio", desktop: "desktop", session: "session", ci: "CI" };

/** What a failed build's failure points at, and so who fixes it. */
export interface FailureCause {
  /** `gear`: one gear of the product does not hold together, which is fixed
   *  where that gear lives; `cluster`: the build never reached the cluster;
   *  `lost`: how it ended is not known; `ci`: the run's own page says why;
   *  `build`: anything else, the product's own. */
  kind: "gear" | "cluster" | "lost" | "ci" | "build";
  /** The gear, when one is named. */
  gear: string | null;
  /** What to do, in one sentence. */
  next: string;
}

/** Why a failed build failed, as far as its failure says. gearbox names the
 *  gear a diagnostic is about as ``gear `id` ``. */
export function failureCause(b: IdeBuild, now = Date.now()): FailureCause {
  if (isLost(b, now)) return { kind: "lost", gear: null, next: "How it ended is not known; build again." };
  const gear = /\bgear `([^`]+)`/.exec(b.failure ?? "")?.[1] ?? null;
  if (gear) {
    return {
      kind: "gear",
      gear,
      next: `Gear ${gear} fails, not the build around it: fix the gear where it lives (this repository if the project owns it, else its gear source) or take it out of the product, then build again.`,
    };
  }
  if (b.failureStep === "start") {
    const personal = /not readable|personal/i.test(b.failure ?? "");
    return {
      kind: "cluster",
      gear: null,
      next: personal
        ? "It never started: the server could not read a connection's token -- most often a personal connection to the repository. Connect it through a workspace or organization connection, then build again."
        : "It never reached the cluster: check the environment's cluster and registry connections (Organization › Infrastructure), then build again.",
    };
  }
  if (b.where === "ci" && !b.failure) {
    return { kind: "ci", gear: null, next: "Its run's page in CI says why; fix it and push again." };
  }
  return { kind: "build", gear: null, next: "Fix it and build again." };
}

/** A failure's first line as a sentence short enough for one line of a page:
 *  the part before gearbox's ` · help:`, at most 240 characters, ending in
 *  one full stop or an ellipsis. */
export function failureLine(failure: string): string {
  const line = failure.split("\n")[0].split(" · ")[0].trim().replace(/\.+$/, "");
  return line.length > 240 ? `${line.slice(0, 240).trimEnd()}…` : `${line}.`;
}

/** The product's builds with the CI's: a pipeline's build links its run, and
 *  a run of the project's build workflow that left no manifest -- it failed,
 *  is still running, or published none -- is a build of its own, so the
 *  product's builds say what CI did too. Newest first. */
export function productBuildsOf(
  builds: readonly IdeBuild[],
  runs: readonly BuildRun[],
  setting: BuildWorkflow | null | undefined,
  repoPaths: ReadonlyMap<string, string>,
): IdeBuild[] {
  const runOf = new Map(runs.filter((r) => r.externalId).map((r) => [`ci-run-${r.externalId}`, r]));
  const linked = builds.map((b) => {
    const run = b.where === "ci" ? runOf.get(b.buildId) : undefined;
    return run ? { ...b, url: run.url, branch: b.branch ?? run.branch, startedAt: b.startedAt ?? run.startedAt ?? run.createdAt } : b;
  });
  const known = new Set(builds.map((b) => b.buildId));
  const fromRuns = runs.flatMap((r): IdeBuild[] => {
    const id = r.externalId ? `ci-run-${r.externalId}` : null;
    if (!id || known.has(id) || r.status === "skipped" || r.status === "unknown") return [];
    const repo = repoPaths.get(r.repoNode ?? "");
    const file = workflowFile(r.workflowPath);
    if (!repo || !file || !isBuildWorkflow(setting, { repo, workflow: file })) return [];
    return [
      {
        id: r.id,
        buildId: id,
        where: "ci",
        action: "build",
        status: r.status === "queued" ? "running" : r.status,
        product: null,
        profile: null,
        commit: r.sha || null,
        shortSha: r.shortSha || null,
        descriptionRevision: null,
        branch: r.branch,
        by: r.author,
        startedAt: r.startedAt ?? r.createdAt,
        finishedAt: r.status === "running" || r.status === "queued" ? null : r.updatedAt,
        durationMs: null,
        failure: null,
        failureStep: null,
        outputs: [],
        chartRef: null,
        chartVersion: null,
        images: [],
        step: null,
        url: r.url,
      },
    ];
  });
  return [...linked, ...fromRuns].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

/** The ways to build the product, as the Builds tab offers them. */
export const BUILD_SCENARIOS = ["studio", "desktop", "ci"] as const;
export type BuildScenario = (typeof BUILD_SCENARIOS)[number];

/** The scenario the Builds tab opens on: the one this member chose for the
 *  project before, else Studio when an environment can take a Studio build,
 *  else the desktop, which needs nothing from the organization. */
export function openingScenario(stored: string | null, canBuildInStudio: boolean): BuildScenario {
  if (stored && (BUILD_SCENARIOS as readonly string[]).includes(stored)) return stored as BuildScenario;
  return canBuildInStudio ? "studio" : "desktop";
}

/** The step of a build's log to show first: the one that failed, else the
 *  one running, else the last that started; `null` when none has. */
export function stepToShow(steps: readonly { step: string; state: string }[]): string | null {
  return (
    steps.find((s) => s.state === "failed")?.step ??
    steps.find((s) => s.state === "running")?.step ??
    [...steps].reverse().find((s) => s.state !== "waiting")?.step ??
    null
  );
}
