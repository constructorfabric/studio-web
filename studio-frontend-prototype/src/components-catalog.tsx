import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "./api";
import type { ComponentSource, ComponentValues, CatalogNode, Connection, FieldSchema, StudioKit } from "./api";
import { errText } from "./format";
import { fieldTrend, type ComponentSnapshot, type FieldTrend } from "./field-trend";
import { readinessOf } from "./readiness";
import { responsibilityOf } from "./responsibility";
import { reviewCounts, reviewOf, type ReviewPart } from "./review-summary";
import { RoadmapReportDialog } from "./roadmap-report-view";
import { useViewMode } from "./view-mode";
import { URL_CHANGE_EVENT, useListState } from "./list-state";
import { DataTable } from "./data-table";
import type { Column } from "./data-table";
import {
  ACTIVITY_CSS,
  ACTIVITY_WINDOWS,
  ActivityTiles,
  ChurnChart,
  MiniChurn,
  PullRequestTiles,
  compact,
  useGearActivity,
} from "./gear-activity";
import type { ActivityIndex, GearActivity } from "./gear-activity";
import {
  COMPONENT_KIND_LABELS,
  componentExcluded,
  componentKind,
  inKindFilter,
  kindChips,
  syncedSources,
} from "./component-kinds";
import type { KindChip } from "./component-kinds";

/* ============================================================================
 * Platform Gears — a schema-driven component page per Gear, in Constructor
 * Studio styling, on live data from the studio-components-catalog gear (crates.io →
 * graph) plus an editable, Studio-owned profile.
 *
 * The field model, groups, lamps, sources and composition are the same
 * schema.json the static gears-catalog playground argues over
 * (product/gear-engineering-focus/gears-catalog). crates.io fills what it can;
 * the profile fills the rest; an empty cell is the finding, not an omission.
 * ==========================================================================*/

// ── schema types ────────────────────────────────────────────────────────────

/* The presentation of a component type -- which fields its page shows, grouped,
 * and where each is read from -- is served by studio-components-catalog and
 * stored in graph-storage beside the type it describes. It used to be a JSON
 * file compiled into this bundle, which meant a micro-frontend rendered against
 * the gear schema (sixty-two fields, eleven ever filled) and no workspace could
 * change either without a release.
 *
 * The types below are the client's view of that payload; `api.ts` holds the
 * wire shape. */

type Kind = "text" | "label" | "docstate" | "bool" | "metric" | "status";
type SourceClass = "repo" | "api" | "manual" | "none";
type Lamp = "good" | "watch" | "bad" | "grey";

interface Field {
  key: string;
  label: string;
  kind: Kind;
  lamp: boolean;
  source: { class: SourceClass; ref: string };
  example?: string;
  domain?: Record<string, unknown>;
}
interface Group {
  id: string;
  title: string;
  icon: string;
  fields: Field[];
}
interface CompositionPart {
  key: string;
  label: string;
  color: string;
}
interface Schema {
  groups: Group[];
  composition: CompositionPart[];
  statusLegend: Record<string, string>;
  docStateLegend: Record<string, string>;
  sourceClasses: Record<string, { label: string; hint: string }>;
}

/** Every schema this tenant has, by the type it describes. */
type Schemas = Record<string, Schema>;

/** What a page renders against when the catalogue has not answered yet, or
 *  answered with nothing for this type and no gear schema to fall back on.
 *
 *  Empty rather than invented: a page with no fields says plainly that nothing
 *  describes this type, where a guessed set of fields would look like findings.
 */
const EMPTY_SCHEMA: Schema = {
  groups: [],
  composition: [],
  statusLegend: {},
  docStateLegend: {},
  sourceClasses: {},
};

/** The component types this page still names.
 *
 *  Three, where there were four: a type no longer needs naming here just to be
 *  rendered, because the schema that renders it arrives keyed by its id. What
 *  is left is the fallback below and the two node kinds this page synthesises
 *  from other gears' data. */
const GEAR_TYPE = "gts.cf.studio.catalog.gear.v1~";
/** The kit node type, as the backend registers it. Named here so the
 *  synthesised built-ins and the synced nodes cannot drift apart into two
 *  types that render as two rows in the type picker. */
const KIT_TYPE = "gts.cf.studio.catalog.kit.v1~";

/** The presentation for one component type.
 *
 *  Keyed by GTS type, because that is what a component type IS. A type with no
 *  schema of its own falls back to the gear schema, which is the only honest
 *  default: it is the one that describes a crate, and a type nobody has
 *  described is more likely to be a new crate-shaped thing than a new shape. */
function schemaFor(schemas: Schemas, typeId: string): Schema {
  return schemas[typeId] ?? schemas[GEAR_TYPE] ?? EMPTY_SCHEMA;
}

/** The served payload as this screen consumes it. The server sends `describes`
 *  and `owner` alongside; the first becomes the key, the second is not
 *  something the rendering needs. */
function indexSchemas(served: FieldSchema[]): Schemas {
  const out: Schemas = {};
  for (const s of served) {
    if (s?.describes) out[s.describes] = s as unknown as Schema;
  }
  return out;
}

/** One field's answer for one gear: full text, brief, number, lamp, link, when. */
interface FieldVal {
  v?: string;
  b?: string;
  n?: number;
  s?: "good" | "watch" | "bad" | "none";
  l?: string;
  u?: string;
}
type Values = Record<string, FieldVal | null>;

type View = "empty" | "filled" | "sources";

/* ── where a component's fields come from ────────────────────────────────────
 *
 * Reconciling the three sources — what crates.io published, what the
 * repository scan read, what a person set — used to happen here, per row, on
 * every render. It lives in `components_catalog/values.rs` now and arrives
 * through `GET /studio-components-catalog/v1/component-values`, so a second
 * portal inherits the precedence instead of working it out again.
 *
 * The one reading still made here is the licence fallback in the detail view,
 * which is the only place that fetches the version list.
 */

/** The newest non-yanked version that declares a licence — a fallback for the
 *  Licence field when the gear node predates the parser change that surfaces
 *  it. Stays here because `versions` is fetched by the detail view alone. */
function licenceFromVersions(rows: CatalogNode[] | null): string | null {
  if (!rows) return null;
  const hit = rows.find((v) => !v.value.yanked && typeof v.value.license === "string" && v.value.license);
  return hit ? String(hit.value.license) : null;
}

// ── lamps ────────────────────────────────────────────────────────────────────

const LAMP_MAP: Record<string, Lamp> = { good: "good", watch: "watch", bad: "bad", none: "grey" };
const RANK: Record<Lamp, number> = { bad: 3, watch: 2, good: 1, grey: 0 };

function lampOf(field: Field, values: Values): Lamp | null {
  if (!field.lamp) return null;
  const raw = values[field.key];
  if (!raw) return "grey";
  return LAMP_MAP[raw.s ?? "good"] ?? "good";
}

/** Each component's earliest snapshot in the window: what "since" compares with. */
interface Baselines {
  status: "off" | "loading" | "ready" | "error";
  byName: Map<string, ComponentSnapshot>;
}

function useComponentBaselines(token: string, days: number): Baselines {
  const [state, setState] = useState<Baselines>({ status: "off", byName: new Map() });
  useEffect(() => {
    if (!token) {
      setState({ status: "off", byName: new Map() });
      return;
    }
    let live = true;
    setState((cur) => ({ ...cur, status: "loading" }));
    api
      .componentHistory(token, days)
      .then((page) => {
        if (live) setState({ status: "ready", byName: new Map(page.items.map((s) => [s.component, s])) });
      })
      // A backend without the history route: the page has no "since" to show,
      // and says nothing rather than an error about a feature it lacks.
      .catch(() => {
        if (live) setState({ status: "error", byName: new Map() });
      });
    return () => {
      live = false;
    };
  }, [token, days]);
  return state;
}

function groupHealth(group: Group, values: Values) {
  const counts: Record<Lamp, number> = { good: 0, watch: 0, bad: 0, grey: 0 };
  let worst: Lamp | null = null;
  let n = 0;
  for (const f of group.fields) {
    const l = lampOf(f, values);
    if (!l) continue;
    n++;
    counts[l]++;
    if (worst === null || RANK[l] > RANK[worst]) worst = l;
  }
  return { counts, worst, n };
}

// ── small helpers ────────────────────────────────────────────────────────────

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function whenLabel(u: string | undefined): string {
  if (!u) return "";
  const [, m, d] = u.split("-");
  if (!m || !d) return "";
  return `${d} ${MON[+m - 1] ?? ""}`;
}
function numText(n: unknown): string {
  return typeof n === "number" ? n.toLocaleString("en-US") : "—";
}
function dateText(s: unknown): string {
  if (typeof s !== "string" || !s) return "—";
  const dd = new Date(s);
  return Number.isNaN(dd.getTime()) ? "—" : dd.toISOString().slice(0, 10);
}
function sizeText(n: unknown): string {
  if (typeof n !== "number") return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── component ────────────────────────────────────────────────────────────────

// ── source selection ─────────────────────────────────────────────────────────

/** One repository source: a connection + repo + ref. */
interface RepoSel {
  enabled: boolean;
  connectionId: string;
  repo: string;
  gitRef: string;
}

/** Where the Components page pulls from: the platform Gears repository, the
 *  FrontX micro-frontends repository, a kit repository (each via a connector),
 *  and/or crates.io. At least one should be enabled.
 *
 *  A kit repository is a source like any other because a kit is a component
 *  like any other. The registry's built-in list is a hardcoded function with a
 *  single entry; a repository source is how a catalogue gets a second one
 *  without shipping a release. */
interface Sources {
  cratesIo: boolean;
  keyword: string;
  gears: RepoSel;
  frontx: RepoSel;
  kits: RepoSel;
  kitsPm: RepoSel;
}

/** The branches worth one click. `HEAD` is the repository's default branch —
 *  which is not the same as `main` on every repository, so it stays a distinct
 *  choice rather than an alias for one. Anything else (a tag, a commit, a
 *  release branch) goes in through "Other…". */
const BRANCH_CHOICES: { value: string; label: string }[] = [
  { value: "HEAD", label: "HEAD (default branch)" },
  { value: "main", label: "main" },
  { value: "develop", label: "develop" },
];
/** Sentinel for the select's "Other…" entry. `~` is forbidden in a git ref
 *  name, so this can never collide with a real branch. */
const CUSTOM_BRANCH = "~custom";

const DEFAULT_SOURCES: Sources = {
  cratesIo: true,
  keyword: "constructorfabric",
  gears: { enabled: false, connectionId: "", repo: "constructorfabric/gears-rust", gitRef: "HEAD" },
  // FrontX is developed on `develop` — the templates this frontend was
  // scaffolded from are pinned to it (see studio-frontend/.frontx/provenance.json),
  // so reading `HEAD` there shows a catalogue behind the one people work in.
  frontx: {
    enabled: false,
    connectionId: "",
    repo: "constructorfabric/gears-frontx",
    gitRef: "develop",
  },
  // The one kit the registry ships, as the default target: a repository whose
  // root holds a `.cf-studio-kit.toml`. Pointed at a monorepo the scan finds
  // every manifest in it, so this is a starting point and not a limit.
  kits: {
    enabled: false,
    connectionId: "",
    repo: "constructorfabric/studio-kit-sdlc",
    gitRef: "HEAD",
  },
  // The second kit repository, and the reason the field above is not the only
  // one: `studio-kits-pm` is a MULTI-kit repository -- its root manifest holds
  // one `[[kits]]` entry per kit -- so "a kit source" is a repository to scan,
  // not a kit. Whatever it grows, the scan finds.
  kitsPm: {
    enabled: false,
    connectionId: "",
    repo: "constructorfabric/studio-kits-pm",
    gitRef: "HEAD",
  },
};

const SOURCES_KEY = "cf.components.sources";

function loadSources(): Sources {
  try {
    const raw = localStorage.getItem(SOURCES_KEY);
    if (raw) return { ...DEFAULT_SOURCES, ...(JSON.parse(raw) as Partial<Sources>) };
  } catch {
    /* private mode / no storage — fall back to defaults */
  }
  return DEFAULT_SOURCES;
}

function saveSources(s: Sources) {
  try {
    localStorage.setItem(SOURCES_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

interface RepoBody {
  tenant: string;
  connection_id: string | null;
  repo: string;
  git_ref: string | null;
  mode: string;
}

/** The POST body for /sync derived from the selection, or an error string. */
function syncBody(
  s: Sources,
  tenantId: string | undefined,
): { crates_io: string | null; repositories: RepoBody[] } | string {
  const crates_io = s.cratesIo ? s.keyword.trim() || "constructorfabric" : null;
  const repositories: RepoBody[] = [];
  const pairs: [string, RepoSel][] = [
    ["gears", s.gears],
    ["frontx", s.frontx],
    ["kits", s.kits],
    ["kits", s.kitsPm],
  ];
  for (const [mode, sel] of pairs) {
    if (!sel.enabled) continue;
    if (!tenantId) return "No workspace/organization in context to read connections from.";
    if (!sel.repo.trim()) return `Enter the ${mode} repository (owner/name).`;
    repositories.push({
      tenant: tenantId,
      connection_id: sel.connectionId || null,
      repo: sel.repo.trim(),
      git_ref: sel.gitRef.trim() || null,
      mode,
    });
  }
  if (!crates_io && repositories.length === 0) return "Enable at least one source.";
  return { crates_io, repositories };
}






/** A kit as a catalogue node.
 *
 *  A kit IS a component: a named, versioned, published thing a project takes
 *  from the shared list. It sat in a list of its own only because it reaches
 *  the portal through a different gear, and that made the catalogue look like
 *  it did not contain half of what a project can install.
 *
 *  The mapping fills what the catalogue renders and stays silent where a kit
 *  has nothing to give: no download counts, no crate versions. Inventing zeroes
 *  would sort kits against gears on a number that means nothing.
 */
function kitAsNode(kit: StudioKit): CatalogNode {
  return {
    type_id: KIT_TYPE,
    instance_id: `kit:${kit.slug}`,
    value: {
      name: kit.slug,
      kind: "kit",
      description: kit.description,
      max_version: kit.default_version,
      newest_version: kit.default_version,
      repository: kit.repository_url || null,
      keywords: [kit.publisher, kit.visibility].filter(Boolean),
      categories: ["kit"],
    },
  };
}

export function ComponentsCatalog({
  token,
  tenantId,
  onCategories,
  focus = null,
}: {
  token: string;
  tenantId?: string;
  /** The shell's filter rail. Not read: the catalogue's search, kind,
   *  category, SDK switch and sort are its own, above the list and in the
   *  address (docs/list-standard.md). */
  query?: string;
  kindFilter?: string;
  sortMode?: "name-asc" | "name-desc" | "downloads-desc";
  hideSdk?: boolean;
  categoryFilter?: string;
  onCategories?: (cats: string[]) => void;
  /** A component page to open on, asked for from outside the catalogue (a
   *  project's product links here). */
  focus?: { name: string; at: number } | null;
}) {
  const [gears, setGears] = useState<CatalogNode[] | null>(null);
  const [profiles, setProfiles] = useState<Record<string, Record<string, unknown>>>({});
  /** Each component's fields with its three sources reconciled, by the gear
   *  that owns the precedence. The raw profiles above are still read, because
   *  the editor writes them — this is what the table reads. */
  const [resolved, setResolved] = useState<Record<string, ComponentValues>>({});
  const [selected, setSelected] = useSelectedComponent(focus?.name ?? null);
  useEffect(() => {
    if (focus) setSelected(focus.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  const [list, listCtl] = useListState();
  const query = list.q;
  const categoryFilter = list.filters.category ?? "";
  const hideSdk = list.filters.sdk === "hide";
  const sortMode: "name-asc" | "name-desc" | "downloads-desc" | "downloads-asc" =
    list.sort?.key === "downloads"
      ? list.sort.dir === "desc"
        ? "downloads-desc"
        : "downloads-asc"
      : list.sort?.key === "name" && list.sort.dir === "desc"
        ? "name-desc"
        : "name-asc";
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sync, setSync] = useState("");
  const [sources, setSources] = useState<Sources>(() => loadSources());
  const [showSources, setShowSources] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  // Which component kind the list shows (a `component-kinds` filter value),
  // in the address as `?f.kind=`. Empty means every component.
  const typeFilter = list.filters.kind ?? "";
  const setTypeFilter = (kind: string) => listCtl.setFilter("kind", kind || null);
  // `gts_id -> schema`, read from the catalogue: what each component type's
  // page is made of. Served rather than compiled in, so a workspace can change
  // a page without a release.
  const [schemas, setSchemas] = useState<Schemas>({});
  // Whether a cap cut the server's list short. An organization can mark a type
  // with six figures of instances, and showing part of one silently would be
  // worse than saying so.
  const [truncated, setTruncated] = useState(false);
  // The types this organization treats as components, or `null` while that is
  // unknown -- an unknown filter shows everything rather than nothing.
  const [componentTypes, setComponentTypes] = useState<Set<string> | null>(null);

  const setSrc = (patch: Partial<Sources>) =>
    setSources((cur) => {
      const next = { ...cur, ...patch };
      saveSources(next);
      return next;
    });

  const setRepo = (which: "gears" | "frontx" | "kits" | "kitsPm", patch: Partial<RepoSel>) =>
    setSources((cur) => {
      const next = { ...cur, [which]: { ...cur[which], ...patch } };
      saveSources(next);
      return next;
    });


  // The presentation of every component type, in one read. The server has
  // already laid this tenant's own schemas over the built-ins, so what comes
  // back is what to render — the overlay is not repeated here.
  useEffect(() => {
    let live = true;
    api
      .fieldSchemas(token)
      .then(({ schemas: served }) => {
        if (!live) return;
        setSchemas(indexSchemas(served ?? []));
        // The same read answers both questions: what each type looks like, and
        // which types this organization calls components. One round trip, and
        // no way for the two answers to disagree.
        setComponentTypes(
          new Set((served ?? []).filter((s) => s.component).map((s) => s.describes)),
        );
      })
      .catch(() => {
        // No schemas means no field cards, which is a visibly empty page
        // rather than a wrong one. The name, description and category on each
        // card come from the node itself and survive this.
        //
        // The marks go to `null` rather than to an empty set: not knowing
        // which types are components must not read as "none of them are".
        if (live) {
          setSchemas({});
          setComponentTypes(null);
        }
      });
    return () => {
      live = false;
    };
  }, [token]);

  useEffect(() => {
    if (!tenantId) return;
    let live = true;
    api
      .connections(token, tenantId)
      .then(({ items }) => {
        if (live) setConnections(items.filter((c) => c.provider === "github"));
      })
      .catch(() => {
        if (live) setConnections([]);
      });
    return () => {
      live = false;
    };
  }, [token, tenantId]);

  const reload = useCallback(async () => {
    setErr(null);
    try {
      const [componentResponse, profileResponse, kitResponse] = await Promise.all([
        api.listComponents(token),
        api.listComponentProfiles(token).catch((error): { nodes: CatalogNode[] } => {
          if (error instanceof ApiError && error.status === 404) return { nodes: [] };
          throw error;
        }),
        // Its own gear, so its own failure: a kit registry that is down leaves
        // the gears listed rather than blanking the whole catalogue.
        api.kits(token).catch((): { items: StudioKit[] } => ({ items: [] })),
      ]);
      // The registry's built-in kits and the kits a sync found from a
      // repository are the same things under the same slugs. A synced node
      // wins: it carries the repository, the ref and the manifest path that a
      // hardcoded catalogue entry cannot. The built-ins stay so that a
      // deployment which has never run a kit sync still shows them.
      const nodes = componentResponse.nodes ?? [];
      setTruncated(Boolean(componentResponse.truncated));
      const registry = new Map((kitResponse.items ?? []).map((k) => [k.slug, k]));
      const synced = new Set(
        nodes
          .filter((n) => n.type_id === KIT_TYPE)
          .map((n) => String(n.value.name ?? "")),
      );
      // A synced kit still wins, but it does not win the fields it has none of.
      //
      // A kit manifest declares `slug`, `name` and `version` in its `[[kits]]`
      // block and nothing else -- neither of the two real kit repositories puts
      // a description there, and the ones further down belong to the kit's
      // RESOURCES, not to the kit. So a synced kit row came back bare.
      //
      // It only started coming back bare when the scan learned to name a kit
      // after itself: while the synced node was called `studio-kit-sdlc` it
      // never matched the registry's `sdlc`, so the registry row with its
      // description was the one that showed. Making the name right is what
      // exposed this, which is the ordinary shape of a fix landing on top of a
      // bug that was hiding it.
      const described = nodes.map((n) => {
        if (n.type_id !== KIT_TYPE) return n;
        const built = registry.get(String(n.value.name ?? ""));
        if (!built) return n;
        const value = { ...n.value };
        if (!String(value.description ?? "").trim()) value.description = built.description;
        if (!value.repository) value.repository = built.repository_url || null;
        if (!value.keywords?.length) {
          value.keywords = [built.publisher, built.visibility].filter(Boolean) as string[];
        }
        return { ...n, value };
      });
      const builtIns = (kitResponse.items ?? [])
        .filter((k) => !synced.has(k.slug))
        .map(kitAsNode);
      // The server sends nodes of the types this organization marked. The two
      // sets below are synthesised here from other gears' data, so they are
      // filtered against the same marks rather than appearing whatever the
      // organization decided.
      // Document types are NOT here any more.
      //
      // They were synthesised onto this list as a "Document type" filter of
      // seven, and this page's own description says what it is a catalogue of:
      // gears, tools and SDKs from the Gears repository, micro-frontends from
      // FrontX, and kits. A document type is none of those. It is a kind of
      // spec — a template with sections and rules — and it is neither something
      // a product is assembled from nor something a project installs, which is
      // the one thing everything else in this list has in common.
      //
      // It already has two homes that are about it: the Objects screen, where
      // an organization decides which types exist, and the Specs tab, where the
      // documents written against them live. A third listing here meant the
      // component counts on this page answered a question nobody asked of it.
      setGears([...described, ...builtIns]);
      const next: Record<string, Record<string, unknown>> = {};
      for (const node of profileResponse.nodes ?? []) {
        const name = typeof node.value.gear_name === "string" ? node.value.gear_name : "";
        if (name) next[name] = node.value as Record<string, unknown>;
      }
      setProfiles(next);
      try {
        const answered = await api.componentValues(token);
        const byName: Record<string, ComponentValues> = {};
        for (const row of answered.items) byName[row.name] = row;
        setResolved(byName);
      } catch {
        // The table then shows what the node itself says and nothing merged
        // onto it, which is thin but honest — better than merging it here a
        // second way.
        setResolved({});
      }
    } catch (e) {
      setErr(errText(e));
    }
  }, [token, tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runSync = async () => {
    const body = syncBody(sources, tenantId);
    if (typeof body === "string") {
      setErr(body);
      setSync("");
      return;
    }
    setErr(null);
    setBusy(true);
    setSync("queued…");
    try {
      const { run_id } = await api.syncComponents(token, body);
      const deadline = Date.now() + 10 * 60 * 1000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const t = await api.componentsCatalogTask(token, run_id);
        if (t.status === "succeeded") {
          setSync(`${t.gears} gears · ${t.versions} versions`);
          await reload();
          break;
        }
        // `cancelled` too — see the artifact sync loop in App.tsx.
        if (t.status === "failed" || t.status === "cancelled") {
          setSync(t.message || `sync ${t.status}`);
          break;
        }
        const phase = (t.message || t.status).replace(/…$/, "");
        setSync(`${phase} — ${t.gears} gears · ${t.versions} versions · ${t.stored} in graph…`);
        if (Date.now() > deadline) {
          setSync("timed out — still running server-side");
          break;
        }
      }
    } catch (e) {
      setSync(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (g: CatalogNode) => String(g.value.name ?? g.instance_id);
  /* The platform category the backend decided; the reconciled field only for
     a backend that does not classify yet. */
  const categoryOf = (g: CatalogNode): string =>
    "component_kind" in g.value
      ? String(g.value.component_category ?? "")
      : String(resolved[nameOf(g)]?.category ?? "");

  /* Every filter but the kind. The chips count over this list and the table
     shows `base` narrowed by the chosen kind, both through `inKindFilter`, so
     a chip's number is the number of rows it shows. */
  const base = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const cat = categoryFilter.trim().toLowerCase();
    const rows = (gears ?? [])
      // A type this organization does not treat as a component does not
      // belong on this page, whichever gear put the node there. Only the
      // synthesised nodes reach this test in practice -- the server has
      // already applied the marks to what it sent -- but applying it in one
      // place is what keeps the two agreeing.
      .filter((g) => componentTypes === null || componentTypes.has(g.type_id))
      .filter((g) => !hideSdk || componentKind(g) !== "sdk")
      .filter((g) => !cat || categoryOf(g).toLowerCase().includes(cat))
      .filter((g) => {
        if (!needle) return true;
        const name = String(g.value.name ?? "").toLowerCase();
        const desc = String(g.value.description ?? "").toLowerCase();
        return name.includes(needle) || desc.includes(needle);
      });
    rows.sort((a, b) => {
      if (sortMode === "downloads-desc" || sortMode === "downloads-asc") {
        const d = Number(b.value.downloads ?? 0) - Number(a.value.downloads ?? 0);
        return sortMode === "downloads-desc" ? d : -d;
      }
      const cmp = nameOf(a).localeCompare(nameOf(b));
      return sortMode === "name-desc" ? -cmp : cmp;
    });
    return rows;
  }, [gears, query, hideSdk, sortMode, categoryFilter, profiles, resolved, componentTypes]);

  /* The chip above the table wins over the filter rail's kind; either way it
     is one value, applied by the same predicate the chips counted with. */
  const kindChosen = typeFilter;
  const visible = useMemo(() => base.filter((g) => inKindFilter(g, kindChosen)), [base, kindChosen]);
  const chips = useMemo(() => kindChips(base), [base]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const g of gears ?? []) {
      if (componentExcluded(g) !== null) continue;
      const c = categoryOf(g).trim();
      if (c) set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gears, profiles]);
  const filtered = !!(list.q.trim() || Object.keys(list.filters).length);

  // Report the distinct categories present, so the filter rail can offer them.
  useEffect(() => {
    if (!onCategories) return;
    const set = new Set<string>();
    for (const g of gears ?? []) {
      if (componentExcluded(g) !== null) continue;
      const c = categoryOf(g).trim();
      if (c) set.add(c);
    }
    onCategories(Array.from(set).sort((a, b) => a.localeCompare(b)));
  }, [gears, profiles, onCategories]);

  const selectedGear = useMemo(
    () => (selected ? (gears ?? []).find((g) => nameOf(g) === selected) ?? null : null),
    [selected, gears],
  );

  const [viewMode, setViewMode] = useState<"list" | "graph">("list");
  /* Cards or a table, inside "List". Defaulted to tiles because cards are what
   * this page has always been, and remembered with everything else — somebody
   * who reads lists as tables reads this one as a table too. */
  // The same preference the list's own toggle sets, read here for the summary
  // over the cards.
  const [listView] = useViewMode("components.view", "tiles");
  const graph = useMemo(() => buildComponentGraph(visible, profiles), [visible, profiles]);

  // Delivery activity from Insight, for the whole catalogue at once: one request
  // per repository, keyed on the gear names, so opening a component page or
  // typing in the filter costs nothing more.
  const [activityDays, setActivityDays] = useState<number>(90);
  const activity = useGearActivity(token, activityDays);
  const baselines = useComponentBaselines(token, activityDays);

  const facts = useMemo(() => {
    const out = new Map<string, RowFacts>();
    for (const g of visible) {
      const name = nameOf(g);
      out.set(
        g.instance_id,
        rowFacts(
          g,
          resolved[name]?.values ?? {},
          schemaFor(schemas, g.type_id),
          activity.byGear.get(name),
          baselines.byName.get(name),
          resolved[name]?.sources,
        ),
      );
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, resolved, schemas, activity, baselines]);
  const columns = useMemo(() => gearColumns((g) => facts.get(g.instance_id), activityDays), [facts, activityDays]);

  /* The catalogue's own filters, on the list's toolbar. They live in the same
     address as the list's (`?q=`, `?f.category=`, `?f.sdk=`, `?f.kind=`). */
  const filterControls = (
    <>
      <input
        className="dt-search"
        type="search"
        placeholder="Search components"
        aria-label="Search components"
        value={list.q}
        onChange={(e) => listCtl.setQ(e.target.value)}
      />
      {categories.length > 0 && (
        <select
          className="dt-select"
          aria-label="Every category"
          value={categoryFilter}
          onChange={(e) => listCtl.setFilter("category", e.target.value || null)}
        >
          <option value="">Every category</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}
      <button
        className={`chip ${hideSdk ? "on" : ""}`}
        aria-pressed={hideSdk}
        onClick={() => listCtl.setFilter("sdk", hideSdk ? null : "hide")}
      >
        Hide SDKs
      </button>
      <KindPicker chips={chips} value={kindChosen} onChange={setTypeFilter} />
      {filtered && (
        <button className="ghost" onClick={listCtl.clearFilters}>
          Clear filters
        </button>
      )}
    </>
  );

  const syncing = sync.endsWith("…");
  /* What filled the catalogue, read off the nodes -- the picker below is only
     this browser's choice for the NEXT sync. */
  const filledFrom = useMemo(() => syncedSources(gears ?? [], profiles).join(" + "), [gears, profiles]);
  const sourceSummary = [
    sources.gears.enabled && "gears",
    sources.frontx.enabled && "frontx",
    (sources.kits.enabled || sources.kitsPm.enabled) && "kits",
    sources.cratesIo && "crates.io",
  ]
    .filter(Boolean)
    .join(" + ");

  return (
    <div className="gcat">
      <style>{GCAT_CSS + ACTIVITY_CSS}</style>

      {selectedGear ? (
        <GearDetail
          token={token}
          gear={selectedGear}
          profile={profiles[selected as string]}
          values={resolved[selected as string]?.values ?? {}}
          schema={schemaFor(schemas, selectedGear.type_id)}
          activity={activity}
          activityDays={activityDays}
          onActivityDays={setActivityDays}
          baselines={baselines}
          onBack={() => setSelected(null)}
          onSaved={(p) => setProfiles((cur) => ({ ...cur, [selected as string]: p }))}
        />
      ) : (
        <>
          <div className="gcat-topbar">
            <div className="crumb">
              <h1>Components</h1>
              <span className="asof">{filledFrom ? filledFrom.replace(/ \+ /g, " · ") : "not synced yet"}</span>
            </div>
            <div className="tools">
              <div className="seg" role="tablist" aria-label="View mode">
                {(["list", "graph"] as const).map((v) => (
                  <button key={v} aria-pressed={viewMode === v} onClick={() => setViewMode(v)}>
                    {v === "list" ? "List" : "Graph"}
                  </button>
                ))}
              </div>
              <div className="seg" role="tablist" aria-label="Activity window">
                {ACTIVITY_WINDOWS.map((w) => (
                  <button
                    key={w.days}
                    aria-pressed={activityDays === w.days}
                    onClick={() => setActivityDays(w.days)}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
              <button
                className={`iconbtn${showSources ? " active" : ""}`}
                onClick={() => setShowSources((v) => !v)}
                aria-expanded={showSources}
              >
                Sources{filledFrom ? ` · ${filledFrom}` : sourceSummary ? ` · ${sourceSummary}` : ""}
              </button>
              <button className="iconbtn" onClick={() => setShowReport(true)}>
                Roadmap report
              </button>
              <button className="iconbtn primary" disabled={busy} onClick={() => void runSync()}>
                {syncing ? "Syncing…" : "Sync"}
              </button>
            </div>
          </div>

          {showReport && <RoadmapReportDialog token={token} onClose={() => setShowReport(false)} />}

          {showSources && (
            <SourcesPanel
              sources={sources}
              setSrc={setSrc}
              setRepo={setRepo}
              connections={connections}
              tenantId={tenantId}
            />
          )}

          <p className="gcat-sub">
            A catalogue of platform <strong>components</strong> — gears, tools and SDKs from the Gears
            repository, micro-frontends from FrontX, and kits — read through a connector, with
            crates.io adding published versions. Each component opens a page of grouped fields,
            traffic lights and sources; an empty cell is a finding, not an omission.
          </p>

          {truncated && (
            <p className="gcat-hint">
              Showing the first {gears?.length ?? 0} components. A marked type has more nodes than
              this page will render — narrow it on Objects, or filter above.
            </p>
          )}
          {sync && <p className="gcat-hint">Sync: {sync}</p>}
          <ActivityStatus activity={activity} />
          {/* A catalogue that never loaded says so in the list, with Retry. */}
          {err && (viewMode === "graph" || gears !== null) && <p className="gcat-err">{err}</p>}

          {viewMode === "graph" ? (
            <>
              <div className="dt-toolbar">
                <div className="dt-toolbar-left">{filterControls}</div>
              </div>
              {gears === null ? (
                <p className="gcat-empty">Loading components…</p>
              ) : visible.length === 0 ? (
                <div className="dt-state dt-empty">
                  <div className="dt-empty-title">Nothing matches.</div>
                  <button className="ghost" onClick={listCtl.clearFilters}>
                    Clear filters
                  </button>
                </div>
              ) : (
                <ComponentGraph graph={graph} nodes={visible} />
              )}
            </>
          ) : (
            <>
              {listView === "tiles" && gears !== null && visible.length > 0 && (
                <CardsSummary shown={visible.length} total={gears.length} resolved={resolved} nodes={visible} />
              )}
              {/* The rows arrive already searched and filtered: the kind chips
                  count with `inKindFilter`, which the list's own filters cannot
                  say. The list sorts, pages and opens them. */}
              <DataTable<CatalogNode>
                list="components"
                defaultView="tiles"
                rows={gears === null ? null : visible}
                error={gears === null ? err : null}
                onRetry={() => void reload()}
                columns={columns}
                rowKey={(g) => g.instance_id}
                rowLabel={nameOf}
                onOpen={(g) => setSelected(nameOf(g))}
                tile={(g, open) => (
                  <GearListCard
                    gear={g}
                    values={resolved[nameOf(g)]?.values ?? {}}
                    schema={schemaFor(schemas, g.type_id)}
                    usedBy={resolved[nameOf(g)]?.values?.consumers?.n ?? null}
                    baseline={baselines.byName.get(nameOf(g))}
                    sources={resolved[nameOf(g)]?.sources}
                    onOpen={open ?? (() => setSelected(nameOf(g)))}
                  />
                )}
                extra={filterControls}
                empty={{ title: "No components yet.", body: "Open Sources, pick a repository, and Sync." }}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── source panel ─────────────────────────────────────────────────────────────

function RepoSourceEditor({
  title,
  note,
  sel,
  onChange,
  connections,
  tenantId,
}: {
  title: string;
  note: string;
  sel: RepoSel;
  onChange: (patch: Partial<RepoSel>) => void;
  connections: Connection[];
  tenantId: string | undefined;
}) {
  return (
    <div className="src-col">
      <label className="src-head">
        <input
          type="checkbox"
          checked={sel.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <span>{title}</span>
      </label>
      <div className="src-body">
        <label className="src-row">
          <span>Connection</span>
          <select
            value={sel.connectionId}
            disabled={!sel.enabled}
            onChange={(e) => onChange({ connectionId: e.target.value })}
          >
            <option value="">
              {connections.length ? "First GitHub connection" : "No GitHub connection"}
            </option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label || c.account || c.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <label className="src-row">
          <span>Repository</span>
          <input
            placeholder="owner/name"
            value={sel.repo}
            disabled={!sel.enabled}
            onChange={(e) => onChange({ repo: e.target.value })}
          />
        </label>
        <label className="src-row">
          <span>Branch</span>
          <select
            value={BRANCH_CHOICES.some((b) => b.value === sel.gitRef) ? sel.gitRef : CUSTOM_BRANCH}
            disabled={!sel.enabled}
            onChange={(e) =>
              // Choosing "Other…" keeps whatever is typed; the input below is
              // what actually edits it.
              onChange({ gitRef: e.target.value === CUSTOM_BRANCH ? "" : e.target.value })
            }
          >
            {BRANCH_CHOICES.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
            <option value={CUSTOM_BRANCH}>Other…</option>
          </select>
        </label>
        {!BRANCH_CHOICES.some((b) => b.value === sel.gitRef) && (
          <label className="src-row">
            <span>Ref</span>
            <input
              placeholder="branch, tag or commit"
              value={sel.gitRef}
              disabled={!sel.enabled}
              onChange={(e) => onChange({ gitRef: e.target.value })}
            />
          </label>
        )}
        <p className="src-note">
          {note}
          {sel.enabled && !tenantId ? " — no workspace in context to list connections." : ""}
        </p>
      </div>
    </div>
  );
}

/** The component kinds in the list, as a row of chips.
 *
 *  Built by `kindChips` from the same list and the same predicate the table
 *  uses (`component-kinds.ts`), so "gear 35" is thirty-five rows. It used to
 *  count graph node types -- "Gear 105 · Micro-frontend 12" -- over a table
 *  that classified the same nodes into eight kinds. What is not a component
 *  gets its own chip, with its count, rather than hiding without a trace.
 */
function KindPicker({
  chips,
  value,
  onChange,
}: {
  chips: KindChip[];
  value: string;
  onChange: (next: string) => void;
}) {
  // "All" alone is no choice.
  if (chips.length < 2) return null;
  return (
    <div className="gcat-types">
      <span className="gcat-types-label">Type</span>
      {chips.map((c) => (
        <button
          key={c.value || "all"}
          className={`gcat-type${value === c.value ? " on" : ""}`}
          onClick={() => onChange(value === c.value ? "" : c.value)}
          title={c.value === "" ? "Every component" : c.label}
        >
          {c.value === "" || c.value === "not-components" ? c.label : (COMPONENT_KIND_LABELS[c.value] ?? c.label)}{" "}
          <span className="gcat-type-n">{c.count}</span>
        </button>
      ))}
    </div>
  );
}

function SourcesPanel({
  sources,
  setSrc,
  setRepo,
  connections,
  tenantId,
}: {
  sources: Sources;
  setSrc: (patch: Partial<Sources>) => void;
  setRepo: (which: "gears" | "frontx" | "kits" | "kitsPm", patch: Partial<RepoSel>) => void;
  connections: Connection[];
  tenantId: string | undefined;
}) {
  return (
    <div className="sources">
      <RepoSourceEditor
        title="Gears (platform components)"
        note="Gears, tools, SDKs and plugins from the Gears repository."
        sel={sources.gears}
        onChange={(p) => setRepo("gears", p)}
        connections={connections}
        tenantId={tenantId}
      />
      <RepoSourceEditor
        title="FrontX (micro-frontends)"
        note="Every package in the FrontX monorepo — packages/* plus the root-level scaffolding templates (template-shell, template-mfe). FrontX develops on `develop`."
        sel={sources.frontx}
        onChange={(p) => setRepo("frontx", p)}
        connections={connections}
        tenantId={tenantId}
      />
      <RepoSourceEditor
        title="Kits · delivery lifecycle"
        note="Every `.cf-studio-kit.toml` in the repository — one at the root, or several in subdirectories. A kit is installed into a project's repositories rather than depended on, so it carries a repository and a ref instead of a version ladder."
        sel={sources.kits}
        onChange={(p) => setRepo("kits", p)}
        connections={connections}
        tenantId={tenantId}
      />
      <RepoSourceEditor
        title="Kits · product management"
        note="`studio-kits-pm` — one repository, several kits: its root manifest carries a `[[kits]]` entry each, so the scan finds whatever has been added since. Competitive analysis is the one there today."
        sel={sources.kitsPm}
        onChange={(p) => setRepo("kitsPm", p)}
        connections={connections}
        tenantId={tenantId}
      />
      <div className="src-col">
        <label className="src-head">
          <input
            type="checkbox"
            checked={sources.cratesIo}
            onChange={(e) => setSrc({ cratesIo: e.target.checked })}
          />
          <span>crates.io</span>
        </label>
        <div className="src-body">
          <label className="src-row">
            <span>Keyword</span>
            <input
              placeholder="constructorfabric"
              value={sources.keyword}
              disabled={!sources.cratesIo}
              onChange={(e) => setSrc({ keyword: e.target.value })}
            />
          </label>
          <p className="src-note">Published versions, downloads and release dates.</p>
        </div>
      </div>
    </div>
  );
}

// ── list card ────────────────────────────────────────────────────────────────

/** Where the activity numbers came from, and what they cost — stated once,
 *  above the cards, so no card has to carry a provenance footnote. */
function ActivityStatus({ activity }: { activity: ActivityIndex }) {
  if (activity.status === "off") return null;
  if (activity.status === "loading") {
    return <p className="gcat-hint">Activity: reading Constructor Insight…</p>;
  }
  if (activity.status === "error") {
    return (
      <p className="gcat-hint">
        Activity unavailable — {activity.error}. The catalogue below is unaffected.
      </p>
    );
  }
  return (
    <p className="gcat-hint">
      Activity {activity.from} → {activity.to}, from Constructor Insight: commits, files and lines
      per gear directory{activity.truncated ? " (Insight capped the page — some gears are missing)" : ""}.
    </p>
  );
}

/** One component as a table row.
 *
 *  The product's own components table is the shape this follows — a first
 *  column that is the component AND what it is for, then one column per
 *  question somebody scans down. What it deliberately does NOT follow is its
 *  CONTENT: that table has Readiness, Delivery and Review columns fed by a
 *  roadmap, an SBOM and a review pipeline, and we hold none of those. Drawing
 *  empty SPEC/SDK/IMPL bars here would be an invented finding, which is worse
 *  than a column that is not there.
 *
 *  So every column below is something the catalogue actually holds, and where
 *  a value is missing the cell says which KIND of missing it is. "Not
 *  published" is a fact about the component; "Not measured" is a fact about
 *  our window; a dash is neither and would collapse them.
 */
/** What one table row shows, worked out once per row rather than once per
 *  cell. */
interface RowFacts {
  values: Values;
  fields: Field[];
  trend: FieldTrend | undefined;
  pct: number;
  kind: string;
  category: string | null;
  kindReason: string | undefined;
  excluded: string | null;
  version: unknown;
  declared: unknown;
  bad: number;
  watch: number;
  repository: string | null;
  activity: GearActivity | undefined;
  sources: ComponentSource[] | undefined;
}

function rowFacts(
  gear: CatalogNode,
  /** Reconciled by the gear that owns the precedence, not merged here. */
  values: Values,
  schema: Schema,
  activity: GearActivity | undefined,
  /** The component as the window found it, when the catalogue kept a snapshot. */
  baseline: ComponentSnapshot | undefined,
  /** Where its facts came from. */
  sources: ComponentSource[] | undefined,
): RowFacts {
  const fields = schema.groups.flatMap((g) => g.fields);
  const trend = fieldTrend(fields, values, baseline);
  const filled = fields.filter((f) => values[f.key]).length;
  const pct = fields.length ? Math.round((filled / fields.length) * 100) : 0;
  /* The Type column says what the component IS (gear, plugin, sdk, toolkit,
     frontx, kit). It used to show `category`, which is a crates.io category
     ("Web programming"), a gear.toml domain ("bss") or, for a FrontX package,
     its first npm keyword ("hai3", "eslint") -- three vocabularies in one
     column that claimed to be a fourth. The category stays, under the type. */
  const kind = componentKind(gear);
  const classified = "component_kind" in gear.value;
  const category = classified
    ? (typeof gear.value.component_category === "string" ? gear.value.component_category : null)
    : values.category?.b ?? null;
  const kindReason = typeof gear.value.component_kind_reason === "string" ? gear.value.component_kind_reason : undefined;
  const excluded = componentExcluded(gear);
  const released = gear.value.max_stable_version ?? gear.value.newest_version ?? null;
  /* A FrontX package is not on crates.io, so "Not published" was true and
     useless: the version its package.json declares is the one people use. */
  const declared = released ? null : values.version?.b ?? null;
  const version = released ?? declared;
  const lamps = fields.map((f) => lampOf(f, values)).filter((l): l is Lamp => !!l);
  const bad = lamps.filter((l) => l === "bad").length;
  const watch = lamps.filter((l) => l === "watch").length;
  /* A component only a repository scan produced (a draft gear, a FrontX
     package) has no crates.io `repository`, but the scan recorded where it
     read it: `synced_from` and, since the scan keeps it, `repo_path`. "Not
     recorded" was wrong for every one of them. */
  const scannedFrom = typeof gear.value.synced_from === "string" && gear.value.synced_from ? gear.value.synced_from : null;
  const repoPath = typeof gear.value.repo_path === "string" && gear.value.repo_path ? gear.value.repo_path : null;
  const repository =
    typeof gear.value.repository === "string" && gear.value.repository
      ? gear.value.repository
      : scannedFrom
        ? `https://github.com/${scannedFrom}${repoPath ? `/tree/HEAD/${repoPath}` : ""}`
        : null;
  return {
    values,
    fields,
    trend,
    pct,
    kind,
    category,
    kindReason,
    excluded,
    version,
    declared,
    bad,
    watch,
    repository,
    activity,
    sources,
  };
}

/** The catalogue's table, as the one list's columns. `factsOf` answers for
 *  every row on screen; a row it has no facts for renders empty cells. */
function gearColumns(
  factsOf: (gear: CatalogNode) => RowFacts | undefined,
  activityDays: number,
): Column<CatalogNode>[] {
  const nameOf = (g: CatalogNode) => String(g.value.name ?? g.instance_id);
  const cell = (render: (g: CatalogNode, f: RowFacts) => ReactNode) => (g: CatalogNode) => {
    const facts = factsOf(g);
    return facts ? render(g, facts) : null;
  };
  return [
    {
      id: "name",
      header: "Component and purpose",
      className: "gcat-lead",
      compare: (a, b) => nameOf(a).localeCompare(nameOf(b)),
      cell: cell((gear, { sources }) => (
        <>
          <div className="gcat-name">{nameOf(gear)}</div>
          {gear.value.description && <div className="gcat-purpose">{String(gear.value.description)}</div>}
          <SourceChips sources={sources} />
        </>
      )),
    },
    {
      id: "type",
      header: "Type",
      cell: cell((_, { kind, category, excluded, kindReason }) => (
        <>
          <span className="pill" title={excluded ?? kindReason}>
            {COMPONENT_KIND_LABELS[kind] ?? kind}
          </span>
          {category && category !== kind && <div className="gcat-sub">{category}</div>}
        </>
      )),
    },
    {
      id: "release",
      header: "Release",
      // No version at all is not "0" and not a blank: crates.io has no record
      // of this component, which is a thing to go and look at.
      cell: cell((gear, { version, declared }) =>
        version ? (
          <>
            <code className="gcat-version">{String(version)}</code>
            <div className="gcat-sub">
              {declared ? "declared, not on crates.io" : `${numText(gear.value.num_versions)} versions`}
            </div>
          </>
        ) : null,
      ),
    },
    {
      id: "readiness",
      header: "Build readiness",
      cell: cell((_, { values }) => <ReadinessCell values={values} />),
    },
    {
      id: "downloads",
      header: "Downloads",
      num: true,
      compare: (a, b) => Number(a.value.downloads ?? 0) - Number(b.value.downloads ?? 0),
      cell: (gear) => (gear.value.downloads != null ? numText(gear.value.downloads) : null),
    },
    {
      id: "activity",
      header: `Activity · ${activityDays} days`,
      cell: cell((_, { activity }) => {
        const moved = activity && (activity.commits > 0 || activity.lines_added + activity.lines_removed > 0);
        if (moved) {
          return (
            <div className="act-card">
              <MiniChurn points={activity!.points} />
              <span>
                <b>{compact(activity!.commits)}</b> commits ·{" "}
                <b className="ink-added">+{compact(activity!.lines_added)}</b>{" "}
                <b className="ink-removed">−{compact(activity!.lines_removed)}</b> ·{" "}
                <b>{compact(activity!.authors)}</b> authors
              </span>
            </div>
          );
        }
        // Nothing moved in the window, or Insight has no directory for this
        // component — two different facts, and the one we can tell apart is
        // whether we measured at all.
        return activity ? <span className="gcat-absent">No commits in {activityDays} days</span> : null;
      }),
    },
    {
      id: "review",
      header: "Review",
      cell: cell((_, { values }) => (
        <ReviewCell parts={(values.grade as { parts?: ReviewPart[] } | null | undefined)?.parts} />
      )),
    },
    {
      id: "profile",
      header: "Profile",
      cell: cell((_, { fields, pct, bad, watch, trend }) => (
        <>
          {fields.length === 0 ? (
            <span className="gcat-absent">No schema</span>
          ) : (
            <div className="gcat-profile">
              <span className="gcat-bar">
                <span className="gcat-bar-fill" style={{ width: `${pct}%` }} />
              </span>
              <span className="gcat-pct">{pct}%</span>
              {bad > 0 && (
                <span className="lchip">
                  <span className="tl bad" />
                  {bad}
                </span>
              )}
              {watch > 0 && (
                <span className="lchip">
                  <span className="tl watch" />
                  {watch}
                </span>
              )}
            </div>
          )}
          {trend && trend.better + trend.worse > 0 && (
            <div className="gcat-sub">
              <TrendMark trend={trend} />
            </div>
          )}
        </>
      )),
    },
    {
      id: "source",
      header: "Source",
      cell: cell((_, { repository }) =>
        repository ? (
          <a className="gcat-link" href={repository} target="_blank" rel="noreferrer" title={repository}>
            {repository.replace(/^https?:\/\/(www\.)?/, "")}
          </a>
        ) : null,
      ),
    },
  ];
}

// ── the component card ───────────────────────────────────────────────────────
//
// One card answers, top to bottom, the questions somebody deciding whether to
// wait for a component asks: what is it and where is it (stage), how far along
// is each part and will the date hold (plan), what can I use today (release),
// how big is its world (documents, dependencies, who uses it), and what is
// wrong with it (the worst finding, then how many more).

/** Words a component name spells in capitals rather than in title case. */
const ACRONYMS = new Set(["api", "llm", "sdk", "oagw", "grpc", "bss", "oss", "http", "json", "ecb", "fx", "ai", "ui", "mfe", "id", "db"]);

/** `cf-gears-account-management` → `Account Management`. */
function displayName(name: string): string {
  const bare = name.replace(/^cf-gears-/, "").replace(/^@[^/]+\//, "");
  return bare
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/** `core-platform-integration` → `Core platform integration`; `gen-ai` → `Gen AI`. */
function categoryLabel(raw: string): string {
  const words = raw.split(/[-_\s]+/).filter(Boolean);
  return words
    .map((w, i) => {
      if (ACRONYMS.has(w.toLowerCase())) return w.toUpperCase();
      return i === 0 ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase();
    })
    .join(" ");
}

/** `In Dev (3 of 6)` → where in the pipeline, as a colour. */
function stageTone(values: Values): "done" | "late" | "early" | "idle" {
  const m = /\((\d+) of (\d+)\)/.exec(values.stage?.v ?? "");
  if (!m) return "idle";
  const at = Number(m[1]);
  const of = Number(m[2]);
  if (at >= of) return "done";
  if (at <= 1) return "idle";
  return at / of >= 0.7 ? "late" : "early";
}

interface Axis {
  label: string;
  value: string;
  pct: number | null;
}

/**
 * SPEC / SDK / IMPL as the board sets them, with what the repository shows
 * underneath -- ticked spec markers, requirement IDs the code cites -- and a
 * flag where the board is well ahead of it (readiness.ts).
 */
function ReadinessCell({ values }: { values: Values }) {
  const r = readinessOf(values as Parameters<typeof readinessOf>[0]);
  if (!r) return <span className="gcat-absent">Not planned</span>;
  return (
    <div className="gcat-ready">
      {r.bars.length > 0 && (
        <div className="gcat-ready-bars">
          {r.bars.map((b) => (
            <span key={b.axis} className="gcat-ready-bar" title={`${b.label} on the roadmap board: ${b.pct === null ? "N/A" : `${b.pct}%`}`}>
              <span className="gcat-ready-k">{b.axis}</span>
              <span className="gcat-bar">
                <span className="gcat-bar-fill" style={{ width: `${b.pct ?? 0}%` }} />
              </span>
              <span className="gcat-ready-v">{b.pct === null ? "—" : `${b.pct}%`}</span>
            </span>
          ))}
        </div>
      )}
      {r.evidence.length > 0 && <div className="gcat-sub">{r.evidence.map((e) => e.text).join(" · ")}</div>}
      {r.gaps.length > 0 && (
        <div className="gcat-ready-gap" title={r.gaps.join("\n")}>
          Board ahead of the repository
        </div>
      )}
    </div>
  );
}

/** The roadmap's progress axes, labelled short enough to sit in a row. */
function axesOf(values: Values): Axis[] {
  const parts = (values.roadmap_progress as unknown as { parts?: { label: string; value: string; pct: number | null }[] } | null)
    ?.parts;
  return (parts ?? []).map((p) => {
    const label = p.label.trim();
    const short = label.length > 6 ? label.slice(0, 4) : label;
    return { label: short.toUpperCase(), value: p.value, pct: p.pct };
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-10-31` → `Oct 2026`. */
function monthOf(date: string | undefined): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(date ?? "");
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
}

/** Whole months from `due` to today, when today is past it. */
function monthsLate(due: string): number {
  const d = new Date(`${due}T00:00:00Z`);
  const now = new Date();
  const months = (now.getUTCFullYear() - d.getUTCFullYear()) * 12 + (now.getUTCMonth() - d.getUTCMonth());
  return Math.max(1, months);
}

/** What the plan says about the date, as one short phrase and a tone. */
function scheduleOf(values: Values): { text: string; tone: Lamp } | null {
  const conv = values.convergence;
  const due = values.milestone?.u;
  if (!values.milestone && !conv) return null;
  if (conv?.b === "delivered") return { text: "Delivered", tone: "good" };
  if (values.milestone?.s === "bad" && due) {
    const n = monthsLate(due);
    return { text: `${n} month${n === 1 ? "" : "s"} late`, tone: "bad" };
  }
  if (!due) return { text: "No date", tone: "grey" };
  if (conv?.s === "watch") return { text: "Check", tone: "watch" };
  return { text: "On target", tone: "good" };
}

/** What can be used today: the newest release, or why there is none. */
function releaseOf(gear: CatalogNode, values: Values): { label: string; version: string | null; tone: Lamp } {
  // Only a version is shown; "unknown" is not something to put on a card.
  const version =
    (gear.value.max_stable_version as string | undefined) ??
    (gear.value.newest_version as string | undefined) ??
    values.lastrelease?.b ??
    null;
  const published = values.published?.b;
  if (published === "sdk only") return { label: "SDK only", version, tone: "watch" };
  if (version) return { label: "Released", version, tone: "good" };
  return { label: "Release unknown", version: null, tone: "grey" };
}

/** `Service · REST API · SDK`: what shape the component comes in. */
function shapeOf(values: Values): string {
  const parts: string[] = [];
  const runtime = values.runtime?.b;
  if (runtime) parts.push(runtime[0].toUpperCase() + runtime.slice(1));
  if (values.openapi?.b === "yes") parts.push("REST API");
  if ((values.sdk?.b ?? "").startsWith("SDK")) parts.push("SDK");
  if (parts.length === 0 && values.prd?.b && values.prd.b !== "N/A") return "Specification only";
  return parts.join(" · ");
}

/** The specification documents present, counted the way the Specification group lists them. */
function documentsOf(values: Values): number {
  const docs = ["prd", "design", "decomp", "upstream"].filter((k) => {
    const b = values[k]?.b;
    return b && b !== "N/A";
  }).length;
  return docs + (values.adr?.n ?? 0);
}

function Count({ n, unit }: { n: number; unit?: string }) {
  return (
    <span className="ccard-count">
      {n}
      {unit ? <span className="ccard-unit"> {n === 1 ? unit : `${unit}s`}</span> : null}
    </span>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  crates_io: "crates.io",
  repository: "repo",
  roadmap: "roadmap",
  gearbox: "Gearbox",
  person: "edited",
};

/** Where a record's facts came from, in the order they are layered. A gear
 *  known from a board alone says so: planned, no code yet. */
function SourceChips({ sources }: { sources: ComponentSource[] | undefined }) {
  if (!sources?.length) return null;
  const planOnly = sources.every((s) => s.kind === "roadmap");
  return (
    <div className="src-chips" aria-label="Sources">
      {planOnly && <span className="src-chip planned">planned · no code yet</span>}
      {sources.map((s) => (
        <span key={`${s.kind}:${s.label}`} className={`src-chip ${s.kind}`} title={s.label}>
          {SOURCE_LABELS[s.kind] ?? s.kind}
          {s.kind === "repository" || s.kind === "roadmap" ? `: ${s.label}` : ""}
        </span>
      ))}
    </div>
  );
}

function GearListCard({
  gear,
  values,
  schema,
  usedBy,
  baseline,
  sources,
  onOpen,
}: {
  gear: CatalogNode;
  /** Reconciled by the gear that owns the precedence, not merged here. */
  values: Values;
  /** This component's own type's schema: findings are counted against it. */
  schema: Schema;
  /** How many catalogued components depend on this one; `null` when unknown. */
  usedBy: number | null;
  activity?: GearActivity | undefined;
  /** The component as the window found it, when the catalogue kept a snapshot. */
  baseline: ComponentSnapshot | undefined;
  /** Where its facts came from. */
  sources?: ComponentSource[] | undefined;
  onOpen: () => void;
}) {
  const name = String(gear.value.name ?? gear.instance_id);
  const fields = useMemo(() => schema.groups.flatMap((g) => g.fields), [schema]);
  const trend = useMemo(() => fieldTrend(fields, values, baseline), [fields, values, baseline]);
  const category = values.category?.b ?? "gear";
  const stage = values.stage?.b ?? null;
  const tone = stageTone(values);
  const axes = axesOf(values);
  const schedule = scheduleOf(values);
  const release = releaseOf(gear, values);
  const shape = shapeOf(values);
  const due = monthOf(values.milestone?.u);
  const committed = values.commitment?.b;

  // Findings: the worst one named, the rest counted.
  // The grade sums the findings up; it is the badge, not one of them.
  const judged = fields
    .filter((f) => f.key !== "grade")
    .map((f) => ({ f, lamp: lampOf(f, values) }))
    .filter((x): x is { f: Field; lamp: Lamp } => !!x.lamp);
  // The plan speaks first: the card is about readiness, and a missed date
  // outranks a missing sign-off. Then the rest, red before amber.
  const plan = judged.find((x) => x.f.key === "convergence" && (x.lamp === "bad" || x.lamp === "watch"));
  const worst =
    plan ?? judged.find((x) => x.lamp === "bad") ?? judged.find((x) => x.lamp === "watch") ?? null;
  const toReview = judged.filter((x) => x.lamp === "bad" || x.lamp === "watch").length;
  const docs = documentsOf(values);
  const stats: { label: string; n: number; unit?: string }[] = [];
  if (docs > 0) stats.push({ label: "Documents", n: docs });
  if (values.deps?.n) stats.push({ label: "Dependencies", n: values.deps.n });
  // Zero users is a finding, so a known zero is shown; an unknown is not.
  if (usedBy !== null) stats.push({ label: "Used by", n: usedBy, unit: "component" });
  const worstText = worst
    ? worst.f.key === "convergence"
      ? String(values.convergence?.v ?? "Plan at risk")
      : `${worst.f.label}: ${values[worst.f.key]?.b ?? "none"}`
    : null;

  return (
    <button className="ccard" onClick={onOpen} title={`Open ${name}`}>
      <div className="ccard-top">
        <span className="ccard-cat-row">
          <span className="ccard-cat">{categoryLabel(String(category))}</span>
          {values.grade?.b && (
            <span className={`ccard-grade ${values.grade.s ?? ""}`} title={values.grade.v}>
              {values.grade.b}
            </span>
          )}
          <TrendMark trend={trend} />
        </span>
        <span className={`ccard-stage ${tone}`}>
          {stage && <span className="dot" />}
          {stage}
          <span className="ccard-chev" aria-hidden="true">›</span>
        </span>
      </div>
      <div className="ccard-title">{displayName(name)}</div>
      <SourceChips sources={sources} />
      {gear.value.description ? <p className="ccard-desc">{String(gear.value.description)}</p> : <div className="ccard-gap" />}

      {(axes.length > 0 || schedule) && (
      <div className="ccard-sec ccard-plan">
        {axes.length > 0 && (
          <div className="ccard-axes">
            {axes.map((a) => (
              <div key={a.label} className="ccard-axis" title={`${a.label}: ${a.value}`}>
                <span className="ccard-k">{a.label}</span>
                <span className={`ccard-v ${a.pct === 100 ? "full" : a.pct === null ? "na" : "part"}`}>
                  <span className="dot" />
                  {a.pct === null ? "—" : `${a.pct}%`}
                </span>
              </div>
            ))}
          </div>
        )}
        {schedule && (
          <div className="ccard-when" title={values.convergence?.v ?? undefined}>
            <div className="ccard-when-top">
              {committed && (
                <span className="ccard-pill">{committed === "committed" ? "Committed" : "Planned"}</span>
              )}
              <span className={`ccard-sched ${schedule.tone}`}>
                <span className="dot" />
                {schedule.text}
              </span>
            </div>
            {(due || values.milestone?.b) && (
              <div className="ccard-due">{due ? `due ${due}` : String(values.milestone?.b)}</div>
            )}
          </div>
        )}
      </div>
      )}

      {(release.version || shape) && (
        <div className="ccard-sec ccard-release">
          {release.version && (
            <span className={`ccard-rel ${release.tone}`}>
              <span className="dot" />
              {release.label}
            </span>
          )}
          {release.version && <code className="ccard-ver">v{release.version.replace(/^v/, "")}</code>}
          {shape && <span className="ccard-shape">{shape}</span>}
        </div>
      )}

      {stats.length > 0 && (
        <div className="ccard-sec ccard-stats">
          {stats.map((st) => (
            <div key={st.label}>
              <span className="ccard-k2">{st.label}</span>
              <Count n={st.n} unit={st.unit} />
            </div>
          ))}
        </div>
      )}

      {values.demand?.b && (
        <div className="ccard-demand" title={values.demand.v ?? undefined}>
          {String(values.demand.b)}
        </div>
      )}

      {(worstText || toReview > 0) && (
        <div className="ccard-foot">
          {worstText && (
            <span className={`ccard-warn ${worst?.lamp === "bad" ? "bad" : ""}`}>
              <span aria-hidden="true">⚠</span> {worstText}
            </span>
          )}
          {toReview > 0 && <span className="ccard-review">{toReview} to review ›</span>}
        </div>
      )}
    </button>
  );
}

/** One line over the cards: how many, and how many of them want attention. */
function CardsSummary({
  shown,
  total,
  resolved,
  nodes,
}: {
  shown: number;
  total: number;
  resolved: Record<string, ComponentValues>;
  nodes: CatalogNode[];
}) {
  let released = 0;
  let planned = 0;
  let review = 0;
  for (const g of nodes) {
    const v = resolved[String(g.value.name ?? g.instance_id)]?.values ?? {};
    if (g.value.max_stable_version || g.value.newest_version || v.lastrelease) released++;
    if (v.stage && stageTone(v) !== "done") planned++;
    const lamp = v.convergence?.s;
    if (lamp === "bad" || lamp === "watch") review++;
  }
  return (
    <div className="ccards-summary">
      <span>
        <b>{shown}</b> of {total} components
      </span>
      <span>
        <b>{released}</b> released
      </span>
      <span>
        <b>{planned}</b> planned or in progress
      </span>
      <span>
        <b>{review}</b> need review
      </span>
    </div>
  );
}

// ── detail page ──────────────────────────────────────────────────────────────

/** What Insight can say about one gear, and — just as importantly — what it
 *  cannot. Every branch here is a real state the page reaches: the upstream is
 *  off, still loading, broken, the gear was never matched to a directory, or it
 *  was matched and simply had a quiet quarter. */
function ActivityPanel({
  name,
  activity,
  index,
  days,
  onDays,
}: {
  name: string;
  activity: GearActivity | undefined;
  index: ActivityIndex;
  days: number;
  onDays: (days: number) => void;
}) {
  const window = ACTIVITY_WINDOWS.find((w) => w.days === days)?.label ?? `${days} days`;
  return (
    <section className="act-panel">
      <header>
        <h2>Delivery activity</h2>
        <span className="seg" role="tablist" aria-label="Activity window">
          {ACTIVITY_WINDOWS.map((w) => (
            <button key={w.days} aria-pressed={days === w.days} onClick={() => onDays(w.days)}>
              {w.label}
            </button>
          ))}
        </span>
      </header>
      {index.status === "loading" ? (
        <p className="act-empty">Reading Constructor Insight…</p>
      ) : index.status === "error" ? (
        <p className="act-empty">Constructor Insight is unavailable — {index.error}</p>
      ) : index.status === "off" ? (
        <p className="act-empty">
          No repository on this component, so there is nothing for Insight to measure.
        </p>
      ) : !activity ? (
        <p className="act-empty">
          No directory named after <code>{name}</code> changed in the last {window.toLowerCase()} —
          either the gear was quiet, or its sources sit under a different directory name.
        </p>
      ) : (
        <>
          <p className="act-note">
            Commits touching a <code>{name}</code> directory, {index.from} → {index.to}, from
            Constructor Insight. CI runs are not here and cannot be: a pipeline run names a commit,
            not a file.
          </p>
          <ActivityTiles activity={activity} />
          <ChurnChart points={activity.points} label={`Weekly change in ${name}`} />
          {activity.pull_requests && (
            <>
              <p className="act-note act-prs-note">
                <b>Pull requests</b> opened in the window that touched <code>{name}</code>, by the
                state they are in now. A PR belongs to the repository, so this is an attribution
                through the files it changed: one touching three gears counts in all three, and a
                PR abandoned without merging often has no file record at all — dependable for what
                shipped, indicative for what did not.
              </p>
              <PullRequestTiles prs={activity.pull_requests} previous={activity.pull_requests_previous} />
            </>
          )}
        </>
      )}
    </section>
  );
}

function GearDetail({
  token,
  gear,
  profile,
  values: given,
  schema,
  activity,
  activityDays,
  onActivityDays,
  baselines,
  onBack,
  onSaved,
}: {
  token: string;
  gear: CatalogNode;
  /** What the editor writes. The table below reads `values`. */
  profile: Record<string, unknown> | undefined;
  /** Reconciled fields, from the gear that owns the precedence. */
  values: Values;
  /** The presentation of this component's TYPE, as the catalogue serves it.
   *  Rendering a micro-frontend against the gear schema is a page of "no data"
   *  with its handful of real values lost in it, which is what this page used
   *  to do. */
  schema: Schema;
  activity: ActivityIndex;
  activityDays: number;
  onActivityDays: (days: number) => void;
  baselines: Baselines;
  onBack: () => void;
  onSaved: (profile: Record<string, unknown>) => void;
}) {
  const name = String(gear.value.name ?? gear.instance_id);
  const schemaFields = useMemo(() => schema.groups.flatMap((g) => g.fields), [schema]);
  const [view, setView] = useState<View>("filled");
  const [versions, setVersions] = useState<CatalogNode[] | null>(null);
  const [editing, setEditing] = useState(false);

  const values = useMemo(() => {
    // The reconciled fields, plus one fallback this view alone can make: it
    // is the only place that fetches the version list, and a gear node from
    // before the parser surfaced `license` has the answer only there.
    const base: Values = { ...given };
    if (!base.licence) {
      const lic = licenceFromVersions(versions);
      if (lic) base.licence = { v: lic, b: lic };
    }
    return base;
  }, [given, versions]);
  const filled = schemaFields.filter((f) => values[f.key]).length;
  const pct = schemaFields.length ? Math.round((filled / schemaFields.length) * 100) : 0;
  const derivable = schemaFields.filter(
    (f) => f.source.class === "repo" || f.source.class === "api",
  ).length;

  useEffect(() => {
    let live = true;
    api
      .listComponentVersions(token, name)
      .then(({ nodes }) => {
        // Newest first, ordered by the catalogue: which version is newer is
        // a judgement, and it was being made a second time here.
        if (live) setVersions(nodes ?? []);
      })
      .catch(() => {
        if (live) setVersions([]);
      });
    return () => {
      live = false;
    };
  }, [token, name]);

  const diagram = (profile?.diagram ?? gear.value.diagram) as ArchDiagram | undefined;
  const uml = (profile?.uml ?? gear.value.uml) as UmlBlock[] | undefined;

  return (
    <>
      <div className="gcat-topbar">
        <div className="crumb">
          <button className="iconbtn" onClick={onBack}>
            ← Gears
          </button>
          <span className="sep">/</span>
          <h1 title={name}>{displayName(name)}</h1>
        </div>
        <div className="seg" role="tablist" aria-label="View">
          {(["empty", "filled", "sources"] as View[]).map((v) => (
            <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>
              {v === "empty" ? "Empty" : v === "filled" ? "Filled" : "Sources"}
            </button>
          ))}
        </div>
        <div className="gauge">
          <Ring pct={view === "empty" ? 0 : pct} />
          <div className="gtxt">
            {view === "empty" ? (
              "The state a component page starts in — every cell a question."
            ) : (
              <>
                <b>{filled}</b> of {schemaFields.length} fields answered · {derivable} derivable from the
                repository
              </>
            )}
          </div>
        </div>
      </div>

      {gear.value.description && <p className="gcat-sub">{String(gear.value.description)}</p>}

      {view === "filled" && <HealthStrip values={values} schema={schema} />}
      {view === "filled" && <Kpis values={values} schema={schema} />}
      {view === "filled" && (
        <ActivityPanel
          name={name}
          activity={activity.byGear.get(name)}
          index={activity}
          days={activityDays}
          onDays={onActivityDays}
        />
      )}

      {view === "filled" && <QualityPanel values={values} />}
      {view === "filled" && <ResponsibilityPanel values={values} />}
      {view === "filled" && baselines.status === "ready" && (
        <ChangesPanel trend={fieldTrend(schemaFields, values, baselines.byName.get(name))} days={activityDays} />
      )}

      <div className="grid">
        {(view === "filled"
          ? // The map above is the Responsibility group, laid out by role.
            answeredGroups(schema, values).filter((g) => g.id !== "responsibility")
          : schema.groups
        ).map((group) => (
          <Panel key={group.id} group={group} values={values} view={view} />
        ))}
      </div>

      {diagram && diagram.nodes?.length ? <ArchPanel diagram={diagram} view={view} /> : null}
      {uml && uml.length ? <UmlPanel blocks={uml} view={view} /> : null}

      <Versions name={name} rows={versions} repository={gear.value.repository as string | undefined} />

      <div className="editrow">
        <button className="iconbtn" onClick={() => setEditing((e) => !e)}>
          {editing ? "Close editor" : "Edit Gear profile"}
        </button>
        {gear.value.repository && (
          <a href={String(gear.value.repository)} target="_blank" rel="noreferrer">
            Repository
          </a>
        )}
        <a href={`https://crates.io/crates/${encodeURIComponent(name)}`} target="_blank" rel="noreferrer">
          crates.io
        </a>
      </div>

      {editing && <ProfileEditor token={token} name={name} profile={profile} onSaved={onSaved} />}
    </>
  );
}

// ── panel + rows ─────────────────────────────────────────────────────────────

interface GradePart {
  area: string;
  label: string;
  pass: boolean;
  /** Whether its input had an answer; a failure without one is missing data, not a finding. */
  known?: boolean;
  fix: string;
}

/**
 * The Components table's Review column: the one check to look at first, and
 * how many more there are, told apart by what they need -- a fix in the
 * component, or data connected or recorded (review-summary.ts). Opening it
 * lists them with what to do, without opening the component.
 */
function ReviewCell({ parts }: { parts: ReviewPart[] | undefined }) {
  const summary = reviewOf(parts);
  if (!summary) return <span className="gcat-absent">Not graded</span>;
  const counts = reviewCounts(summary);
  if (!summary.top || !counts) return <span className="gcat-review-clear">No open checks</span>;
  const items = [...summary.toReview, ...summary.noData];
  return (
    <details className="gcat-review" onClick={(e) => e.stopPropagation()}>
      <summary title={summary.top.fix}>
        <span className={`gcat-review-top${summary.top.known === false ? " nodata" : ""}`}>{summary.top.label}</span>
        <span className="gcat-sub">{counts}</span>
      </summary>
      <ul>
        {items.map((p) => (
          <li key={`${p.area}:${p.label}`} className={p.known === false ? "nodata" : ""}>
            <b>{p.label}</b>
            <span className="gcat-sub">
              {p.known === false ? "No data · " : ""}
              {p.fix}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Who answers for the component, role by role, and which roles nobody
 *  holds yet (responsibility.ts). An unheld role says where its answer would
 *  come from, so the gap reads as something to fill, not as missing data. */
function ResponsibilityPanel({ values }: { values: Values }) {
  const map = responsibilityOf(values);
  return (
    <section className="panel resp" id="panel-responsibility">
      <header>
        <h2>Responsibility</h2>
        <span className="cnt">
          {map.held} of {map.roles.length} roles held
        </span>
      </header>
      <div className="resp-grid">
        {map.roles.map((r) => (
          <div key={r.key} className={`resp-role${r.holders.length ? "" : " open"}`}>
            <span className="resp-k">{r.role}</span>
            {r.holders.length ? (
              <span className="resp-who">
                {r.lamp && <span className={`tl ${r.lamp}`} />}
                {r.link ? (
                  <a href={r.link} target="_blank" rel="noreferrer">
                    {r.holders.join(", ")}
                  </a>
                ) : (
                  r.holders.join(", ")
                )}
              </span>
            ) : (
              <span className="resp-who none">Not recorded</span>
            )}
            <span className="resp-src">{r.source}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const TONE_WORD = { better: "Better", worse: "Worse", neutral: "Changed" } as const;

/** How many graded fields got worse and better since the window opened; nothing
 *  when none moved, since "0 worse, 0 better" on every row is noise. */
function TrendMark({ trend }: { trend: FieldTrend | undefined }) {
  if (!trend || trend.better + trend.worse === 0) return null;
  return (
    <span className="trend-mark" title={`Graded fields that moved since ${trend.since}`}>
      {trend.worse > 0 && <span className="act-trend act-trend-worse">▼ {trend.worse} worse</span>}
      {trend.worse > 0 && trend.better > 0 && " · "}
      {trend.better > 0 && <span className="act-trend act-trend-better">▲ {trend.better} better</span>}
    </span>
  );
}

/** What moved since the window opened, against the snapshot the catalogue
 *  kept then. Worse first: that is what the reader came to find. */
function ChangesPanel({ trend, days }: { trend: FieldTrend | undefined; days: number }) {
  return (
    <section className="panel changes" id="panel-changes">
      <header>
        <h2>Since {trend ? whenLabel(trend.since) || trend.since : `${days} days ago`}</h2>
        <span className="cnt">
          {trend
            ? `${trend.changes.length} changed · ${trend.worse} worse · ${trend.better} better`
            : "no snapshot yet"}
        </span>
      </header>
      {!trend ? (
        <p className="chg-empty">
          The catalogue keeps one snapshot of each component a day, on every sync. None of this one is from the
          window yet, so there is nothing to compare with.
        </p>
      ) : trend.changes.length === 0 ? (
        <p className="chg-empty">Nothing changed since {trend.since}.</p>
      ) : (
        <table className="chg">
          <tbody>
            {trend.changes.map((c) => (
              <tr key={c.key}>
                <td className="chg-k">{c.label}</td>
                <td className="chg-was">{c.before}</td>
                <td className="chg-arrow">→</td>
                <td>{c.now}</td>
                <td>
                  <span className={`act-trend act-trend-${c.tone}`}>{TONE_WORD[c.tone]}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The grade, criterion by criterion: what it meets, and for what it does
 *  not, what to do. Grouped by area, failures first within each. */
function QualityPanel({ values }: { values: Values }) {
  const g = values.grade as (FieldVal & { parts?: GradePart[]; capped?: boolean }) | null | undefined;
  if (!g?.b || !g.parts?.length) return null;
  const areas: string[] = [];
  for (const p of g.parts) if (!areas.includes(p.area)) areas.push(p.area);
  return (
    <section className="panel quality" id="panel-quality">
      <header>
        <span className={`qgrade ${g.s ?? ""}`}>{g.b}</span>
        <h2>Quality</h2>
        <span className="cnt">{g.v}</span>
      </header>
      <div className="qareas">
        {areas.map((area) => {
          const parts = g.parts!.filter((p) => p.area === area).sort((a, b) => Number(a.pass) - Number(b.pass));
          const met = parts.filter((p) => p.pass).length;
          return (
            <div key={area} className="qarea">
              <div className="qarea-head">
                <b>{area}</b>
                <span>
                  {met} / {parts.length}
                </span>
              </div>
              <ul>
                {parts.map((p) => (
                  <li key={p.label} className={p.pass ? "pass" : p.known === false ? "fail nodata" : "fail"}>
                    {/* No answer is not a red finding: it is data nobody
                        connected yet, and says so in words too. */}
                    <span className={`tl ${p.pass ? "good" : p.known === false ? "watch" : "bad"}`} />
                    <span className="qlabel">{p.label}</span>
                    {!p.pass && (
                      <span className="qfix">
                        {p.known === false ? "No data · " : ""}
                        {p.fix}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The groups with at least one answered field, each cut down to those fields.
 *
 *  A page of "no data" rows buries the handful of real values; the Empty and
 *  Sources views still show every field, because there the gaps are the point. */
function answeredGroups(schema: Schema, values: Values): Group[] {
  return schema.groups
    .map((g) => ({ ...g, fields: g.fields.filter((f) => values[f.key]) }))
    .filter((g) => g.fields.length > 0);
}

function Panel({ group, values, view }: { group: Group; values: Values; view: View }) {
  const health = groupHealth(group, values);
  return (
    <section className="panel" id={`panel-${group.id}`}>
      <header>
        <span className="ic">{group.icon}</span>
        <h2>{group.title}</h2>
        {view === "filled" && health.worst && <span className={`tl ${health.worst}`} />}
        <span className="cnt">{group.fields.length}</span>
      </header>
      <div className="rows">
        {group.fields.map((field) => (
          <Row key={field.key} field={field} values={values} view={view} />
        ))}
      </div>
    </section>
  );
}

function Row({ field, values, view }: { field: Field; values: Values; view: View }) {
  const raw = values[field.key];
  const lamp = lampOf(field, values);
  const dated = view === "filled" && raw?.u ? whenLabel(raw.u) : "";

  return (
    <div className={`row${dated ? " dated" : ""}`}>
      <div className="k">{field.label}</div>
      <div className="val">
        <ValueCell field={field} raw={raw} lamp={lamp} view={view} />
      </div>
      {dated && (
        <span className="upd" title={`last changed ${raw?.u}`}>
          {dated}
        </span>
      )}
    </div>
  );
}

const BOOLGLYPH: Record<string, string> = { good: "yes", watch: "yes", bad: "no", none: "no" };

function ValueCell({
  field,
  raw,
  lamp,
  view,
}: {
  field: Field;
  raw: FieldVal | null;
  lamp: Lamp | null;
  view: View;
}) {
  if (view === "empty") return <span className="q">?</span>;

  if (view === "sources") {
    const chip = <span className={`src ${field.source.class}`}>{field.source.ref}</span>;
    return raw?.l ? (
      <a href={raw.l} target="_blank" rel="noreferrer">
        {chip}
      </a>
    ) : (
      chip
    );
  }

  const dot = lamp ? <span className={`tl ${lamp}`} /> : null;
  const brief = raw ? raw.b ?? raw.v ?? "" : null;

  if (!raw || brief === null) {
    const body =
      field.kind === "label" ? (
        <span className="pill unset">not set</span>
      ) : (
        <span className="novalue">no data</span>
      );
    return (
      <span className="wrap">
        {body}
        {dot}
      </span>
    );
  }

  const link = (t: string) =>
    raw.l ? (
      <a href={raw.l} target="_blank" rel="noreferrer">
        {t}
      </a>
    ) : (
      <>{t}</>
    );

  let body: ReactNode;
  switch (field.kind) {
    case "label":
      body = <span className="pill">{link(brief)}</span>;
      break;
    case "docstate": {
      const st =
        brief === "done" ? "ds-done" : brief === "in progress" ? "ds-wip" : "ds-na";
      body = <span className={`pill ${st}`}>{link(brief)}</span>;
      break;
    }
    case "bool":
      body = <span className="bool">{link(BOOLGLYPH[raw.s ?? "good"] ?? "yes")}</span>;
      break;
    case "metric":
      body = <span className="num">{link(brief)}</span>;
      break;
    case "status":
      body = <span className="bstrong">{link(brief)}</span>;
      break;
    default:
      body = <span className="txtval">{link(brief)}</span>;
  }
  return (
    <span className="wrap">
      {body}
      {dot}
    </span>
  );
}

// ── health strip ─────────────────────────────────────────────────────────────

function HealthStrip({ values, schema }: { values: Values; schema: Schema }) {
  const goTo = (id: string) => {
    document.getElementById(`panel-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  return (
    <div className="health">
      {answeredGroups(schema, values).filter((group) => groupHealth(group, values).n > 0).map((group) => {
        const h = groupHealth(group, values);
        const order: Lamp[] = ["bad", "watch", "good", "grey"];
        const pips = h.n
          ? order.flatMap((k) => Array<Lamp>(h.counts[k]).fill(k))
          : null;
        return (
          <button key={group.id} className="hcell" onClick={() => goTo(group.id)} title={group.title}>
            <span className="hh">{group.title}</span>
            <span className="lamps">
              {pips ? (
                pips.map((k, i) => <span key={i} className={`tl ${k}`} />)
              ) : (
                <span className="lc">info only</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── KPIs: composition bar + facts ────────────────────────────────────────────

function Kpis({ values, schema }: { values: Values; schema: Schema }) {
  const parts = schema.composition.map((c) => ({ ...c, n: values[c.key]?.n ?? 0 }));
  const total = parts.reduce((a, p) => a + p.n, 0);
  const ratio = values.ratio?.b ?? values.ratio?.v ?? "—";
  const adr = values.adr?.n;
  const hasRatio = Boolean(values.ratio?.b ?? values.ratio?.v);
  // ADRs alone are already in the Specification group; the block is for size.
  if (total === 0 && !hasRatio) return null;

  return (
    <div className="kpis">
      {total > 0 && (
      <div className="compo">
        <div className="cbar">
          {total > 0 ? (
            parts
              .filter((p) => p.n)
              .map((p) => (
                <span
                  key={p.key}
                  style={{ width: `${((p.n / total) * 100).toFixed(2)}%`, background: p.color }}
                  title={`${p.label}: ${p.n.toLocaleString("en-US")} lines`}
                />
              ))
          ) : (
            <span style={{ width: "100%", background: "var(--studio-surface-sunken)" }} />
          )}
        </div>
        <div className="ckeys">
          {parts.map((p) => (
            <span key={p.key} className="ck">
              <i style={{ background: p.color }} />
              {p.label}
              <b>{p.n.toLocaleString("en-US")}</b>
            </span>
          ))}
          <span className="ck tot">{total.toLocaleString("en-US")} lines total</span>
        </div>
      </div>
      )}
      <div className="facts">
        {total > 0 && <Fact label="Total lines" value={total.toLocaleString("en-US")} note="spec, code and tests" />}
        {hasRatio && <Fact label="Spec to code" value={ratio} note="lines of code per line of spec" />}
        {adr !== undefined && <Fact label="ADRs" value={String(adr)} note="recorded decisions" />}
      </div>
    </div>
  );
}

function Fact({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="fact">
      <span className="fl">{label}</span>
      <span className="fv">{value}</span>
      <span className="fn">{note}</span>
    </div>
  );
}

// ── completeness ring ────────────────────────────────────────────────────────

function Ring({ pct }: { pct: number }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  const off = c * (1 - pct / 100);
  return (
    <span className="ring">
      <svg width={40} height={40}>
        <circle cx={20} cy={20} r={r} fill="none" stroke="var(--studio-line)" strokeWidth={4} />
        <circle
          cx={20}
          cy={20}
          r={r}
          fill="none"
          stroke="var(--studio-accent)"
          strokeWidth={4}
          strokeDasharray={c}
          strokeDashoffset={off}
          strokeLinecap="round"
        />
      </svg>
      <span className="lab">{pct}%</span>
    </span>
  );
}

// ── architecture diagram ─────────────────────────────────────────────────────

interface ArchNode {
  id: string;
  label: string;
  sub?: string;
  kind: string;
  col: number;
  row: number;
}
interface ArchEdge {
  f: string;
  t: string;
  l: string;
  d?: number;
}
interface ArchNote {
  h: string;
  items: string[];
}
interface ArchDiagram {
  cols: number;
  rows: number;
  nodes: ArchNode[];
  edges: ArchEdge[];
  notes?: ArchNote[];
}

const NW = 176;
const NH = 56;
const GX = 62;
const GY = 52;
const PAD = 14;
const KIND: Record<string, [string, string, string]> = {
  backend: ["var(--dg-backend-fill)", "var(--dg-backend-stroke)", "Backend"],
  database: ["var(--dg-db-fill)", "var(--dg-db-stroke)", "Database"],
  external: ["var(--dg-ext-fill)", "var(--dg-ext-stroke)", "External"],
  security: ["var(--dg-sec-fill)", "var(--dg-sec-stroke)", "Security"],
  messagebus: ["var(--dg-bus-fill)", "var(--dg-bus-stroke)", "Message bus"],
};

function box(n: ArchNode) {
  const x = PAD + (n.col - 1) * (NW + GX);
  const y = PAD + (n.row - 1) * (NH + GY);
  return { x, y, cx: x + NW / 2, cy: y + NH / 2, r: x + NW, b: y + NH };
}

function ArchPanel({ diagram, view }: { diagram: ArchDiagram; view: View }) {
  const kinds = Array.from(new Set(diagram.nodes.map((n) => n.kind)));
  const W = PAD * 2 + diagram.cols * NW + (diagram.cols - 1) * GX;
  const H = PAD * 2 + diagram.rows * NH + (diagram.rows - 1) * GY;
  const byId: Record<string, ReturnType<typeof box>> = Object.fromEntries(
    diagram.nodes.map((n) => [n.id, box(n)]),
  );

  const lanes: Record<string, ArchEdge[]> = {};
  for (const e of diagram.edges) {
    const a = byId[e.f];
    const b = byId[e.t];
    if (!a || !b || a.cy === b.cy) continue;
    const key = e.f + (b.cy < a.cy ? "-up" : "-dn");
    (lanes[key] = lanes[key] ?? []).push(e);
  }

  return (
    <section className="panel wide" id="panel-arch">
      <header>
        <span className="ic">A</span>
        <h2>Architecture</h2>
        <span className="cnt">
          {diagram.nodes.length} components · {diagram.edges.length} links
        </span>
      </header>
      {view === "empty" ? (
        <div className="blank">No diagram generated. A component page starts with an empty canvas.</div>
      ) : (
        <div className="archbody">
          <div className="canvas">
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Architecture diagram">
              <defs>
                <marker id="ah-s" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                  <path d="M0 0 L10 5 L0 10 z" fill="var(--dg-arrow)" />
                </marker>
                <marker id="ah-d" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
                  <path d="M0 0 L10 5 L0 10 z" fill="var(--dg-arrow-dash)" />
                </marker>
              </defs>
              {diagram.edges.map((e, idx) => {
                const a = byId[e.f];
                const b = byId[e.t];
                if (!a || !b) return null;
                const dash = e.d ? "5 4" : undefined;
                const col = e.d ? "var(--dg-arrow-dash)" : "var(--dg-arrow)";
                const mk = e.d ? "url(#ah-d)" : "url(#ah-s)";
                let path: string;
                let lx: number;
                let ly: number;
                if (a.cy === b.cy) {
                  const right = b.x > a.x;
                  const x1 = right ? a.r : a.x;
                  const x2 = right ? b.x - 7 : b.r + 7;
                  path = `M${x1} ${a.cy} L${x2} ${b.cy}`;
                  lx = (x1 + x2) / 2;
                  ly = a.cy - 9;
                } else {
                  const up = b.cy < a.cy;
                  const y1 = up ? a.y : a.b;
                  const y2 = up ? b.b + 7 : b.y - 7;
                  const key = e.f + (up ? "-up" : "-dn");
                  const lane = lanes[key] ?? [e];
                  const i = lane.indexOf(e);
                  const n = lane.length;
                  const mid = up ? y1 - ((y1 - y2) * (i + 1)) / (n + 1) : y1 + ((y2 - y1) * (i + 1)) / (n + 1);
                  path = `M${a.cx} ${y1} L${a.cx} ${mid} L${b.cx} ${mid} L${b.cx} ${y2}`;
                  lx = (a.cx + b.cx) / 2;
                  ly = mid - 7;
                }
                return (
                  <g key={idx}>
                    <path d={path} fill="none" stroke={col} strokeWidth={1.4} strokeDasharray={dash} markerEnd={mk} />
                    <text x={lx} y={ly} textAnchor="middle" className={`elab${e.d ? " d" : ""}`}>
                      {e.l}
                    </text>
                  </g>
                );
              })}
              {diagram.nodes.map((n) => {
                const p = box(n);
                const k = KIND[n.kind] ?? KIND.external;
                return (
                  <g key={n.id}>
                    <rect x={p.x} y={p.y} width={NW} height={NH} rx={9} fill={k[0]} stroke={k[1]} strokeWidth={1.3} />
                    <text x={p.cx} y={p.y + (n.sub ? 23 : 32)} textAnchor="middle" className="nlab">
                      {n.label}
                    </text>
                    {n.sub && (
                      <text x={p.cx} y={p.y + 38} textAnchor="middle" className="nsub">
                        {n.sub}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="legend">
            {kinds.map((k) => {
              const c = KIND[k] ?? KIND.external;
              return (
                <span key={k} className="lg">
                  <i style={{ background: c[0], borderColor: c[1] }} />
                  {c[2]} <span className="mono">{diagram.nodes.filter((n) => n.kind === k).length}</span>
                </span>
              );
            })}
          </div>
          {diagram.notes && diagram.notes.length > 0 && (
            <div className="notes">
              {diagram.notes.map((nn, i) => (
                <div key={i} className="note">
                  <h3>{nn.h}</h3>
                  <ul>
                    {nn.items.map((it, j) => (
                      <li key={j}>{it}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ── UML blocks (titled sources; mermaid-ready) ───────────────────────────────

interface UmlBlock {
  title: string;
  kind?: string;
  note?: string;
  src?: string;
  l?: string;
  code: string;
}

// Mermaid is loaded once from the CDN and reused for every diagram on the page.
type MermaidApi = {
  initialize: (cfg: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
};
let mermaidPromise: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = new Promise<MermaidApi>((resolve, reject) => {
    const w = window as unknown as { mermaid?: MermaidApi };
    if (w.mermaid) {
      resolve(w.mermaid);
      return;
    }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.3/mermaid.min.js";
    s.onload = () => {
      const m = (window as unknown as { mermaid?: MermaidApi }).mermaid;
      if (!m) {
        reject(new Error("mermaid unavailable"));
        return;
      }
      try {
        // No `theme` here on purpose. Every render re-initializes with the one
        // `surfaceIsDark` measured off the panel the diagram actually lands on,
        // and seeding this from the OS preference only gave the first diagram a
        // chance to flash the wrong one.
        m.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          fontFamily: "var(--studio-sans, 'Inter Variable', system-ui, sans-serif)",
        });
      } catch {
        /* keep going with defaults */
      }
      resolve(m);
    };
    s.onerror = () => reject(new Error("failed to load mermaid"));
    document.head.appendChild(s);
  });
  return mermaidPromise;
}

let mermaidSeq = 0;

/** Is the surface this element sits on dark? Walks up to the first ancestor
 *  with a real (non-transparent) background and measures its luminance, so the
 *  mermaid theme follows the actual panel colour rather than the OS setting.
 *  Falls back to the portal's own theme flag when nothing opaque is found —
 *  the OS preference is a different switch and answering with it was how a
 *  dark diagram used to land in a light page. */
function surfaceIsDark(el: HTMLElement | null): boolean {
  let node: HTMLElement | null = el;
  while (node) {
    const nums = getComputedStyle(node).backgroundColor.match(/[\d.]+/g);
    if (nums && nums.length >= 3 && !(nums.length >= 4 && Number(nums[3]) === 0)) {
      const [r, g, b] = nums.map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
    }
    node = node.parentElement;
  }
  return document.documentElement.dataset.theme === "dark";
}

/** Work around mermaid quirks in prose-heavy diagrams lifted from docs: `;` is
 *  a statement separator, so a semicolon in a Note/message breaks the parse.
 *  Convert it to a comma while preserving any HTML entities (&amp; &#39; …). */
function sanitizeMermaid(src: string): string {
  // Mermaid treats ';' as a statement separator, which mangles prose in
  // Notes and messages lifted from docs. Convert to ',' for rendering.
  return src.replace(/;/g, ",");
}

/** Renders one mermaid diagram, falling back to source when it can't. */
function Mermaid({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const empty = !code || !code.trim();

  useEffect(() => {
    if (empty) return;
    let alive = true;
    setFailed(false);
    loadMermaid()
      .then(async (m) => {
        const id = `cmp-mmd-${mermaidSeq++}`;
        try {
          // Match the diagram theme to the surface it actually renders on, not
          // the OS preference: the Studio panels are dark regardless of
          // prefers-color-scheme, so a light ("default") theme would draw dark
          // strokes on a dark panel and vanish.
          m.initialize({
            startOnLoad: false,
            securityLevel: "loose",
            theme: surfaceIsDark(ref.current) ? "dark" : "default",
            fontFamily: "var(--studio-sans, 'Inter Variable', system-ui, sans-serif)",
          });
          const { svg } = await m.render(id, sanitizeMermaid(code));
          // Mermaid may return an error diagram (the "bomb") instead of throwing.
          if (/aria-roledescription="error"|>\s*Syntax error/i.test(svg)) {
            throw new Error("mermaid syntax error");
          }
          if (alive && ref.current) ref.current.innerHTML = svg;
        } catch {
          if (alive) setFailed(true);
        } finally {
          // Remove only stray nodes mermaid may append directly to <body> on
          // error. NEVER use getElementById(id) here: the rendered SVG's root
          // carries that same id, so it would match — and delete — the diagram
          // we just inserted into our own ref, leaving a blank box.
          document
            .querySelectorAll(`body > [id="${id}"], body > [id="d${id}"]`)
            .forEach((n) => n.remove());
        }
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [code, empty]);

  if (empty) {
    return (
      <div className="mermaid-empty">
        No diagram source was captured for this block. Re-run <strong>Sync</strong> with the
        repository source selected to lift it from <code>docs/DESIGN.md</code>.
      </div>
    );
  }
  if (failed) return <pre className="mermaid-src">{code}</pre>;
  return <div className="mermaid-view" ref={ref} aria-label="diagram" />;
}

// ── component dependency graph ───────────────────────────────────────────────

function graphNodeName(g: CatalogNode): string {
  return String(g.value.name ?? g.instance_id);
}
function shortComponentName(name: string): string {
  return name.replace(/^cf-gears-/, "").replace(/^@[^/]+\//, "");
}
function kindClass(kind: string): string {
  return ["gear", "sdk", "plugin", "toolkit", "frontx"].includes(kind) ? kind : "other";
}
function componentDeps(profile: Record<string, unknown> | undefined): string[] {
  const auto = profile?.auto;
  if (auto && typeof auto === "object" && !Array.isArray(auto)) {
    const dn = (auto as Record<string, unknown>).deps_names;
    if (Array.isArray(dn)) return dn.filter((x): x is string => typeof x === "string");
  }
  return [];
}

interface GraphModel {
  /** Mermaid source containing only the nodes that participate in an edge. */
  code: string;
  /** Number of dependency edges drawn. */
  edgeCount: number;
  /** Components with no mapped dependency (kept out of the diagram). */
  isolated: number;
}

/** One hue per component kind, taken from the product's categorical set
 *  (--avatar-*). This map is the only place the association is written: the
 *  mermaid diagram, the legend beside it and the chip rules in the stylesheet
 *  all read it, so a kind cannot come out three different colours. */
const KIND_COLOR: Record<string, string> = {
  gear: "var(--avatar-mint)",
  sdk: "var(--avatar-blue)",
  plugin: "var(--avatar-purple)",
  toolkit: "var(--avatar-yellow)",
  frontx: "var(--avatar-red)",
  other: "var(--avatar-grey)",
};

/** Build a mermaid `graph LR` from components and their inter-dependencies.
 *  Only *connected* components are drawn — a wall of isolated boxes is noise,
 *  not a graph — and the caller reports how many were left out. Intentionally
 *  uses no semicolons: the renderer's sanitizer turns ';' into ',', so classDef
 *  statements are terminated by newlines instead. */
function buildComponentGraph(
  nodes: CatalogNode[],
  profiles: Record<string, Record<string, unknown>>,
): GraphModel {
  const idByName = new Map<string, string>();
  nodes.forEach((g, i) => idByName.set(graphNodeName(g), `c${i}`));

  // Resolve edges first so we know which nodes are actually connected.
  const edges: Array<[number, number]> = [];
  const seen = new Set<string>();
  const connected = new Set<number>();
  nodes.forEach((g, i) => {
    for (const dep of componentDeps(profiles[graphNodeName(g)])) {
      const tid = idByName.get(dep);
      if (!tid) continue;
      const j = Number(tid.slice(1));
      if (j === i || seen.has(`${i}>${j}`)) continue;
      seen.add(`${i}>${j}`);
      edges.push([i, j]);
      connected.add(i);
      connected.add(j);
    }
  });

  const lines = ["graph LR"];
  nodes.forEach((g, i) => {
    if (!connected.has(i)) return;
    const label = shortComponentName(graphNodeName(g)).replace(/"/g, "'");
    lines.push(`  c${i}["${label}"]:::${kindClass(String(g.value.kind ?? "gear"))}`);
  });
  for (const [i, j] of edges) lines.push(`  c${i} --> c${j}`);
  // classDef values are templated straight into each node's style attribute, so
  // a var() reference survives into the SVG and resolves against .gcat — the
  // diagram follows the theme without mermaid knowing there is one.
  for (const [kind, color] of Object.entries(KIND_COLOR)) {
    lines.push(`classDef ${kind} stroke:${color},stroke-width:${kind === "other" ? 1 : 2}px`);
  }

  return {
    code: edges.length ? lines.join("\n") : "",
    edgeCount: edges.length,
    isolated: nodes.length - connected.size,
  };
}

/** The legend names every kind except `other`, which is the absence of one. */
const GRAPH_LEGEND: [string, string][] = (
  ["gear", "sdk", "plugin", "toolkit", "frontx"] as const
).map((kind) => [kind, KIND_COLOR[kind]]);

function ComponentGraph({ graph, nodes }: { graph: GraphModel; nodes: CatalogNode[] }) {
  const hasEdges = graph.edgeCount > 0;
  return (
    <div className="cgraph">
      <div className="cgraph-legend">
        {GRAPH_LEGEND.map(([k, c]) => (
          <span key={k} className="cgraph-lg">
            <i style={{ borderColor: c }} />
            {k}
          </span>
        ))}
        <span className="cgraph-count">
          {hasEdges
            ? `${graph.edgeCount} edges · ${graph.isolated} unlinked`
            : `${nodes.length} components`}
        </span>
      </div>
      {hasEdges ? (
        <div className="cgraph-canvas">
          <Mermaid code={graph.code} />
        </div>
      ) : (
        // No edges to draw: a stack of disconnected boxes is just a bad list, so
        // show a compact chip grid instead and say how to populate the graph.
        <div className="cgraph-empty">
          <p className="gcat-hint">
            No dependency links mapped yet. Dependencies are read from each component's Cargo /
            package manifests during Sync — components below aren't connected to any catalogued
            sibling.
          </p>
          <div className="cgraph-chips">
            {nodes.map((g) => (
              <span key={graphNodeName(g)} className={`cgraph-chip ${kindClass(String(g.value.kind ?? "gear"))}`}>
                {shortComponentName(graphNodeName(g))}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UmlPanel({ blocks, view }: { blocks: UmlBlock[]; view: View }) {
  if (view === "empty") {
    return (
      <section className="panel wide">
        <header>
          <span className="ic">U</span>
          <h2>UML</h2>
        </header>
        <div className="blank">No diagrams lifted yet.</div>
      </section>
    );
  }
  return (
    <section className="panel wide">
      <header>
        <span className="ic">U</span>
        <h2>UML</h2>
        <span className="cnt">{blocks.length}</span>
      </header>
      <div className="umlwrap">
        {blocks.map((b, i) => (
          <div key={i} className="uml">
            <div className="umlhead">
              <strong>{b.title}</strong>
              {b.kind && <span className="pill">{b.kind}</span>}
              {b.l && (
                <a href={b.l} target="_blank" rel="noreferrer">
                  {b.src ?? "source"}
                </a>
              )}
            </div>
            <Mermaid code={b.code} />
            {b.code && b.code.trim() ? (
              <details className="uml-src">
                <summary>source</summary>
                <pre className="mermaid-src">{b.code}</pre>
              </details>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── version history ──────────────────────────────────────────────────────────

function Versions({
  name,
  rows,
  repository,
}: {
  name: string;
  rows: CatalogNode[] | null;
  repository: string | undefined;
}) {
  return (
    <section className="panel wide" style={{ marginTop: 4 }}>
      <header>
        <span className="ic">V</span>
        <h2>Published versions</h2>
        <span className="cnt">{rows ? rows.length : "…"}</span>
      </header>
      <div className="verlinks">
        {repository && (
          <a href={repository} target="_blank" rel="noreferrer">
            repository
          </a>
        )}
        <a href={`https://crates.io/crates/${encodeURIComponent(name)}`} target="_blank" rel="noreferrer">
          crates.io
        </a>
      </div>
      {rows === null ? (
        <p className="gcat-empty">Loading versions…</p>
      ) : rows.length === 0 ? (
        <p className="gcat-empty">No versions.</p>
      ) : (
        <div className="tablewrap">
          <table className="vtable">
            <thead>
              <tr>
                <th>Version</th>
                <th>Published</th>
                <th>License</th>
                <th>Rust</th>
                <th>Size</th>
                <th>Downloads</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.instance_id}>
                  <td>
                    <code>{String(v.value.num ?? "—")}</code>
                    {v.value.yanked ? <span className="ymark"> · yanked</span> : ""}
                  </td>
                  <td>{dateText(v.value.created_at)}</td>
                  <td>{String(v.value.license ?? "—")}</td>
                  <td>{String(v.value.rust_version ?? "—")}</td>
                  <td>{sizeText(v.value.crate_size)}</td>
                  <td>{numText(v.value.downloads)}</td>
                  <td>{publishedBy(v.value.published_by)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function publishedBy(pb: unknown): string {
  if (pb && typeof pb === "object") {
    const o = pb as Record<string, unknown>;
    return String(o.name ?? o.login ?? "—");
  }
  return typeof pb === "string" ? pb : "—";
}

// ── profile editor ───────────────────────────────────────────────────────────

function ProfileEditor({
  token,
  name,
  profile,
  onSaved,
}: {
  token: string;
  name: string;
  profile: Record<string, unknown> | undefined;
  onSaved: (profile: Record<string, unknown>) => void;
}) {
  const [draft, setDraft] = useState(() =>
    JSON.stringify(profile ?? defaultProfile(name), null, 2),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const parsed: unknown = JSON.parse(draft);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("Profile must be a JSON object");
      }
      const saved = await api.saveComponentProfile(token, name, parsed as Record<string, unknown>);
      onSaved(saved.value as Record<string, unknown>);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="editor">
      <p className="gcat-hint">
        The profile is Studio-owned and survives crates.io sync. Put per-field answers under{" "}
        <code>values</code>, keyed by schema field id (e.g. <code>owner</code>, <code>coverage</code>),
        each a <code>{"{ v, b, n, s, l, u }"}</code> object — <code>s</code> is the lamp
        (good/watch/bad), <code>l</code> a link, <code>u</code> a YYYY-MM-DD date. Optional{" "}
        <code>diagram</code> and <code>uml</code> blocks render the architecture and UML sections.
      </p>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
      {error && <p className="gcat-err">{error}</p>}
      <div className="editbtns">
        <button className="iconbtn primary" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save profile"}
        </button>
      </div>
    </div>
  );
}

function defaultProfile(name: string): Record<string, unknown> {
  return {
    gear_name: name,
    values: {
      category: { v: "", b: "" },
      lifecycle: { v: "in development", b: "in development" },
      owner: { v: "", b: "", s: "grey", l: "" },
      coverage: { v: "", b: "", n: 0, s: "grey" },
    },
    diagram: null,
    uml: [],
  };
}

// ── styles (scoped under .gcat) ──────────────────────────────────────────────

const GCAT_CSS = `
/* The --studio-* names stay — some 150 rules below read them — but they are an
 * ALIAS LAYER now, not a palette: each one points at the product token that
 * holds the same role. Two consequences worth stating. The catalogue can no
 * longer drift from the portal around it, and the theme switch is a single
 * switch again: the block that used to redefine all of this under
 * prefers-color-scheme is gone, because these tokens already flip with
 * data-theme on <html>. On an OS in dark mode that block painted a dark
 * catalogue inside a light portal, which is the bug it hid. */
.gcat {
  --studio-bg:var(--card);
  --studio-chrome:var(--muted);
  --studio-surface:var(--card);
  --studio-surface-raised:var(--muted);
  --studio-surface-sunken:var(--secondary);
  --studio-text:var(--foreground);
  --studio-muted:var(--muted-foreground);
  --studio-line:var(--border);
  --studio-edge:var(--input);
  --studio-accent:var(--primary);
  --studio-on-accent:var(--primary-foreground);
  --studio-verified:var(--success);
  --studio-warning:var(--warning);
  --studio-danger:var(--destructive);
  --studio-shadow:color-mix(in oklab,var(--foreground) 14%,transparent);
  --studio-radius:var(--radius-lg);
  --studio-sans:var(--font-sans);
  --studio-mono:var(--font-mono);
  --studio-accent-soft:var(--accent);
  /* Architecture diagram: one hue per node kind, taken from the product's
   * categorical set, with each fill mixed from its own stroke over the card so
   * the pair stays a pair in either theme. */
  --dg-backend-fill:color-mix(in oklab,var(--avatar-mint) 12%,var(--card));
  --dg-backend-stroke:var(--avatar-mint);
  --dg-db-fill:color-mix(in oklab,var(--avatar-purple) 12%,var(--card));
  --dg-db-stroke:var(--avatar-purple);
  --dg-ext-fill:color-mix(in oklab,var(--avatar-grey) 12%,var(--card));
  --dg-ext-stroke:var(--avatar-grey);
  --dg-sec-fill:color-mix(in oklab,var(--avatar-red) 12%,var(--card));
  --dg-sec-stroke:var(--avatar-red);
  --dg-bus-fill:color-mix(in oklab,var(--avatar-yellow) 12%,var(--card));
  --dg-bus-stroke:var(--avatar-yellow);
  --dg-arrow:var(--muted-foreground);
  --dg-arrow-dash:var(--avatar-purple);
  color:var(--studio-text); font-size:var(--text-body-size); line-height:1.5;
}
.gcat * { box-sizing:border-box; }

.gcat .gcat-topbar { display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-bottom:12px; }
.gcat .crumb { display:flex; align-items:center; gap:10px; min-width:0; }
.gcat .crumb h1 { font-size:20px; font-weight:600; letter-spacing:-.015em; margin:0; }
.gcat .crumb .sep { color:var(--studio-edge); }
.gcat .asof { font-family:var(--studio-mono); font-size:10.5px; color:var(--studio-muted); }
.gcat .tools { display:flex; gap:8px; align-items:center; margin-left:auto; flex-wrap:wrap; }
.gcat input, .gcat textarea {
  font:inherit; color:var(--studio-text); background:var(--studio-surface);
  border:1px solid var(--studio-edge); border-radius:var(--radius-md); padding:6px 10px;
}
.gcat input { min-width:200px; }
.gcat .iconbtn {
  border:1px solid var(--studio-edge); background:var(--studio-surface); color:var(--studio-text);
  border-radius:var(--radius-md); padding:6px 12px; cursor:pointer; font:inherit; font-size:12.5px;
}
.gcat .iconbtn:hover { border-color:var(--studio-accent); }
.gcat .iconbtn.primary { background:var(--studio-accent); color:var(--studio-on-accent); border-color:var(--studio-accent); font-weight:600; }
.gcat .iconbtn.primary:disabled { opacity:.6; cursor:default; }
.gcat .iconbtn.active { border-color:var(--studio-accent); color:var(--studio-accent); background:var(--studio-accent-soft); }

/* sources panel */
.gcat .sources { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; margin:0 0 14px; }
.gcat .src-col { background:var(--studio-surface); border:1px solid var(--studio-line); border-radius:var(--studio-radius); padding:11px 13px 12px; box-shadow:0 1px 2px var(--studio-shadow); }
.gcat .src-head { display:flex; align-items:center; gap:8px; font-weight:600; font-size:12.5px; cursor:pointer; }
.gcat .src-head input { width:auto; min-width:0; }
.gcat .src-body { display:flex; flex-direction:column; gap:7px; margin-top:9px; }
.gcat .src-row { display:grid; grid-template-columns:78px 1fr; align-items:center; gap:8px; font-size:11.5px; color:var(--studio-muted); }
.gcat .src-row span { font-size:11px; }
.gcat .src-row input, .gcat .src-row select { width:100%; min-width:0; padding:4px 8px; font-size:12px; }
.gcat .src-row input:disabled, .gcat .src-row select:disabled { opacity:.5; }
.gcat .src-note { font-size:10.5px; color:var(--studio-muted); margin:2px 0 0; }

.gcat .seg { display:inline-flex; border:1px solid var(--studio-edge); border-radius:var(--radius-md); overflow:hidden; background:var(--studio-surface); }
.gcat .seg button { font:inherit; font-size:12px; background:none; border:0; cursor:pointer; color:var(--studio-muted); padding:5px 13px; border-right:1px solid var(--studio-line); }
.gcat .seg button:last-child { border-right:0; }
.gcat .seg button[aria-pressed="true"] { background:var(--studio-accent); color:var(--studio-on-accent); font-weight:600; }

.gcat .gauge { display:flex; align-items:center; gap:10px; margin-left:auto; }
.gcat .ring { position:relative; width:40px; height:40px; flex:none; }
.gcat .ring svg { transform:rotate(-90deg); }
.gcat .ring .lab { position:absolute; inset:0; display:grid; place-items:center; font-family:var(--studio-mono); font-size:10.5px; font-weight:600; }
.gcat .gtxt { font-size:11.5px; color:var(--studio-muted); line-height:1.35; max-width:280px; }
.gcat .gtxt b { color:var(--studio-text); font-family:var(--studio-mono); }

.gcat .gcat-types { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:0; }
.gcat .gcat-types-label { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--studio-muted); margin-right:2px; }
.gcat .gcat-type { font-size:12px; padding:3px 10px; border:1px solid var(--border); border-radius:var(--radius-full); background:transparent; cursor:pointer; color:inherit; }
.gcat .gcat-type:hover { border-color:var(--primary); }
.gcat .gcat-type.on { border-color:var(--primary); background:var(--accent); font-weight:600; }
.gcat .gcat-type-n { opacity:.55; font-variant-numeric:tabular-nums; margin-left:2px; }
.gcat .gcat-sub { font-size:14px; line-height:1.5; color:var(--studio-muted); max-width:82ch; margin:0 0 14px; }
.gcat .gcat-hint { font-size:11.5px; color:var(--studio-muted); margin:6px 0; }
.gcat .gcat-err { color:var(--studio-danger); font-size:12px; margin:6px 0; }
.gcat .gcat-empty { color:var(--studio-muted); font-style:italic; font-size:12.5px; padding:12px 0; }
.gcat code { font-family:var(--studio-mono); font-size:.92em; }

/* list cards */
.gcat .vtiles { grid-template-columns:repeat(auto-fill,minmax(360px,1fr)); gap:14px; }
.gcat .dt-tile { display:flex; }
.gcat .dt-tile > .ccard { flex:1; }
.gcat .ccards-summary { display:flex; flex-wrap:wrap; gap:6px 18px; font-size:12.5px; color:var(--studio-muted); margin:2px 2px 10px; }
.gcat .ccards-summary b { color:var(--studio-text); font-weight:600; }
.gcat .ccard {
  text-align:left; font:inherit; color:inherit; cursor:pointer;
  background:var(--studio-surface); border:1px solid var(--studio-line);
  border-radius:12px; padding:16px 18px 14px; display:flex; flex-direction:column; gap:0;
  box-shadow:0 1px 2px var(--studio-shadow); transition:border-color .15s, box-shadow .15s;
}
.gcat .ccard:hover { border-color:var(--studio-accent); box-shadow:0 4px 14px var(--studio-shadow); }
.gcat .ccard .dot { width:6px; height:6px; border-radius:50%; background:currentColor; display:inline-block; flex:none; }
.gcat .ccard-top { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.gcat .ccard-cat-row { display:inline-flex; align-items:center; gap:6px; }
.gcat .ccard-grade { font-size:11.5px; font-weight:700; min-width:20px; text-align:center; padding:1px 6px; border-radius:6px; border:1px solid currentColor; color:var(--studio-muted); }
.gcat .ccard-grade.good { color:var(--studio-verified); }
.gcat .ccard-grade.watch { color:var(--studio-warning); }
.gcat .ccard-grade.bad { color:var(--studio-danger); }
.gcat .panel.quality { margin-bottom:14px; }
.gcat .qgrade { font-weight:700; font-size:15px; min-width:26px; text-align:center; padding:1px 7px; border-radius:7px; border:1px solid currentColor; }
.gcat .qgrade.good { color:var(--studio-verified); }
.gcat .qgrade.watch { color:var(--studio-warning); }
.gcat .qgrade.bad { color:var(--studio-danger); }
.gcat .resp-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:10px 18px; padding:10px 14px 14px; }
.gcat .resp-role { display:flex; flex-direction:column; gap:2px; border-left:2px solid var(--studio-verified); padding-left:8px; }
.gcat .resp-role.open { border-left-color:var(--studio-line); }
.gcat .resp-k { font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--studio-muted); }
.gcat .resp-who { font-size:13px; font-weight:600; display:flex; align-items:center; gap:6px; }
.gcat .resp-who.none { font-weight:400; font-style:italic; color:var(--studio-muted); }
.gcat .resp-src { font-size:10.5px; color:var(--studio-muted); }
.gcat .trend-mark { white-space:nowrap; }
.gcat .chg { width:100%; border-collapse:collapse; font-size:12.5px; }
.gcat .chg td { padding:5px 14px; border-top:1px solid var(--studio-line); vertical-align:top; }
.gcat .chg-k { font-weight:600; white-space:nowrap; }
.gcat .chg-was { color:var(--studio-muted); text-decoration:line-through; }
.gcat .chg td.chg-arrow { color:var(--studio-muted); width:1%; padding:5px 0; }
.gcat .chg-empty { margin:0; padding:10px 14px 14px; font-size:12.5px; color:var(--studio-muted); }
.gcat .qareas { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:10px 18px; padding:10px 14px 14px; }
.gcat .qarea-head { display:flex; justify-content:space-between; font-size:12.5px; margin-bottom:4px; }
.gcat .qarea-head span { color:var(--studio-muted); font-variant-numeric:tabular-nums; }
.gcat .qarea ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px; }
.gcat .qarea li { display:grid; grid-template-columns:auto 1fr; column-gap:7px; align-items:baseline; font-size:12.5px; }
.gcat .qarea li.pass .qlabel { color:var(--studio-muted); }
.gcat .qfix { grid-column:2; font-size:11.5px; color:var(--studio-muted); }
.gcat .ccard-cat { font-size:12px; padding:2px 9px; border-radius:999px; color:var(--studio-accent); background:color-mix(in srgb, var(--studio-accent) 12%, transparent); border:1px solid color-mix(in srgb, var(--studio-accent) 25%, transparent); }
.gcat .ccard-stage { display:inline-flex; align-items:center; gap:6px; font-size:12.5px; color:var(--studio-muted); }
.gcat .ccard-stage.done { color:var(--studio-verified); }
.gcat .ccard-stage.late { color:var(--studio-warning); }
.gcat .ccard-stage.early { color:var(--studio-accent); }
.gcat .ccard-chev { color:var(--studio-muted); font-size:16px; line-height:1; margin-left:6px; }
.gcat .ccard-title { font-size:18px; font-weight:600; letter-spacing:-.01em; margin-top:12px; color:var(--studio-text); }
.gcat .ccard-desc { font-size:13.5px; color:var(--studio-muted); margin:4px 0 14px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-height:2.6em; }
.gcat .ccard-sec { border-top:1px solid var(--studio-line); padding:10px 0; }
.gcat .ccard-plan { display:flex; align-items:flex-start; gap:18px; flex-wrap:wrap; }
.gcat .ccard-axes { display:flex; gap:16px; }
.gcat .ccard-axis { display:flex; flex-direction:column; gap:3px; }
.gcat .ccard-k { font-size:10px; letter-spacing:.04em; color:var(--studio-muted); font-weight:600; }
.gcat .ccard-v { display:inline-flex; align-items:center; gap:5px; font-size:12px; font-weight:600; font-variant-numeric:tabular-nums; color:var(--studio-text); }
.gcat .ccard-v.full .dot { color:var(--studio-verified); }
.gcat .ccard-v.part .dot { color:var(--studio-accent); }
.gcat .ccard-v.na .dot { color:var(--studio-edge); }
.gcat .ccard-when { display:flex; flex-direction:column; gap:3px; }
.gcat .ccard-when-top { display:flex; align-items:center; gap:8px; }
.gcat .ccard-pill { font-size:10.5px; font-weight:600; padding:1px 7px; border-radius:999px; border:1px solid var(--studio-line); color:var(--studio-text); }
.gcat .ccard-sched { display:inline-flex; align-items:center; gap:5px; font-size:11.5px; }
.gcat .ccard-sched.good { color:var(--studio-verified); }
.gcat .ccard-sched.watch { color:var(--studio-warning); }
.gcat .ccard-sched.bad { color:var(--studio-danger); }
.gcat .ccard-sched.grey { color:var(--studio-muted); }
.gcat .ccard-due { font-size:12.5px; color:var(--studio-text); }
.gcat .ccard-release { display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-size:12.5px; }
.gcat .ccard-rel { display:inline-flex; align-items:center; gap:6px; font-weight:500; }
.gcat .ccard-rel.good { color:var(--studio-verified); }
.gcat .ccard-rel.watch { color:var(--studio-warning); }
.gcat .ccard-rel.grey { color:var(--studio-muted); }
.gcat .ccard-ver { font-family:var(--studio-mono); font-size:12px; color:var(--studio-accent); }
.gcat .ccard-shape { color:var(--studio-text); }
.gcat .ccard-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
.gcat .ccard-stats > div { display:flex; flex-direction:column; gap:3px; }
.gcat .ccard-k2 { font-size:11px; color:var(--studio-muted); }
.gcat .ccard-count { font-size:14px; color:var(--studio-text); font-variant-numeric:tabular-nums; }
.gcat .ccard-unit { font-size:12.5px; }
.gcat .ccard-gap { height:12px; }
.gcat .ccard-demand { font-size:12px; color:var(--studio-muted); padding:0 0 6px; }
.gcat .ccard-foot { display:flex; flex-direction:column; gap:4px; margin-top:auto; padding-top:6px; font-size:12.5px; }
.gcat .ccard-warn.bad { color:var(--studio-danger); }
.gcat .ccard-warn { color:var(--studio-warning); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.gcat .ccard-review { color:var(--studio-accent); }

/* The table beside the cards. Same rows, same click target, laid out for
   scanning one question down a column instead of one component at a time.
   The first column is the component AND its purpose, as the product's own
   table has it: a name with no purpose beside it sends you into the page to
   find out what it was. */
.gcat .gcat-lead { min-width:260px; max-width:420px; }
.gcat .gcat-name { font-weight:600; color:var(--foreground); }
.gcat .gcat-purpose { margin-top:2px; font-size:12px; color:var(--muted-foreground); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.gcat .gcat-version { font-family:var(--font-mono); font-size:12px; }
.gcat .src-chips { display:flex; flex-wrap:wrap; gap:4px; margin:4px 0 2px; }
.gcat .src-chip { font-size:10.5px; line-height:16px; padding:0 6px; border-radius:8px; border:1px solid var(--border); color:var(--muted-foreground); white-space:nowrap; max-width:220px; overflow:hidden; text-overflow:ellipsis; }
.gcat .src-chip.roadmap { border-color:color-mix(in srgb, var(--primary) 40%, var(--border)); color:var(--primary); }
.gcat .src-chip.planned { background:color-mix(in srgb, var(--primary) 10%, transparent); border-color:transparent; color:var(--primary); font-weight:600; }
.gcat .gcat-sub { font-size:11px; color:var(--muted-foreground); margin-top:2px; }
/* A missing value says WHICH missing it is, so it reads as a finding rather
   than as a gap in the rendering. Muted and italic: present, not shouting. */
.gcat .gcat-absent { color:var(--muted-foreground); font-style:italic; font-size:12px; white-space:nowrap; }
/* Build readiness: three short bars, the repository's evidence, and a flag. */
.gcat .gcat-ready { display:flex; flex-direction:column; gap:3px; min-width:150px; }
.gcat .gcat-ready-bars { display:flex; flex-direction:column; gap:2px; }
.gcat .gcat-ready-bar { display:grid; grid-template-columns:34px 1fr 32px; align-items:center; gap:6px; font-size:11px; }
.gcat .gcat-ready-k { font-family:var(--studio-mono); font-size:10px; color:var(--studio-muted); }
.gcat .gcat-ready-v { text-align:right; font-variant-numeric:tabular-nums; }
.gcat .gcat-ready-gap { font-size:11px; font-weight:600; color:var(--studio-warning); }
/* Review: the top check, and a list that opens in place without opening the row. */
.gcat .gcat-review summary { list-style:none; cursor:pointer; display:flex; flex-direction:column; gap:2px; }
.gcat .gcat-review summary::-webkit-details-marker { display:none; }
.gcat .gcat-review-top { font-size:12.5px; font-weight:600; color:var(--studio-danger); }
.gcat .gcat-review-top.nodata { color:var(--studio-warning); }
.gcat .gcat-review ul { margin:6px 0 0; padding:0; list-style:none; display:flex; flex-direction:column; gap:4px; max-width:320px; }
.gcat .gcat-review li { display:flex; flex-direction:column; font-size:12px; border-left:2px solid var(--studio-danger); padding-left:6px; }
.gcat .gcat-review li.nodata { border-left-color:var(--studio-warning); }
.gcat .gcat-review-clear { font-size:12px; color:var(--studio-verified); white-space:nowrap; }
.gcat .gcat-profile { display:flex; align-items:center; gap:8px; }
.gcat .gcat-bar { width:64px; height:6px; border-radius:999px; background:var(--border); overflow:hidden; flex:none; }
.gcat .gcat-bar-fill { display:block; height:100%; background:var(--primary); }
.gcat .gcat-pct { font-size:12px; font-variant-numeric:tabular-nums; color:var(--muted-foreground); }
.gcat .gcat-link { color:var(--primary); text-decoration:none; font-size:12px; white-space:nowrap; }
.gcat .gcat-link:hover { text-decoration:underline; }
.gcat .gcard {
  text-align:left; font:inherit; color:inherit; cursor:pointer;
  background:var(--studio-surface); border:1px solid var(--studio-line);
  border-radius:var(--studio-radius); padding:13px 14px; display:flex; flex-direction:column; gap:9px;
  box-shadow:0 1px 2px var(--studio-shadow); transition:border-color .15s, transform .15s;
}
.gcat .gcard:hover { border-color:var(--studio-accent); transform:translateY(-1px); }
.gcat .gcard-head { display:flex; align-items:center; gap:8px; }
.gcat .gcard-name { font-weight:600; font-size:14px; letter-spacing:-.01em; }
.gcat .gcard-desc { font-size:12px; color:var(--studio-muted); margin:0; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.gcat .gcard-meta { display:flex; gap:14px; flex-wrap:wrap; font-size:11px; color:var(--studio-muted); }
.gcat .gcard-meta b { font-family:var(--studio-mono); color:var(--studio-text); font-weight:600; }
.gcat .gcard-foot { display:flex; align-items:center; justify-content:space-between; margin-top:auto; padding-top:4px; border-top:1px solid var(--studio-line); }
.gcat .lampline { display:inline-flex; gap:8px; }
.gcat .gcard-plan { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; font-size:12px; color:var(--studio-muted); }
.gcat .gcard-plan b { color:var(--foreground); font-weight:600; }
.gcat .gcard-plan-demand { flex-basis:100%; }
.gcat .lchip { display:inline-flex; align-items:center; gap:4px; font-family:var(--studio-mono); font-size:10.5px; color:var(--studio-muted); }
.gcat .gcard-pct { font-family:var(--studio-mono); font-size:10.5px; color:var(--studio-muted); }

/* health strip */
.gcat .health { display:grid; grid-template-columns:repeat(auto-fit,minmax(104px,1fr)); gap:8px; margin:0 0 14px; }
.gcat .hcell { background:var(--studio-surface); border:1px solid var(--studio-line); border-radius:var(--studio-radius); padding:9px 11px 10px; display:flex; flex-direction:column; gap:7px; cursor:pointer; text-align:left; font:inherit; color:inherit; transition:border-color .15s, transform .15s; }
.gcat .hcell:hover { border-color:var(--studio-accent); transform:translateY(-1px); }
.gcat .hcell .hh { font-size:10.5px; color:var(--studio-muted); line-height:1.25; }
.gcat .hcell .lamps { display:flex; gap:5px; align-items:center; flex-wrap:wrap; min-height:9px; }
.gcat .hcell .lc { font-family:var(--studio-mono); font-size:10px; color:var(--studio-muted); }

/* traffic lights */
.gcat .tl { width:9px; height:9px; border-radius:50%; flex:none; display:inline-block; box-shadow:0 0 0 3px color-mix(in srgb, currentColor 16%, transparent); }
.gcat .tl.good { background:var(--studio-verified); color:var(--studio-verified); }
.gcat .tl.watch { background:var(--studio-warning); color:var(--studio-warning); }
.gcat .tl.bad { background:var(--studio-danger); color:var(--studio-danger); }
.gcat .tl.grey { background:none; border:1px dashed var(--studio-edge); color:transparent; box-shadow:none; }

/* KPIs */
.gcat .kpis { display:grid; grid-template-columns:minmax(0,2fr) minmax(0,1.15fr); gap:10px; margin:0 0 14px; }
.gcat .compo, .gcat .facts { background:var(--studio-surface); border:1px solid var(--studio-line); border-radius:var(--studio-radius); padding:11px 13px 12px; }
.gcat .compo { display:flex; flex-direction:column; gap:9px; justify-content:center; }
.gcat .cbar { display:flex; height:14px; border-radius:4px; overflow:hidden; gap:2px; background:var(--studio-surface-sunken); }
.gcat .ckeys { display:flex; flex-wrap:wrap; gap:4px 16px; align-items:center; }
.gcat .ck { display:inline-flex; align-items:center; gap:6px; font-size:11px; color:var(--studio-muted); }
.gcat .ck i { width:9px; height:9px; border-radius:2px; display:inline-block; }
.gcat .ck b { font-family:var(--studio-mono); font-size:11px; color:var(--studio-text); font-weight:600; }
.gcat .ck.tot { margin-left:auto; font-family:var(--studio-mono); font-size:10.5px; }
.gcat .facts { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
.gcat .fact { display:flex; flex-direction:column; gap:3px; min-width:0; }
.gcat .fact .fl { font-size:10px; color:var(--studio-muted); letter-spacing:.02em; }
.gcat .fact .fv { font-family:var(--studio-mono); font-size:20px; font-weight:600; line-height:1.1; letter-spacing:-.02em; }
.gcat .fact .fn { font-size:9.5px; color:var(--studio-muted); line-height:1.3; }

/* panels grid */
.gcat .grid { columns:3 320px; column-gap:14px; }
.gcat .panel { break-inside:avoid; margin:0 0 14px; background:var(--studio-surface); border:1px solid var(--studio-line); border-radius:var(--studio-radius); overflow:hidden; box-shadow:0 1px 2px var(--studio-shadow); }
.gcat .panel.wide { break-inside:auto; }
.gcat .panel > header { display:flex; align-items:center; gap:8px; padding:9px 13px; border-bottom:1px solid var(--studio-line); background:var(--studio-surface-raised); }
.gcat .panel > header .ic { width:18px; height:18px; border-radius:5px; flex:none; background:var(--studio-accent-soft); color:var(--studio-accent); display:grid; place-items:center; font-size:10px; font-weight:700; }
.gcat .panel > header h2 { font-size:12.5px; font-weight:600; margin:0; letter-spacing:-.005em; }
.gcat .panel > header .cnt { margin-left:auto; font-family:var(--studio-mono); font-size:10px; color:var(--studio-muted); }
.gcat .panel > header .tl { margin-left:auto; }
.gcat .panel > header .tl + .cnt { margin-left:8px; }
.gcat .rows { padding:3px 0; }
.gcat .row { display:grid; grid-template-columns:minmax(0,42%) minmax(0,58%); gap:10px; align-items:baseline; padding:5px 13px; }
.gcat .row.dated { grid-template-columns:minmax(0,38%) minmax(0,1fr) auto; }
.gcat .row + .row { border-top:1px solid var(--studio-line); }
.gcat .row:hover { background:var(--studio-surface-raised); }
.gcat .row .k { font-size:12px; color:var(--studio-muted); line-height:1.35; }
.gcat .row .val { font-size:12px; text-align:right; line-height:1.4; word-break:break-word; }
.gcat .wrap { display:inline-flex; align-items:center; gap:7px; justify-content:flex-end; }
.gcat .q { display:inline-block; min-width:18px; text-align:center; font-family:var(--studio-mono); font-size:11px; color:var(--studio-muted); border:1px dashed var(--studio-edge); border-radius:var(--radius-full); padding:0 6px; }
.gcat .novalue { color:var(--studio-muted); font-style:italic; font-size:11.5px; }
.gcat .num { font-family:var(--studio-mono); font-size:12.5px; font-weight:600; }
.gcat .bstrong { font-family:var(--studio-mono); font-size:11.5px; }
.gcat .bool { font-family:var(--studio-mono); font-size:11.5px; color:var(--studio-muted); }
.gcat .txtval { font-size:11.5px; }
.gcat .upd { font-family:var(--studio-mono); font-size:9.5px; color:var(--studio-muted); white-space:nowrap; padding-left:8px; }
.gcat .row a, .gcat .verlinks a, .gcat .editrow a { color:var(--studio-accent); text-decoration:none; }
.gcat .row a:hover { text-decoration:underline; text-underline-offset:2px; }
.gcat .row a::after { content:"\\2197"; font-size:.75em; opacity:.5; margin-left:2px; vertical-align:super; }

/* pills */
/* A global \`.pill\` elsewhere is a 36px round icon button; this one is a label. */
.gcat .pill { width:auto; height:auto; display:inline-block; font-size:10.5px; padding:1px 8px; border-radius:var(--radius-full); background:var(--studio-surface-sunken); border:1px solid var(--studio-line); color:var(--studio-text); white-space:nowrap; }
.gcat .pill.unset { border-style:dashed; color:var(--studio-muted); background:none; font-style:italic; }
.gcat .pill.ds-done { background:color-mix(in srgb,var(--studio-verified) 14%,var(--studio-bg)); border-color:color-mix(in srgb,var(--studio-verified) 40%,transparent); color:var(--studio-verified); }
.gcat .pill.ds-wip { background:color-mix(in srgb,var(--studio-warning) 16%,var(--studio-bg)); border-color:color-mix(in srgb,var(--studio-warning) 42%,transparent); color:var(--studio-warning); }
.gcat .pill.ds-na { background:none; border-style:dashed; color:var(--studio-muted); }

/* source chips */
.gcat .src { display:inline-block; font-family:var(--studio-mono); font-size:10.5px; padding:1px 7px; border-radius:var(--radius-full); }
.gcat .src.repo, .gcat .src.api { background:var(--studio-accent-soft); color:var(--studio-accent); }
.gcat .src.manual { background:color-mix(in srgb,var(--studio-warning) 14%,var(--studio-bg)); color:var(--studio-warning); }
.gcat .src.none { border:1px dashed var(--studio-edge); color:var(--studio-muted); }

/* diagram */
.gcat .archbody { padding:12px 13px 14px; }
.gcat .canvas { overflow-x:auto; }
.gcat .canvas svg { max-width:100%; height:auto; }
.gcat .nlab { font-family:var(--studio-mono); font-size:11.5px; font-weight:600; fill:var(--studio-text); }
.gcat .nsub { font-family:var(--studio-mono); font-size:9.5px; fill:var(--studio-muted); }
.gcat .elab { font-family:var(--studio-mono); font-size:9px; fill:var(--studio-muted); }
.gcat .elab.d { fill:var(--dg-arrow-dash); }
.gcat .legend { display:flex; flex-wrap:wrap; gap:12px; margin-top:10px; }
.gcat .lg { display:inline-flex; align-items:center; gap:6px; font-size:11px; color:var(--studio-muted); }
.gcat .lg i { width:11px; height:11px; border-radius:3px; border:1px solid; display:inline-block; }
.gcat .lg .mono { font-family:var(--studio-mono); }
.gcat .notes { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; margin-top:12px; }
.gcat .note h3 { font-size:11.5px; margin:0 0 4px; }
.gcat .note ul { margin:0; padding-left:16px; font-size:11.5px; color:var(--studio-muted); }
.gcat .blank { padding:26px 16px; text-align:center; color:var(--studio-muted); font-size:12px; }

/* uml */
.gcat .umlwrap { padding:12px 13px; display:flex; flex-direction:column; gap:12px; }
.gcat .umlhead { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
.gcat .umlhead a { color:var(--studio-accent); text-decoration:none; font-size:11px; margin-left:auto; }
.gcat .mermaid-src { margin:0; padding:10px 12px; background:var(--studio-surface-sunken); border:1px solid var(--studio-line); border-radius:var(--radius-md); font-family:var(--studio-mono); font-size:11px; overflow-x:auto; white-space:pre; }
.gcat .mermaid-empty { padding:14px 16px; background:var(--studio-surface-sunken); border:1px dashed var(--studio-line); border-radius:var(--radius-md); color:var(--studio-muted); font-size:12px; line-height:1.5; }
.gcat .mermaid-empty code { font-family:var(--studio-mono); font-size:11px; }
.gcat .uml { border:1px solid var(--studio-line); border-radius:var(--studio-radius); padding:10px 12px; background:var(--studio-surface); }
.gcat .mermaid-view { overflow-x:auto; padding:6px 2px 2px; display:flex; justify-content:center; min-height:40px; }
.gcat .mermaid-view svg { max-width:100%; height:auto; }
.gcat .cgraph { border:1px solid var(--studio-line); border-radius:var(--studio-radius); background:var(--studio-surface); overflow:hidden; }
.gcat .cgraph-legend { display:flex; align-items:center; gap:14px; flex-wrap:wrap; padding:10px 13px; border-bottom:1px solid var(--studio-line); background:var(--studio-surface-raised); }
.gcat .cgraph-lg { display:inline-flex; align-items:center; gap:6px; font-size:11px; color:var(--studio-muted); text-transform:capitalize; }
.gcat .cgraph-lg i { width:12px; height:12px; border-radius:3px; border:2px solid; display:inline-block; }
.gcat .cgraph-count { margin-left:auto; font-family:var(--studio-mono); font-size:10.5px; color:var(--studio-muted); }
.gcat .cgraph-canvas { overflow:auto; padding:14px; max-height:78vh; }
.gcat .cgraph-canvas .mermaid-view { justify-content:flex-start; }
.gcat .cgraph-empty { padding:14px 16px; }
.gcat .cgraph-empty .gcat-hint { margin:0 0 12px; }
.gcat .cgraph-chips { display:flex; flex-wrap:wrap; gap:8px; }
.gcat .cgraph-chip { font-size:11.5px; padding:4px 10px; border-radius:var(--radius-full); border:1px solid var(--studio-line); border-left-width:3px; background:var(--studio-surface-raised); color:var(--studio-text); white-space:nowrap; }
.gcat .cgraph-chip.gear { border-left-color:var(--avatar-mint); }
.gcat .cgraph-chip.sdk { border-left-color:var(--avatar-blue); }
.gcat .cgraph-chip.plugin { border-left-color:var(--avatar-purple); }
.gcat .cgraph-chip.toolkit { border-left-color:var(--avatar-yellow); }
.gcat .cgraph-chip.frontx { border-left-color:var(--avatar-red); }
.gcat .cgraph-chip.other { border-left-color:var(--avatar-grey); }
.gcat .uml-src { margin-top:8px; }
.gcat .uml-src summary { cursor:pointer; font-size:10.5px; color:var(--studio-muted); font-family:var(--studio-mono); }
.gcat .uml-src[open] summary { margin-bottom:6px; }

/* versions */
.gcat .verlinks { display:flex; gap:10px; padding:8px 13px 0; font-size:11.5px; }
.gcat .tablewrap { overflow-x:auto; padding:8px 4px 4px; }
.gcat .vtable { width:100%; border-collapse:collapse; font-size:11.5px; }
.gcat .vtable th { text-align:left; font-weight:600; color:var(--studio-muted); font-size:10.5px; padding:6px 12px; border-bottom:1px solid var(--studio-line); }
.gcat .vtable td { padding:6px 12px; border-bottom:1px solid var(--studio-line); }
.gcat .vtable code { font-family:var(--studio-mono); }
.gcat .ymark { color:var(--studio-warning); font-size:10.5px; }

/* editor */
.gcat .editrow { display:flex; gap:12px; align-items:center; margin:14px 0 8px; font-size:12px; }
.gcat .editor { background:var(--studio-surface); border:1px solid var(--studio-line); border-radius:var(--studio-radius); padding:12px 14px; }
.gcat .editor textarea { width:100%; min-height:260px; font-family:var(--studio-mono); font-size:12px; }
.gcat .editbtns { display:flex; gap:8px; margin-top:8px; }
`;

/** The open component, as `?component=` in the address. Opening one is a
 *  step (pushed, so Back closes it); closing it from the page is Back when
 *  this page opened it, so the list is where it was. */
function useSelectedComponent(initial: string | null): [string | null, (name: string | null) => void] {
  const read = () => new URLSearchParams(window.location.search).get("component");
  const [selected, setState] = useState<string | null>(() => read() ?? initial);
  useEffect(() => {
    const sync = () => setState(read());
    window.addEventListener("popstate", sync);
    window.addEventListener(URL_CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(URL_CHANGE_EVENT, sync);
    };
  }, []);
  const set = (name: string | null) => {
    const params = new URLSearchParams(window.location.search);
    if (name === read()) return;
    if (name === null && window.history.state?.componentOpened) {
      window.history.back();
      return;
    }
    if (name) params.set("component", name);
    else params.delete("component");
    const query = params.toString();
    const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
    if (name) window.history.pushState({ ...(window.history.state ?? {}), componentOpened: true }, "", url);
    else window.history.replaceState(window.history.state, "", url);
    setState(name);
  };
  return [selected, set];
}
