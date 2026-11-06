/* A product's infra services (ADR-0064): the third-party services its gears
 * need beside them -- PostgreSQL, Keycloak -- read from the catalogue's
 * `service.gdl` passports (`kind = "infra"`), added to the project, and
 * deployed with the product or read from the environment's shared place.
 *
 * Pure, so it is tested without a backend; infra-services-view.tsx draws it. */

import type {
  CatalogNode,
  InfraPassport,
  KeycloakRealm,
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
  return `${i.service}: ${INSTALL_WORDS[i.install]}${from ? ` (${from})` : ""}${i.route ? `, reached at ${i.route}` : ""}`;
}

/** The plan's refusals, the first of which stops a deploy. */
export function planRefusals(p: InfraPlan | null): string[] {
  return (p?.items ?? []).filter((i) => i.refusal).map((i) => `${i.refusal_code}: ${i.refusal}`);
}

/** What the plan says a deploy leaves undone, each with its service. */
export function planNotes(p: InfraPlan | null): string[] {
  return (p?.items ?? []).flatMap((i) => (i.notes ?? []).map((n) => `${i.service}: ${n}`));
}

/** What a deploy goes on with and says, with its code: an issuer pods
 *  cannot reach, a configuration secret the description wins over. */
export function planWarnings(p: InfraPlan | null): string[] {
  return [
    ...(p?.items ?? []).flatMap((i) => (i.warnings ?? []).map((w) => `${w.code}: ${w.message}`)),
    ...(p?.configuration ?? []).filter((c) => !c.refuses).map((c) => `${c.code}: ${c.message}`),
  ];
}

/** Every refusal of the plan: its services', then a configuration secret
 *  that contradicts the description, which refuses an install too. */
export function planAllRefusals(p: InfraPlan | null): string[] {
  return [...planRefusals(p), ...(p?.configuration ?? []).filter((c) => c.refuses).map((c) => `${c.code}: ${c.message}`)];
}

/* ── Files a service's container reads (ADR-0064, amended) ──────────────── */

/** As the backend: at most 20 files and 256 KiB together. */
export const MAX_FILES = 20;
export const MAX_FILES_BYTES = 256 * 1024;

/** Where stock Keycloak imports realms from with `--import-realm`. */
export const KEYCLOAK_IMPORT_DIR = "/opt/keycloak/data/import";

/** What is wrong with a service's files, as the backend checks them: each
 *  path absolute without `.`, `..` or empty names; the size together. */
export function fileProblems(files: Record<string, string>): string[] {
  const out: string[] = [];
  const entries = Object.entries(files);
  if (entries.length > MAX_FILES) out.push(`at most ${MAX_FILES} files`);
  for (const [path] of entries) {
    const names = path.slice(1).split("/");
    if (!path.startsWith("/") || path.length < 2 || names.some((n) => n === "" || n === "." || n === ".."))
      out.push(`"${path}" is not an absolute path in the container (/…, no ..)`);
  }
  const size = entries.reduce((n, [k, v]) => n + new TextEncoder().encode(k).length + new TextEncoder().encode(v).length, 0);
  if (size > MAX_FILES_BYTES) out.push(`the files are ${size} bytes together; at most ${MAX_FILES_BYTES}`);
  return out;
}

/** The realm a passport's issuer names: `{public_url}/realms/product` is
 *  `product`. */
export function realmNameOf(p: Pick<InfraPassport, "provides">): string {
  return p.provides["oidc.issuer"]?.match(/\/realms\/([^/{}?#\s]+)/)?.[1] ?? "product";
}

/** `s`'s files and arguments with the realm the server made added: its
 *  file, and `--import-realm` once. The realm itself is the server's
 *  (`GET /infra-services/{name}/keycloak-realm`, the MCP tool
 *  `infra_keycloak_realm`): a client for each gear that signs in, wired to
 *  the secret it reads, and the root tenant on every confidential one. */
export function withRealmFile(
  s: Pick<InfraService, "files" | "args">,
  realm: Pick<KeycloakRealm, "path" | "content" | "args">,
): { files: Record<string, string>; args: string[] } {
  const args = [...(s.args ?? [])];
  for (const a of realm.args) if (!args.includes(a)) args.push(a);
  return { files: { ...(s.files ?? {}), [realm.path]: realm.content }, args };
}

/** The realm's clients in words: `product-portal (public), mini-chat (mini-chat's, {env.MINI_CHAT_CLIENT_SECRET})`. */
export function realmClientsText(realm: Pick<KeycloakRealm, "clients">): string {
  return realm.clients
    .map((c) => `${c.client_id} (${c.gear ? `${c.gear}'s` : c.kind}${c.secret ? `, secret ${c.secret}` : ""})`)
    .join(", ");
}

/** Is `p` a Keycloak: it gives an issuer, or is named so. */
export function isKeycloak(p: Pick<InfraPassport, "name" | "provides">): boolean {
  return p.name === "keycloak" || "keycloak.admin_url" in p.provides;
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

/* ── The Product › Infrastructure editor ─────────────────────────────────── */

/** The engine's needs a passport meets, by what it provides: Keycloak meets
 *  `oidc` and `keycloak`. In the order of {@link NEED_CAPABILITY}. */
export function needsMet(p: Pick<InfraPassport, "provides">): string[] {
  return Object.entries(NEED_CAPABILITY)
    .filter(([, capability]) => capability in p.provides)
    .map(([need]) => need);
}

/** A catalogue passport the project could add, and what adding it does. */
export interface InfraOffer {
  passport: InfraPassport;
  /** Every need it meets: "oidc", "keycloak". */
  meets: string[];
  /** Of those, the ones the product needs and nothing of the project meets. */
  unmet: string[];
  /** The project's services it would take the place of: no two may provide
   *  the same capability (ADR-0064 §2). */
  replaces: string[];
}

/** The project's services that provide one of `p`'s capabilities. */
function clashes(services: readonly InfraService[], p: InfraPassport): InfraService[] {
  const caps = Object.keys(p.provides);
  return services.filter((s) => s.passport.name !== p.name && caps.some((c) => c in s.passport.provides));
}

/** The catalogue's passports the project has not added: those meeting a need
 *  nothing meets yet first, then those meeting any need, then by name. */
export function offersFor(
  offered: readonly InfraPassport[],
  services: readonly InfraService[],
  needs: readonly ProductTechnology[] | null,
): InfraOffer[] {
  const met = new Set(services.flatMap((s) => needsMet(s.passport)));
  const wanted = new Set((needs ?? []).map((n) => n.id));
  return offered
    .filter((p) => !services.some((s) => s.passport.name === p.name))
    .map((p): InfraOffer => {
      const meets = needsMet(p);
      return {
        passport: p,
        meets,
        unmet: meets.filter((n) => wanted.has(n) && !met.has(n)),
        replaces: clashes(services, p).map((s) => s.passport.name),
      };
    })
    .sort(
      (a, b) =>
        b.unmet.length - a.unmet.length || b.meets.length - a.meets.length || a.passport.name.localeCompare(b.passport.name),
    );
}

/** The passports that could meet `need`: the project's own first, then the
 *  catalogue's, each name once. */
export function candidatesFor(
  need: Pick<ProductTechnology, "id">,
  services: readonly InfraService[],
  offered: readonly InfraPassport[],
): InfraPassport[] {
  const capability = NEED_CAPABILITY[need.id];
  if (!capability) return [];
  const out: InfraPassport[] = [];
  for (const p of [...services.map((s) => s.passport), ...offered])
    if (capability in p.provides && !out.some((x) => x.name === p.name)) out.push(p);
  return out;
}

/** The list with `p` added as a new service. The services it clashes with
 *  go, since the backend refuses two that provide the same capability: this
 *  is how a member picks which service meets a need. */
export function withService(list: readonly InfraService[], p: InfraPassport): { next: InfraService[]; dropped: string[] } {
  if (list.some((s) => s.passport.name === p.name)) return { next: [...list], dropped: [] };
  const gone = clashes(list, p).map((s) => s.passport.name);
  return { next: [...list.filter((s) => !gone.includes(s.passport.name)), serviceFrom(p)], dropped: gone };
}

/** The list without the service `name`. */
export function withoutService(list: readonly InfraService[], name: string): InfraService[] {
  return list.filter((s) => s.passport.name !== name);
}

/** The list with `patch` over the service `name`: every field it does not
 *  name is kept as it was, the passport always. */
export function patchService(
  list: readonly InfraService[],
  name: string,
  patch: Partial<Omit<InfraService, "passport">>,
): InfraService[] {
  return list.map((s) => (s.passport.name === name ? { ...s, ...patch, passport: s.passport } : s));
}

/** The list with `patch` over the passport of the service `name` -- the
 *  product's choices of it (its publisher image, its literal config); every
 *  other field of the service and its passport is kept. */
export function patchPassport(list: readonly InfraService[], name: string, patch: Partial<InfraPassport>): InfraService[] {
  return list.map((s) => (s.passport.name === name ? { ...s, passport: { ...s.passport, ...patch, name: s.passport.name } } : s));
}

/** The needs nothing of the project would meet once `name` goes. A database
 *  need is then met by the environment's own Postgres, as before. */
export function unmetWithout(
  needs: readonly ProductTechnology[] | null,
  services: readonly InfraService[],
  name: string,
): ProductTechnology[] {
  const gone = services.find((s) => s.passport.name === name);
  if (!gone) return [];
  const before = new Set(needsMet(gone.passport));
  const after = new Set(withoutService(services, name).flatMap((s) => needsMet(s.passport)));
  return (needs ?? []).filter((n) => before.has(n.id) && !after.has(n.id));
}

/** One environment's answer to one need. */
export interface NeedWhere {
  environment: string;
  text: string;
  tone: "ok" | "warn" | "danger";
}

/** One need of the gears, joined with what meets it and what each
 *  environment's plan does about it. */
export interface NeedRow {
  need: ProductTechnology;
  capability: string | null;
  /** The project's service that meets it. */
  service: InfraService | null;
  /** The catalogue's service that would, when the project has none. */
  offer: InfraPassport | null;
  /** Every passport that could: more than one is a choice. */
  candidates: InfraPassport[];
  /** `service`: a project service; `database`: the environment's own
   *  Postgres; `outside`: nothing Studio deploys meets it. */
  met: "service" | "database" | "outside";
  where: NeedWhere[];
}

/** {@link bindNeeds}, with what each environment does about the need: its
 *  plan's item for the service, its database, or nothing. `environments`
 *  are `infrastructureOf`'s `runsIn`. */
export function needRows(
  needs: readonly ProductTechnology[],
  services: readonly InfraService[],
  offered: readonly InfraPassport[],
  plans: readonly InfraPlan[],
  environments: readonly { environment: string; database: string; missing: string[] }[],
): NeedRow[] {
  return bindNeeds([...needs], [...services], [...offered]).map((b): NeedRow => {
    const met = b.service ? "service" : b.need.id === "postgres" ? "database" : "outside";
    const name = b.service?.passport.name;
    const where: NeedWhere[] = name
      ? plans.map((plan): NeedWhere => {
          const item = plan.items.find((i) => i.service === name);
          if (!item) return { environment: plan.environment_name, text: "not in its plan", tone: "warn" };
          return item.refusal
            ? { environment: plan.environment_name, text: `${item.refusal_code}: ${item.refusal}`, tone: "danger" }
            : { environment: plan.environment_name, text: planItemText(item), tone: "ok" };
        })
      : environments.map(
          (e): NeedWhere =>
            met === "database"
              ? { environment: e.environment, text: e.database, tone: e.missing.includes("PostgreSQL") ? "danger" : "ok" }
              : { environment: e.environment, text: "not provided: set where it runs in the gear's settings", tone: "warn" },
        );
    return { ...b, candidates: candidatesFor(b.need, services, offered), met, where };
  });
}

/** A configuration field of a gear that holds a capability's value. `[]`
 *  marks a list: `jwt.trusted_issuers[].issuer`. */
export interface CapabilityRead {
  /** The gear's key (`gearKey`): `oidc-authn-plugin`. */
  gear: string;
  field: string;
}

/** Where the platform's gears hold each capability, as their config structs
 *  say (gears-rust). The engine says which gears need a technology, not the
 *  field; until gear.gdl says it, the fields are kept here. */
export const CAPABILITY_READS: Record<string, CapabilityRead[]> = {
  "oidc.issuer": [
    { gear: "oidc-authn-plugin", field: "jwt.trusted_issuers[].issuer" },
    { gear: "oidc-authn-plugin", field: "s2s_oauth.discovery_url" },
  ],
  "keycloak.admin_url": [{ gear: "keycloak-idp-plugin", field: "keycloak.base_url" }],
};

/** The variable the gear runtime's environment layer reads a config field
 *  from: `oidc-authn-plugin`, `s2s_oauth.discovery_url` ->
 *  `APP__GEARS__OIDC_AUTHN_PLUGIN__CONFIG__S2S_OAUTH__DISCOVERY_URL`. `null`
 *  for a field inside a list, which no variable addresses. */
export function configVariable(gear: string, field: string): string | null {
  if (field.includes("[]")) return null;
  const up = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  return ["APP", "GEARS", up(gear), "CONFIG", ...field.split(".").map(up)].join("__");
}

/** The values at `field` in a configuration: one, or one per list item. */
export function valuesAt(config: unknown, field: string): unknown[] {
  let at: unknown[] = [config];
  for (const part of field.split(".")) {
    const list = part.endsWith("[]");
    const key = list ? part.slice(0, -2) : part;
    at = at.flatMap((v) => {
      const x = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[key] : undefined;
      return list ? (Array.isArray(x) ? x : []) : x === undefined || x === null ? [] : [x];
    });
  }
  return at;
}

/** Every string field of a configuration that names `${VARIABLE}`, dotted
 *  (`[]` for a list). */
export function fieldsNaming(config: unknown, variable: string, at = ""): string[] {
  const needle = `\${${variable}}`;
  if (typeof config === "string") return config.includes(needle) ? [at] : [];
  if (Array.isArray(config)) return [...new Set(config.flatMap((v) => fieldsNaming(v, variable, `${at}[]`)))];
  if (config && typeof config === "object")
    return Object.entries(config as Record<string, unknown>).flatMap(([k, v]) => fieldsNaming(v, variable, at ? `${at}.${k}` : k));
  return [];
}

/** One link from an infra service to a gear: a capability it provides, a
 *  gear that needs it, and the field that holds it. */
export interface LinkRow {
  capability: string;
  variable: string;
  /** The project's service providing it; null: a need nothing provides. */
  service: string | null;
  /** The engine's need it meets, when it is one. */
  need: string | null;
  /** The gear, as the engine names it; null: no gear needs it. */
  gear: string | null;
  /** Every gear the row is about: the one `gear`, or each gear the database
   *  step wires. */
  gears: string[];
  /** The field holding it; null: not known which. */
  field: string | null;
  /** What the configuration has there now. */
  value: string | null;
  /** `reference`: the field names `${VARIABLE}`; `literal`: a value set by
   *  hand, which does not follow the service; `unset`; `database`: wired by
   *  the database step; `unknown`: no field known. */
  state: "reference" | "literal" | "unset" | "database" | "unknown";
  /** The variable a deploy would set for the field, when one can. */
  env: string | null;
}

const shownValues = (vs: unknown[]): string | null =>
  vs.length === 0 ? null : vs.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ");

/** The links between the project's infra services and its gears, need by
 *  need, then every other capability a service provides. `configOf` reads a
 *  gear's configuration by its key, `keyOf` makes that key (`gearKey`). */
export function linkRows(
  needs: readonly ProductTechnology[],
  services: readonly InfraService[],
  configOf: (key: string) => Record<string, unknown>,
  keyOf: (gear: string) => string,
): LinkRow[] {
  const out: LinkRow[] = [];
  const provider = (cap: string) => services.find((s) => cap in s.passport.provides)?.passport.name ?? null;
  const seen = new Set<string>();
  for (const need of needs) {
    const capability = NEED_CAPABILITY[need.id];
    if (!capability) continue;
    seen.add(capability);
    const variable = variableOf(capability);
    const service = provider(capability);
    // The database step wires every gear that keeps data the same way: one
    // row for them all, with the gears listed.
    if (need.id === "postgres") {
      out.push({
        capability,
        variable,
        service,
        need: need.id,
        gear: need.gears[0] ?? null,
        gears: need.gears,
        field: "database",
        value: null,
        state: "database",
        env: null,
      });
      continue;
    }
    for (const gear of need.gears) {
      const key = keyOf(gear);
      const base = { capability, variable, service, need: need.id, gear, gears: [gear] };
      const config = configOf(key);
      const fields = [
        ...(CAPABILITY_READS[capability] ?? []).filter((r) => r.gear === key).map((r) => r.field),
        ...fieldsNaming(config, variable),
      ].filter((f, i, all) => all.indexOf(f) === i);
      if (fields.length === 0) out.push({ ...base, field: null, value: null, state: "unknown", env: null });
      for (const field of fields) {
        const values = valuesAt(config, field);
        const value = shownValues(values);
        const named = values.some((v) => typeof v === "string" && v.includes(`\${${variable}}`));
        out.push({
          ...base,
          field,
          value,
          state: named ? "reference" : value === null ? "unset" : "literal",
          env: configVariable(key, field),
        });
      }
    }
  }
  for (const s of services)
    for (const capability of Object.keys(s.passport.provides).sort()) {
      if (seen.has(capability)) continue;
      seen.add(capability);
      out.push({
        capability,
        variable: variableOf(capability),
        service: s.passport.name,
        need: null,
        gear: null,
        gears: [],
        field: null,
        value: null,
        state: "unknown",
        env: null,
      });
    }
  return out;
}

/** The environment's copy of the publisher's image: the newest import of
 *  `source` that landed under the environment's registry `prefix`
 *  (`ghcr.io/acme`), by digest. Null: not imported there. The import itself
 *  is the environment's business (Releases › Images), not the product's. */
export function mirrorIn<
  T extends { source_ref?: string | null; digest: string; pushed_at: string; registry_host: string; repository: string; state: string },
>(records: T[], source: string | null | undefined, prefix: string): T | null {
  const root = prefix.trim().replace(/\/+$/, "");
  if (!root) return null;
  return (
    importedFrom(records, source).find((r) => r.state === "present" && `${r.registry_host}/${r.repository}`.startsWith(`${root}/`)) ??
    null
  );
}

/** A gear's configuration with `field` reading `${VARIABLE}`: the link from
 *  a capability to the field, as product.gdl will say it. A field in a list
 *  (`jwt.trusted_issuers[].issuer`) is set in every item, and in a first one
 *  when the list is empty. The configuration given is not changed. */
export function linkedConfig(config: Record<string, unknown>, field: string, variable: string): Record<string, unknown> {
  const ref = `\${${variable}}`;
  const set = (at: unknown, parts: string[]): unknown => {
    const [part, ...rest] = parts;
    const list = part.endsWith("[]");
    const key = list ? part.slice(0, -2) : part;
    const obj = at && typeof at === "object" && !Array.isArray(at) ? { ...(at as Record<string, unknown>) } : {};
    if (!list) {
      obj[key] = rest.length ? set(obj[key], rest) : ref;
      return obj;
    }
    const items = Array.isArray(obj[key]) && (obj[key] as unknown[]).length ? (obj[key] as unknown[]) : [{}];
    obj[key] = items.map((item) => (rest.length ? set(item, rest) : ref));
    return obj;
  };
  return set(config, field.split(".")) as Record<string, unknown>;
}

/** A passport's literal config as the editor writes it: `KEY=value` lines. */
export function configLines(config: Record<string, string>): string {
  return Object.entries(config)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** {@link configLines} read back, with what is wrong with it: a line
 *  without `=`, a key that is not an environment variable name, a key the
 *  passport keeps as a secret. */
export function parseConfigLines(text: string, secrets: readonly string[]): { config: Record<string, string>; problems: string[] } {
  const config: Record<string, string> = {};
  const problems: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf("=");
    const key = at > 0 ? line.slice(0, at).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) problems.push(`"${line}" is not KEY=value`);
    else if (secrets.includes(key)) problems.push(`${key} is a secret: the environment keeps it`);
    else config[key] = line.slice(at + 1).trim();
  }
  return { config, problems };
}

/* ── One table: what runs beside the gears ───────────────────────────────── */

/** One environment of one row, as a small pill: `dev ✓ with the product`. */
export interface EnvPill {
  environment: string;
  tone: "ok" | "warn" | "danger";
  /** The pill's words, short. */
  text: string;
  /** The whole of it, for the expanded row and the pill's title. */
  detail: string;
}

/** One thing that runs beside the gears: the environment's own Postgres, or
 *  one of the project's infra services. */
export interface InfraRow {
  /** `database`, or the service's name. */
  id: string;
  kind: "database" | "service";
  name: string;
  version: string | null;
  description: string | null;
  /** The needs it meets (`oidc`, `keycloak`, `postgres`); a service that
   *  meets none says its capabilities. */
  gives: string[];
  /** The gears that need what it gives, each once. */
  usedBy: string[];
  service: InfraService | null;
  envs: EnvPill[];
  /** Its links to gear fields: only rows about a gear. */
  links: LinkRow[];
}

/** The environments a row is shown in: `id` and `name` from the target,
 *  `registry` its prefix, `database`/`missing` from `infrastructureOf`. */
export interface RowEnvironment {
  id: string;
  name: string;
  registry: string;
  database: string;
  missing: string[];
}

const REFUSAL_WORDS: Record<string, string> = {
  INFRA_IMAGE_NOT_IMPORTED: "no copy yet",
  IMAGE_NOT_IN_PROJECT_PATH: "copy outside the project",
  INFRA_NOT_IN_SHARED_PLACE: "not in the shared place",
  INFRA_PUBLIC_URL_MISSING: "no public address",
  INFRA_ISSUER_NOT_HTTPS: "issuer not https",
};

const WARNING_WORDS: Record<string, string> = {
  INFRA_ISSUER_UNREACHABLE_IN_CLUSTER: "pods cannot reach it",
};

/** How one service comes in one environment, as its plan says. */
export function servicePill(env: Pick<RowEnvironment, "name">, item: InfraPlanItem | null | undefined): EnvPill {
  if (!item) return { environment: env.name, tone: "warn", text: `${env.name} ⚠ not planned`, detail: "its plan does not name it yet" };
  if (item.refusal)
    return {
      environment: env.name,
      tone: "danger",
      text: `${env.name} ⚠ ${REFUSAL_WORDS[item.refusal_code ?? ""] ?? "refused"}`,
      detail: `${item.refusal_code}: ${item.refusal}`,
    };
  const warnings = item.warnings ?? [];
  if (warnings.length)
    return {
      environment: env.name,
      tone: "warn",
      text: `${env.name} ⚠ ${WARNING_WORDS[warnings[0].code] ?? "warning"}`,
      detail: [INSTALL_WORDS[item.install], ...warnings.map((w) => `${w.code}: ${w.message}`)].join("; "),
    };
  return {
    environment: env.name,
    tone: "ok",
    text: `${env.name} ✓ ${item.placement === "shared" ? "shared place" : "with the product"}`,
    // Without the image's reference: the digest is the environment's copy.
    detail: [INSTALL_WORDS[item.install], ...(item.route ? [`reached at ${item.route}`] : []), ...(item.notes ?? [])].join("; "),
  };
}

/** The rows of the Infrastructure table: the environment's own Postgres
 *  first, while the gears need a database and no service gives one; then
 *  the project's services, in their order. `links` is {@link linkRows}'s. */
export function infraRows(
  needs: readonly ProductTechnology[],
  services: readonly InfraService[],
  plans: readonly InfraPlan[],
  environments: readonly RowEnvironment[],
  links: readonly LinkRow[],
): InfraRow[] {
  const out: InfraRow[] = [];
  const pg = needs.find((n) => n.id === "postgres");
  if (pg && !services.some((s) => needsMet(s.passport).includes("postgres")))
    out.push({
      id: "database",
      kind: "database",
      name: "PostgreSQL",
      version: null,
      description: "The environment's own database: one per environment, with each deploy",
      gives: ["postgres"],
      usedBy: pg.gears,
      service: null,
      envs: environments.map((e) =>
        e.missing.includes("PostgreSQL")
          ? { environment: e.name, tone: "danger", text: `${e.name} ⚠ no database`, detail: e.database }
          : { environment: e.name, tone: "ok", text: `${e.name} ✓ with the product`, detail: e.database },
      ),
      links: links.filter((l) => l.need === "postgres" && l.gear),
    });
  for (const s of services) {
    const name = s.passport.name;
    const meets = needsMet(s.passport);
    out.push({
      id: name,
      kind: "service",
      name,
      version: s.passport.version ?? null,
      description: s.passport.description ?? null,
      gives: meets.length ? meets : Object.keys(s.passport.provides).sort(),
      usedBy: [...new Set(needs.filter((n) => meets.includes(n.id)).flatMap((n) => n.gears))],
      service: s,
      envs: environments.map((e) =>
        servicePill(
          e,
          plans.find((p) => p.environment_id === e.id)?.items.find((i) => i.service === name),
        ),
      ),
      links: links.filter((l) => l.service === name && l.gear),
    });
  }
  return out;
}

/** The needs nothing meets, each with the catalogue's service that would:
 *  the warning line above the table. */
export function unmetNeeds(rows: readonly NeedRow[]): { need: ProductTechnology; offer: InfraPassport | null }[] {
  return rows.filter((r) => r.met === "outside").map((r) => ({ need: r.need, offer: r.offer }));
}
