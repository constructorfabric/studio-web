import { describe, expect, it } from "vitest";
import type { ActivityEvent, OpenPullRequest, PersonAlias, PullPerson } from "./api";
import type { AccessConfig } from "./access";
import {
  NO_ACTIVITY,
  accessOf,
  activityScore,
  addDesktops,
  addEvents,
  addInsight,
  addOpenPulls,
  configRepos,
  directoryOf,
  foldLogin,
  gitHandles,
  insightFigures,
  insightStatements,
  insightTotals,
  intensityOf,
  lastSeenOf,
  matrixColumns,
  onlineNow,
  personProjects,
  projectStack,
  recentFor,
  repoProjects,
  teamPath,
  totals,
  type ActivityIndex,
  type OrgProject,
} from "./people-activity";
import { activityWords, roleAbbr } from "./people-org";

const alias = (kind: string, id: string, confidence = "confirmed"): PersonAlias => ({
  kind,
  external_id: id,
  confidence,
  attributes: confidence === "confirmed",
  added_at_epoch_ms: 0,
});

const P = (id: string, name: string, ws = "w1", wsName = "Alpha"): OrgProject => ({
  id,
  name,
  workspaceId: ws,
  workspaceName: wsName,
  kind: null,
});

const projects = [P("p1", "Studio"), P("p2", "Gears"), P("p3", "Insight", "w2", "Beta")];

const person = (login: string, user_id: string | null = null): PullPerson => ({
  login,
  user_id,
  display_name: null,
  in_organization: user_id !== null,
});

function pr(over: Partial<OpenPullRequest>): OpenPullRequest {
  return {
    id: Math.random().toString(36),
    repo: "acme/studio",
    provider: "github",
    project_id: "p1",
    number: 1,
    title: "t",
    url: null,
    author: null,
    waiting: "nobody",
    waiting_on: [],
    waiting_on_teams: [],
    reason: "",
    review_decision: null,
    reviewers: [],
    assignees: [],
    draft: false,
    open_threads: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-02T00:00:00Z",
    days_open: 3,
    days_since_update: 1,
    ...over,
  };
}

const dir = directoryOf([
  { id: "ann", aliases: [alias("github", "Ann-Dev")], subjects: ["sub-ann"] },
  { id: "bob", aliases: [alias("github", "bobby", "claimed"), alias("email", "bob@x")], subjects: ["sub-bob"] },
  { id: "cy", aliases: [alias("github", "cy", "suggested")], subjects: [] },
]);

describe("accessOf", () => {
  const cfg: AccessConfig = {
    model: "roles",
    roles: [
      { key: "viewer", name: "Viewer", privileges: [] },
      { key: "editor", name: "Editor", privileges: [] },
    ],
    grants: [
      { id: "g1", subjectType: "member", subjectId: "ann", subjectName: "Ann", roleKey: "viewer", scopeType: "org", scopeId: "", scopeName: "" },
      { id: "g2", subjectType: "member", subjectId: "ann", subjectName: "Ann", roleKey: "editor", scopeType: "project", scopeId: "p2", scopeName: "Gears" },
      { id: "g3", subjectType: "member", subjectId: "bob", subjectName: "Bob", roleKey: "editor", scopeType: "project", scopeId: "p3", scopeName: "Insight" },
      { id: "g4", subjectType: "member", subjectId: "bob", subjectName: "Bob", roleKey: "editor", scopeType: "project", scopeId: "gone", scopeName: "Gone" },
    ],
  };

  it("under roles, a project grant wins over the organization-wide one", () => {
    const a = accessOf("ann", "member", cfg, projects);
    expect(a.get("p1")).toMatchObject({ roleName: "Viewer", via: "org" });
    expect(a.get("p2")).toMatchObject({ roleName: "Editor", via: "project" });
    expect(a.size).toBe(3);
  });

  it("under roles, only granted projects, and none that is not in the organization", () => {
    const b = accessOf("bob", "member", cfg, projects);
    expect([...b.keys()]).toEqual(["p3"]);
  });

  it("under tenant access, or with no config, every project with the membership role", () => {
    const t = accessOf("cy", "owner", null, projects);
    expect(t.size).toBe(3);
    expect(t.get("p1")).toMatchObject({ roleName: "Owner", via: "tenant" });
    expect(accessOf("cy", "member", { ...cfg, model: "tenant" }, projects).get("p3")?.roleName).toBe("Member");
  });
});

describe("who an account is", () => {
  it("folds logins and leaves bots out", () => {
    expect(foldLogin(" Ann-Dev ")).toBe("ann-dev");
    expect(foldLogin("coderabbitai[bot]")).toBeNull();
    expect(foldLogin("")).toBeNull();
  });

  it("takes confirmed and claimed git aliases, not suggested ones or addresses", () => {
    expect(gitHandles([alias("github", "A"), alias("gitlab", "b", "claimed"), alias("github", "c", "suggested"), alias("email", "d@x")])).toEqual([
      { handle: "a", kind: "github", confirmed: true },
      { handle: "b", kind: "gitlab", confirmed: false },
    ]);
  });

  it("drops a login two people claim", () => {
    const d = directoryOf([
      { id: "x", aliases: [alias("github", "same")], subjects: [] },
      { id: "y", aliases: [alias("github", "same")], subjects: [] },
    ]);
    expect(d.byLogin.has("same")).toBe(false);
  });

  it("maps logins and subjects", () => {
    expect(dir.byLogin.get("ann-dev")).toBe("ann");
    expect(dir.byLogin.get("bobby")).toBe("bob");
    expect(dir.byLogin.has("cy")).toBe(false);
    expect(dir.bySubject.get("sub-bob")).toBe("bob");
  });
});

describe("active in", () => {
  it("counts open pull requests authored, reviewed and waiting, by user id or login", () => {
    const index: ActivityIndex = new Map();
    addOpenPulls(index, dir, "p1", [
      pr({ author: person("ann-dev"), reviewers: [{ person: person("bobby"), state: "pending" }], waiting: "review", waiting_on: [person("bobby")] }),
      pr({ author: person("whoever", "bob"), reviewers: [{ person: person("BOBBY"), state: "approved" }] }),
      pr({ author: person("stranger"), reviewers: [{ person: person("coderabbitai[bot]"), state: "commented" }] }),
    ]);
    expect(index.get("ann")?.get("p1")).toMatchObject({ pullsAuthored: 1, pullsReviewing: 0 });
    // Bob's own pull request does not count as one he reviews.
    expect(index.get("bob")?.get("p1")).toMatchObject({ pullsAuthored: 1, pullsReviewing: 1, waitingOnThem: 1 });
    expect(index.get("bob")?.get("p1")?.lastAt).toBe("2026-10-02T00:00:00Z");
    expect(index.size).toBe(2);
  });

  it("counts feed events since a date, by login", () => {
    const index: ActivityIndex = new Map();
    const ev = (by: string, recorded: string | null): ActivityEvent => ({ id: by + recorded, kind: "comment", event: "Comment", subject: "#1", by, recorded });
    addEvents(index, dir, "p2", [ev("ann-dev", "2026-10-10T00:00:00Z"), ev("ann-dev", "2026-01-01T00:00:00Z"), ev("ann-dev", null), ev("nobody", "2026-10-10T00:00:00Z")], "2026-09-01T00:00:00Z");
    expect(index.get("ann")?.get("p2")?.events).toBe(1);
    expect(index.size).toBe(1);
  });

  it("counts desktops by sign-in subject", () => {
    const index: ActivityIndex = new Map();
    addDesktops(index, dir, "p3", [
      { id: "d", workspace_id: "p3", member_id: "sub-ann", device_id: "x", started_at_epoch_secs: 1, last_seen_epoch_secs: 1_790_000_000, expires_at_epoch_secs: 2, heartbeat_secs: 30 },
      { id: "e", workspace_id: "p3", member_id: "sub-unknown", device_id: "x", started_at_epoch_secs: 1, last_seen_epoch_secs: 1, expires_at_epoch_secs: 2, heartbeat_secs: 30 },
    ]);
    expect(index.get("ann")?.get("p3")?.desktop).toBe(1);
    expect(index.size).toBe(1);
  });

  it("reads a project's repositories from its config", () => {
    expect(
      configRepos({
        sources: [{ full_path: "Fork/Studio", clone_url: "https://github.com/Fork/Studio.git" }],
        source_git_url: "https://github.com/acme/studio.git",
        build: { repo: "acme/ci" },
      }),
    ).toEqual(["fork/studio", "acme/studio", "acme/ci"]);
    expect(configRepos({ source_git_url: "not a url" })).toEqual([]);
    expect(configRepos(null)).toEqual([]);
  });

  it("places Insight's figures on the projects whose sources hold the repository", () => {
    const index: ActivityIndex = new Map();
    const repos = repoProjects([
      { id: "p1", repos: ["Acme/Studio.git", "acme/shared"] },
      { id: "p2", repos: ["acme/shared", ""] },
    ]);
    expect(repos.get("acme/studio")).toEqual(["p1"]);
    expect(repos.get("acme/shared")).toEqual(["p1", "p2"]);
    addInsight(index, dir, [
      { login: "ann-dev", repo: "acme/shared", prs: 4, merged: 3, reviews: 8, last: "2026-10-01T00:00:00.000Z" },
      { login: "ann-dev", repo: "acme/elsewhere", prs: 9, merged: 9, reviews: 0, last: null },
    ], repos);
    expect(index.get("ann")?.get("p1")).toMatchObject({ insightPrs: 4, insightReviews: 8 });
    expect(index.get("ann")?.get("p2")).toMatchObject({ insightMerged: 3 });
    expect(index.get("ann")?.size).toBe(2);
  });

  it("grades intensity from nothing to very active", () => {
    expect(intensityOf(null)).toBe(0);
    expect(intensityOf(NO_ACTIVITY)).toBe(0);
    expect(intensityOf({ ...NO_ACTIVITY, events: 1 })).toBe(1);
    expect(intensityOf({ ...NO_ACTIVITY, pullsAuthored: 1 })).toBe(2);
    expect(intensityOf({ ...NO_ACTIVITY, pullsAuthored: 4 })).toBe(3);
    expect(intensityOf({ ...NO_ACTIVITY, insightPrs: 40, insightReviews: 80 })).toBe(4);
    expect(activityScore({ ...NO_ACTIVITY, insightPrs: 1, insightReviews: 1 })).toBe(2);
  });
});

describe("the Projects cell", () => {
  const act = new Map([
    ["p2", { ...NO_ACTIVITY, pullsAuthored: 5 }],
    ["p3", { ...NO_ACTIVITY, events: 1 }],
  ]);

  it("under tenant access, shows only where somebody was active, busiest first", () => {
    const rows = personProjects(projects, accessOf("x", "member", null, projects), act);
    const s = projectStack(rows, "tenant", 1);
    expect(s.shown.map((r) => r.project.id)).toEqual(["p2"]);
    expect(s.more).toBe(1);
    expect(s.total).toBe(2);
  });

  it("under roles, shows granted projects too, active before access-only", () => {
    const cfg: AccessConfig = {
      model: "roles",
      roles: [{ key: "editor", name: "Editor", privileges: [] }],
      grants: [{ id: "g", subjectType: "member", subjectId: "x", subjectName: "X", roleKey: "editor", scopeType: "project", scopeId: "p1", scopeName: "" }],
    };
    const rows = personProjects(projects, accessOf("x", "member", cfg, projects), act);
    const s = projectStack(rows, "roles", 4);
    expect(s.shown.map((r) => r.project.id)).toEqual(["p2", "p3", "p1"]);
    expect(s.shown[2].access?.roleName).toBe("Editor");
    expect(s.shown[0].access).toBeNull();
  });

  it("sums a person's activity", () => {
    const t = totals(act);
    expect(t).toMatchObject({ pullsAuthored: 5, events: 1 });
    expect(totals(undefined)).toEqual(NO_ACTIVITY);
  });
});

describe("last seen and presence", () => {
  const presence = [{ user_id: "sub-ann", tenant_id: "o", place: "org", since_ms: 1, last_seen_ms: 5_000 }];

  it("takes the newest of what studio-user recorded, presence and desktops", () => {
    expect(lastSeenOf("ann", 1_000, dir, presence, [])).toBe(5_000);
    expect(lastSeenOf("ann", 9_000, dir, presence, [])).toBe(9_000);
    expect(
      lastSeenOf("bob", null, dir, [], [
        { id: "d", workspace_id: "p", member_id: "sub-bob", device_id: "x", started_at_epoch_secs: 1, last_seen_epoch_secs: 7, expires_at_epoch_secs: 8, heartbeat_secs: 1 },
      ]),
    ).toBe(7_000);
    expect(lastSeenOf("cy", undefined, dir, presence, [])).toBeUndefined();
  });

  it("knows who is online by person", () => {
    expect(onlineNow(dir, presence).has("ann")).toBe(true);
  });
});

describe("Insight", () => {
  it("names only logins it may, sorted and without duplicates", () => {
    const sql = insightStatements(["Ann-Dev", "ann-dev", "x'); DROP TABLE t; --", "bob"], 30);
    expect(sql?.authored).toContain("IN ('ann-dev', 'bob')");
    expect(sql?.authored).toContain("INTERVAL 30 DAY");
    expect(sql?.reviewed).toContain("silver.fct_git_review");
    expect(sql?.authored).not.toContain("DROP");
    expect(insightStatements(["no good"])).toBeNull();
    expect(insightStatements([])).toBeNull();
  });

  it("folds both answers into one figure per login and repository, counts as strings or numbers", () => {
    const figures = insightFigures(
      [{ login: "Ann", repo: "Acme/X", prs: "3", merged: 2, last: "2026-10-01 10:00:00" }],
      [
        { login: "ann", repo: "acme/x", reviews: 5, last: "2026-10-02 10:00:00" },
        { login: "ann", repo: "acme/y", reviews: "1", last: "" },
      ],
    );
    expect(figures).toEqual([
      { login: "ann", repo: "acme/x", prs: 3, merged: 2, reviews: 5, last: "2026-10-02T10:00:00.000Z" },
      { login: "ann", repo: "acme/y", prs: 0, merged: 0, reviews: 1, last: null },
    ]);
    const t = insightTotals(figures, ["ANN"]);
    expect(t).toMatchObject({ prs: 3, merged: 2, reviews: 6 });
    expect(t.repos.map((r) => r.repo)).toEqual(["acme/x", "acme/y"]);
    expect(insightTotals(figures, ["bob"]).prs).toBe(0);
  });
});

describe("layout and words", () => {
  it("groups the matrix's columns by workspace, both by name", () => {
    const cols = matrixColumns([P("a", "Zed", "w2", "Beta"), P("b", "Ant", "w1", "Alpha"), P("c", "Bee", "w2", "Beta")]);
    expect(cols.map((c) => [c.name, c.projects.map((p) => p.name)])).toEqual([
      ["Alpha", ["Ant"]],
      ["Beta", ["Bee", "Zed"]],
    ]);
  });

  it("addresses a project's Team tab", () => {
    expect(teamPath({ id: "p", workspaceId: "w" }, "o")).toBe("/workspaces/w/projects/p/people?org=o");
    expect(teamPath({ id: "p", workspaceId: "w" }, null)).toBe("/workspaces/w/projects/p/people");
  });

  it("lists the newest events a person made", () => {
    const ev = (by: string, at: string): ActivityEvent => ({ id: at, kind: "check", event: "Checked", subject: "s", by, recorded: at });
    const r = recentFor("ann", dir, [
      { projectId: "p1", events: [ev("ann-dev", "2026-10-01T00:00:00Z"), ev("bobby", "2026-10-05T00:00:00Z")] },
      { projectId: "p2", events: [ev("ann-dev", "2026-10-03T00:00:00Z")] },
    ]);
    expect(r.map((x) => x.projectId)).toEqual(["p2", "p1"]);
  });

  it("says what was seen and abbreviates a role", () => {
    expect(activityWords({ ...NO_ACTIVITY, pullsAuthored: 1, pullsReviewing: 2, insightPrs: 3 })).toBe("1 open PR · reviewing 2 · 3 PRs in 90d");
    expect(activityWords(null)).toBe("");
    expect(roleAbbr("Project admin")).toBe("PA");
    expect(roleAbbr("Owner")).toBe("Own");
  });
});
