import { describe, expect, it } from "vitest";
import {
  basisSummary,
  buildLine,
  codeSpans,
  coverageCounts,
  entitiesOf,
  factsByKind,
  filterRequirements,
  orderRelated,
  mergeTargets,
  orderFindings,
  orderProductFindings,
  relatedEntities,
  requirementKinds,
  traceGaps,
  ruleLabel,
  sideLabel,
  subjectKey,
  type GlossaryEntry,
  type WorkItem,
  workLabel,
  workState,
  type ProductFinding,
  type SpecModelFact,
  type SpecModelFinding,
} from "./spec-model";
import type { RelatedRequirement, RequirementTrace, SpecRequirement } from "./spec-model";

function fact(subject: string, kind: SpecModelFact["kind"], path = "a.md", extra: Partial<SpecModelFact> = {}): SpecModelFact {
  return {
    kind,
    subject,
    aspect: "",
    value: "",
    text: `${subject} ${kind}`,
    status: "active",
    status_because: "",
    source: { path, line_start: 1, line_end: 1, quote: "q" },
    ...extra,
  };
}

describe("subjectKey", () => {
  it("folds case, articles, punctuation and a plural s, like the backend", () => {
    expect(subjectKey("The Seat Snapshots")).toBe(subjectKey("seat-snapshot"));
    expect(subjectKey("status")).toBe("status");
    expect(subjectKey("access")).toBe("access");
  });
});

describe("entitiesOf", () => {
  it("merges spellings, names an entity by its commonest one, and counts documents", () => {
    const facts = [
      fact("Seat snapshot", "entity", "a.md"),
      fact("seat snapshots", "attribute", "b.md"),
      fact("Seat snapshot", "lifecycle", "a.md", { status: "deferred" }),
      fact("Gateway", "constraint"),
    ];
    const [seat, gateway] = entitiesOf(facts);
    expect(seat.name).toBe("Seat snapshot");
    expect(seat.facts).toHaveLength(3);
    expect(seat.documents).toBe(2);
    expect(seat.active).toBe(2);
    expect(gateway.name).toBe("Gateway");
  });

  it("leaves out a subject that is only a decision", () => {
    expect(entitiesOf([fact("Use Postgres", "decision")])).toEqual([]);
  });
});

describe("the glossary", () => {
  const entry = (key: string, name: string, extra: Partial<GlossaryEntry> = {}): GlossaryEntry => ({
    key,
    name,
    chosen: false,
    spellings: [name],
    aliases: [],
    facts: 1,
    documents: 1,
    ...extra,
  });

  it("puts an alias's facts under its entry, by the entry's chosen name", () => {
    const facts = [
      fact("Tenant", "entity"),
      fact("Organization", "attribute", "b.md"),
      fact("Person", "relation", "a.md", { value: "one organization" }),
    ];
    const glossary = [
      entry("tenant", "Workspace", { chosen: true, aliases: [{ key: "organization", name: "Organization" }] }),
      entry("person", "Person"),
    ];
    const all = entitiesOf(facts, glossary);
    const tenant = all.find((e) => e.key === "tenant")!;
    expect(tenant.name).toBe("Workspace");
    expect(tenant.facts).toHaveLength(2);
    expect(tenant.documents).toBe(2);
    expect(all.some((e) => e.key === "organization")).toBe(false);
    // A relation naming the alias reaches the entry.
    expect(relatedEntities(all.find((e) => e.key === "person")!, all)).toEqual(["tenant"]);
  });

  it("offers no merge for an entry that has aliases of its own, since an alias of an alias holds nothing", () => {
    const a = entry("a", "A", { aliases: [{ key: "c", name: "C" }] });
    const b = entry("b", "B");
    expect(mergeTargets(a, [a, b])).toEqual([]);
    expect(mergeTargets(b, [a, b]).map((e) => e.key)).toEqual(["a"]);
  });
});

describe("work", () => {
  const w = (extra: Partial<WorkItem>): WorkItem => ({
    kind: "issue",
    number: 12,
    title: "t",
    url: null,
    state: "open",
    merged: false,
    sha: null,
    ...extra,
  });

  it("names an issue, a pull request and a commit the way a list reads them", () => {
    expect(workLabel(w({}))).toBe("Issue #12");
    expect(workLabel(w({ kind: "pull_request", number: 7 }))).toBe("PR #7");
    expect(workLabel(w({ kind: "commit", number: null, sha: "abc1234" }))).toBe("abc1234");
  });

  it("says merged before closed, and a commit is committed", () => {
    expect(workState(w({ kind: "pull_request", state: "closed", merged: true }))).toBe("merged");
    expect(workState(w({ state: "closed" }))).toBe("closed");
    expect(workState(w({ kind: "commit" }))).toBe("committed");
  });
});

describe("factsByKind", () => {
  it("orders what it is before what is required of it, and drops empty kinds", () => {
    const groups = factsByKind([fact("x", "requirement"), fact("x", "entity"), fact("x", "attribute")]);
    expect(groups.map((g) => g.kind)).toEqual(["entity", "attribute", "requirement"]);
  });
});

describe("relatedEntities", () => {
  it("follows a relation whose value names another entity", () => {
    const all = entitiesOf([
      fact("Person", "entity"),
      fact("Person", "relation", "a.md", { value: "many Source Accounts" }),
      fact("Source account", "entity"),
    ]);
    const person = all.find((e) => e.key === "person")!;
    expect(relatedEntities(person, all)).toEqual(["source account"]);
  });
});

describe("orderFindings", () => {
  const f = (fingerprint: string, extra: Partial<SpecModelFinding>): SpecModelFinding => ({
    fingerprint,
    rule: "contradiction.value",
    severity: "high",
    message: "",
    sides: [],
    decide: [],
    ...extra,
  });

  it("puts undecided first, dismissed last, high before medium, disagreements before references", () => {
    const ordered = orderFindings([
      f("dismissed", { decision: "dismissed" }),
      f("ref", { rule: "reference.dangling" }),
      f("medium", { severity: "medium" }),
      f("confirmed", { decision: "confirmed" }),
      f("high", {}),
    ]);
    expect(ordered.map((x) => x.fingerprint)).toEqual(["high", "ref", "medium", "confirmed", "dismissed"]);
  });
});

describe("coverage and progress", () => {
  it("counts documents per state", () => {
    const counts = coverageCounts([
      { path: "a", revision: "r", state: "extracted", facts: 3, dropped: 0 },
      { path: "b", revision: "r", state: "pending", facts: 0, dropped: 0 },
      { path: "c", revision: "r", state: "pending", facts: 0, dropped: 0 },
    ]);
    expect(counts).toEqual({ extracted: 1, failed: 0, stale: 0, pending: 2 });
  });

  it("says what a build is doing, or why it stopped", () => {
    const base = { running: true, documents: 4, done: 1, candidates: 0, judged: 0, current: "docs/PRD.md" };
    expect(buildLine(base)).toBe("Reading documents 1/4 · docs/PRD.md");
    expect(buildLine({ ...base, done: 4, candidates: 10, judged: 3 })).toBe("Checking disagreements 3/10");
    expect(buildLine({ ...base, running: false, error: "add a key" })).toBe("Stopped: add a key");
  });

  it("sets backticked names as code and leaves a lone backtick alone", () => {
    expect(codeSpans("The link to `a.md` leads nowhere: no `b.md`.")).toEqual([
      { code: false, text: "The link to " },
      { code: true, text: "a.md" },
      { code: false, text: " leads nowhere: no " },
      { code: true, text: "b.md" },
      { code: false, text: "." },
    ]);
    expect(codeSpans("a ` b")).toEqual([{ code: false, text: "a ` b" }]);
  });

  it("labels a side by its lines", () => {
    expect(sideLabel({ path: "a.md", line_start: 3, line_end: 5 })).toBe("a.md:3-5");
    expect(sideLabel({ path: "a.md", line_start: 3, line_end: 3 })).toBe("a.md:3");
    expect(sideLabel({ path: "a.md" })).toBe("a.md");
  });
});

describe("product findings", () => {
  const finding = (capability: string, severity: ProductFinding["severity"]): ProductFinding => ({
    fingerprint: capability,
    rule: "product.missing",
    severity,
    capability,
    message: "",
    sides: [],
    candidates: [],
  });

  it("come high first, then by capability, and read as words", () => {
    const ordered = orderProductFindings([finding("tenancy", "medium"), finding("storage", "high"), finding("auth", "high")]);
    expect(ordered.map((f) => f.capability)).toEqual(["auth", "storage", "tenancy"]);
    expect(ruleLabel("product.decided_not_built")).toBe("Decided, not built");
    expect(ruleLabel("product.immature")).toBe("Rests on an unready gear");
  });
});

describe("requirements and their basis", () => {
  const req = (id: string, basis: SpecRequirement["basis"], extra: Partial<SpecRequirement> = {}): SpecRequirement => ({
    id,
    defined_in: { path: "prd.md", line_start: 1, line_end: 1, quote: null },
    title: null,
    text: `${id} text`,
    kind: "fr",
    priority: null,
    done: null,
    basis,
    cites: [],
    because: null,
    work: 0,
    ...extra,
  });
  const items = [
    req("cpt-a-fr-1", "cited", { work: 2 }),
    req("cpt-a-fr-2", "stated"),
    req("cpt-a-actor-x", "stated", { kind: "actor" }),
    req("cpt-a-fr-3", "open_question", { title: "Upload limit" }),
  ];
  const all = { basis: "all", kind: "all", text: "", noWork: false } as const;

  it("puts doubt first, then keeps document order", () => {
    expect(filterRequirements(items, all).map((r) => r.id)).toEqual([
      "cpt-a-fr-3",
      "cpt-a-fr-2",
      "cpt-a-actor-x",
      "cpt-a-fr-1",
    ]);
  });

  it("filters by basis, kind, text in the title, and work", () => {
    expect(filterRequirements(items, { ...all, basis: "stated", kind: "fr" }).map((r) => r.id)).toEqual(["cpt-a-fr-2"]);
    expect(filterRequirements(items, { ...all, text: "upload" }).map((r) => r.id)).toEqual(["cpt-a-fr-3"]);
    expect(filterRequirements(items, { ...all, noWork: true })).toHaveLength(3);
  });

  it("lists kinds most common first", () => {
    expect(requirementKinds(items)).toEqual(["fr", "actor"]);
  });

  it("summarises the basis counts", () => {
    expect(basisSummary({ items, total: 4, by_basis: { cited: 1, stated: 2, open_question: 1 }, synced: true })).toBe(
      "1 of 4 cite a source; 1 open question; 2 state no basis.",
    );
  });
});

describe("requirements elsewhere", () => {
  const side = { path: "prd.md", line_start: 1, line_end: 1, quote: null };
  const rel = (id: string, relation: RelatedRequirement["relation"], score: number): RelatedRequirement => ({
    id,
    defined_in: side,
    text: "",
    other_project_id: "p",
    other_project_name: "P",
    other_workspace_name: "W",
    other_id: "x",
    other_defined_in: side,
    other_text: "",
    score,
    relation,
    shared: [],
  });
  it("puts opposites first, then the same, then overlaps, strongest first", () => {
    const got = orderRelated([rel("a", "overlap", 0.6), rel("b", "same", 0.8), rel("c", "opposite", 0.5), rel("d", "same", 0.9)]);
    expect(got.map((r) => r.id)).toEqual(["c", "d", "b", "a"]);
  });
});

describe("requirement traces", () => {
  const side = { path: "x", line_start: 1, line_end: 1, quote: null };
  const tr = (id: string, docs: number, code: number, tests: number): RequirementTrace => ({
    id,
    defined_in: side,
    title: null,
    text: "",
    documents: Array(docs).fill(side),
    code: Array(code).fill(side),
    tests: Array(tests).fill(side),
  });
  const items = [tr("a", 1, 1, 1), tr("b", 1, 1, 0), tr("c", 0, 0, 0), tr("d", 1, 0, 0)];
  it("keeps the gaps a filter asks for", () => {
    expect(traceGaps(items, "no-code").map((t) => t.id)).toEqual(["c", "d"]);
    expect(traceGaps(items, "no-test").map((t) => t.id)).toEqual(["b", "c", "d"]);
    expect(traceGaps(items, "untraced").map((t) => t.id)).toEqual(["c"]);
    expect(traceGaps(items, "all")).toHaveLength(4);
  });
});
