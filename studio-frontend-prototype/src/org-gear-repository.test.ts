import { describe, expect, it } from "vitest";

import type { Connection, RegistryEntry, RegistryProjectWalk } from "./api";
import {
  connectionScopeWarning,
  gearRepoConnections,
  gearRepoWalkLine,
  isOrganizationScope,
  normalizeRepo,
  occurrencePlace,
  repoUrl,
  scaffoldTargetLine,
} from "./org-gear-repository";
import { candidateWhere, projectsOf } from "./registry";

const conn = (id: string, label: string, scope: string, provider = "github", base_url = "https://api.github.com"): Connection => ({
  id,
  owner_tenant_id: "org",
  provider,
  label,
  account: "acme",
  base_url,
  scope,
  secret_ref: "s",
  created_at_epoch_secs: 0,
});

describe("the organization's gear repository", () => {
  it("offers GitHub connections, the organization-scoped first", () => {
    const offered = gearRepoConnections([
      conn("1", "mine", "personal"),
      conn("2", "Team", "workspace"),
      conn("3", "Acme", "organization"),
      conn("4", "Jira", "organization", "jira"),
    ]);
    expect(offered.map((c) => c.id)).toEqual(["3", "1", "2"]);
    // One the organization only inherits (the platform's) is not offered:
    // the server refuses it as not the organization's own.
    const inherited = { ...conn("5", "Platform GitHub", "organization"), owner_tenant_id: "root" };
    expect(gearRepoConnections([conn("3", "Acme", "organization"), inherited], "org").map((c) => c.id)).toEqual(["3"]);
    expect(gearRepoConnections([inherited]).map((c) => c.id)).toEqual(["5"]);
    expect(isOrganizationScope("organization")).toBe(true);
    expect(isOrganizationScope("org")).toBe(true);
    expect(isOrganizationScope("workspace")).toBe(false);
  });

  it("warns about a connection the server would refuse, and says why", () => {
    expect(connectionScopeWarning(conn("3", "Acme", "organization"))).toBeNull();
    expect(connectionScopeWarning(null)).toBeNull();
    const personal = connectionScopeWarning(conn("1", "mine", "personal"));
    expect(personal).toContain("personal connection");
    expect(personal).toContain("background read cannot use it");
    expect(personal).toContain("organization scope");
    const workspace = connectionScopeWarning(conn("2", "Team", "workspace"));
    expect(workspace).toContain("workspace connection");
    expect(workspace).toContain("organization scope");
  });

  it("reads owner/name out of what a person pastes", () => {
    expect(normalizeRepo(" https://github.com/acme/gears.git ")).toBe("acme/gears");
    expect(normalizeRepo("/acme/gears/")).toBe("acme/gears");
    expect(normalizeRepo("acme")).toBeNull();
    expect(normalizeRepo("acme/gears/extra")).toBeNull();
    expect(normalizeRepo("a b/c")).toBeNull();
  });

  it("links to github.com, or to the enterprise host a connection names", () => {
    expect(repoUrl("acme/gears")).toBe("https://github.com/acme/gears");
    expect(repoUrl("acme/gears", { base_url: "https://api.github.com" })).toBe("https://github.com/acme/gears");
    expect(repoUrl("acme/gears", { base_url: "https://ghe.acme.io/api/v3/" })).toBe("https://ghe.acme.io/acme/gears");
  });

  it("says where a new gear is written, in the order the server chose", () => {
    expect(scaffoldTargetLine("organization", "acme/gears")).toBe("Into the organization's gear repository acme/gears.");
    expect(scaffoldTargetLine("project", "acme/app-gears")).toBe("Into this project's gear repository acme/app-gears.");
    expect(scaffoldTargetLine("sources", "acme/app")).toContain("from its sources");
    expect(scaffoldTargetLine(null, null)).toContain("Nowhere to write yet");
    expect(scaffoldTargetLine(undefined, "acme/x")).toBe("Into acme/x.");
  });

  it("names an occurrence in the organization's repository as such, not as a project", () => {
    const org = { scope: "organization", project_id: null, project_name: "Acme" };
    expect(occurrencePlace(org)).toBe("Acme · organization gear repository");
    expect(occurrencePlace({ scope: "organization", project_id: null, project_name: null })).toBe(
      "organization gear repository",
    );
    expect(occurrencePlace({ scope: "project", project_id: "p1", project_name: "studio" })).toBe("studio");
    expect(occurrencePlace({ project_id: "p1", project_name: null })).toBe("p1");

    const entry: RegistryEntry = {
      name: "ledger",
      kind: "gear",
      state: "candidate",
      capabilities: [],
      orphaned: false,
      occurrences: [
        { ...org, repo: "acme/gears", path: "gears/ledger", declared_in: "detected" },
        { scope: "project", project_id: "p1", project_name: "studio", repo: "acme/app", path: "src/ledger", declared_in: "gear.toml" },
      ],
    };
    expect(projectsOf(entry)).toEqual(["Acme · organization gear repository", "studio"]);
    expect(candidateWhere(entry)).toBe("Acme · organization gear repository · gears/ledger");
  });

  it("reads the gear repository's walk from the organization's row", () => {
    const walks: RegistryProjectWalk[] = [
      { project_id: "p1", project_name: "studio", at: "2026-10-09T10:00:00Z", repos: [{ repo: "acme/app", status: "read", components: 3 }] },
      {
        project_id: "org",
        project_name: "Acme",
        at: "2026-10-09T10:00:00Z",
        repos: [{ repo: "acme/gears", status: "read", components: 1 }],
      },
    ];
    const ok = gearRepoWalkLine(walks, "org")!;
    expect(ok.failed).toBe(false);
    expect(ok.text).toContain("1 component");
    expect(ok.text).not.toContain("components");
    expect(gearRepoWalkLine(walks, "other")).toBeNull();
    expect(gearRepoWalkLine(walks, undefined)).toBeNull();
    const failed = gearRepoWalkLine(
      [
        {
          project_id: "org",
          project_name: "Acme",
          at: "",
          repos: [{ repo: "acme/gears", status: "failed", components: 0, error: "401", hint: "renew it" }],
        },
      ],
      "org",
    )!;
    expect(failed.failed).toBe(true);
    expect(failed.text).toContain("401");
    expect(failed.hint).toBe("renew it");
  });
});
