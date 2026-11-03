/* Where a project's gears run (ADR-0043 §4 read back onto the product):
 * for each gear of the product, the environments whose latest successful
 * deploy carried it, since when and at which version or commit -- or that it
 * is not deployed -- and a hint where that contradicts the gear's maturity.
 *
 * Joined in the portal from what it already reads: the project's deployments
 * (`/studio-environments/v1/deployments`), its targets (which environment is
 * protected) and its product record (where product.gdl was last committed,
 * and when the product last changed). A deploy record names the product and
 * the commit, not the gears, so a deploy older than the product's last change
 * may have carried another set: such a run is said as `earlier`, not claimed.
 *
 * Pure: product-configurator-view.tsx and project-components-view.tsx render
 * what these compute. */

import type { Deployment } from "./api";

/** What one environment runs now: its latest successful deploy. */
export interface Running {
  environmentId: string;
  environment: string;
  /** Protected, or named like production: what experimental must not reach. */
  productionLike: boolean;
  /** When it was deployed: decided, or asked for when nobody had to decide. */
  since: string;
  commit: string | null;
  requestedAt: string;
}

/** The product's state the runs are measured against. */
export interface ProductAt {
  /** Where product.gdl was last committed. */
  commit?: string | null;
  /** When the product's record last changed. */
  updatedAt?: string | null;
}

/** One environment a gear runs in. */
export interface GearRun extends Running {
  /** `current`: deployed from the product as it is now; `earlier`: from a
   *  product that has changed since, which may not have had this gear. */
  as: "current" | "earlier";
}

export interface GearDeployState {
  runs: GearRun[];
  /** "running in stage since 2026-10-19 (0.1.0)", or "not deployed". */
  line: string;
  /** Where the runs contradict the maturity; null when they do not. */
  hint: string | null;
}

const PRODUCTION = /(^|[^a-z])(prod|production|live)([^a-z]|$)/i;

/** An environment experimental gears must not run in: one a deploy to waits
 *  for an administrator, or one named production. */
export function productionLike(env: { name: string; protected?: boolean }): boolean {
  return env.protected === true || PRODUCTION.test(env.name);
}

/** The latest successful deploy in each environment: a later one that failed,
 *  waits or was declined does not replace what runs there. */
export function runningNow(
  deployments: readonly Deployment[],
  environments: readonly { id: string; name: string; protected?: boolean }[] = [],
): Running[] {
  const envs = new Map(environments.map((e) => [e.id, e]));
  const latest = new Map<string, Deployment>();
  for (const d of deployments) {
    // A preview runs beside the environment, not in it (ADR-0055 §2).
    if (d.state !== "succeeded" || d.preview) continue;
    const seen = latest.get(d.environment_id);
    if (!seen || Date.parse(d.requested_at) > Date.parse(seen.requested_at)) latest.set(d.environment_id, d);
  }
  return [...latest.values()]
    // The latest was taking it out: nothing runs there now.
    .filter((d) => (d.action ?? "install") === "install")
    .map((d) => {
      const env = envs.get(d.environment_id);
      const name = env?.name ?? d.environment_name;
      return {
        environmentId: d.environment_id,
        environment: name,
        productionLike: productionLike({ name, protected: env?.protected }),
        since: d.decided_at ?? d.requested_at,
        commit: d.commit ?? null,
        requestedAt: d.requested_at,
      };
    })
    .sort((a, b) => a.environment.localeCompare(b.environment));
}

/** Two commits are one when the shorter is the longer's prefix. */
function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return l.toLowerCase().startsWith(s.toLowerCase());
}

/** The version a pick names (`analytics@0.1.0`, ADR-0044 §2), if any. */
export function versionOf(name: string): string | null {
  const at = name.lastIndexOf("@");
  return at > 0 && at < name.length - 1 ? name.slice(at + 1) : null;
}

/** "2026-10-19". */
function day(iso: string): string {
  return iso.slice(0, 10);
}

/** Where one gear of the product runs, and what that says about its
 *  maturity. `running` null: the deployments could not be read, and nothing
 *  is said. */
export function gearDeployState(
  gear: { name: string; maturity?: string | null },
  running: readonly Running[] | null,
  product: ProductAt = {},
): GearDeployState | null {
  if (!running) return null;
  const changed = product.updatedAt ? Date.parse(product.updatedAt) : NaN;
  const runs: GearRun[] = running.map((r) => ({
    ...r,
    as:
      sameCommit(r.commit, product.commit) || Number.isNaN(changed) || Date.parse(r.requestedAt) >= changed
        ? "current"
        : "earlier",
  }));
  const version = versionOf(gear.name);
  const line =
    runs.length === 0
      ? "not deployed"
      : `running in ${runs
          .map((r) => {
            const at = version ?? (r.commit ? r.commit.slice(0, 8) : null);
            return `${r.environment} since ${day(r.since)}${at ? ` (${at})` : ""}${r.as === "earlier" ? ", from an earlier product" : ""}`;
          })
          .join("; ")}`;
  const maturity = gear.maturity?.trim().toLowerCase() ?? "";
  const exposed = runs.filter((r) => r.productionLike);
  const hint =
    maturity === "stable" && runs.length === 0
      ? "Stable, but not deployed anywhere: nothing yet shows it runs."
      : (maturity === "experimental" || maturity === "design") && exposed.length > 0
        ? `${maturity === "design" ? "Design only" : "Experimental"}, but ${
            exposed.every((r) => r.as === "earlier") ? "possibly " : ""
          }running in ${exposed.map((r) => r.environment).join(", ")}: an experimental gear must not ship as stable.`
        : null;
  return { runs, line, hint };
}
