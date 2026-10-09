import { describe, expect, it } from "vitest";

import type { RegistryEntry } from "./api";
import {
  ACTION_LABEL,
  REGISTRY_STATES,
  STATE_LABEL,
  allowedActions,
  candidateWhere,
  candidatesOf,
  declareRefusal,
  detectedProjects,
  evidenceLines,
  decisionLine,
  decisionRefusal,
  decisionTargets,
  filterEntries,
  isDuplicated,
  ownerLabel,
  projectsOf,
  registryProjects,
  stateCounts,
  walkLine,
  consumerLine,
  consumersLabel,
  deprecationImpact,
  isOrphaned,
  publishPreviewLines,
  publishStatus,
  suggestRefusal,
  suggestionEdit,
} from "./registry";

const entry = (name: string, extra: Partial<RegistryEntry> = {}): RegistryEntry => ({
  name,
  kind: "gear",
  state: "declared",
  capabilities: [],
  orphaned: false,
  occurrences: [{ project_id: "p1", project_name: "studio-web", repo: "cf/studio-web", path: `src/${name}`, declared_in: "attribute" }],
  ...extra,
});

describe("the registry", () => {
  const entries = [
    entry("studio-documents", { description: "document management" }),
    entry("studio-user", { state: "registered" }),
    entry("billing", {
      occurrences: [
        { project_id: "p1", project_name: "studio-web", repo: "cf/studio-web", path: "src/billing", declared_in: "attribute" },
        { project_id: "p2", project_name: "insight", repo: "cf/insight", path: "gears/billing", declared_in: "gear.toml" },
      ],
    }),
  ];

  it("counts by state", () => {
    expect(stateCounts(entries)).toEqual({ declared: 2, registered: 1 });
  });

  it("filters by state, project and text in names, descriptions and paths", () => {
    expect(filterEntries(entries, { state: "registered", q: "", project: null }).map((e) => e.name)).toEqual(["studio-user"]);
    expect(filterEntries(entries, { state: null, q: "", project: "p2" }).map((e) => e.name)).toEqual(["billing"]);
    expect(filterEntries(entries, { state: null, q: "document", project: null }).map((e) => e.name)).toEqual(["studio-documents"]);
    expect(filterEntries(entries, { state: null, q: "gears/bill", project: null }).map((e) => e.name)).toEqual(["billing"]);
  });

  it("names the projects and flags a component declared in two repositories", () => {
    expect(projectsOf(entries[2])).toEqual(["studio-web", "insight"]);
    expect(isDuplicated(entries[2])).toBe(true);
    expect(isDuplicated(entries[0])).toBe(false);
    expect(registryProjects(entries)).toEqual([
      { id: "p2", name: "insight" },
      { id: "p1", name: "studio-web" },
    ]);
  });
});

describe("what the last walk saw", () => {
  const at = "2026-10-09T13:00:00Z";
  it("says a project was not readable, and what to do", () => {
    const line = walkLine({
      project_id: "p1",
      project_name: "studio-web",
      at,
      repos: [{ repo: "cf/studio-web", status: "failed", components: 0, error: "not readable", hint: "Share the connection" }],
    });
    expect(line).toEqual({ text: "1 of 1 repository not readable", failed: true, hint: "Share the connection" });
  });

  it("counts what it read, and says when nothing changed", () => {
    expect(
      walkLine({ project_id: "p", project_name: "x", at, repos: [{ repo: "a", status: "unchanged", components: 2 }, { repo: "b", status: "read", components: 1 }] }),
    ).toEqual({ text: "read · 3 components", failed: false, hint: null });
    expect(walkLine(undefined).text).toBe("not read yet");
  });
});

describe("decisions about an entry", () => {
  it("offers the moves the server allows from each state", () => {
    expect(allowedActions("declared")).toEqual(["register", "reject", "merge", "edit"]);
    expect(allowedActions("candidate")).toEqual(["register", "reject", "merge", "edit"]);
    expect(allowedActions("registered")).toEqual(["publish", "deprecate", "merge", "edit"]);
    expect(allowedActions("registered", { platformAdmin: true })).toEqual(["publish", "mark_published", "deprecate", "merge", "edit"]);
    expect(allowedActions("published", { platformAdmin: true })).toEqual(["deprecate", "merge", "edit"]);
    expect(allowedActions("published")).toEqual(["deprecate", "merge", "edit"]);
    expect(allowedActions("rejected")).toEqual(["restore", "merge", "edit"]);
    expect(allowedActions("deprecated")).toEqual(["restore", "merge", "edit"]);
    expect(allowedActions("merged")).toEqual(["edit"]);
    expect(allowedActions("unheard-of")).toEqual([]);
    for (const s of REGISTRY_STATES) {
      expect(STATE_LABEL[s]).toBeTruthy();
      for (const a of allowedActions(s)) expect(ACTION_LABEL[a]).toBeTruthy();
    }
  });

  it("names an owner and the entries a decision may point at", () => {
    expect(ownerLabel({ kind: "person", id: "u1", name: "Ada" })).toBe("Ada (person)");
    expect(ownerLabel({ kind: "team", name: "Payments" })).toBe("Payments (team)");
    expect(ownerLabel(null)).toBeNull();
    const all = [
      entry("billing"),
      entry("ledger", { state: "registered" }),
      entry("old", { state: "merged" }),
      entry("Alpha"),
    ];
    expect(decisionTargets(all, "Billing")).toEqual(["Alpha", "ledger"]);
  });

  it("writes a decision as one line, with who, the move and why", () => {
    const at = "2026-10-09T12:00:00Z";
    expect(
      decisionLine(
        { action: "deprecate", from: "registered", to: "deprecated", by: "u1", at, reason: "superseded", details: { replaced_by: "ledger" } },
        { u1: "Ada" },
      ),
    ).toBe("Ada deprecated (registered → deprecated): use ledger instead — “superseded”");
    expect(
      decisionLine({
        action: "register",
        from: "declared",
        to: "registered",
        by: "u2",
        by_name: "Bob",
        at,
        details: { owner: { kind: "team", name: "Payments" } },
      }),
    ).toBe("Bob registered (declared → registered): owner Payments (team)");
    expect(decisionLine({ action: "merge", from: "registered", to: "registered", by: "u3", at, details: { merged_from: "billing-v1" } })).toBe(
      "u3 merged: took in billing-v1",
    );
    expect(
      decisionLine({ action: "mark_published", from: "registered", to: "published", by: "u3", at, details: { version: "1.0.0" } }),
    ).toBe("u3 marked published (registered → published): version 1.0.0");
    expect(
      decisionLine({
        action: "publish",
        from: "registered",
        to: "registered",
        by: "u3",
        at,
        details: { contribution: { repo: "cf/gears-rust", pr_url: "https://github.com/cf/gears-rust/pull/9" } },
      }),
    ).toBe("u3 opened a contribution to the platform for: pull request https://github.com/cf/gears-rust/pull/9");
    expect(
      decisionLine({ action: "published", from: "registered", to: "published", by: "platform-sync", by_name: "platform sync", at, details: { version: "0.2.0" } }),
    ).toBe("platform sync found it on the platform (registered → published): version 0.2.0");
  });

  it("says a refusal for a non-administrator in plain words", () => {
    expect(decisionRefusal(403, "HTTP 403 · Forbidden")).toContain("Only an organization administrator");
    expect(decisionRefusal(400, "a `declared` entry cannot be moved by `publish`")).toBe(
      "a `declared` entry cannot be moved by `publish`",
    );
  });
});

describe("candidates (ADR-0041 P3)", () => {
  const detected = (project: string, path: string) => ({
    project_id: project,
    project_name: project === "p1" ? "studio-web" : "insight",
    repo: "cf/app",
    path,
    declared_in: "detected",
  });
  const hooks = entry("hooks", {
    state: "candidate",
    score: 5,
    evidence: [
      { signal: "rest", detail: "own REST surface: rest.rs", weight: 3 },
      { signal: "copied", detail: "copied in insight", weight: 2 },
    ],
    occurrences: [detected("p1", "src/hooks"), detected("p2", "src/hooks"), detected("p2", "lib/hooks")],
  });
  const documents = entry("documents", {
    state: "candidate",
    score: 8,
    evidence: [
      { signal: "boundary", detail: "exposes a boundary: port", weight: 2 },
      { signal: "rest", detail: "own REST surface: rest.rs", weight: 3 },
      { signal: "persistence", detail: "owns persistence: repo.rs", weight: 3 },
    ],
    occurrences: [detected("p1", "studio-backend/src/documents")],
  });

  it("lists only candidates, strongest first", () => {
    expect(candidatesOf([hooks, entry("billing"), documents]).map((e) => e.name)).toEqual(["documents", "hooks"]);
  });

  it("writes the evidence heaviest first, with its weight", () => {
    expect(evidenceLines(documents)).toEqual([
      "own REST surface: rest.rs (+3)",
      "owns persistence: repo.rs (+3)",
      "exposes a boundary: port (+2)",
    ]);
    expect(evidenceLines(entry("billing"))).toEqual([]);
  });

  it("says where it was detected and in which projects", () => {
    expect(candidateWhere(documents)).toBe("studio-web · studio-backend/src/documents");
    expect(detectedProjects(hooks)).toEqual(["p1", "p2"]);
    expect(detectedProjects(entry("billing"))).toEqual([]);
  });

  it("records a Declare it with its pull request", () => {
    const at = "2026-10-09T12:00:00Z";
    expect(
      decisionLine({
        action: "declare",
        from: "candidate",
        to: "candidate",
        by: "u1",
        by_name: "Ada",
        at,
        details: { branch: "declare/hooks", pr_url: "https://github.com/cf/app/pull/7" },
      }),
    ).toBe("Ada opened a pull request declaring: pull request https://github.com/cf/app/pull/7");
    expect(
      decisionLine({ action: "declare", from: "candidate", to: "candidate", by: "u1", at, details: { branch: "declare/hooks" } }),
    ).toBe("u1 opened a pull request declaring: branch declare/hooks");
  });

  it("explains a refused Declare it", () => {
    expect(declareRefusal(403, "Forbidden")).toContain("Only an organization administrator can declare");
    expect(declareRefusal(503, "no product")).toContain("not available in this deployment");
    expect(declareRefusal(400, "not a candidate")).toBe("not a candidate");
  });

  it("labels the candidate state for people", () => {
    expect(STATE_LABEL.candidate).toBe("could become a gear");
  });
});

describe("publishing, consumers and suggestions (ADR-0041 P4)", () => {
  const contribution = {
    repo: "cf/gears-rust",
    branch: "contribute/acme/ledger",
    pr_url: "https://github.com/cf/gears-rust/pull/9",
    path: "gears/ledger",
    files: 3,
    at: "2026-10-09T10:00:00Z",
    by: "u1",
  };

  it("says a contribution is pending until the platform has it, then its version", () => {
    expect(publishStatus(entry("a", { state: "registered" }))).toBeNull();
    expect(publishStatus(entry("a", { state: "registered", contribution }))).toEqual({
      kind: "pending",
      label: "Contribution PR opened",
      prUrl: "https://github.com/cf/gears-rust/pull/9",
    });
    expect(publishStatus(entry("a", { state: "published", version: "v0.3.0", contribution }))?.label).toBe("Published (v0.3.0)");
    expect(publishStatus(entry("a", { state: "published" }))?.label).toBe("Published");
  });

  it("previews a publish: where the pull request goes and what it carries", () => {
    const lines = publishPreviewLines({
      repo: "cf/gears-rust",
      base_branch: "develop",
      branch: "contribute/acme/ledger",
      path: "modules/ledger",
      files: ["modules/ledger/Cargo.toml", "modules/ledger/src/lib.rs"],
      skipped: ["logo.png"],
      title: "Contribute ledger from Acme",
    });
    expect(lines).toEqual([
      "Pull request into cf/gears-rust (develop) from contribute/acme/ledger",
      "Placed at modules/ledger/ — 2 files",
      "Not copied (not text): logo.png",
    ]);
  });

  it("never counts a merged entry as orphaned", () => {
    expect(isOrphaned(entry("gone", { orphaned: true, occurrences: [] }))).toBe(true);
    // An older backend flags the merged entry too; it is the merge, not a loss.
    expect(isOrphaned(entry("billing-v1", { state: "merged", orphaned: true, occurrences: [] }))).toBe(false);
    expect(isOrphaned(entry("billing"))).toBe(false);
  });

  it("counts and names the projects that use an entry", () => {
    const used = entry("ledger", {
      consumers: [
        { project_id: "p1", project_name: "Insight", via: ["cargo", "product"] },
        { project_id: "p2", project_name: "", via: ["product"] },
      ],
    });
    expect(consumersLabel(used)).toBe("Used by 2 projects");
    expect(consumersLabel(entry("x"))).toBeNull();
    expect(consumerLine(used.consumers![0])).toBe("Insight (cargo, product)");
    expect(consumerLine(used.consumers![1])).toBe("p2 (product)");
    expect(deprecationImpact(used)).toBe("2 projects use it and will see it deprecated: Insight, p2.");
    expect(deprecationImpact(entry("x"))).toBeNull();
  });

  it("applies a suggestion as an edit and explains a refused one", () => {
    expect(
      suggestionEdit({ description: "Keeps books.", category: "bss", capabilities: ["billing"], at: "t", model: "anthropic:m" }),
    ).toEqual({ action: "edit", description: "Keeps books.", category: "bss", capabilities: ["billing"] });
    expect(suggestionEdit({ capabilities: [], at: "t", model: "m" })).toEqual({ action: "edit", capabilities: [] });
    expect(suggestRefusal(400, "No anthropic key for you.")).toContain("Add a model key");
    expect(suggestRefusal(403, "Forbidden")).toContain("Only an organization administrator");
    expect(suggestRefusal(503, "unreadable")).toContain("No suggestion this time");
    expect(ACTION_LABEL.mark_published).toBe("Mark published");
  });
});
