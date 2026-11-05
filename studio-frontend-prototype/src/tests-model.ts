/* The project's Tests tab: does what we built work, and is what the specs
 * say checked? In this first version a "test" is a CI job -- the sync reads
 * every run's jobs and the step a failed one failed at. Test cases out of the
 * jobs' reports (JUnit and the like) are a later phase: they need the
 * workflow artifacts the sync does not read yet.
 *
 * Pure: tests-tab.tsx draws it. */

import type { CiJob, CiRun, CiRunList, Conformance, OpenPullRequest } from "./api";
import { type BuildStatus, buildStatus } from "./builds";

const DAY_MS = 86_400_000;

/** A run's status in a build's words. */
export function runStatus(r: Pick<CiRun, "status" | "conclusion">): BuildStatus {
  return buildStatus(r.status, r.conclusion);
}

const finished = (s: BuildStatus) => s === "passed" || s === "failed";

/** One failed job of a run: its name, the step it failed at, its page. */
export interface FailedJob {
  name: string;
  step: string | null;
  url: string | null;
}

/** The jobs of a run that failed, in the order they ran. */
export function failedJobs(run: Pick<CiRun, "jobs">): FailedJob[] {
  return (run.jobs ?? [])
    .filter((j) => buildStatus(j.status, j.conclusion) === "failed")
    .map((j) => ({ name: j.name, step: j.failed_step, url: j.url }));
}

/** "build-backend → cargo test", or the job alone when no step is named. */
export function failedJobLabel(j: FailedJob): string {
  return j.step ? `${j.name} → ${j.step}` : j.name;
}

/** The mainline, as the Mainline card says it. */
export interface Mainline {
  run: CiRun;
  status: BuildStatus;
  branch: string | null;
  failed: FailedJob[];
  /** Finished runs on the same branch in the last 7 days; null without any. */
  week: { passed: number; finished: number } | null;
}

/** The run that speaks for the mainline (the server's `latest_completed`)
 *  and how the same branch went over the last week. Null when no run has
 *  finished yet. */
export function mainline(list: Pick<CiRunList, "items" | "latest_completed">, now = Date.now()): Mainline | null {
  const run = list.items.find((r) => r.id === list.latest_completed);
  if (!run) return null;
  const since = now - 7 * DAY_MS;
  const week = list.items.filter((r) => {
    const at = Date.parse(r.created_at ?? "");
    return r.branch === run.branch && !Number.isNaN(at) && at >= since && finished(runStatus(r));
  });
  const passed = week.filter((r) => runStatus(r) === "passed").length;
  return {
    run,
    status: runStatus(run),
    branch: run.branch,
    failed: failedJobs(run),
    week: week.length > 0 ? { passed, finished: week.length } : null,
  };
}

/** "92%", rounded down so 99.6% never reads as all green. */
export function passRate(week: { passed: number; finished: number }): string {
  return `${Math.floor((week.passed / week.finished) * 100)}%`;
}

/** One day of the strip. */
export interface StripDay {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  passed: number;
  failed: number;
}

/** The last `days` days, oldest first, with how many runs finished green or
 *  red on each: a day with none is in the strip too, as a gap. Cancelled and
 *  skipped runs said nothing about the code, so they are not counted. */
export function dailyStrip(runs: readonly CiRun[], now = Date.now(), days = 14): StripDay[] {
  const today = Math.floor(now / DAY_MS);
  const out: StripDay[] = [];
  for (let d = today - days + 1; d <= today; d++) {
    out.push({ day: new Date(d * DAY_MS).toISOString().slice(0, 10), passed: 0, failed: 0 });
  }
  for (const r of runs) {
    const at = Date.parse(r.created_at ?? "");
    if (Number.isNaN(at)) continue;
    const i = Math.floor(at / DAY_MS) - (today - days + 1);
    if (i < 0 || i >= days) continue;
    const s = runStatus(r);
    if (s === "passed") out[i].passed++;
    else if (s === "failed") out[i].failed++;
  }
  return out;
}

/** The newest run on a pull request's branch in its repository: what its CI
 *  says. `repoPaths` maps repository nodes to `owner/name`; a run whose
 *  repository is not known still counts by its branch. */
export function pullRun(
  pull: Pick<OpenPullRequest, "repo" | "source_branch">,
  runs: readonly CiRun[],
  repoPaths: ReadonlyMap<string, string>,
): CiRun | null {
  const branch = pull.source_branch;
  if (!branch) return null;
  const mine = runs.filter((r) => {
    if (r.branch !== branch) return false;
    const path = r.repo ? repoPaths.get(r.repo) : undefined;
    return !path || !pull.repo || path === pull.repo;
  });
  return mine.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0] ?? null;
}

/** How the open pull requests' CI stands, for the card. */
export interface PullsCi {
  green: number;
  red: number;
  running: number;
  /** No run found on the pull request's branch. */
  none: number;
}

export function pullsCi(
  pulls: readonly Pick<OpenPullRequest, "repo" | "source_branch">[],
  runs: readonly CiRun[],
  repoPaths: ReadonlyMap<string, string>,
): PullsCi {
  const out: PullsCi = { green: 0, red: 0, running: 0, none: 0 };
  for (const p of pulls) {
    const r = pullRun(p, runs, repoPaths);
    const s = r ? runStatus(r) : null;
    if (s === "passed") out.green++;
    else if (s === "failed") out.red++;
    else if (s === "running" || s === "queued") out.running++;
    else out.none++;
  }
  return out;
}

/** `6 min`, `40 s`, `1 h 5 min`. */
export function durationLabel(seconds: number | null | undefined): string | null {
  if (seconds == null || seconds < 0) return null;
  if (seconds < 60) return `${seconds} s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** How long a run's jobs took end to end: from the first start to the last
 *  finish. Null until a job has both. */
export function runSeconds(jobs: readonly CiJob[] | undefined): number | null {
  const starts = (jobs ?? []).map((j) => Date.parse(j.started_at ?? "")).filter((t) => !Number.isNaN(t));
  const ends = (jobs ?? []).map((j) => Date.parse(j.completed_at ?? "")).filter((t) => !Number.isNaN(t));
  if (starts.length === 0 || ends.length === 0) return null;
  const s = Math.round((Math.max(...ends) - Math.min(...starts)) / 1000);
  return s >= 0 ? s : null;
}

/** What the Spec ↔ code card says: how many of the capabilities the specs
 *  declare the code is made to answer. Non-functional ones are not a gear's
 *  to answer, so they are counted apart. */
export interface SpecCode {
  implemented: number;
  missing: number;
  nonfunctional: number;
  /** Functional capabilities: implemented + missing. */
  functional: number;
}

export function specCode(c: Pick<Conformance, "items">): SpecCode {
  // The server also answers `nonfunctional`, which the shared type predates.
  const n = (s: string) => c.items.filter((i) => (i.status as string) === s).length;
  const implemented = n("implemented");
  const missing = n("missing");
  return { implemented, missing, nonfunctional: n("nonfunctional"), functional: implemented + missing };
}

/** A read that failed, as a chip says it: the server's whole text is for the
 *  popover. `connection`: what fixes it is the connection the repository is
 *  read through (a token gone, not readable, no access). */
export function readProblem(text: string): { short: string; connection: boolean } {
  const connection =
    /precondition|could not be\s+read|not readable|token|credential|permission|access|unauthori[sz]ed|forbidden|\b40[134]\b/i.test(text);
  return connection
    ? { short: "the repository can't be read", connection: true }
    : { short: "couldn't be checked", connection: false };
}
