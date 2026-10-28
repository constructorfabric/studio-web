/* ── The Product tab's parts ─────────────────────────────────────────────────
 *
 * A product is one thing with up to three parts, and the Product tab shows
 * them as sections of one page rather than as tabs of their own:
 *
 *   - Infrastructure: where it runs -- the profile it is composed for, the
 *     environments it is bound to, and the database each gives it;
 *   - Backend: the gears it is composed from (the specs-to-product journey);
 *   - Frontend: a FrontX shell with micro-frontends mounted in it (ADR-0050).
 *     Optional: a product may be gears alone, and then the section offers to
 *     add a frontend instead of drawing an empty constructor.
 *
 * The Frontend used to be a project tab of its own (`/…/frontend`); an address
 * that names it still lands here, on that section.
 *
 * Pure, so it is tested without a backend. */

import type { DeployEnvironment, EnvironmentBinding, ProjectConfig, ProjectProduct } from "./api";
import { PRODUCT_PROFILES } from "./product";

export type ProductSectionId = "infrastructure" | "backend" | "frontend";

export const PRODUCT_SECTIONS: readonly { id: ProductSectionId; title: string; hint: string }[] = [
  { id: "infrastructure", title: "Infrastructure", hint: "Where it runs: its profile, environments and databases" },
  { id: "backend", title: "Backend", hint: "The gears it is composed from" },
  { id: "frontend", title: "Frontend", hint: "A FrontX shell with micro-frontends, if it has one" },
];

/** The FrontX template a new frontend's shell comes from, spelled as FrontX's
 *  provenance spells a source. The same repository the constructor suggests
 *  as the catalogue's first micro-frontend source. */
export const FRONTX_SHELL_TEMPLATE = "github:constructorfabric/gears-frontx-templates//template-shell@main";

/** Project tabs that became a section of Product, by their old id. */
export const MOVED_PROJECT_TABS: Readonly<Record<string, { tab: "components"; section: ProductSectionId }>> = {
  frontend: { tab: "components", section: "frontend" },
};

/** Whether the product has a frontend: its configuration names one. A project
 *  that picked micro-frontends before this was a question has one. */
export function hasFrontend(cfg: ProjectConfig | null | undefined): boolean {
  return !!cfg?.frontend && typeof cfg.frontend === "object";
}

/** The configuration with a frontend added from the FrontX shell template,
 *  keeping any micro-frontends already picked. */
export function withFrontend(cfg: ProjectConfig | null | undefined): ProjectConfig {
  const base = cfg ?? {};
  return { ...base, frontend: { mfes: [], ...(base.frontend ?? {}), shell: base.frontend?.shell ?? FRONTX_SHELL_TEMPLATE } };
}

/** The configuration without its frontend: the product is gears alone again. */
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
  /** What it gives the product for a database, in words. */
  database: string;
}

/** What Infrastructure says: the profile the product is composed for and the
 *  environments it may run in, each with its binding and its database. */
export interface Infrastructure {
  profile: string | null;
  profileLabel: string | null;
  runsIn: RunsIn[];
}

const DATABASE_WORDS: Record<DeployEnvironment["database"], string> = {
  none: "no database",
  shared: "the environment's shared Postgres",
  namespace: "a Postgres of its own in its namespace",
};

export function infrastructureOf(
  product: Pick<ProjectProduct, "profile"> | null,
  targets: { environments: { environment: DeployEnvironment; namespace: string }[]; bindings: EnvironmentBinding[] } | null,
): Infrastructure {
  const profile = product?.profile ?? null;
  const profileLabel = profile ? (PRODUCT_PROFILES.find((p) => p.id === profile)?.label ?? profile) : null;
  const runsIn = (targets?.environments ?? []).map(({ environment, namespace }) => ({
    environment: environment.name,
    namespace,
    profile: targets?.bindings.find((b) => b.environment_id === environment.id)?.profile ?? null,
    database:
      environment.database === "namespace" && environment.database_image
        ? `${DATABASE_WORDS.namespace} (${environment.database_image})`
        : (DATABASE_WORDS[environment.database] ?? environment.database),
  }));
  return { profile, profileLabel, runsIn };
}
