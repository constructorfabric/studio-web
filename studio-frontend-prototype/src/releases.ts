/* A project's Releases tab (ADR-0056 §4): the ladder its product climbs. The
 * environments it may deploy to, in `promote_from` order -- dev, then the
 * stage that takes from dev, then the prod that takes from stage -- each with
 * what runs there, how its newest deploy went, and the one action that
 * applies: promote the build the environment before it runs, or deploy a
 * published build. The same order is the organization's ladder under
 * Infrastructure (§2).
 *
 * Pure, so it is tested without a backend; releases-tab.tsx reads the facts
 * and draws them. */

import type { Deployment, DeployEnvironment } from "./api";
import type { IdeBuild } from "./builds";
import { STATE_LABELS, shortCommit } from "./environments";
import { deployableBuilds } from "./project-deploys";

/** Environments in the order a release goes through them: each chain from
 *  the one that takes from nobody, every environment right after the one it
 *  takes from. Ties keep the order given; an environment in a loop of
 *  `promote_from`, which the server should not allow, comes last rather than
 *  not at all. */
export function ladderOrder<T extends Pick<DeployEnvironment, "id" | "promote_from">>(environments: readonly T[]): T[] {
  const ids = new Set(environments.map((e) => e.id));
  const from = (e: T) => (e.promote_from && e.promote_from !== e.id && ids.has(e.promote_from) ? e.promote_from : null);
  const out: T[] = [];
  const placed = new Set<string>();
  const visit = (e: T) => {
    if (placed.has(e.id)) return;
    placed.add(e.id);
    out.push(e);
    for (const next of environments) if (from(next) === e.id) visit(next);
  };
  for (const e of environments) if (from(e) === null) visit(e);
  for (const e of environments) if (!placed.has(e.id)) out.push(e);
  return out;
}

/** What a deploy installed, as people name it: the chart's version, else the
 *  build, else the commit. */
export function versionOf(d: Pick<Deployment, "chart_version" | "build" | "commit">): string | null {
  return d.chart_version || d.build || shortCommit(d.commit) || null;
}

export type StepState = "empty" | "runs" | "deploying" | "waiting" | "failed" | "removed";

export interface LadderStep {
  environment: DeployEnvironment;
  namespace: string;
  /** What runs there now: the newest install that succeeded, unless an
   *  uninstall succeeded after it. */
  runs: Deployment | null;
  /** The newest deploy there, whatever its state; previews are not one. */
  latest: Deployment | null;
  /** The newest deploy waiting for an administrator, in a protected one. */
  waiting: Deployment | null;
  state: StepState;
  /** The environment it takes from, by name; null for the first. */
  from: string | null;
  /** The build the environment it takes from runs, when this one does not
   *  run it yet and could take it: what Promote installs. */
  promote: IdeBuild | null;
  /** The published builds a Deploy here could name. */
  deployable: IdeBuild[];
}

const newestFirst = (a: Deployment, b: Deployment) => b.requested_at.localeCompare(a.requested_at);
const isInstall = (d: Deployment) => (d.action ?? "install") === "install";

function runsIn(own: readonly Deployment[]): Deployment | null {
  const done = own.find((d) => d.state === "succeeded");
  return done && isInstall(done) ? done : null;
}

/** The ladder, one step per environment in `ladderOrder`. */
export function ladderSteps(
  targets: readonly { environment: DeployEnvironment; namespace: string }[],
  deployments: readonly Deployment[],
  builds: readonly IdeBuild[],
): LadderStep[] {
  // The server lists deploys newest first; sorted again so nothing here
  // depends on it.
  const sorted = deployments.filter((d) => !d.preview).sort(newestFirst);
  const ofEnv = (id: string) => sorted.filter((d) => d.environment_id === id);
  const ordered = ladderOrder(targets.map((t) => ({ ...t, id: t.environment.id, promote_from: t.environment.promote_from })));
  const byId = new Map(ordered.map((t) => [t.id, t]));
  return ordered.map(({ environment, namespace }) => {
    const own = ofEnv(environment.id);
    const latest = own[0] ?? null;
    const runs = runsIn(own);
    const pending = own.find((d) => d.state === "awaiting_approval") ?? null;
    const waiting = environment.protected ? pending : null;
    const state: StepState = waiting
      ? "waiting"
      : !latest
        ? "empty"
        : latest.state === "queued" || latest.state === "running" || latest.state === "awaiting_approval"
          ? "deploying"
          : latest.state === "failed" || latest.state === "declined"
            ? "failed"
            : latest.state === "succeeded" && !isInstall(latest)
              ? "removed"
              : runs
                ? "runs"
                : "empty";
    const deployable = deployableBuilds(builds, environment);
    const before = environment.promote_from ? byId.get(environment.promote_from) : undefined;
    const theirs = before ? runsIn(ofEnv(before.id)) : null;
    // Promote names the build itself: a deploy of an uploaded chart left no
    // build to name, and one already here or already asked for is not offered.
    const promote =
      theirs?.build && theirs.build !== runs?.build && theirs.build !== pending?.build
        ? (deployable.find((b) => b.buildId === theirs.build) ?? null)
        : null;
    return {
      environment,
      namespace,
      runs,
      latest,
      waiting,
      state,
      from: before?.environment.name ?? null,
      promote,
      deployable,
    };
  });
}

/** The Releases header's status: where the product stands, as a few chips
 *  read from the ladder -- what runs where, what waits, what failed -- or,
 *  with nothing deployed, whether there is a build to deploy. */
export function releaseStatus(
  steps: readonly LadderStep[],
  published: number,
): { text: string; tone: "ok" | "warn" | "danger" | "info" | "neutral" | "running" }[] {
  const out: ReturnType<typeof releaseStatus> = [];
  for (const s of steps) {
    const name = s.environment.name;
    const runs = s.runs ? versionOf(s.runs) : null;
    if (runs) out.push({ text: `${runs} runs in ${name}`, tone: "ok" });
    if (s.state === "waiting") out.push({ text: `${versionOf(s.waiting!) ?? "a deploy"} waits for approval in ${name}`, tone: "warn" });
    else if (s.state === "deploying") {
      const v = versionOf(s.latest!);
      out.push({ text: v ? `deploying ${v} to ${name}` : `deploying to ${name}`, tone: "running" });
    }
    else if (s.state === "failed") out.push({ text: `the last deploy to ${name} failed`, tone: "danger" });
  }
  if (!steps.some((s) => s.runs)) {
    if (published > 0)
      out.unshift({ text: `${published} build${published === 1 ? "" : "s"} ready · nothing deployed yet`, tone: "info" });
    else out.unshift({ text: "nothing published yet", tone: "neutral" });
  }
  return out;
}

/** A step's state in words, and the badge it is drawn with. */
export function stepStatus(s: LadderStep): { text: string; tone: "ok" | "warn" | "bad" | "idle" } {
  const running = s.runs ? versionOf(s.runs) : null;
  const runsText = running ? `runs ${running}` : "runs nothing yet";
  switch (s.state) {
    case "waiting":
      return { text: `waiting for approval: ${versionOf(s.waiting!) ?? "a deploy"}; ${runsText}`, tone: "warn" };
    case "deploying":
      return {
        text: `${STATE_LABELS[s.latest!.state].toLowerCase()} ${versionOf(s.latest!) ?? ""}`.trim() + `; ${runsText}`,
        tone: "warn",
      };
    case "failed":
      return { text: `the last deploy ${s.latest!.state === "declined" ? "was declined" : "failed"}; ${runsText}`, tone: "bad" };
    case "removed":
      return { text: "uninstalled", tone: "idle" };
    case "runs":
      return { text: runsText, tone: "ok" };
    default:
      return { text: "nothing deployed yet", tone: "idle" };
  }
}

/** The build the ladder starts from: the newest one some step could deploy. */
export function newestRelease(steps: readonly LadderStep[]): IdeBuild | null {
  const all = steps.flatMap((s) => s.deployable);
  const at = (b: IdeBuild) => b.finishedAt ?? b.startedAt ?? "";
  return all.sort((a, b) => at(b).localeCompare(at(a)))[0] ?? null;
}

/** One project's row of the organization's What runs where (ADR-0056 §2):
 *  per environment, what runs there and the newest deploy, as on a step. */
export interface ProjectRuns {
  projectId: string;
  projectName: string;
  cells: Map<string, { runs: Deployment | null; latest: Deployment }>;
}

/** Projects by environments, from the organization's deploys: every project
 *  that deployed anywhere, by name. Previews are left out, as on the ladder. */
export function whatRunsWhere(deployments: readonly Deployment[]): ProjectRuns[] {
  const sorted = deployments.filter((d) => !d.preview).sort(newestFirst);
  const rows = new Map<string, ProjectRuns>();
  for (const d of sorted) {
    let row = rows.get(d.project_id);
    if (!row) rows.set(d.project_id, (row = { projectId: d.project_id, projectName: d.project_name, cells: new Map() }));
    if (row.cells.has(d.environment_id)) continue;
    const own = sorted.filter((x) => x.project_id === d.project_id && x.environment_id === d.environment_id);
    row.cells.set(d.environment_id, { runs: runsIn(own), latest: d });
  }
  return [...rows.values()].sort((a, b) => a.projectName.localeCompare(b.projectName));
}

/** How an environment gives a product its database, in a few words. */
export function databaseWord(e: Pick<DeployEnvironment, "database" | "kind">): string {
  if (e.database === "shared") return "a shared Postgres";
  return e.kind === "research" ? "its own, in the application" : "its own, in the namespace";
}
