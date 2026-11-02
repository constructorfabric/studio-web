/* ── The frontend constructor's model (ADR-0050) ──────────────────────────────
 *
 * A product's frontend is a FrontX shell with micro-frontends mounted in it.
 * The catalogue already lists every FrontX package; a sync now also records,
 * for a micro-frontend, where it shows in the shell (its `mfe.json`
 * extensions) and which gears its API services call (`/cf/<gear>/v1`). This
 * module turns those into what the constructor draws: the shell's zones with
 * the screens the picked packages bring, and whether the product has the
 * gears they call.
 *
 * Pure, so it is tested without a backend.
 */

import type { CatalogNode, CatalogRepoSource } from "./api";

export const FRONTX_NODE_TYPE = "gts.cf.studio.catalog.frontx.v1~";

/** FrontX's own templates: `template-mfe` carries a blank micro-frontend, a
 *  demo and two widget fixtures, each with an `mfe.json`. The catalogue reads
 *  them as templates and examples, not as screens a product mounts, so the
 *  constructor offers them as where a new micro-frontend starts; the
 *  micro-frontends a product adds come from a repository that has real ones
 *  (the project's own, see `frontxSuggestion`). */
export const SUGGESTED_FRONTX_SOURCE = {
  repo: "constructorfabric/gears-frontx-templates",
  git_ref: "main",
  mode: "frontx",
} as const;

/** The nil tenant: in an organization's source it stands for the
 *  organization itself, whose GitHub connection the sync reads through. */
const ORG_TENANT = "00000000-0000-0000-0000-000000000000";

const repoKey = (repo: string) =>
  repo
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "");

/** The organization's catalogue sources with the suggested FrontX one added
 *  at the end, or `null` when it already reads that repository as FrontX
 *  (at any ref): then there is nothing to add, only to sync. */
export function withSuggestedFrontx(items: readonly CatalogRepoSource[]): CatalogRepoSource[] | null {
  return withFrontxSource(items, SUGGESTED_FRONTX_SOURCE.repo, SUGGESTED_FRONTX_SOURCE.git_ref);
}

/** The organization's catalogue sources with `repo` added as a FrontX source
 *  at the end, or `null` when it already reads that repository as FrontX (at
 *  any ref): then there is nothing to add, only to sync. */
export function withFrontxSource(
  items: readonly CatalogRepoSource[],
  repo: string,
  gitRef: string | null = "main",
): CatalogRepoSource[] | null {
  const want = repoKey(repo);
  const has = items.some((s) => (s.mode || "gears") === "frontx" && repoKey(s.repo) === want);
  if (has) return null;
  return [...items, { tenant: ORG_TENANT, connection_id: null, repo, git_ref: gitRef, mode: "frontx" }];
}

/** The repository the constructor offers to read micro-frontends from: the
 *  project's own first one the catalogue does not read as FrontX yet. Its
 *  micro-frontends are the screens this product is likely to mount (Studio's
 *  own are under `studio-frontend/src-app/mfe_packages/`). `null` when every
 *  repository of the project is read already, or it has none. */
export function frontxSuggestion(projectRepos: readonly string[], sources: readonly CatalogRepoSource[]): string | null {
  const read = new Set(sources.filter((s) => (s.mode || "gears") === "frontx").map((s) => repoKey(s.repo)));
  return projectRepos.find((r) => r.trim() && !read.has(repoKey(r))) ?? null;
}

/** `owner/repo` of a GitHub pull request link, or `null`. */
function repoOfPullRequest(url: string | null | undefined): string | null {
  const m = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\//i.exec(url ?? "");
  return m ? m[1] : null;
}

/** The project's repositories, the one a product is written to first: its
 *  connected gear repository, its sources, the repository the product's last
 *  pull request went to, and the repositories ingested as its artifacts. Each
 *  once, in that order. A project need not have every record: one whose
 *  repository was never ingested still names it as a source. */
export function projectRepos(of: {
  gearRepo?: string | null;
  sources?: readonly { full_path: string }[];
  writtenPrUrl?: string | null;
  artifactRepos?: readonly string[];
}): string[] {
  const all = [
    of.gearRepo,
    ...(of.sources ?? []).map((s) => s.full_path),
    repoOfPullRequest(of.writtenPrUrl),
    ...(of.artifactRepos ?? []),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of all) {
    if (!r?.trim() || seen.has(repoKey(r))) continue;
    seen.add(repoKey(r));
    out.push(r.trim());
  }
  return out;
}

/** Catalogue kinds of a package that shows how to write a micro-frontend
 *  rather than being one a product mounts. */
const TEMPLATE_KINDS = new Set(["template", "example"]);

/** A template or example micro-frontend: where a new one starts, not a screen
 *  to add. */
export function isTemplateMfe(m: Pick<Mfe, "kind" | "repo">): boolean {
  return TEMPLATE_KINDS.has(m.kind ?? "") || repoKey(m.repo ?? "").includes(repoKey(SUGGESTED_FRONTX_SOURCE.repo));
}

/** The micro-frontends a product can add, and the templates to start a new
 *  one from. */
export function splitTemplates(mfes: readonly Mfe[]): { addable: Mfe[]; templates: Mfe[] } {
  return { addable: mfes.filter((m) => !isTemplateMfe(m)), templates: mfes.filter(isTemplateMfe) };
}

/** One place a micro-frontend takes in the shell. */
export interface Placement {
  id: string;
  /** The shell domain it mounts in: `screen`, `sidebar`, `overlay`, `popup`, … */
  domain: string;
  label: string | null;
  icon: string | null;
  route: string | null;
  order: number | null;
  /** Which level of the portal it belongs to (`organization`, `project`, …). */
  level: string | null;
}

export interface Mfe {
  /** The npm package name, the catalogue key. */
  name: string;
  /** The catalogue's kind: `micro-frontend`, or `template`/`example` for one
   *  that shows how to write a micro-frontend. */
  kind?: string | null;
  description: string;
  version: string | null;
  repo: string | null;
  placements: Placement[];
  /** Gear route segments it calls (`studio-documents`): its own API
   *  services', and those of the FrontX packages it depends on. */
  calls: string[];
  /** For a call it makes through a dependency: which package makes it. */
  via: Record<string, string>;
  /** The FrontX versions it pins (`@gears-frontx/react` → `0.2.0-alpha.0`),
   *  held against what the shell carries. Empty until a sync reads them. */
  wants?: Record<string, string>;
}

/** The shell's zones, in the order the constructor draws them. A domain no
 *  zone names is shown under "other", never dropped. */
export const ZONES: { domain: string; title: string; hint: string }[] = [
  { domain: "screen", title: "Screens", hint: "Full pages, one per route; the navigation lists them" },
  { domain: "sidebar", title: "Sidebar", hint: "Panels beside the page" },
  { domain: "overlay", title: "Overlays", hint: "Drawn over the page" },
  { domain: "popup", title: "Popups", hint: "Dialogs a screen opens" },
];

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function placementOf(raw: unknown): Placement | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    domain: str(r.domain) ?? "other",
    label: str(r.label),
    icon: str(r.icon),
    route: str(r.route),
    order: typeof r.order === "number" ? r.order : null,
    level: str(r.level),
  };
}

/** The micro-frontends in the catalogue, with what their profiles say. A
 *  package the scan did not find to be a micro-frontend is not one here. */
export function mfesFrom(nodes: CatalogNode[], profiles: Record<string, Record<string, unknown>>): Mfe[] {
  const out: Mfe[] = [];
  const autoOf = (name: string) => (profiles[name]?.auto ?? {}) as Record<string, unknown>;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  // Every FrontX package's own calls, libraries included: a micro-frontend
  // that talks to the backend through a shared package calls what it calls.
  const own = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.type_id !== FRONTX_NODE_TYPE) continue;
    const name = str((n.value as Record<string, unknown>).name) ?? n.instance_id;
    own.set(name, strings(autoOf(name).mfe_calls));
  }
  for (const n of nodes) {
    if (n.type_id !== FRONTX_NODE_TYPE) continue;
    const v = n.value as Record<string, unknown>;
    const name = str(v.name) ?? n.instance_id;
    const auto = (profiles[name]?.auto ?? {}) as Record<string, unknown>;
    const kind = str(v.component_kind);
    // A template or example counts when it is a micro-frontend's template:
    // it declares extensions, or names itself one (`_blank-mfe`).
    const isMfe =
      kind === "micro-frontend" ||
      Array.isArray(auto.mfe_extensions) ||
      (TEMPLATE_KINDS.has(kind ?? "") && /mfe/i.test(name));
    if (!isMfe) continue;
    const placements = (Array.isArray(auto.mfe_extensions) ? auto.mfe_extensions : [])
      .map(placementOf)
      .filter((p): p is Placement => p !== null);
    const calls = new Set(strings(auto.mfe_calls));
    const via: Record<string, string> = {};
    for (const dep of strings(auto.deps_names)) {
      for (const c of own.get(dep) ?? []) {
        if (!calls.has(c)) {
          calls.add(c);
          via[c] = dep;
        }
      }
    }
    out.push({
      name,
      kind,
      description: str(v.description) ?? str(profiles[name]?.description) ?? "",
      version: str(v.max_version) ?? str(v.newest_version),
      repo: str(v.repository) ?? str(v.synced_from),
      placements,
      calls: [...calls].sort(),
      via,
      wants: frontxPins(auto.deps_versions),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A gear's key as a route names it: `cf-gears-account-management` and
 *  `account-management` are the same gear; so are `studio-documents` and
 *  `cf-studio-documents`. */
export function gearKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^cf-gears-/, "")
    .replace(/^cf-/, "");
}

/** A placement's text, for a reader: its label, else its route, else the
 *  last part of its id. */
export function placementLabel(p: Placement): string {
  return p.label ?? p.route ?? p.id.split("~").filter(Boolean).pop() ?? p.id;
}

/** The picked packages' placements in each zone, ordered as the shell
 *  orders them (`order`, then label). Zones nothing fills stay, empty. */
export function zonesOf(picked: Mfe[]): { domain: string; title: string; hint: string; items: { mfe: Mfe; placement: Placement }[] }[] {
  const known = new Set(ZONES.map((z) => z.domain));
  const all = picked.flatMap((mfe) => mfe.placements.map((placement) => ({ mfe, placement })));
  const others = [...new Set(all.map((x) => x.placement.domain).filter((d) => !known.has(d)))].sort();
  const zones = [...ZONES, ...others.map((d) => ({ domain: d, title: d, hint: "A domain this shell has no name for" }))];
  return zones.map((z) => ({
    ...z,
    items: all
      .filter((x) => x.placement.domain === z.domain)
      .sort(
        (a, b) =>
          (a.placement.order ?? 1e9) - (b.placement.order ?? 1e9) ||
          placementLabel(a.placement).localeCompare(placementLabel(b.placement)),
      ),
  }));
}

export interface Coverage {
  /** Per picked package: the gears it calls that the product does not have. */
  missing: Map<string, string[]>;
  /** The product's gears no picked package calls: backend without a screen. */
  unseen: string[];
}

/** Whether the product has the gears its frontend calls, and which of its
 *  gears no screen uses. Platform plumbing every product has (the gateway,
 *  sign-in) is not asked to have a screen. */
export function coverage(picked: Mfe[], productGears: string[]): Coverage {
  const have = new Set(productGears.map(gearKey));
  const missing = new Map<string, string[]>();
  const used = new Set<string>();
  for (const m of picked) {
    const lacks = m.calls.filter((c) => !have.has(gearKey(c)));
    if (lacks.length > 0) missing.set(m.name, lacks);
    for (const c of m.calls) used.add(gearKey(c));
  }
  const unseen = [...have].filter((g) => !used.has(g) && !PLUMBING.has(g)).sort();
  return { missing, unseen };
}

/** Gears that serve the platform rather than a screen of their own. */
const PLUMBING = new Set([
  "api-gateway",
  "authn-resolver",
  "authz-resolver",
  "tenant-resolver",
  "types-registry",
  "credstore",
  "grpc-hub",
  "nodes-registry",
  "oagw",
  "api-egress",
  "module-orchestrator",
]);

/** Packages that offer a screen for a gear, for "what could show this". */
export function offersFor(gear: string, mfes: Mfe[]): Mfe[] {
  const k = gearKey(gear);
  return mfes.filter((m) => m.calls.some((c) => gearKey(c) === k));
}

/* ── How the frontend gets built ───────────────────────────────────────────
 *
 * Assembling a product's frontend by hand showed the steps a build takes and
 * where each goes wrong: the shell is a workspace that carries its own FrontX
 * packages, and a micro-frontend mounted in it gets those, whatever versions
 * it pinned; a shell signs its users in or it does not; the screens call
 * gears the product may not have; and nothing yet builds the result into an
 * image. The constructor shows those steps, each with what it found. */

/** A FrontX shell the product's frontend can be assembled on. */
export interface Shell {
  name: string;
  repo: string | null;
  /** Its directory in the repository (`template-shell`, `studio-frontend`). */
  path: string | null;
  version: string | null;
  /** The FrontX packages a micro-frontend mounted in it gets, name → version:
   *  those its workspace carries, the ones it depends on, and itself. */
  carries: Record<string, string>;
  /** Whether it signs users in; `null` when the scan did not say. */
  signsIn: boolean | null;
  /** Whether it reads the product's addresses at start (`/env.js`). */
  runtimeEnv: boolean | null;
}

const FRONTX_SCOPE = "@gears-frontx/";

/** The FrontX pins of a package: `@gears-frontx/*` versions, without the
 *  ones that point into its own workspace (`file:`, `workspace:`). */
export function frontxPins(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.startsWith(FRONTX_SCOPE) && typeof v === "string" && !/^(file|workspace|link):/.test(v)) out[k] = v;
  }
  return out;
}

const textOf = (v: unknown): string | null =>
  str(v) ?? (v && typeof v === "object" ? str((v as Record<string, unknown>).v) : null);

/** The shells in the catalogue: a FrontX package whose workspace carries
 *  packages of its own. */
export function shellsFrom(nodes: CatalogNode[], profiles: Record<string, Record<string, unknown>>): Shell[] {
  const out: Shell[] = [];
  for (const n of nodes) {
    if (n.type_id !== FRONTX_NODE_TYPE) continue;
    const v = n.value as Record<string, unknown>;
    const name = str(v.name) ?? n.instance_id;
    const auto = (profiles[name]?.auto ?? {}) as Record<string, unknown>;
    const own = auto.carries && typeof auto.carries === "object" ? (auto.carries as Record<string, unknown>) : null;
    if (!own || Object.keys(own).length === 0) continue;
    const version = str(v.max_version) ?? str(v.newest_version) ?? textOf(auto.version);
    const carries: Record<string, string> = { ...frontxPins(auto.deps_versions) };
    for (const [k, ver] of Object.entries(own)) if (typeof ver === "string") carries[k] = ver;
    if (version) carries[name] = version;
    out.push({
      name,
      repo: str(v.repository) ?? str(v.synced_from),
      path: textOf(auto.path),
      version,
      carries,
      signsIn: typeof auto.shell_signin === "boolean" ? auto.shell_signin : null,
      runtimeEnv: typeof auto.shell_runtime_env === "boolean" ? auto.shell_runtime_env : null,
    });
  }
  return out.sort(
    (a, b) => (ownerRepo(a.repo) ?? "").localeCompare(ownerRepo(b.repo) ?? "") || a.name.localeCompare(b.name),
  );
}

/** `owner/repo` out of whatever a catalogue entry says its repository is. */
export function ownerRepo(repo: string | null | undefined): string | null {
  const s = (repo ?? "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/^git@github\.com:/i, "");
  const m = /^([^/\s]+)\/([^/\s#?]+)/.exec(s);
  return m ? `${m[1]}/${m[2].replace(/\.git$/, "")}` : null;
}

/** What `project.config.frontend.shell` names: `github:owner/repo//dir@ref`. */
export function parseShellRef(ref: string | null | undefined): { repo: string; path: string; ref: string } | null {
  const m = /^github:([^/]+\/[^/]+?)\/\/(.+?)(?:@([^@]+))?$/.exec((ref ?? "").trim());
  return m ? { repo: m[1], path: m[2], ref: m[3] ?? "main" } : null;
}

export function shellRefOf(shell: Pick<Shell, "repo" | "path">, ref = "main"): string | null {
  const repo = ownerRepo(shell.repo);
  return repo && shell.path ? `github:${repo}//${shell.path}@${ref}` : null;
}

/** The catalogue's shell that `ref` names, if the catalogue has it. */
export function chosenShell(shells: readonly Shell[], ref: string | null | undefined): Shell | null {
  const want = parseShellRef(ref);
  if (!want) return null;
  return (
    shells.find((s) => repoKey(ownerRepo(s.repo) ?? "") === repoKey(want.repo) && (s.path ?? "") === want.path) ?? null
  );
}

/** A version as numbers and a prerelease: `0.2.0-alpha.16`. */
function parseVersion(v: string): { nums: number[]; pre: (string | number)[] } | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)],
    pre: m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

/** Semver order; `null` when either side is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  // A release is newer than any of its prereleases.
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    if (typeof p === "number") return -1;
    if (typeof q === "number") return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Whether `version` meets `spec`: exact, `*`, `>=`, `^` and `~`. */
export function satisfies(spec: string, version: string): boolean {
  const s = spec.trim();
  if (s === "" || s === "*" || s === "latest") return true;
  const op = /^(>=|\^|~)?\s*(.+)$/.exec(s);
  if (!op) return false;
  const want = parseVersion(op[2]);
  const have = parseVersion(version);
  const cmp = compareVersions(version, op[2]);
  if (!want || !have || cmp === null) return false;
  if (!op[1]) return cmp === 0;
  if (cmp < 0) return false;
  if (op[1] === ">=") return true;
  if (op[1] === "~") return have.nums[0] === want.nums[0] && have.nums[1] === want.nums[1];
  // ^: the leftmost non-zero part stays.
  if (want.nums[0] !== 0) return have.nums[0] === want.nums[0];
  if (want.nums[1] !== 0) return have.nums[0] === 0 && have.nums[1] === want.nums[1];
  return have.nums[0] === 0 && have.nums[1] === 0 && have.nums[2] === want.nums[2];
}

/** One FrontX pin of a micro-frontend held against the shell. */
export interface Fit {
  pkg: string;
  wants: string;
  /** The version the shell carries; `null` when it carries none. */
  has: string | null;
  /** `fits`: the shell's meets the pin. `differs`: assembly sets it to the
   *  shell's, which builds only if the package uses nothing the shell's
   *  version lacks. `outside`: the shell does not carry it; it comes from the
   *  registry at the version pinned. */
  verdict: "fits" | "differs" | "outside";
}

export function fitOf(mfe: Pick<Mfe, "wants">, shell: Pick<Shell, "carries">): Fit[] {
  return Object.entries(mfe.wants ?? {})
    .map(([pkg, wants]): Fit => {
      const has = shell.carries[pkg] ?? null;
      const verdict = has === null ? "outside" : satisfies(wants, has) ? "fits" : "differs";
      return { pkg, wants, has, verdict };
    })
    .sort((a, b) => a.pkg.localeCompare(b.pkg));
}

/** Gears that sign a product's users in: a shell mounted on such a product
 *  has to sign in against it. */
const IDP_GEARS = /(^|-)(oidc-authn|keycloak|idp)(-|$)/;

export function productIdp(productGears: readonly string[]): string | null {
  return productGears.map(gearKey).find((g) => IDP_GEARS.test(g)) ?? null;
}

export type StepState = "ok" | "warn" | "bad" | "todo" | "info";

/** One step of turning the picks into a running frontend, with what the
 *  constructor found for it. */
export interface Step {
  id: "shell" | "mount" | "versions" | "signin" | "backend" | "gears" | "build" | "ship";
  title: string;
  state: StepState;
  detail: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The steps a build takes, in order, each judged from what the catalogue and
 *  the product say. A step nothing automates yet says so. */
export function assemblySteps(input: {
  shellRef: string | null | undefined;
  shell: Shell | null;
  picked: Mfe[];
  productGears: string[];
}): Step[] {
  const { shell, picked, productGears } = input;
  const ref = parseShellRef(input.shellRef);
  const steps: Step[] = [];

  steps.push(
    shell
      ? {
          id: "shell",
          title: "Take the shell",
          state: "ok",
          detail: `${shell.name}${shell.version ? `@${shell.version}` : ""} from ${ownerRepo(shell.repo) ?? "?"}/${shell.path ?? ""}; it carries ${plural(Object.keys(shell.carries).length, "FrontX package")}`,
        }
      : {
          id: "shell",
          title: "Take the shell",
          state: "warn",
          detail: ref
            ? `${ref.repo}/${ref.path} is not in the catalogue: add ${ref.repo} as a frontx source and sync, or what it carries is unknown`
            : "No shell chosen",
        },
  );

  steps.push({
    id: "mount",
    title: "Mount the micro-frontends",
    state: picked.length > 0 ? "ok" : "todo",
    detail:
      picked.length > 0
        ? `${plural(picked.length, "package")} into src-app/mfe_packages/: ${picked.map((m) => m.name).join(", ")}`
        : "Nothing picked: the shell would come up empty",
  });

  const fits = shell ? picked.flatMap((m) => fitOf(m, shell)) : [];
  const differs = fits.filter((f) => f.verdict === "differs").length;
  const outside = fits.filter((f) => f.verdict === "outside").length;
  const unread = picked.filter((m) => Object.keys(m.wants ?? {}).length === 0).length;
  const notes = [
    outside > 0 ? `${plural(outside, "pin")} the shell does not carry come from the registry` : "",
    unread > 0 ? `the pins of ${plural(unread, "package")} are not read yet: sync the catalogue` : "",
  ].filter(Boolean);
  steps.push({
    id: "versions",
    title: "Align FrontX versions",
    state: !shell || picked.length === 0 ? "todo" : differs > 0 ? "warn" : "ok",
    detail: !shell
      ? "Needs a shell the catalogue knows"
      : picked.length === 0
        ? "Nothing to align"
        : [
            differs > 0
              ? `${plural(differs, "pin")} differ from the shell's; assembly sets them to the shell's, and a package that uses what the shell's version lacks fails to build`
              : "Every pin the shell carries fits",
            ...notes,
          ].join("; "),
  });

  const idp = productIdp(productGears);
  steps.push({
    id: "signin",
    title: "Sign users in",
    state: !idp ? "info" : shell?.signsIn === true ? "ok" : shell?.signsIn === false ? "bad" : "warn",
    detail: !idp
      ? "The product has no sign-in gear; the shell opens without one"
      : shell?.signsIn === true
        ? `The shell signs in against the product's ${idp}`
        : shell?.signsIn === false
          ? `The product signs in with ${idp}, and this shell has no sign-in: its screens get 401. Pick a shell that signs in`
          : `The product signs in with ${idp}; whether this shell does is not known: sync the catalogue`,
  });

  steps.push({
    id: "backend",
    title: "Reach the backend",
    state: !shell ? "todo" : shell.runtimeEnv === false ? "warn" : "ok",
    detail:
      shell?.runtimeEnv === false
        ? "/cf goes to the product's api-gateway; the shell takes its addresses at build, so one image serves one environment"
        : "/cf goes to the product's api-gateway; the shell reads the issuer and client id from /env.js at start",
  });

  const lacking = [...new Set([...coverage(picked, productGears).missing.values()].flat())].sort();
  steps.push({
    id: "gears",
    title: "Gears behind the screens",
    state: picked.length === 0 ? "todo" : lacking.length > 0 ? "bad" : "ok",
    detail:
      picked.length === 0
        ? "No screens yet"
        : lacking.length > 0
          ? `Not in the product: ${lacking.join(", ")}. Those screens open and get 404`
          : "Every gear a screen calls is in the product",
  });

  steps.push({
    id: "build",
    title: "Build",
    state: "todo",
    detail:
      "npm ci, build the shell's packages, build each micro-frontend, generate the manifests, vite build. By hand today: gearbox generate does not assemble a frontend yet (ADR-0050 phase 2)",
  });
  steps.push({
    id: "ship",
    title: "Ship",
    state: "todo",
    detail: "A static image beside the product's, in its chart. Not yet: nothing builds it",
  });
  return steps;
}
