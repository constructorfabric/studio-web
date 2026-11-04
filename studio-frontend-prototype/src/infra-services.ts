/* A product's infra services (ADR-0064): the third-party services its gears
 * need beside them -- PostgreSQL, Keycloak -- read from the catalogue's
 * `service.gdl` passports (`kind = "infra"`), added to the project, and
 * deployed with the product or read from the environment's shared place.
 *
 * Pure, so it is tested without a backend; infra-services-view.tsx draws it. */

import type {
  CatalogNode,
  InfraPassport,
  InfraPlacement,
  InfraPlan,
  InfraPlanItem,
  InfraService,
  ProductTechnology,
} from "./api";

/** The capability each of the engine's infrastructure needs is bound to
 *  (the backend's `infra::NEEDS`). */
export const NEED_CAPABILITY: Record<string, string> = {
  postgres: "postgres",
  oidc: "oidc.issuer",
  keycloak: "keycloak.admin_url",
  clickhouse: "clickhouse.url",
  timescaledb: "timescaledb.url",
};

/** The variable a gear's configuration reads a capability as:
 *  `oidc.issuer` -> `OIDC_ISSUER`. */
export function variableOf(capability: string): string {
  return capability.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

function record<T>(v: unknown, keep: (x: unknown) => x is T): Record<string, T> {
  const out: Record<string, T> = {};
  if (v && typeof v === "object" && !Array.isArray(v))
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (keep(x)) out[k] = x;
  return out;
}

const isString = (x: unknown): x is string => typeof x === "string";
const isNumber = (x: unknown): x is number => typeof x === "number";
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isString) : []);
const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** An infra service's passport from its catalogue node; `null` for any
 *  other component. */
export function passportOf(node: Pick<CatalogNode, "value">): InfraPassport | null {
  const v = node.value as Record<string, unknown>;
  if (v.kind !== "service" || v.service_kind !== "infra" || typeof v.name !== "string") return null;
  const i = (v.infra ?? {}) as Record<string, unknown>;
  return {
    name: v.name,
    version: text(v.version),
    description: text(v.description),
    image: text(v.image),
    ports: record(v.ports, isNumber),
    health: text(v.health),
    args: strings(i.args),
    config: record(i.config, isString),
    secrets: strings(i.secrets),
    provides: record(i.provides, isString),
    stateful: i.stateful === true,
    storage: text(i.storage),
    data_path: text(i.data_path),
    chart: text(i.chart),
    chart_version: text(i.chart_version),
  };
}

/** Every infra service the catalogue offers, by name, sorted. */
export function offeredInfra(nodes: Pick<CatalogNode, "value">[]): InfraPassport[] {
  const byName = new Map<string, InfraPassport>();
  for (const n of nodes) {
    const p = passportOf(n);
    if (p && !byName.has(p.name)) byName.set(p.name, p);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One need of the product's gears and the infra service bound to it. */
export interface Bound {
  need: ProductTechnology;
  capability: string | null;
  /** The project's service that provides it. */
  service: InfraService | null;
  /** A catalogue service that would, when the project has none. */
  offer: InfraPassport | null;
}

/** Each need bound to the project's service that provides its capability,
 *  else to a catalogue service that would. */
export function bindNeeds(needs: ProductTechnology[], services: InfraService[], offered: InfraPassport[]): Bound[] {
  return needs.map((need) => {
    const capability = NEED_CAPABILITY[need.id] ?? null;
    const provides = (p: InfraPassport) => !!capability && capability in p.provides;
    const service = services.find((s) => provides(s.passport)) ?? null;
    const offer = service ? null : (offered.find(provides) ?? null);
    return { need, capability, service, offer };
  });
}

/** A catalogue passport as a new service of the project: nothing imported yet. */
export function serviceFrom(p: InfraPassport): InfraService {
  return { passport: p, image: null, chart_ref: null, chart_version: null, chart_values: null, public_url: null };
}

/** How a service comes, in words, before a plan is read. */
export function sourceText(s: InfraService): string {
  if (s.chart_ref) return `ready chart ${s.chart_ref}${s.chart_version ? `:${s.chart_version}` : ""}`;
  if (s.image) return `chart generated from its passport, image ${s.image}`;
  return `${s.passport.image ?? "no image"} — not imported into the project's path yet`;
}

/** Whether a service can be deployed as it is: it runs an imported image or a
 *  ready chart. */
export function deployable(s: InfraService): boolean {
  return !!(s.image || s.chart_ref);
}

/** The placement in words. */
export function placementText(p: InfraPlacement | null | undefined): string {
  if (!p || p.placement === "with_product") return "with the product, one of each per environment";
  const names = p.shared.map((s) => s.service);
  return names.length ? `the organization's shared place (${names.join(", ")})` : "the organization's shared place";
}

/** A dev environment always runs them with the product (ADR-0064 §3). */
export function sharedAllowed(e: { strictness?: "dev" | "prod" | null; protected: boolean }): boolean {
  return (e.strictness ?? (e.protected ? "prod" : "dev")) === "prod";
}

const INSTALL_WORDS: Record<InfraPlanItem["install"], string> = {
  database: "made by the database step with its image",
  chart: "installed from its ready chart",
  generated: "installed from a chart generated from its passport",
  shared: "read from the shared place, nothing installed",
};

/** One plan item as a line. */
export function planItemText(i: InfraPlanItem): string {
  const from = i.chart ?? i.image;
  return `${i.service}: ${INSTALL_WORDS[i.install]}${from ? ` (${from})` : ""}`;
}

/** The plan's refusals, the first of which stops a deploy. */
export function planRefusals(p: InfraPlan | null): string[] {
  return (p?.items ?? []).filter((i) => i.refusal).map((i) => `${i.refusal_code}: ${i.refusal}`);
}

/** The variables the product gets from its infra services, sorted. */
export function providedVariables(services: InfraService[]): string[] {
  return [...new Set(services.flatMap((s) => Object.keys(s.passport.provides).map(variableOf)))].sort();
}

/** The shared places as the environment form writes them: one service per
 *  line, `keycloak oidc.issuer=https://id.acme.example/realms/shop`, an
 *  optional `@namespace` word for people. */
export function sharedText(list: InfraPlacement["shared"]): string {
  return list
    .map((s) =>
      [s.service, ...(s.namespace ? [`@${s.namespace}`] : []), ...Object.entries(s.provides).map(([k, v]) => `${k}=${v}`)].join(
        " ",
      ),
    )
    .join("\n");
}

/** {@link sharedText} read back; a line without a service name is skipped. */
export function parseShared(text: string): InfraPlacement["shared"] {
  const out: InfraPlacement["shared"] = [];
  for (const line of text.split("\n")) {
    const [service, ...rest] = line.trim().split(/\s+/).filter(Boolean);
    if (!service) continue;
    const provides: Record<string, string> = {};
    let namespace: string | null = null;
    for (const w of rest) {
      if (w.startsWith("@")) namespace = w.slice(1) || null;
      else {
        const at = w.indexOf("=");
        if (at > 0) provides[w.slice(0, at)] = w.slice(at + 1);
      }
    }
    out.push({ service, namespace, provides });
  }
  return out;
}

/** The project's image records that came from `source`, newest first: what
 *  an import of a passport's image left in the project's path. */
export function importedFrom<T extends { source_ref?: string | null; digest: string; pushed_at: string }>(
  records: T[],
  source: string | null | undefined,
): T[] {
  if (!source) return [];
  const bare = (r: string) => r.replace(/^docker\.io\/(library\/)?/, "");
  return records
    .filter((r) => r.source_ref && bare(r.source_ref) === bare(source) && r.digest)
    .sort((a, b) => b.pushed_at.localeCompare(a.pushed_at));
}
