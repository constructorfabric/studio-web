/* A project's Deploys tab (ADR-0043, project side): the rules behind it, kept
 * apart from the React for their tests. */

import type { Deployment, DeployEnvironment } from "./api";
import type { IdeBuild } from "./builds";

/** The newest deployment of the project in each environment, whatever its
 *  state: the server lists them newest first. A preview is not what runs
 *  there (ADR-0055), so it is not one. */
export function latestByEnvironment(deployments: readonly Deployment[]): Map<string, Deployment> {
  const out = new Map<string, Deployment>();
  for (const d of deployments) if (!d.preview && !out.has(d.environment_id)) out.set(d.environment_id, d);
  return out;
}

/** The project's previews in an environment that are not removed yet,
 *  newest first (ADR-0055). */
export function livePreviews(deployments: readonly Deployment[], environment: string): Deployment[] {
  return deployments.filter((d) => d.environment_id === environment && !!d.preview && !d.preview.removed_at);
}

/** A name for a preview of `build`, as the namespace takes it: the build's
 *  chart version or id, lowercase letters, digits and `-`, at most 20. */
export function previewNameFor(build: Pick<IdeBuild, "chartVersion" | "buildId">): string {
  const raw = (build.chartVersion ?? build.buildId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const tail = raw.slice(-20).replace(/^-+/, "");
  return tail || "preview";
}

/** The lifetimes a preview can be asked for, in hours: the usual steps up to
 *  the environment's most, which is always offered and comes last. */
export function previewLifetimes(most: number): number[] {
  const steps = [4, 24, 72, 168].filter((h) => h < most);
  return most >= 1 ? [...steps, most] : steps;
}

/** A lifetime as a person reads it: "4 h", "3 d". */
export function lifetimeLabel(hours: number): string {
  return hours >= 48 && hours % 24 === 0 ? `${hours / 24} d` : `${hours} h`;
}

/** How long until a preview expires, as a person reads it: "expires in 2 d",
 *  "expires in 5 h", "expiring". */
export function expiresIn(expiresAt: string, now: number = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "expiring";
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 48) return `expires in ${Math.round(hours / 24)} d`;
  if (hours >= 1) return `expires in ${hours} h`;
  return `expires in ${Math.max(1, Math.round(ms / 60_000))} min`;
}

/** The profiles bound to an environment, as the line under it says them. */
export function profilesBoundTo(bindings: readonly { profile: string; environment_id: string }[], environment: string): string[] {
  return bindings.filter((b) => b.environment_id === environment).map((b) => b.profile);
}

/** The builds a deploy can name: passed, with a published chart (ADR-0048);
 *  or, for a Constructor Research environment, made in Research, which runs
 *  only images it built and keeps no chart (ADR-0049 §3). Without an
 *  environment, any build some environment could take. */
export function deployableBuilds(builds: readonly IdeBuild[], env?: Pick<DeployEnvironment, "kind">): IdeBuild[] {
  const charted = (b: IdeBuild) => !!(b.chartRef && b.chartVersion);
  const research = (b: IdeBuild) => b.where === "research";
  return builds.filter(
    (b) => b.status === "passed" && (env ? (env.kind === "research" ? research(b) : charted(b)) : charted(b) || research(b)),
  );
}

/** What a rollback in an environment installs again: the newest succeeded
 *  install there before the latest one, with a published chart -- an
 *  uploaded one is not kept -- or, in Research, another build. `null` when
 *  there is none. */
export function rollbackTarget(deployments: readonly Deployment[], environment: string): Deployment | null {
  const installs = deployments.filter(
    (d) => d.environment_id === environment && !d.preview && d.state === "succeeded" && (d.action ?? "install") === "install",
  );
  const [latest, ...earlier] = installs;
  if (!latest) return null;
  return (
    earlier.find((d) =>
      d.chart_ref
        ? !(d.chart_ref === latest.chart_ref && d.chart_version === latest.chart_version)
        : !latest.chart_ref && !!d.build && d.build !== latest.build,
    ) ?? null
  );
}

/** Where a product a deploy started opens: the addresses its outcome names
 *  (a Research deploy ends "… runs in Constructor Research: https://…"). */
export function productUrls(outcome: string | null | undefined): string[] {
  return (outcome ?? "").match(/https?:\/\/[^\s,;]+/g) ?? [];
}

/** Whether the release runs in the environment now, so it can be taken out. */
export function runsNow(latest: Deployment | undefined): boolean {
  return !!latest && latest.state === "succeeded" && (latest.action ?? "install") === "install";
}

/** Why a build cannot go into `env` yet, from the history: it has not
 *  succeeded in the environment `env` takes from. `null` when it can. */
export function promotionGap(
  env: DeployEnvironment,
  build: IdeBuild,
  deployments: readonly Deployment[],
  name: (id: string) => string,
): string | null {
  if (!env.promote_from) return null;
  const ran = deployments.some(
    (d) =>
      d.environment_id === env.promote_from &&
      !d.preview &&
      d.state === "succeeded" &&
      (d.action ?? "install") === "install" &&
      d.build === build.buildId,
  );
  return ran ? null : `Takes only what runs in ${name(env.promote_from)}: deploy it there first.`;
}

/** A binding's values as the text the person edits, and back: an object or
 *  nothing; anything else is a mistake to say. */
export function valuesText(values: Record<string, unknown> | null | undefined): string {
  return values && Object.keys(values).length ? JSON.stringify(values, null, 2) : "";
}

export function parseValues(text: string): { values: Record<string, unknown> | null; error: string | null } {
  if (!text.trim()) return { values: null, error: null };
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return { values: v as Record<string, unknown>, error: null };
    return { values: null, error: "Chart values are a JSON object: { \"api-gateway\": { \"replicaCount\": 2 } }." };
  } catch (e) {
    return { values: null, error: `Not JSON: ${(e as Error).message}` };
  }
}

/** A secret's key: an environment variable name. */
export function isSecretKey(key: string): boolean {
  return /^[A-Z_][A-Z0-9_]{0,127}$/.test(key);
}
