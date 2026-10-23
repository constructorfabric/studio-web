/* A project's Deploys tab (ADR-0043, project side): the rules behind it, kept
 * apart from the React for their tests. */

import type { Deployment, DeployEnvironment } from "./api";
import type { IdeBuild } from "./builds";

/** The newest deployment of the project in each environment, whatever its
 *  state: the server lists them newest first. */
export function latestByEnvironment(deployments: readonly Deployment[]): Map<string, Deployment> {
  const out = new Map<string, Deployment>();
  for (const d of deployments) if (!out.has(d.environment_id)) out.set(d.environment_id, d);
  return out;
}

/** The profiles bound to an environment, as the line under it says them. */
export function profilesBoundTo(bindings: readonly { profile: string; environment_id: string }[], environment: string): string[] {
  return bindings.filter((b) => b.environment_id === environment).map((b) => b.profile);
}

/** The builds a deploy can name: passed, with a published chart (ADR-0048). */
export function deployableBuilds(builds: readonly IdeBuild[]): IdeBuild[] {
  return builds.filter((b) => b.status === "passed" && b.chartRef && b.chartVersion);
}

/** What a rollback in an environment installs again: the newest succeeded
 *  install there before the latest one, with a published chart -- an
 *  uploaded one is not kept. `null` when there is none. */
export function rollbackTarget(deployments: readonly Deployment[], environment: string): Deployment | null {
  const installs = deployments.filter(
    (d) => d.environment_id === environment && d.state === "succeeded" && (d.action ?? "install") === "install",
  );
  const [latest, ...earlier] = installs;
  if (!latest) return null;
  return earlier.find((d) => d.chart_ref && !(d.chart_ref === latest.chart_ref && d.chart_version === latest.chart_version)) ?? null;
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
