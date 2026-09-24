/**
 * The shell's route: what the one screen-domain entry says (ADR-0028).
 *
 * `token` names the screen group (`screenTokens.ts` derives it from the
 * manifests); the four parameters are the level context, written in this
 * order and only as far down as the level in scope goes. The codec is
 * deliberately dumb: it neither validates ids nor knows levels —
 * `materialize` does both.
 */
import type { DomainKey, Param } from '@gears-frontx/routing';

/** The root domain key the shell projects. A valid `name`; `route.test.ts` proves it. */
export const SCREEN_DOMAIN_KEY = 'screen' as DomainKey;

export interface ShellRoute {
  token: string;
  org?: string;
  workspace?: string;
  project?: string;
  section?: string;
}

const PARAM_ORDER = ['org', 'workspace', 'project', 'section'] as const;
type RouteParam = (typeof PARAM_ORDER)[number];

export function routeToParams(route: ShellRoute): Param[] {
  const params: Param[] = [];
  for (const name of PARAM_ORDER) {
    const value = route[name];
    if (value) params.push({ name, value });
  }
  return params;
}

export function routeFromEntry(entry: { extension: string; params: readonly Param[] }): ShellRoute {
  const route: ShellRoute = { token: entry.extension };
  for (const param of entry.params) {
    const name = param.name as RouteParam;
    if (!PARAM_ORDER.includes(name)) continue;
    if (route[name] !== undefined || !param.value) continue;
    route[name] = param.value;
  }
  return route;
}

export function routesEqual(
  a: ShellRoute | null | undefined,
  b: ShellRoute | null | undefined
): boolean {
  if (!a || !b) return !a && !b;
  if (a.token !== b.token) return false;
  return PARAM_ORDER.every((name) => (a[name] || undefined) === (b[name] || undefined));
}
