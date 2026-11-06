// Picking gears into a product, and what a product project's IDE session needs.
//
// The composing itself is the Gearbox engine's, behind
// `POST /projects/{id}/product/preview` (studio-backend
// product/gearbox.rs): which gears a pick really pulls in, where
// they land, what cannot work. This module only decides what can be offered
// for picking and how the picks and the session are spelled.

import type { EnvironmentBinding, GearboxDiagnostic, GearboxStatus, ProductCheck, ProjectProduct, RepoEntry } from "./api";
import type { Candidate, PlanRow } from "./api";
import { readProfiles } from "./infra-gdl";

/** The shape a profile deploys the product in, as `product.gdl` spells its
 *  constructor. */
export type ProfileKind = "embedded" | "self_hosted" | "kubernetes";

/** The deployment profiles a generated product.gdl declares, in the order they
 *  are shown: the shape first, which is what somebody reading cares about,
 *  then the id the description and the bindings use. */
export const PRODUCT_PROFILES: readonly { id: string; kind: ProfileKind; label: string }[] = [
  { id: "prod", kind: "kubernetes", label: "Kubernetes · prod" },
  { id: "local", kind: "self_hosted", label: "One host · local" },
  { id: "dev", kind: "embedded", label: "One process · dev" },
];

/** The profiles an environment can run (ADR-0057: only kubernetes ones bind,
 *  for now): the ones whose shape is a cluster. */
export const KUBERNETES_PROFILES: readonly string[] = PRODUCT_PROFILES.filter((p) => p.kind === "kubernetes").map((p) => p.id);

/** How a profile's kind reads: the shape it deploys in. */
const KIND_LABEL: Record<string, string> = {
  kubernetes: "Kubernetes",
  self_hosted: "One host",
  embedded: "One process",
};

/** A profile a product's description declares, as it is shown. */
export interface DeclaredProfile {
  id: string;
  /** The constructor that makes it: `kubernetes`, `self_hosted`,
   *  `embedded`, or another the engine knows. */
  kind: string;
  label: string;
}

/** The profiles the saved description declares (its latest revision's
 *  text), each with its kind; the three a new description starts with when
 *  there is no text or it declares none Studio can read. */
export function declaredProfiles(text: string | null | undefined): DeclaredProfile[] {
  const read = text ? readProfiles(text) : null;
  if (!read || read.length === 0) return PRODUCT_PROFILES.map((p) => ({ ...p }));
  return read.map((p) => ({ id: p.id, kind: p.kind, label: `${KIND_LABEL[p.kind] ?? p.kind} · ${p.id}` }));
}

/** The profiles an environment can run: a cluster runs the `kubernetes`
 *  ones (ADR-0057), and so does Research, which deploys onto one. */
export function deployableProfiles(profiles: readonly DeclaredProfile[]): DeclaredProfile[] {
  return profiles.filter((p) => p.kind === "kubernetes");
}

/** A profile as a person reads it: "Kubernetes · prod"; an id the product
 *  does not declare, as it is. `declared` (the description's) first, then
 *  the profiles a new description starts with. */
export function profileLabel(id: string, declared: readonly DeclaredProfile[] = []): string {
  return declared.find((p) => p.id === id)?.label ?? PRODUCT_PROFILES.find((p) => p.id === id)?.label ?? id;
}

/** The profile checked when no environment is bound: the one a release would
 *  take. */
export const FALLBACK_PROFILE = "prod";

/** The profiles the engine checks whenever the product changes: the ones some
 *  environment runs, or -- with none bound -- `prod`. Others are checked on
 *  demand. */
export function profilesToCheck(bindings: readonly Pick<EnvironmentBinding, "profile">[]): string[] {
  const bound = [...new Set(bindings.map((b) => b.profile))];
  if (bound.length === 0) return [FALLBACK_PROFILE];
  // In the order the profiles are shown, an unknown id last.
  const order = (id: string) => {
    const i = PRODUCT_PROFILES.findIndex((p) => p.id === id);
    return i < 0 ? PRODUCT_PROFILES.length : i;
  };
  return bound.sort((a, b) => order(a) - order(b));
}

/** The environments that run `profile`, by id. */
export function environmentsRunning(bindings: readonly EnvironmentBinding[], profile: string): string[] {
  return bindings.filter((b) => b.profile === profile).map((b) => b.environment_id);
}

type CheckFacts = Pick<ProjectProduct, "checks" | "last_preview"> | null | undefined;

/** What the engine last said of the product for `profile`. A record from
 *  before checks were kept per profile has only its last preview, which
 *  answers for the profile it was made for. */
export function checkOf(product: CheckFacts, profile: string): ProductCheck | null {
  const kept = product?.checks?.[profile];
  if (kept) return kept;
  const last = product?.last_preview;
  return !product?.checks && last?.profile === profile ? last : null;
}

/** Whether `profile`'s kept check is about the description hashing to
 *  `sha256`: a check a save left running on the server has landed. */
export function checkLanded(product: CheckFacts, profile: string, sha256: string): boolean {
  return !!sha256 && checkOf(product, profile)?.gdl_sha256 === sha256;
}

/** The description the record is about now: the hash of the last check's, which
 *  every change of the product makes again. `null` for a record from before. */
export function currentDescription(product: CheckFacts): string | null {
  return product?.last_preview?.gdl_sha256 ?? null;
}

/** One profile's verdict: resolves, fails with errors, never checked, or
 *  checked against a description that has changed since. */
export interface ProfileVerdict {
  state: "ok" | "failed" | "unchecked" | "stale";
  errors: number;
  check: ProductCheck | null;
}

/** `profile`'s verdict against the description whose hash is `current`
 *  (the record's own by default). A check without a hash is current only
 *  while nothing says otherwise: a record from before hashes were kept. */
export function verdictOf(product: CheckFacts, profile: string, current: string | null = currentDescription(product)): ProfileVerdict {
  const check = checkOf(product, profile);
  if (!check) return { state: "unchecked", errors: 0, check: null };
  if (current && check.gdl_sha256 !== current) return { state: "stale", errors: check.errors, check };
  return { state: check.ok ? "ok" : "failed", errors: check.errors, check };
}

/** A verdict in a few words: "✓", "✗ 2 errors", "not checked", "stale". */
export function verdictText(v: ProfileVerdict): string {
  switch (v.state) {
    case "ok":
      return "✓";
    case "failed":
      return `✗ ${v.errors} error${v.errors === 1 ? "" : "s"}`;
    case "unchecked":
      return "not checked";
    case "stale":
      return "stale";
  }
}

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

/** Findings of one code, for reading: the engine says the same thing once per
 *  gear -- forty plugins that resolve AuthZ without linking it are forty rows
 *  of one warning. One group per code and severity, errors first, in the
 *  engine's order; `items` are the findings it holds. */
export interface DiagnosticGroup {
  code: string;
  severity: string;
  items: GroupedDiagnostic[];
}

export function diagnosticsByCode(ds: readonly GearboxDiagnostic[]): DiagnosticGroup[] {
  const groups: DiagnosticGroup[] = [];
  for (const d of groupDiagnostics(ds)) {
    const same = groups.find((g) => g.code === d.code && g.severity === d.severity);
    if (same) same.items.push(d);
    else groups.push({ code: d.code, severity: d.severity, items: [d] });
  }
  return groups;
}

/** Where a project's product.gdl is in its repository, by the rule the
 *  backend keeps (`description_path`): the path its record gives, else the
 *  product's own `products/<id>/product.gdl`. `null` for a project with no
 *  product, which has nothing to build -- never the repository root's file. */
export function productPathOf(
  record: Pick<ProjectProduct, "product_id" | "written" | "description" | "published"> | null | undefined,
): string | null {
  const recorded = record?.published?.path || record?.written?.path || record?.description?.path;
  if (recorded) return recorded;
  const id = record?.product_id?.trim();
  return id ? `products/${id}/product.gdl` : null;
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
