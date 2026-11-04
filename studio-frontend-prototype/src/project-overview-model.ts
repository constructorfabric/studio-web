/* The project's Overview, for its project manager: one verdict, the reasons
 * behind it, and the panels only a project has. Pure, so the rules are tested
 * without a backend (project-overview-model.test.ts); project-overview.tsx
 * reads the sources and draws what this says.
 *
 * Every input may be `undefined` (still reading) or `null` (could not be
 * read). Neither is a reason: a source that did not answer leaves the verdict
 * to the ones that did, and the screen names it rather than counting a zero.
 *
 * THE VERDICT is the worst of the signals:
 *
 *   Blocked   the repository connection is refused (nothing syncs);
 *             the product does not resolve;
 *             the last build on the main branch failed;
 *             the last deploy failed;
 *             a high finding is open (the path says it blocks a build).
 *   At risk   specs fail their checks;
 *             pull requests have waited over a week (QUIET_DAYS);
 *             pull requests have nobody asked to review them.
 *   On track  none of those, with the next step of the path as its reason
 *             ("next: compose the product"), or "path complete".
 *
 * Signals of the kind `info` (comment threads waiting, a quiet project) are
 * listed under Needs attention and do not move the verdict. */

import type { ActivityEvent, Deployment, OpenPullRequest, OrgProjectHealth, RollupRow, User } from "./api";
import { collapseRuns, type ActivityRow } from "./activity-filter";
import { pctText, ratio, type Panel } from "./metrics-model";
import { foldLogin } from "./people-activity";
import type { ProjTab } from "./project-overview";
import type { PathFacts, PathStep } from "./project-path";
import { QUIET_DAYS, personName } from "./pull-request-waits";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ── Signals ────────────────────────────────────────────────────────────── */

export type SignalLevel = "blocked" | "risk" | "info";

/** Where a signal's action goes: a project tab, or the pull requests' list
 *  opened in place, or the IDE. */
export type SignalTarget = ProjTab | "pulls" | "ide";

export interface Signal {
  key: string;
  level: SignalLevel;
  /** The reason in a few words: the verdict's line, and the row's sentence. */
  phrase: string;
  detail?: string;
  action: { label: string; target: SignalTarget };
}

/** What the Overview read. `undefined`: still reading; `null`: not readable. */
export interface OverviewFacts {
  path: PathFacts | null | undefined;
  rollup: RollupRow | null | undefined;
  pulls: OpenPullRequest[] | null | undefined;
  deployments: Deployment[] | null | undefined;
  /** The project's line of the organization's overview. */
  health: OrgProjectHealth | null | undefined;
  /** Comment threads in the repositories waiting on the reader. */
  waitingOnMe?: number;
}

/** When a deployment happened: decided, else asked for. */
const deployedAt = (d: Deployment) => d.decided_at ?? d.requested_at ?? "";

/** The newest deploy that ran (succeeded or failed), installs only. */
export function lastDeploy(deployments: readonly Deployment[]): Deployment | null {
  const ran = deployments.filter(
    (d) => (d.action ?? "install") === "install" && !d.preview && (d.state === "succeeded" || d.state === "failed"),
  );
  return ran.reduce<Deployment | null>((a, d) => (!a || deployedAt(d) > deployedAt(a) ? d : a), null);
}

/** Open pull requests quiet for a week or more, drafts aside. */
export function stuckPulls(pulls: readonly OpenPullRequest[]): OpenPullRequest[] {
  return pulls.filter((p) => !p.draft && p.waiting !== "draft" && (p.days_since_update ?? 0) >= QUIET_DAYS);
}

/** Who the stuck ones wait on, by name, at most three. */
function waitingOnText(pulls: readonly OpenPullRequest[]): string {
  const names = [
    ...new Set(
      pulls.flatMap((p) => (p.waiting === "nobody" ? ["nobody asked"] : p.waiting_on.map((w) => personName(w)))),
    ),
  ];
  if (names.length === 0) return "";
  return `waiting on ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}`;
}

/** Everything that waits on the PM or the team, worst first. */
export function projectSignals(f: OverviewFacts): Signal[] {
  const out: Signal[] = [];
  const reasons = f.health?.reasons ?? [];

  /* Blocked */
  if (reasons.some((r) => r.kind === "refused"))
    out.push({
      key: "refused",
      level: "blocked",
      phrase: "repository connection refused",
      detail: "nothing syncs until the connection is fixed",
      action: { label: "Open Sources", target: "sources" },
    });
  const p = f.path;
  if (p?.product && p.product.resolves === false)
    out.push({
      key: "product",
      level: "blocked",
      phrase: "product does not resolve",
      detail: plural(p.product.errors, "error"),
      action: { label: "Open Product", target: "components" },
    });
  if (p?.build && p.build !== "none" && p.build.status === "failed")
    out.push({
      key: "build",
      level: "blocked",
      phrase: "last build failed",
      detail: p.build.sha ? `at ${p.build.sha}` : undefined,
      action: { label: "Open Releases", target: "releases" },
    });
  const deploy = f.deployments ? lastDeploy(f.deployments) : null;
  if (deploy?.state === "failed")
    out.push({
      key: "deploy",
      level: "blocked",
      phrase: `last deploy to ${deploy.environment_name} failed`,
      detail: deploy.reason || deploy.outcome || undefined,
      action: { label: "Open Releases", target: "releases" },
    });
  if (p?.findings && p.findings.high > 0)
    out.push({
      key: "findings",
      level: "blocked",
      phrase: `${plural(p.findings.high, "high finding")} open`,
      detail: "a high finding blocks the build",
      action: { label: "Open findings", target: "model" },
    });

  /* At risk */
  const failing = f.rollup?.specs_failing ?? f.health?.specs_failing ?? null;
  if (failing !== null && failing > 0)
    out.push({
      key: "specs",
      level: "risk",
      phrase: failing === 1 ? "1 spec fails its checks" : `${failing} specs fail their checks`,
      detail: f.rollup?.specs ? `of ${f.rollup.specs} specs` : undefined,
      action: { label: "Open Specs", target: "specs" },
    });
  const stuck = f.pulls ? stuckPulls(f.pulls) : null;
  const stuckCount = stuck ? stuck.length : (f.health?.stuck ?? 0);
  if (stuckCount > 0)
    out.push({
      key: "stuck",
      level: "risk",
      phrase: `${plural(stuckCount, "pull request")} stuck over ${QUIET_DAYS} days`,
      detail: stuck ? waitingOnText(stuck) || undefined : undefined,
      action: { label: "Who they wait on", target: "pulls" },
    });
  const nobody = f.pulls ? f.pulls.filter((x) => x.waiting === "nobody" && !(stuck ?? []).includes(x)).length : 0;
  if (nobody > 0)
    out.push({
      key: "nobody",
      level: "risk",
      phrase: `${plural(nobody, "pull request")} with no reviewer asked`,
      action: { label: "Who they wait on", target: "pulls" },
    });

  /* Info: listed, not counted against the project. */
  if (f.waitingOnMe && f.waitingOnMe > 0)
    out.push({
      key: "threads-me",
      level: "info",
      phrase: `${plural(f.waitingOnMe, "comment thread")} ${f.waitingOnMe === 1 ? "waits" : "wait"} on you`,
      detail: "answered in the IDE, on the text each is about",
      action: { label: "Open IDE", target: "ide" },
    });
  else if ((f.rollup?.open_comments ?? 0) > 0)
    out.push({
      key: "threads",
      level: "info",
      phrase: `${plural(f.rollup!.open_comments!, "comment thread")} unanswered`,
      detail: "questions the team left in the documents",
      action: { label: "Open Activity", target: "activity" },
    });
  const quiet = reasons.find((r) => r.kind === "quiet");
  if (quiet)
    out.push({
      key: "quiet",
      level: "info",
      phrase: `no activity for ${Math.round(quiet.value ?? f.health?.quiet_days ?? 0)} days`,
      action: { label: "Open Activity", target: "activity" },
    });
  return out;
}

/* ── Verdict ────────────────────────────────────────────────────────────── */

export type VerdictState = "on-track" | "at-risk" | "blocked" | "reading";

export interface Verdict {
  state: VerdictState;
  label: string;
  tone: "ok" | "warn" | "danger" | "running";
  /** The main reason, in one short phrase. */
  reason: string;
  /** How many more reasons Needs attention lists. */
  more: number;
}

/** The step to do next: the path's current one; null when the path is done
 *  (or not read). */
export function nextStep(steps: readonly PathStep[] | null | undefined): PathStep | null {
  return steps?.find((s) => s.state === "current") ?? null;
}

export function projectVerdict(signals: readonly Signal[], steps: readonly PathStep[] | null | undefined): Verdict {
  const blocked = signals.filter((s) => s.level === "blocked");
  const risk = signals.filter((s) => s.level === "risk");
  if (blocked.length)
    return { state: "blocked", label: "Blocked", tone: "danger", reason: blocked[0].phrase, more: blocked.length + risk.length - 1 };
  if (risk.length) return { state: "at-risk", label: "At risk", tone: "warn", reason: risk[0].phrase, more: risk.length - 1 };
  if (steps === undefined) return { state: "reading", label: "Reading…", tone: "running", reason: "", more: 0 };
  const next = nextStep(steps);
  const reason = next
    ? `next: ${next.title.charAt(0).toLowerCase()}${next.title.slice(1)}`
    : steps && steps.length > 0 && steps.every((s) => s.state === "done")
      ? "path complete"
      : "no step blocks the path";
  return { state: "on-track", label: "On track", tone: "ok", reason, more: 0 };
}

/* ── Path strip ─────────────────────────────────────────────────────────── */

/** A path step's state in StepFlow's words: a build or a product that failed
 *  is `failed`, high findings are `warn`, an unknown step is `later`. */
export function stripState(step: PathStep, path: PathFacts | null | undefined): "done" | "current" | "todo" | "later" | "warn" | "failed" {
  if (step.id === "build" && path?.build && path.build !== "none" && path.build.status === "failed") return "failed";
  if (step.id === "product" && path?.product?.resolves === false) return "failed";
  if (step.id === "findings" && (path?.findings?.high ?? 0) > 0) return "warn";
  if (step.state === "unknown") return "later";
  return step.state;
}

/* ── Releases ───────────────────────────────────────────────────────────── */

export interface EnvVersion {
  environment: string;
  /** What runs there: the chart version, else the build, else the commit. */
  version: string;
  at: string;
  /** A deploy to it failed after this one succeeded. */
  failedAfter: boolean;
}

/** The version each environment runs: its newest successful install, and
 *  whether a later attempt failed. Environments sorted by name. */
export function versionsByEnvironment(deployments: readonly Deployment[]): EnvVersion[] {
  const by = new Map<string, Deployment[]>();
  for (const d of deployments) {
    if ((d.action ?? "install") !== "install" || d.preview) continue;
    by.set(d.environment_name, [...(by.get(d.environment_name) ?? []), d]);
  }
  const out: EnvVersion[] = [];
  for (const [environment, list] of by) {
    const ok = list.filter((d) => d.state === "succeeded").sort((a, b) => deployedAt(b).localeCompare(deployedAt(a)))[0];
    if (!ok) continue;
    const failedAfter = list.some((d) => d.state === "failed" && deployedAt(d) > deployedAt(ok));
    const version = ok.chart_version || (ok.build ? `build ${ok.build.slice(0, 8)}` : "") || (ok.commit ? ok.commit.slice(0, 7) : "") || ok.product;
    out.push({ environment, version, at: deployedAt(ok), failedAfter });
  }
  return out.sort((a, b) => a.environment.localeCompare(b.environment));
}

/* ── Spec health ────────────────────────────────────────────────────────── */

/** The specs that pass their checks, of those checked: ONE panel, opening Specs. */
export function specHealthPanel(rollup: RollupRow | null | undefined): Panel {
  const base = {
    key: "project-spec-health",
    title: "Spec health",
    source: "Studio" as const,
    unit: "of checked specs pass",
    info:
      "The project's specs that pass their type's checks, of those checked, with the failing ones and the open findings against them " +
      "(Studio's spec quality, as the organization's rollup counts it). It is now, not a range: Studio keeps no history of it yet.",
    target: "specs" as const,
  };
  const off = (state: Panel["state"], why: string): Panel => ({ ...base, state, value: "—", trend: null, chart: null, why });
  if (rollup === undefined) return off("loading", "Reading…");
  if (rollup === null) return off("unavailable", "The project's rollup could not be read.");
  const checked = rollup.specs_checked ?? null;
  const failing = rollup.specs_failing ?? null;
  if (checked === null || failing === null) return off("unavailable", "The spec checks could not be read.");
  if (checked === 0) return off("empty", "No spec has been checked yet.");
  const passing = Math.max(0, checked - failing);
  return {
    ...base,
    state: "ok",
    value: pctText(ratio(passing, checked)),
    trend: null,
    sub: `${failing} failing · ${rollup.open_findings ?? "—"} open findings · ${rollup.specs ?? checked} specs`,
    chart: {
      kind: "rank",
      rows: [
        { label: "Passing", value: passing },
        { label: "Failing", value: failing },
      ],
      format: (v) => String(v),
    },
  };
}

/* ── Team ───────────────────────────────────────────────────────────────── */

/** How much of each member the project saw: Activity events by their login,
 *  open pull requests they wrote or review. Most active first. */
export function teamActivity(
  team: readonly User[],
  events: readonly ActivityEvent[],
  pulls: readonly OpenPullRequest[],
): { user: User; seen: number }[] {
  const logins = (u: User) =>
    new Set([u.username, u.display_name, u.email, u.email?.split("@")[0]].map((x) => foldLogin(x)).filter((x): x is string => !!x));
  return team
    .map((user) => {
      const mine = logins(user);
      const isMe = (login: string | null | undefined, id?: string | null) => id === user.id || mine.has(foldLogin(login) ?? "");
      const seen =
        events.filter((e) => isMe(e.by)).length +
        pulls.filter((p) => (p.author && isMe(p.author.login, p.author.user_id)) || p.reviewers.some((r) => isMe(r.person.login, r.person.user_id))).length;
      return { user, seen };
    })
    .sort((a, b) => b.seen - a.seen || (a.user.display_name || a.user.username).localeCompare(b.user.display_name || b.user.username));
}

/** The people on the project, and who of them the project saw at work. */
export function teamPanel(
  team: readonly User[] | null | undefined,
  rollupTeam: number | null | undefined,
  events: readonly ActivityEvent[] | null | undefined,
  pulls: readonly OpenPullRequest[] | null | undefined,
): Panel {
  const base = {
    key: "project-team",
    title: "Team",
    source: "Studio" as const,
    unit: "people on the project",
    info:
      "The organization's members the project's access reaches, and how often the project saw each at work: Activity events signed with their login " +
      "and open pull requests they wrote or review. A person working under another git login is not matched. It is now, not a range.",
    target: "people" as const,
  };
  const off = (state: Panel["state"], why: string): Panel => ({ ...base, state, value: "—", trend: null, chart: null, why });
  if (team === undefined) return off("loading", "Reading…");
  if (team === null) {
    if (rollupTeam != null) return { ...base, state: "ok", value: String(rollupTeam), trend: null, sub: "who they are could not be read", chart: null };
    return off("unavailable", "The project's members could not be read: who is on it is unknown, not nobody.");
  }
  if (team.length === 0) return off("empty", "Nobody is on the project yet.");
  const ranked = teamActivity(team, events ?? [], pulls ?? []);
  const active = ranked.filter((r) => r.seen > 0);
  const name = (u: User) => u.display_name || u.username;
  return {
    ...base,
    state: "ok",
    value: String(team.length),
    trend: null,
    sub:
      events || pulls
        ? `${active.length} seen at work · ${ranked
            .slice(0, 3)
            .map((r) => name(r.user))
            .join(", ")}${ranked.length > 3 ? ` +${ranked.length - 3}` : ""}`
        : ranked.map((r) => name(r.user)).slice(0, 3).join(", "),
    chart: active.length ? { kind: "rank", rows: active.slice(0, 5).map((r) => ({ label: name(r.user), value: r.seen })), format: (v) => String(v) } : null,
  };
}

/* ── Recent activity ────────────────────────────────────────────────────── */

/** The newest `n` rows of the Activity feed, runs of one check folded. */
export function recentActivity(events: readonly ActivityEvent[], n = 5): ActivityRow[] {
  const sorted = [...events].sort((a, b) => (b.recorded ?? "").localeCompare(a.recorded ?? ""));
  return collapseRuns(sorted).slice(0, n);
}
