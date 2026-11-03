/* ── The Product tab's parts ─────────────────────────────────────────────────
 *
 * A product is one thing with up to three parts, and the Product tab shows
 * them as sections of one page rather than as tabs of their own:
 *
 *   - Parts: what the project has to make it from -- the platform's and the
 *     organization's components, its own gears, code that could become one,
 *     services that are not gears, and gears the specs ask for that nobody
 *     wrote. It was the Components tab, which read as this page twice;
 *   - Infrastructure: where it runs -- the environments it may run in, the
 *     profile each runs and what the engine said of it, and the database
 *     each gives it;
 *   - Backend: the gears it is composed from (the specs-to-product journey);
 *   - Frontend: a FrontX shell with micro-frontends mounted in it (ADR-0050).
 *     Optional: a product may be gears alone, and then the section offers to
 *     add a frontend instead of drawing an empty constructor.
 *
 * The Frontend used to be a project tab of its own (`/…/frontend`); an address
 * that names it still lands here, on that section.
 *
 * Pure, so it is tested without a backend. */

import type {
  DeployEnvironment,
  EnvironmentBinding,
  FrontendPick,
  ProductTechnology,
  ProjectConfig,
  ProjectProduct,
} from "./api";
import { parseShellRef } from "./frontend-constructor";
import { checkOf, currentDescription, profileLabel, profilesToCheck, verdictOf, type ProfileVerdict } from "./product";

export type ProductSectionId = "parts" | "infrastructure" | "backend" | "frontend";

export const PRODUCT_SECTIONS: readonly { id: ProductSectionId; title: string; hint: string }[] = [
  { id: "parts", title: "Parts", hint: "What the project has to make it from, and what it lacks" },
  { id: "infrastructure", title: "Infrastructure", hint: "Where it runs: its environments, their profiles and databases" },
  { id: "backend", title: "Backend", hint: "The gears it is composed from" },
  { id: "frontend", title: "Frontend", hint: "A FrontX shell with micro-frontends, if it has one" },
];

/** The FrontX template a new frontend's shell comes from, spelled as FrontX's
 *  provenance spells a source. The same repository the constructor suggests
 *  as the catalogue's first micro-frontend source. */
export const FRONTX_SHELL_TEMPLATE = "github:constructorfabric/gears-frontx-templates//template-shell@main";

/** Project tabs that moved, by their old id: Frontend became a section of
 *  Product, and Builds and Deploys became Releases (ADR-0056 §4). */
export const MOVED_PROJECT_TABS: Readonly<Record<string, { tab: "components" | "releases"; section?: ProductSectionId }>> = {
  frontend: { tab: "components", section: "frontend" },
  builds: { tab: "releases" },
  deploys: { tab: "releases" },
};

/** The tab an id names now: a moved one's new tab, any other unchanged. For
 *  every id kept somewhere -- a stored place, a pin, a project type. */
export function currentProjectTab(id: string): string {
  return MOVED_PROJECT_TABS[id]?.tab ?? id;
}

/** Whether the product has a frontend: the product records one, or -- for a
 *  project that picked micro-frontends before the product kept them -- its
 *  configuration does. */
export function hasFrontend(
  cfg: ProjectConfig | null | undefined,
  product?: Pick<ProjectProduct, "frontend"> | null,
): boolean {
  return !!product?.frontend || (!!cfg?.frontend && typeof cfg.frontend === "object");
}

/** The frontend a product starts with: the FrontX shell template, nothing
 *  mounted yet. */
export function newFrontend(): FrontendPick {
  const { repo, path, ref } = parseShellRef(FRONTX_SHELL_TEMPLATE)!;
  return { shell: { repo, path, ref }, mfes: [] };
}

/** The configuration without the frontend it recorded before the product
 *  kept it. */
export function withoutFrontend(cfg: ProjectConfig | null | undefined): ProjectConfig {
  const out = { ...(cfg ?? {}) };
  delete out.frontend;
  return out;
}

/** The section an old project-tab path asks for: `/…/projects/{id}/frontend`
 *  opens Product › Frontend. `null` for any other path. */
export function sectionFromPath(pathname: string): ProductSectionId | null {
  const last = pathname.split("/").filter(Boolean).pop() ?? "";
  return MOVED_PROJECT_TABS[last]?.section ?? null;
}

/** One environment the product runs in, as Infrastructure lists it. */
export interface RunsIn {
  environment: string;
  namespace: string;
  /** The profile bound to it; null when none is. */
  profile: string | null;
  /** That profile as a person reads it: "Kubernetes · prod". */
  profileLabel: string | null;
  /** What the engine said of that profile; null when none is bound. */
  verdict: ProfileVerdict | null;
  /** What that profile needs running beside it, as its check found; null
   *  before a check that says. */
  needs: ProductTechnology[] | null;
  /** What it gives the product for a database, in words. */
  database: string;
  /** What the product needs that it does not give: "PostgreSQL". */
  missing: string[];
  /** "not checked yet for prod" when the bound profile has no current
   *  check: what it needs there is not known yet. Null otherwise. */
  unchecked: string | null;
}

/** What Infrastructure says: the environments the product may run in, each
 *  with its binding, its profile's verdict and its database; and what the
 *  product needs, for the profile the table shows. */
export interface Infrastructure {
  /** The profile `needs` and `applications` are for: the first one an
   *  environment runs, else the one the engine checked last. */
  profile: string | null;
  profileLabel: string | null;
  runsIn: RunsIn[];
  /** What the gears need running beside them, as that profile's check found;
   *  null before a check that says (an older record, or none yet). */
  needs: ProductTechnology[] | null;
  /** The applications the product is built into, as that check found. */
  applications: string[];
}

const DATABASE_WORDS: Record<DeployEnvironment["database"], string> = {
  none: "its own Postgres, with each deploy",
  // ADR-0048 §7: recorded, not used -- a deploy gets no database from it.
  shared: "none: a shared Postgres is recorded, and deploys get nothing from it",
  namespace: "its own Postgres, with each deploy",
};

/** How a technology the product needs gets to where it runs: the database
 *  comes with every deploy; the rest is somebody else's to run, and the
 *  gear's settings say where. */
export function comesWith(technology: string): { deployed: boolean; words: string } {
  return technology === "postgres"
    ? { deployed: true, words: "with every deploy: Studio runs it beside the product" }
    : { deployed: false, words: "not deployed by Studio: run it, and set where in the gear's settings" };
}

export function infrastructureOf(
  product: Pick<ProjectProduct, "checks" | "last_preview"> | null,
  targets: { environments: { environment: DeployEnvironment; namespace: string }[]; bindings: EnvironmentBinding[] } | null,
): Infrastructure {
  const bindings = targets?.bindings ?? [];
  const current = currentDescription(product);
  const profile = bindings.length > 0 ? profilesToCheck(bindings)[0] : (product?.last_preview?.profile ?? null);
  const shown = profile ? checkOf(product, profile) : null;
  const needs = shown?.infrastructure ?? null;
  const runsIn = (targets?.environments ?? []).map(({ environment, namespace }): RunsIn => {
    const bound = bindings.find((b) => b.environment_id === environment.id)?.profile ?? null;
    const verdict = bound ? verdictOf(product, bound, current) : null;
    // What runs here needs what its own profile's check found; an
    // environment nothing is bound to is read with the shown profile's.
    const here = bound ? (checkOf(product, bound)?.infrastructure ?? null) : needs;
    const postgres = here?.some((t) => t.id === "postgres") ?? false;
    return {
      environment: environment.name,
      namespace,
      profile: bound,
      profileLabel: bound ? profileLabel(bound) : null,
      verdict,
      needs: here,
      database:
        here !== null && !postgres && environment.database !== "shared"
          ? "none needed"
          : environment.database !== "shared" && environment.database_image
            ? `${DATABASE_WORDS[environment.database]} (${environment.database_image})`
            : (DATABASE_WORDS[environment.database] ?? environment.database),
      // A shared server is recorded, not handed to the chart: nothing serves
      // the host it names. Any other mode brings the product's own.
      missing: postgres && environment.database === "shared" ? ["PostgreSQL"] : [],
      unchecked:
        verdict && (verdict.state === "unchecked" || verdict.state === "stale") ? `not checked yet for ${bound}` : null,
    };
  });
  return {
    profile,
    profileLabel: profile ? profileLabel(profile) : null,
    runsIn,
    needs,
    applications: shown?.applications ?? [],
  };
}

/** The Product page's header: the product in one line -- what it is, from
 *  how many gears, where it was last saved, whether it
 *  resolved, and whether it has a frontend. */
export interface ProductSummary {
  id: string | null;
  gears: number;
  saved: { branch: string | null; prUrl: string | null } | null;
  /** The description revision Studio keeps (ADR-0053), when it keeps one. */
  revision: number | null;
  /** `ok`, `N errors`, or null before the first preview. */
  preview: { ok: boolean; errors: number; warnings: number } | null;
  frontend: boolean;
}

export function productSummary(
  product: Pick<
    ProjectProduct,
    "product_id" | "gears" | "written" | "description" | "last_preview" | "frontend"
  > | null,
  cfg: ProjectConfig | null | undefined,
): ProductSummary {
  return {
    id: product?.product_id ?? null,
    gears: product?.gears?.length ?? 0,
    saved: product?.written ? { branch: product.written.branch || null, prUrl: product.written.pr_url ?? null } : null,
    revision: product?.description?.revision ?? null,
    preview: product?.last_preview
      ? { ok: product.last_preview.ok, errors: product.last_preview.errors, warnings: product.last_preview.warnings }
      : null,
    frontend: hasFrontend(cfg, product),
  };
}

/** The section the Product page opens on: an old Frontend-tab address first,
 *  then the one this member last looked at for the project, else Backend --
 *  the gears, where a product starts. */
export function openingSection(landing: ProductSectionId | null, stored: string | null): ProductSectionId {
  if (landing) return landing;
  return PRODUCT_SECTIONS.some((s) => s.id === stored) ? (stored as ProductSectionId) : "backend";
}
