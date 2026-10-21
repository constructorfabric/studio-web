// The Domain model tab's arithmetic: a project's facts folded into entities,
// its findings put in the order a person works through them, and where its
// documents stand. Pure, so the screen only draws.
//
// The facts come from `GET /studio-documents/v1/spec-model`
// (docs/spec-domain-model.md); the folding here matches the backend's
// `rules::subject_key`, so the entity a person opens holds the same facts the
// rules compared.

export interface SpecModelSide {
  path: string;
  line_start?: number | null;
  line_end?: number | null;
  quote?: string | null;
}

export type FactKind =
  | "entity"
  | "attribute"
  | "relation"
  | "requirement"
  | "constraint"
  | "lifecycle"
  | "decision"
  | "role"
  | "action"
  | "problem"
  | "outcome"
  | "idea"
  | "benefit"
  | "scenario";

/** Kinds that describe the need and its claims (need-view.ts), not a thing
 *  the application keeps: they stay off the model map. */
export const NEED_KINDS: ReadonlySet<string> = new Set(["problem", "outcome", "idea", "benefit", "scenario"]);

export type FactStatus = "active" | "proposed" | "deferred" | "superseded" | "resolved" | "evidence";

export interface SpecModelFact {
  kind: FactKind;
  subject: string;
  aspect: string;
  value: string;
  text: string;
  status: FactStatus;
  status_because: string;
  /** Where an `entity` sits, as the extractor stated it; absent on other
   *  kinds and on facts extracted before it was asked. */
  layer?: "domain" | "system" | "deployment" | null;
  source: SpecModelSide;
  /** Saved from this screen and not read by a build yet (saved-entities.ts):
   *  shown at once so a person sees the edit, replaced on the next build. */
  provisional?: boolean;
}

export interface SpecModelDocument {
  path: string;
  revision: string;
  /** `kept`: the text is not on this server; the last reading is shown. */
  state: "extracted" | "failed" | "stale" | "pending" | "kept";
  facts: number;
  dropped: number;
  error?: string | null;
}

export interface SpecModelBuild {
  running: boolean;
  documents: number;
  done: number;
  candidates: number;
  judged: number;
  current?: string | null;
  error?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  /** Seconds reading was estimated to take when the build started. */
  estimated_seconds?: number | null;
  /** The one document this build reads again, when it was asked for one. */
  path?: string | null;
}

export interface SpecModel {
  build: SpecModelBuild;
  documents: SpecModelDocument[];
  facts: SpecModelFact[];
  /** Typed documents this server has no copy of: the repository is not
   *  synced here (or its clone went with a restarted backend). Absent from
   *  an older server. */
  unread_documents?: number;
  /** Why that copy is missing, when the server knows: the last clone
   *  failed, or the clone volume cannot be written. */
  unread_because?: string | null;
}

/** Why the model has nothing to read, or reads less than is typed, in one
 *  line. `null` when every typed document was read. */
export function unreadNote(model: SpecModel): string | null {
  const unread = model.unread_documents ?? 0;
  if (unread === 0) {
    return model.documents.length === 0
      ? "The domain model is read from the project's documentation: the documents whose type was settled in the Specs tab (its Bound list). None are yet. Type the documents there first, then build the model."
      : null;
  }
  const n = `${unread} typed document${unread === 1 ? "" : "s"}`;
  const kept = model.documents.filter((d) => d.state === "kept").length;
  const shown = kept > 0 ? " The model shows what was last read of them." : "";
  if (model.unread_because) {
    return `${n} cannot be read: ${model.unread_because}. A sync will not bring them back until that is fixed.${shown}`;
  }
  if (model.documents.length === 0) {
    return `${n} cannot be read: this server has no copy of the repository right now. Sync the repository on the Sources tab, then build the model.`;
  }
  return kept > 0
    ? `${n} are shown as last read: the server's copy of the repository is missing. Sync it on the Sources tab to read them again.`
    : `${n} cannot be read: the server's copy of the repository is missing. Sync it on the Sources tab to read them too.`;
}

export interface SpecModelFinding {
  fingerprint: string;
  rule: string;
  severity: "high" | "medium" | "low";
  message: string;
  sides: SpecModelSide[];
  decide: string[];
  edit?: { path: string; replace: string; with: string } | null;
  decision?: "confirmed" | "dismissed" | null;
}

/** A subject folded so two spellings of one thing meet: case, articles,
 *  punctuation and a plural `s` do not count. The backend's `subject_key`. */
export function subjectKey(subject: string): string {
  return subject
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && w !== "the" && w !== "a" && w !== "an")
    .map((w) => (w.length > 3 && /s$/.test(w) && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w))
    .join(" ");
}

/** An issue, pull request or commit that names an identifier. */
export interface WorkItem {
  kind: "issue" | "pull_request" | "commit";
  number: number | null;
  title: string;
  url: string | null;
  state: string | null;
  merged: boolean;
  sha: string | null;
}

/** An identifier the documents define, and the work that names it. */
export interface WorkLink {
  id: string;
  defined_in: SpecModelSide;
  work: WorkItem[];
}

export interface WorkLinks {
  items: WorkLink[];
  total: number;
  identifiers: number;
  work: number;
  unlinked: number;
  synced: boolean;
}

/** What a requirement's own block states it rests on, strongest doubt first
 *  (docs/spec-domain-model.md, "Requirements and their basis"). */
export type RequirementBasis = "open_question" | "assumption" | "cited" | "reasoned" | "stated";

export const BASIS_ORDER: RequirementBasis[] = ["open_question", "assumption", "stated", "reasoned", "cited"];

export const BASIS_LABEL: Record<RequirementBasis, string> = {
  open_question: "Open question",
  assumption: "Assumption",
  stated: "No basis stated",
  reasoned: "Reason only",
  cited: "Cites a source",
};

/** One requirement a project's documents define. */
export interface SpecRequirement {
  id: string;
  defined_in: SpecModelSide;
  title: string | null;
  text: string;
  kind: string | null;
  priority: string | null;
  done: boolean | null;
  basis: RequirementBasis;
  cites: string[];
  because: string | null;
  work: number;
}

export interface SpecRequirements {
  items: SpecRequirement[];
  total: number;
  by_basis: Partial<Record<RequirementBasis, number>>;
  synced: boolean;
}

export interface RequirementFilter {
  basis: RequirementBasis | "all";
  kind: string | "all";
  text: string;
  /** Only the ones no issue, pull request or commit names yet. */
  noWork: boolean;
}

/** The kinds the project's identifiers use, most common first. */
export function requirementKinds(items: SpecRequirement[]): string[] {
  const counts = new Map<string, number>();
  for (const r of items) if (r.kind) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
}

/** The requirements a filter keeps, doubt first and then in document order. */
export function filterRequirements(items: SpecRequirement[], f: RequirementFilter): SpecRequirement[] {
  const needle = f.text.trim().toLowerCase();
  return items
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => f.basis === "all" || r.basis === f.basis)
    .filter(({ r }) => f.kind === "all" || r.kind === f.kind)
    .filter(({ r }) => !f.noWork || r.work === 0)
    .filter(
      ({ r }) =>
        !needle ||
        r.id.toLowerCase().includes(needle) ||
        r.text.toLowerCase().includes(needle) ||
        (r.title ?? "").toLowerCase().includes(needle),
    )
    .sort((a, b) => BASIS_ORDER.indexOf(a.r.basis) - BASIS_ORDER.indexOf(b.r.basis) || a.i - b.i)
    .map(({ r }) => r);
}

/** "12 of 40 cite a source; 3 open questions, 5 assumptions." */
export function basisSummary(read: SpecRequirements): string {
  const n = (b: RequirementBasis) => read.by_basis[b] ?? 0;
  const parts = [`${n("cited")} of ${read.total} cite a source`];
  if (n("open_question")) parts.push(`${n("open_question")} open question${n("open_question") === 1 ? "" : "s"}`);
  if (n("assumption")) parts.push(`${n("assumption")} assumption${n("assumption") === 1 ? "" : "s"}`);
  if (n("stated")) parts.push(`${n("stated")} state no basis`);
  return parts.join("; ") + ".";
}

/** One requirement and every place that names it (docs/spec-domain-model.md,
 *  "From requirement to code and test"). */
export interface RequirementTrace {
  id: string;
  defined_in: SpecModelSide;
  title: string | null;
  text: string;
  documents: SpecModelSide[];
  code: SpecModelSide[];
  tests: SpecModelSide[];
}

export interface RequirementTraces {
  items: RequirementTrace[];
  total: number;
  implemented: number;
  tested: number;
  files: number;
}

export type TraceGap = "all" | "no-code" | "no-test" | "untraced";

/** The traces a gap filter keeps: no code, no test, or named nowhere at all. */
export function traceGaps(items: RequirementTrace[], gap: TraceGap): RequirementTrace[] {
  switch (gap) {
    case "no-code":
      return items.filter((t) => t.code.length === 0);
    case "no-test":
      return items.filter((t) => t.tests.length === 0);
    case "untraced":
      return items.filter((t) => t.code.length === 0 && t.tests.length === 0 && t.documents.length === 0);
    default:
      return items;
  }
}

/** A requirement of another project that reads like one of this project's
 *  (docs/spec-domain-model.md, "Across projects"). */
export interface RelatedRequirement {
  id: string;
  defined_in: SpecModelSide;
  text: string;
  other_project_id: string;
  other_project_name: string;
  other_workspace_name: string;
  other_id: string;
  other_defined_in: SpecModelSide;
  other_text: string;
  score: number;
  relation: "same" | "overlap" | "opposite";
  shared: string[];
}

export interface RelatedRequirements {
  items: RelatedRequirement[];
  total: number;
  projects: number;
  truncated: boolean;
}

export const RELATION_LABEL: Record<RelatedRequirement["relation"], string> = {
  opposite: "Says the opposite",
  same: "Reads alike",
  overlap: "Overlaps",
};

/** Opposites first (they are the ones to settle), then the same, then
 *  overlaps; strongest first within each. */
export function orderRelated(items: RelatedRequirement[]): RelatedRequirement[] {
  const rank = { opposite: 0, same: 1, overlap: 2 } as const;
  return [...items].sort((a, b) => rank[a.relation] - rank[b.relation] || b.score - a.score);
}

/** How a piece of work is named in a list: `#12`, `PR #7`, or a commit's sha. */
export function workLabel(w: WorkItem): string {
  if (w.kind === "commit") return w.sha ?? "commit";
  const n = w.number === null ? "" : ` #${w.number}`;
  return w.kind === "pull_request" ? `PR${n}` : `Issue${n}`;
}

/** Where a piece of work stands: merged, open or closed; a commit is in. */
export function workState(w: WorkItem): string {
  if (w.kind === "commit") return "committed";
  if (w.merged) return "merged";
  return w.state ?? "";
}

/** One name merged into a glossary entry. */
export interface GlossaryAlias {
  key: string;
  name: string;
}

/** One entry of the project's glossary (docs/project-and-product.md, "The
 *  project's words"): a thing the documents name, the name the project uses
 *  for it, and the other names members merged into it. */
export interface GlossaryEntry {
  key: string;
  name: string;
  /** Whether a member chose `name`; else it is the most frequent spelling. */
  chosen: boolean;
  spellings: string[];
  aliases: GlossaryAlias[];
  facts: number;
  documents: number;
  /** Entries a member said are different things from this one. */
  distinct_from?: string[];
}

/** Each key the glossary knows, its entry's and its aliases', to the entry it
 *  belongs to. */
export function glossaryIndex(entries: GlossaryEntry[]): Map<string, GlossaryEntry> {
  const out = new Map<string, GlossaryEntry>();
  for (const e of entries) {
    out.set(e.key, e);
    for (const a of e.aliases) out.set(a.key, e);
  }
  return out;
}

/** The entries another can be merged into: any but itself, and none while it
 *  has aliases of its own, since an alias of an alias holds nothing. */
export function mergeTargets(entry: GlossaryEntry, entries: GlossaryEntry[]): GlossaryEntry[] {
  if (entry.aliases.length > 0) return [];
  return entries.filter((e) => e.key !== entry.key).sort((a, b) => a.name.localeCompare(b.name));
}

export interface Entity {
  key: string;
  /** The glossary's name, else the spelling the documents use most. */
  name: string;
  /** Its own key and its aliases' keys. */
  keys: string[];
  facts: SpecModelFact[];
  /** Documents that say something about it. */
  documents: number;
  /** Facts in force. */
  active: number;
}

/** The model's subjects, each with every fact about it, the most described
 *  first. Relations and attributes hang off their subject; a subject that is
 *  only ever a decision is left out, since a decision is not part of the
 *  application. */
export function entitiesOf(facts: SpecModelFact[], glossary: GlossaryEntry[] = []): Entity[] {
  const index = glossaryIndex(glossary);
  const byKey = new Map<string, { spellings: Map<string, number>; facts: SpecModelFact[] }>();
  for (const fact of facts) {
    if (NEED_KINDS.has(fact.kind)) continue;
    const own = subjectKey(fact.subject);
    if (!own) continue;
    const key = index.get(own)?.key ?? own;
    const group = byKey.get(key) ?? { spellings: new Map<string, number>(), facts: [] as SpecModelFact[] };
    group.spellings.set(fact.subject, (group.spellings.get(fact.subject) ?? 0) + 1);
    group.facts.push(fact);
    byKey.set(key, group);
  }
  const out: Entity[] = [];
  for (const [key, group] of byKey) {
    if (group.facts.every((f) => f.kind === "decision")) continue;
    const entry = index.get(key);
    const name =
      entry?.name ?? [...group.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    out.push({
      key,
      name,
      keys: [key, ...(entry?.aliases.map((a) => a.key) ?? [])],
      facts: group.facts,
      documents: new Set(group.facts.map((f) => f.source.path)).size,
      active: group.facts.filter((f) => f.status === "active").length,
    });
  }
  return out.sort((a, b) => b.facts.length - a.facts.length || a.name.localeCompare(b.name));
}

/** The facts the documents give about one entity, in the order a reader
 *  wants them: what it is, what it has, what it relates to, what must hold,
 *  how it lives, and what is required of it. */
export const KIND_ORDER: FactKind[] = [
  "entity",
  "attribute",
  "relation",
  "role",
  "action",
  "constraint",
  "lifecycle",
  "requirement",
  "decision",
];

export function factsByKind(facts: SpecModelFact[]): { kind: FactKind; facts: SpecModelFact[] }[] {
  return KIND_ORDER.map((kind) => ({ kind, facts: facts.filter((f) => f.kind === kind) })).filter(
    (g) => g.facts.length > 0,
  );
}

/** The other entities an entity relates to, by the relation facts whose value
 *  names one of them. */
export function relatedEntities(entity: Entity, all: Entity[]): string[] {
  const out = new Set<string>();
  for (const fact of entity.facts) {
    if (fact.kind !== "relation") continue;
    const target = subjectKey(fact.value);
    for (const other of all) {
      if (other.key !== entity.key && other.keys.some((k) => target.includes(k))) out.add(other.key);
    }
  }
  return [...out];
}

const SEVERITY: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Findings in the order a person works through them: undecided first, then
 *  confirmed, dismissed last; within each, high before medium before low,
 *  and disagreements before references. */
export function orderFindings(findings: SpecModelFinding[]): SpecModelFinding[] {
  const decided = (f: SpecModelFinding) =>
    f.decision === "dismissed" ? 2 : f.decision === "confirmed" ? 1 : 0;
  const family = (f: SpecModelFinding) => (f.rule.startsWith("reference.") ? 1 : 0);
  return [...findings].sort(
    (a, b) =>
      decided(a) - decided(b) ||
      (SEVERITY[a.severity] ?? 3) - (SEVERITY[b.severity] ?? 3) ||
      family(a) - family(b) ||
      a.rule.localeCompare(b.rule),
  );
}

/** What a rule is called on the screen. */
export function ruleLabel(rule: string): string {
  const labels: Record<string, string> = {
    "contradiction.value": "Two values",
    "contradiction.cardinality": "Cardinality",
    "contradiction.lifecycle": "Lifecycle",
    "contradiction.access": "Access",
    "contradiction.decision": "Against a decision",
    "stale.superseded": "Describes what was replaced",
    "reference.dangling": "Refers to nothing",
    "reference.ambiguous": "Ambiguous reference",
    "reference.misattributed": "Wrong record cited",
    "product.missing": "Not in the code",
    "product.decided_not_built": "Decided, not built",
    "product.immature": "Rests on an unready gear",
  };
  return labels[rule] ?? rule;
}

/** A document a product finding sits on (`GET /studio-spec-mapping/v1/findings`). */
export interface ProductSide {
  /** `file`: a repository path; `document`: a Studio document's title. */
  kind: "file" | "document";
  path: string;
  quote: string;
}

/** What the project's documents ask for that its code is not made of. */
export interface ProductFinding {
  fingerprint: string;
  rule: "product.missing" | "product.decided_not_built" | "product.immature";
  severity: "high" | "medium";
  capability: string;
  gear?: string | null;
  message: string;
  sides: ProductSide[];
  candidates: string[];
}

/** Product findings high first, then by capability. */
export function orderProductFindings(findings: ProductFinding[]): ProductFinding[] {
  const rank = (f: ProductFinding) => (f.severity === "high" ? 0 : 1);
  return [...findings].sort((a, b) => rank(a) - rank(b) || a.capability.localeCompare(b.capability));
}

/** How many documents are in each state. */
export function coverageCounts(documents: SpecModelDocument[]): Record<SpecModelDocument["state"], number> {
  const counts = { extracted: 0, failed: 0, stale: 0, pending: 0, kept: 0 };
  for (const d of documents) counts[d.state] += 1;
  return counts;
}

/** One line about the build: what it is doing, or how it ended. */
export function buildLine(build: SpecModelBuild): string {
  if (build.running) {
    if (build.candidates > 0 || build.done >= build.documents) {
      return `Checking disagreements ${build.judged}/${build.candidates}`;
    }
    return `Reading documents ${build.done}/${build.documents}${build.current ? ` · ${build.current}` : ""}`;
  }
  if (build.error) return `Stopped: ${build.error}`;
  if (build.finished_at) return `Built ${build.done} document(s), checked ${build.judged} candidate(s)`;
  return "";
}

/** A message cut where the backend quoted a name in backticks, so the screen
 *  sets those parts as code rather than printing the backticks. An unpaired
 *  backtick stays as written. */
export function codeSpans(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const re = /`([^`]+)`/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ code: false, text: text.slice(at, m.index) });
    out.push({ code: true, text: m[1] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ code: false, text: text.slice(at) });
  return out;
}

/** "path:12-14", or the path alone for a whole document. */
export function sideLabel(side: SpecModelSide): string {
  if (!side.line_start) return side.path;
  return side.line_end && side.line_end !== side.line_start
    ? `${side.path}:${side.line_start}-${side.line_end}`
    : `${side.path}:${side.line_start}`;
}
