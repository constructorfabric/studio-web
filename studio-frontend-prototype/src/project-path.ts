// The path of a project, from an empty tenant to a product that builds: six
// steps, each read off what the project already holds. Pure, so the rules for
// "done" sit in one place and are tested without a backend; the view in
// project-path-view.tsx only gathers the numbers and draws them.

import type { ProjTab } from "./project-overview";

export type StepState = "done" | "current" | "todo" | "unknown";

export type StepId = "repos" | "types" | "model" | "findings" | "product" | "build";

/** What the Overview could read. `null` everywhere means "that read failed":
 *  the step then says it does not know, rather than claiming it is not done. */
export interface PathFacts {
  /** Repositories attached to the project. */
  repositories: number | null;
  /** The Specs queues: typed (bound), waiting for a decision, not read yet. */
  specs: { bound: number; needsReview: number; notScanned: number } | null;
  /** The domain model: documents read out of how many, facts, a build running. */
  model: { documents: number; extracted: number; facts: number; running: boolean } | null;
  /** Findings nobody has decided yet, and how many of those are high. */
  findings: { open: number; high: number } | null;
  /** The product record: gears picked, and what the last preview said. */
  product: { gears: number; resolves: boolean | null; errors: number; written: boolean } | null;
  /** The newest finished build on the main branch, or none ever. */
  build: { status: string; sha: string } | null | "none";
}

export interface PathStep {
  id: StepId;
  title: string;
  state: StepState;
  /** One line from the data, e.g. "74 of 75 documents typed". */
  status: string;
  /** The tab where this step is done. */
  tab: ProjTab;
  action: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Draft = Omit<PathStep, "state"> & { done: boolean | null };

function repos(f: PathFacts): Draft {
  const base = { id: "repos" as const, title: "Connect a repository", tab: "sources" as const, action: "Open Sources" };
  if (f.repositories === null) return { ...base, done: null, status: "Could not read the project's sources." };
  return f.repositories > 0
    ? { ...base, done: true, status: `${plural(f.repositories, "repository", "repositories")} attached.` }
    : { ...base, done: false, status: "No repository yet. Attach one so Studio can read its documents." };
}

function types(f: PathFacts): Draft {
  const base = { id: "types" as const, title: "Type the documents", tab: "specs" as const, action: "Open Specs" };
  if (f.specs === null) return { ...base, done: null, status: "Could not read the Specs queues." };
  const { bound, needsReview, notScanned } = f.specs;
  const total = bound + needsReview + notScanned;
  if (total === 0) return { ...base, done: false, status: "No documents found yet. Sync a repository or write one." };
  const left = [needsReview ? `${needsReview} need review` : "", notScanned ? `${notScanned} not scanned` : ""]
    .filter(Boolean)
    .join(", ");
  return {
    ...base,
    done: bound > 0 && needsReview === 0 && notScanned === 0,
    status: `${bound} of ${plural(total, "document")} typed${left ? ` (${left})` : ""}.`,
  };
}

function model(f: PathFacts): Draft {
  const base = { id: "model" as const, title: "Build the domain model", tab: "model" as const, action: "Open Domain model" };
  if (f.model === null) return { ...base, done: null, status: "Could not read the domain model." };
  const { documents, extracted, facts, running } = f.model;
  if (running) return { ...base, done: false, status: `Building: ${extracted} of ${plural(documents, "document")} read.` };
  if (documents === 0) return { ...base, done: false, status: "Not built yet. Type the documents first, then build it." };
  return {
    ...base,
    done: extracted === documents && facts > 0,
    status: `${extracted} of ${plural(documents, "document")} read, ${plural(facts, "fact")}.`,
  };
}

function findings(f: PathFacts): Draft {
  const base = {
    id: "findings" as const,
    title: "Resolve what blocks a build",
    tab: "model" as const,
    action: "Open findings",
  };
  if (f.findings === null) return { ...base, done: null, status: "Could not read the findings." };
  // Only an undecided high finding blocks: medium and low are worth a look
  // but a product can be composed with them open.
  const { open, high } = f.findings;
  if (open === 0) return { ...base, done: true, status: "No open findings." };
  return {
    ...base,
    done: high === 0,
    status: high ? `${plural(open, "open finding")}, ${high} high.` : `${plural(open, "open finding")}, none high.`,
  };
}

function product(f: PathFacts): Draft {
  const base = { id: "product" as const, title: "Compose the product", tab: "components" as const, action: "Open Product" };
  if (f.product === null) return { ...base, done: null, status: "Could not read the product." };
  const { gears, resolves, errors, written } = f.product;
  if (gears === 0) return { ...base, done: false, status: "No gears picked yet." };
  const saved = written ? ", saved to the repository" : "";
  if (resolves === null) return { ...base, done: false, status: `${plural(gears, "gear")} picked, not previewed yet.` };
  return resolves
    ? { ...base, done: true, status: `${plural(gears, "gear")}, resolves${saved}.` }
    : { ...base, done: false, status: `${plural(gears, "gear")}, does not resolve (${plural(errors, "error")}).` };
}

function build(f: PathFacts): Draft {
  const base = { id: "build" as const, title: "Build and deploy", tab: "builds" as const, action: "Open Builds" };
  if (f.build === null) return { ...base, done: null, status: "Could not read the CI runs." };
  if (f.build === "none") return { ...base, done: false, status: "No CI run seen yet." };
  const at = f.build.sha ? ` at ${f.build.sha}` : "";
  return { ...base, done: f.build.status === "passed", status: `Last build ${f.build.status}${at}.` };
}

/** The six steps in order. The current one is the first that is known and not
 *  done; an unknown step is skipped rather than made current, because a failed
 *  read is not where the project stands. */
export function projectPath(f: PathFacts): PathStep[] {
  const drafts = [repos(f), types(f), model(f), findings(f), product(f), build(f)];
  const current = drafts.findIndex((d) => d.done === false);
  return drafts.map(({ done, ...rest }, i) => ({
    ...rest,
    state: done === null ? "unknown" : done ? "done" : i === current ? "current" : "todo",
  }));
}

/** How many steps are done, for the card's heading. */
export function pathProgress(steps: readonly PathStep[]): { done: number; total: number } {
  return { done: steps.filter((s) => s.state === "done").length, total: steps.length };
}

/** Folds the Specs queue counts the server sends into the three the path needs. */
export function specQueues(counts: readonly { queue: string; count: number }[]): PathFacts["specs"] {
  const n = (q: string) => counts.find((c) => c.queue === q)?.count ?? 0;
  return { bound: n("bound"), needsReview: n("needs-review"), notScanned: n("not-scanned") };
}

/** One line per project tab: what a person does there. Shown at the top of
 *  the tab, so a first visit is not spent guessing. Domain model and Builds are
 *  missing on purpose: each of Domain model's views carries its own line, and
 *  Builds opens on where the build stands and what comes next (pipeline.ts). */
export const TAB_HOWTO: Partial<Record<ProjTab, { lead: string; rest: string }>> = {
  overview: { lead: "Where the project stands.", rest: "Follow the path below; each step opens the tab where it is done." },
  sources: { lead: "Connect the repositories.", rest: "A sync reads their documents, issues, pull requests and CI runs into the project." },
  specs: { lead: "Type the documents.", rest: "Confirm the template each file was written against; what Studio could not decide waits under Needs review." },
  components: { lead: "Compose the product.", rest: "Pick the gears the specs ask for, preview until it resolves, then save it to the repository." },
  artifacts: { lead: "Take what the project produced.", rest: "Download the files its CI builds kept and its releases; its typed documents and the files kept in Studio are beside them." },
  kits: { lead: "Install the project's ways of working.", rest: "Kits add workflows and conventions to the repository, pinned to a version." },
  people: { lead: "Choose who works here.", rest: "Add people from the organization and give each a role on this project." },
};
