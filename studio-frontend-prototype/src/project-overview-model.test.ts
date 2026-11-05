import { describe, expect, it } from "vitest";

import type { ActivityEvent, Deployment, OpenPullRequest, OrgProjectHealth, RollupRow, User } from "./api";
import {
  lastDeploy,
  nextStep,
  projectSignals,
  projectVerdict,
  recentActivity,
  specHealthPanel,
  stripState,
  teamPanel,
  versionsByEnvironment,
  type OverviewFacts,
} from "./project-overview-model";
import { projectPath, type PathFacts } from "./project-path";

const PATH: PathFacts = {
  repositories: 1,
  synced: 1,
  specs: { bound: 10, needsReview: 0, notScanned: 0 },
  model: { documents: 10, extracted: 10, facts: 40, running: false },
  findings: { open: 0, high: 0 },
  product: { gears: 4, resolves: true, errors: 0, written: true },
  build: { status: "passed", sha: "abc1234" },
};

const ROLLUP = { id: "p", name: "P", kind: "project", specs: 20, specs_checked: 20, specs_failing: 0, open_findings: 3, team: 2 } as RollupRow;

const dep = (over: Partial<Deployment>): Deployment =>
  ({
    id: Math.random().toString(36).slice(2),
    project_id: "p",
    project_name: "P",
    environment_id: "e",
    environment_name: "dev",
    profile: "",
    product: "prod",
    images: [],
    namespace: "",
    chart_sha256: "",
    state: "succeeded",
    requested_by: "",
    requested_by_name: "",
    requested_at: "2026-11-01T10:00:00Z",
    ...over,
  }) as Deployment;

const pr = (over: Partial<OpenPullRequest>): OpenPullRequest =>
  ({
    id: Math.random().toString(36).slice(2),
    repo: "o/r",
    provider: "github",
    project_id: "p",
    number: 1,
    title: "t",
    url: null,
    author: null,
    waiting: "review",
    waiting_on: [],
    waiting_on_teams: [],
    reason: "",
    review_decision: null,
    reviewers: [],
    assignees: [],
    draft: false,
    open_threads: null,
    created_at: null,
    updated_at: null,
    days_open: 1,
    days_since_update: 1,
    ...over,
  }) as OpenPullRequest;

const facts = (over: Partial<OverviewFacts> = {}): OverviewFacts => ({
  path: PATH,
  rollup: ROLLUP,
  pulls: [],
  deployments: [],
  health: null,
  ...over,
});

const verdictOf = (f: OverviewFacts) => projectVerdict(projectSignals(f), f.path ? projectPath(f.path) : f.path);

describe("the verdict", () => {
  it("is On track with the path complete when nothing is wrong", () => {
    const v = verdictOf(facts());
    expect(v).toMatchObject({ state: "on-track", label: "On track", tone: "ok", reason: "path complete", more: 0 });
  });

  it("names the next step when the path is not done", () => {
    const v = verdictOf(facts({ path: { ...PATH, product: { gears: 0, resolves: null, errors: 0, written: false } } }));
    expect(v.state).toBe("on-track");
    expect(v.reason).toBe("next: compose the product");
  });

  it("is Blocked by a failed build, a failed deploy, a product that does not resolve or a high finding", () => {
    expect(verdictOf(facts({ path: { ...PATH, build: { status: "failed", sha: "x" } } }))).toMatchObject({
      state: "blocked",
      reason: "last build failed",
    });
    expect(
      verdictOf(facts({ deployments: [dep({ state: "succeeded" }), dep({ state: "failed", requested_at: "2026-11-02T00:00:00Z", environment_name: "test" })] })),
    ).toMatchObject({ state: "blocked", reason: "last deploy to test failed" });
    expect(verdictOf(facts({ path: { ...PATH, product: { gears: 3, resolves: false, errors: 2, written: false } } })).reason).toBe(
      "product does not resolve",
    );
    expect(verdictOf(facts({ path: { ...PATH, findings: { open: 3, high: 2 } } })).reason).toBe("2 high findings open");
  });

  it("is Blocked by a refused connection first, and counts the other reasons", () => {
    const health = { id: "p", reasons: [{ kind: "refused", value: null }], stuck: 0 } as unknown as OrgProjectHealth;
    const v = verdictOf(facts({ health, rollup: { ...ROLLUP, specs_failing: 4 }, path: { ...PATH, build: { status: "failed", sha: "" } } }));
    expect(v).toMatchObject({ state: "blocked", tone: "danger", reason: "repository connection refused", more: 2 });
  });

  it("is At risk for failing specs or stuck pull requests, not for a fresh one", () => {
    expect(verdictOf(facts({ rollup: { ...ROLLUP, specs_failing: 1 } }))).toMatchObject({
      state: "at-risk",
      tone: "warn",
      reason: "1 spec fails its checks",
    });
    expect(verdictOf(facts({ pulls: [pr({ days_since_update: 2 })] })).state).toBe("on-track");
    const stuck = [pr({ days_since_update: 9, waiting_on: [{ login: "ann", user_id: null, display_name: "Ann", in_organization: true }] })];
    const signals = projectSignals(facts({ pulls: stuck }));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ key: "stuck", level: "risk", phrase: "1 pull request stuck over 7 days", detail: "waiting on Ann" });
    // A draft is the author's own work in progress, not stuck.
    expect(verdictOf(facts({ pulls: [pr({ days_since_update: 30, draft: true, waiting: "draft" })] })).state).toBe("on-track");
  });

  it("does not let unread sources or info signals move it", () => {
    expect(verdictOf(facts({ rollup: null, pulls: null, deployments: null, health: undefined })).state).toBe("on-track");
    const v = verdictOf(facts({ waitingOnMe: 3 }));
    expect(v.state).toBe("on-track");
    expect(projectSignals(facts({ waitingOnMe: 3 }))[0]).toMatchObject({ level: "info", phrase: "3 comment threads wait on you" });
  });

  it("is Reading while the path is, unless something already blocks", () => {
    expect(verdictOf(facts({ path: undefined })).state).toBe("reading");
    expect(verdictOf(facts({ path: undefined, rollup: { ...ROLLUP, specs_failing: 2 } })).state).toBe("at-risk");
  });
});

describe("the path strip", () => {
  it("takes the current step as the next action, none when done", () => {
    const steps = projectPath({ ...PATH, build: "none" });
    expect(nextStep(steps)?.id).toBe("build");
    expect(nextStep(projectPath(PATH))).toBeNull();
  });

  it("marks a failed build or product failed, high findings warn, unknown later", () => {
    const f: PathFacts = { ...PATH, build: { status: "failed", sha: "" }, findings: { open: 1, high: 1 }, model: null };
    const steps = projectPath(f);
    const by = Object.fromEntries(steps.map((s) => [s.id, stripState(s, f)]));
    expect(by).toMatchObject({ build: "failed", findings: "warn", model: "later", repos: "done" });
  });
});

describe("releases", () => {
  it("finds the newest deploy that ran, installs only", () => {
    const a = dep({ requested_at: "2026-11-01T00:00:00Z" });
    const b = dep({ requested_at: "2026-11-03T00:00:00Z", state: "failed" });
    const c = dep({ requested_at: "2026-11-04T00:00:00Z", action: "uninstall" });
    const d = dep({ requested_at: "2026-11-05T00:00:00Z", state: "queued" });
    expect(lastDeploy([a, b, c, d])).toBe(b);
    expect(lastDeploy([])).toBeNull();
  });

  it("says the version each environment runs, and a later failure", () => {
    const rows = versionsByEnvironment([
      dep({ environment_name: "test", chart_version: "0.3.0", requested_at: "2026-11-01T00:00:00Z" }),
      dep({ environment_name: "dev", chart_version: "0.2.0", requested_at: "2026-11-01T00:00:00Z" }),
      dep({ environment_name: "dev", chart_version: "0.4.0", requested_at: "2026-11-02T00:00:00Z" }),
      dep({ environment_name: "dev", chart_version: "0.5.0", state: "failed", requested_at: "2026-11-03T00:00:00Z" }),
      dep({ environment_name: "prod", state: "failed" }),
      dep({ environment_name: "qa", commit: "0123456789abcdef" }),
    ]);
    expect(rows.map((r) => [r.environment, r.version, r.failedAfter])).toEqual([
      ["dev", "0.4.0", true],
      ["qa", "0123456", false],
      ["test", "0.3.0", false],
    ]);
  });
});

describe("panels", () => {
  it("spec health is the passing share, with the failing ones", () => {
    const p = specHealthPanel({ ...ROLLUP, specs_checked: 155, specs_failing: 32, open_findings: 211, specs: 155 });
    expect(p).toMatchObject({ state: "ok", value: "79%", target: "specs", sub: "32 failing · 211 open findings · 155 specs" });
    expect(specHealthPanel(undefined).state).toBe("loading");
    expect(specHealthPanel(null).state).toBe("unavailable");
    expect(specHealthPanel({ ...ROLLUP, specs_checked: 0 }).state).toBe("empty");
  });

  it("team counts the members and ranks who was seen at work", () => {
    const team: User[] = [
      { id: "u1", username: "ann", display_name: "Ann" },
      { id: "u2", username: "bob" },
    ];
    const events = [{ id: "1", kind: "comment", event: "Commented", subject: "a.md", by: "Bob" }] as ActivityEvent[];
    const pulls = [pr({ author: { login: "x", user_id: "u2", display_name: null, in_organization: true } })];
    const p = teamPanel(team, 2, events, pulls);
    expect(p.value).toBe("2");
    expect(p.chart).toMatchObject({ kind: "rank", rows: [{ label: "bob", value: 2 }] });
    expect(teamPanel(null, 3, null, null)).toMatchObject({ state: "ok", value: "3" });
    expect(teamPanel(null, null, null, null).state).toBe("unavailable");
    expect(teamPanel([], 0, [], []).state).toBe("empty");
  });
});

describe("recent activity", () => {
  it("is the newest five rows, a run of one check folded", () => {
    const ev = (i: number, event = "Document checked", kind: "check" | "comment" = "check"): ActivityEvent => ({
      id: String(i),
      kind,
      event,
      subject: `d${i}.md`,
      by: "leak",
      recorded: `2026-11-0${Math.min(9, i)}T00:00:00Z`,
    });
    const rows = recentActivity([ev(1), ev(2), ev(3), ev(4), ev(9, "Commented", "comment"), ev(8, "Commented", "comment")]);
    expect(rows.map((r) => r.event)).toEqual(["Commented", "Commented", "Document checked"]);
    expect(rows[2].items).toHaveLength(4);
  });
});
