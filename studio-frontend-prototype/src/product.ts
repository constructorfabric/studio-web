// Picking gears into a product, and what a product project's IDE session needs.
//
// The composing itself is the Gearbox engine's, behind
// `POST /projects/{id}/product/preview` (studio-backend
// product/gearbox.rs): which gears a pick really pulls in, where
// they land, what cannot work. This module only decides what can be offered
// for picking and how the picks and the session are spelled.

import type { GearboxDiagnostic, GearboxStatus, RepoEntry } from "./api";
import type { Candidate, PlanRow } from "./api";

/** The deployment profiles a generated product.gdl declares, in the order they
 *  are offered, with what each one means to somebody choosing. */
export const PRODUCT_PROFILES: readonly { id: string; label: string }[] = [
  { id: "dev", label: "dev · one process" },
  { id: "local", label: "local · processes on one host" },
  { id: "prod", label: "prod · Kubernetes" },
];

/** Whether a candidate can go into a product.gdl at all. Only Rust gears and
 *  their plugins are composed by the engine; FrontX packages (`@scope/x`),
 *  SDKs and the toolkit are not gears a product selects. */
export function isPickable(c: Pick<Candidate, "name" | "kind">): boolean {
  return !c.name.startsWith("@") && (c.kind === "gear" || c.kind === "plugin");
}

/** A first pick to start from: per capability, the best built gear. Nothing is
 *  picked for a row with no built, pickable candidate — suggesting something
 *  that has no crate would only make the engine say so. */
export function defaultPicks(plan: readonly PlanRow[]): string[] {
  const picks: string[] = [];
  for (const row of plan) {
    // Built and not proved unable to run; the ones the engine says can go
    // into a product first.
    const usable = row.candidates.filter((c) => c.built === "built" && isPickable(c) && c.composable !== "blocked");
    const first = usable.find((c) => c.composable === "runs") ?? usable[0];
    if (first && !picks.includes(first.name)) picks.push(first.name);
  }
  return picks;
}

/** A product id as GDL wants it: kebab-case, starting with a letter. Built
 *  from the project's name, so the description reads as the project. */
export function productIdFrom(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "");
  return slug || "product";
}

/** A product project's session sources with the gear corpus beside them.
 *
 *  The generated product.gdl names its gears from `path("../gears-rust")`, so
 *  the corpus has to be checked out next to the project's repository for the
 *  description to resolve in the IDE the way it resolved in the preview.
 *  Nothing is added when previews are off, or when a source already takes
 *  that directory — a person who pinned their own checkout keeps it. */
export function withCorpusSource(repos: readonly RepoEntry[], status: GearboxStatus | null): RepoEntry[] {
  if (!status?.enabled || !status.corpus_url) return [...repos];
  const dir = status.source_id;
  if (repos.some((r) => (r.target?.trim() || r.name) === dir)) return [...repos];
  return [
    ...repos,
    {
      name: dir,
      source: "git",
      url: status.corpus_url,
      ...(status.corpus_ref ? { branch: status.corpus_ref } : {}),
    },
  ];
}

/** Errors first, then warnings, each in the engine's own order. */
export function sortDiagnostics(ds: readonly GearboxDiagnostic[]): GearboxDiagnostic[] {
  const rank = (d: GearboxDiagnostic) => (d.severity === "error" ? 0 : d.severity === "warning" ? 1 : 2);
  return ds
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i)
    .map(({ d }) => d);
}

/** One finding, with every deployment profile it was raised in. */
export type GroupedDiagnostic = GearboxDiagnostic & { profiles: string[] };

/** The engine checks every declared profile and says so per profile — the
 *  same missing plugin arrives once for `dev`, `local` and `prod`. Folded here
 *  into one finding that names its profiles, errors first. */
export function groupDiagnostics(ds: readonly GearboxDiagnostic[]): GroupedDiagnostic[] {
  const groups: GroupedDiagnostic[] = [];
  for (const d of sortDiagnostics(ds)) {
    const m = /^in profile `([^`]+)`, /.exec(d.message);
    const message = m ? d.message.slice(m[0].length) : d.message;
    const same = groups.find(
      (g) => g.code === d.code && g.message === message && g.severity === d.severity && g.file === d.file,
    );
    if (same) {
      if (m && !same.profiles.includes(m[1])) same.profiles.push(m[1]);
      continue;
    }
    groups.push({ ...d, message, profiles: m ? [m[1]] : [] });
  }
  return groups;
}

/** The errors that are not about this product at all: a corpus `gear.gdl`
 *  the engine could not read. They block the resolve, and no change to the
 *  gears picked here can clear them -- they mean the engine and the gear
 *  corpus disagree, which is a deployment's to fix. Counted by file, because
 *  one unreadable description reports once per profile. */
export function corpusErrors(ds: readonly GearboxDiagnostic[]): { errors: number; files: number } {
  const own = (f?: string | null) => !f || f === "product.gdl" || f.endsWith("/product.gdl");
  const errs = ds.filter((d) => d.severity === "error" && !own(d.file));
  return { errors: errs.length, files: new Set(errs.map((d) => d.file)).size };
}

/** `cf-gears-api-gateway` → `api-gateway`, the way a person reads it. */
export function gearLabel(name: string): string {
  return name.replace(/^cf-gears-/, "").replace(/^@[^/]+\//, "");
}
