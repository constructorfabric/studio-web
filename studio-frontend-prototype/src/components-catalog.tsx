import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "./api";
import type { CatalogNode, Connection } from "./api";
import { errText } from "./format";
import schemaJson from "./components-catalog.schema.json";

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

const SCHEMA = schemaJson as unknown as Schema;
const ALL_FIELDS: Field[] = SCHEMA.groups.flatMap((g) => g.fields);

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

// ── crates.io → schema mapping ───────────────────────────────────────────────

function shortRepo(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

/** Everything the crates.io payload can answer for the schema fields. */
function deriveFromCrate(value: CatalogNode["value"]): Values {
  const out: Values = {};
  const name = String(value.name ?? "");
  const crateUrl = name ? `https://crates.io/crates/${encodeURIComponent(name)}` : undefined;
  const latest =
    (value.max_stable_version as string | undefined) ??
    (value.newest_version as string | undefined) ??
    (value.max_version as string | undefined) ??
    null;

  if (value.description) out.description = { v: String(value.description), b: String(value.description) };
  if (value.repository) {
    const r = String(value.repository);
    out.path = { v: r, b: shortRepo(r), l: r };
  }
  if (latest) {
    out.version = { v: latest, b: latest, l: crateUrl };
    out.lastrelease = { v: latest, b: latest, l: crateUrl };
    out.published = { v: `On crates.io — ${name} ${latest}`, b: "crates.io", s: "good", l: crateUrl };
  }
  const updated = value.updated_at as string | undefined;
  if (updated) {
    const day = updated.slice(0, 10);
    out.lastchange = { v: day, b: day, u: day };
  }
  const cats = (value.categories as string[] | undefined) ?? [];
  const kws = (value.keywords as string[] | undefined) ?? [];
  if (cats.length) out.category = { v: cats.join(", "), b: cats[0] };
  else if (kws.length) out.category = { v: kws.join(", "), b: kws[0] };

  const license = value.license as string | undefined;
  if (license) out.licence = { v: license, b: license };

  return out;
}

/** The newest non-yanked version that declares a licence — a client-side
 *  fallback for the Licence field when the gear node predates the parser
 *  change that surfaces it. */
function licenceFromVersions(rows: CatalogNode[] | null): string | null {
  if (!rows) return null;
  const hit = rows.find((v) => !v.value.yanked && typeof v.value.license === "string" && v.value.license);
  return hit ? String(hit.value.license) : null;
}

/** Turn a bare profile value into a FieldVal if it isn't already one. */
function toFieldVal(raw: unknown): FieldVal | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if ("v" in o || "b" in o || "n" in o || "s" in o || "l" in o || "u" in o) return o as FieldVal;
    // an object we don't recognise — stringify it compactly
    return { v: JSON.stringify(o), b: JSON.stringify(o) };
  }
  if (Array.isArray(raw)) {
    const s = raw.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
    return s ? { v: s, b: s, n: raw.length } : null;
  }
  if (typeof raw === "number") return { v: raw.toLocaleString("en-US"), b: raw.toLocaleString("en-US"), n: raw };
  return { v: String(raw), b: String(raw) };
}

/** A few legacy flat profile keys the old editor produced, mapped to schema keys. */
const LEGACY_KEYS: Record<string, string> = {
  category: "category",
  domain: "category",
  lifecycle_status: "lifecycle",
  maintainers: "maintainer",
  repository: "path",
  code_coverage: "coverage",
  code_loc: "codeloc",
  spec_loc: "specloc",
  unit_test_loc: "unitloc",
  e2e_test_loc: "e2eloc",
  supported_databases: "dbs",
  plugins: "plugins",
  dependencies: "deps",
  events_published: "events",
  feature_flags: "flags",
  api_spec_link: "openapi",
};

/** Merge the three sources in precedence order: crates.io < repository < profile. */
function buildValues(value: CatalogNode["value"], profile: Record<string, unknown> | undefined): Values {
  const out = deriveFromCrate(value);

  if (profile) {
    // repository-parsed fields (auto), refreshed on every Sync from the repo files
    const auto = profile.auto;
    if (auto && typeof auto === "object" && !Array.isArray(auto)) {
      for (const [k, raw] of Object.entries(auto as Record<string, unknown>)) {
        const fv = toFieldVal(raw);
        if (fv) out[k] = fv;
      }
    }
    // the rich shape: profile.values keyed by schema field id (manual overrides)
    const richValues = profile.values;
    if (richValues && typeof richValues === "object" && !Array.isArray(richValues)) {
      for (const [k, raw] of Object.entries(richValues as Record<string, unknown>)) {
        out[k] = toFieldVal(raw);
      }
    }
    // legacy flat keys — only fill where nothing is set yet
    for (const [flat, key] of Object.entries(LEGACY_KEYS)) {
      if (out[key]) continue;
      if (flat in profile) {
        const fv = toFieldVal((profile as Record<string, unknown>)[flat]);
        if (fv) out[key] = fv;
      }
    }
  }
  return out;
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

/** Where the Components page pulls from: the platform Gears repository and/or
 *  the FrontX micro-frontends repository (each via a connector), and/or
 *  crates.io. At least one should be enabled. */
interface Sources {
  cratesIo: boolean;
  keyword: string;
  gears: RepoSel;
  frontx: RepoSel;
}

const DEFAULT_SOURCES: Sources = {
  cratesIo: true,
  keyword: "constructorfabric",
  gears: { enabled: false, connectionId: "", repo: "constructorfabric/gears-rust", gitRef: "HEAD" },
  frontx: { enabled: false, connectionId: "", repo: "constructorfabric/gears-frontx", gitRef: "HEAD" },
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

/** The category/domain of a component, from its profile or the crates.io node. */
function componentCategory(g: CatalogNode, profile: Record<string, unknown> | undefined): string {
  const pick = (obj: unknown, key: string): string | undefined => {
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const v = (obj as Record<string, unknown>)[key];
      if (v && typeof v === "object") {
        const b = (v as Record<string, unknown>).b ?? (v as Record<string, unknown>).v;
        if (typeof b === "string") return b;
      }
      if (typeof v === "string") return v;
    }
    return undefined;
  };
  const catList = Array.isArray(g.value.categories) ? (g.value.categories as string[]) : [];
  return (
    pick(profile?.auto, "category") ??
    pick(profile?.values, "category") ??
    (typeof g.value.category === "string" ? (g.value.category as string) : undefined) ??
    catList[0] ??
    ""
  );
}

export function ComponentsCatalog({
  token,
  tenantId,
  query = "",
  kindFilter = "",
  sortMode = "name-asc",
  hideSdk = false,
  categoryFilter = "",
  onCategories,
}: {
  token: string;
  tenantId?: string;
  query?: string;
  kindFilter?: string;
  sortMode?: "name-asc" | "name-desc" | "downloads-desc";
  hideSdk?: boolean;
  categoryFilter?: string;
  onCategories?: (cats: string[]) => void;
}) {
  const [gears, setGears] = useState<CatalogNode[] | null>(null);
  const [profiles, setProfiles] = useState<Record<string, Record<string, unknown>>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sync, setSync] = useState("");
  const [sources, setSources] = useState<Sources>(() => loadSources());
  const [showSources, setShowSources] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);

  const setSrc = (patch: Partial<Sources>) =>
    setSources((cur) => {
      const next = { ...cur, ...patch };
      saveSources(next);
      return next;
    });

  const setRepo = (which: "gears" | "frontx", patch: Partial<RepoSel>) =>
    setSources((cur) => {
      const next = { ...cur, [which]: { ...cur[which], ...patch } };
      saveSources(next);
      return next;
    });

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
      const [{ nodes }, profileResponse] = await Promise.all([
        api.listComponents(token),
        api.listComponentProfiles(token).catch((error): { nodes: CatalogNode[] } => {
          if (error instanceof ApiError && error.status === 404) return { nodes: [] };
          throw error;
        }),
      ]);
      setGears(nodes ?? []);
      const next: Record<string, Record<string, unknown>> = {};
      for (const node of profileResponse.nodes ?? []) {
        const name = typeof node.value.gear_name === "string" ? node.value.gear_name : "";
        if (name) next[name] = node.value as Record<string, unknown>;
      }
      setProfiles(next);
    } catch (e) {
      setErr(errText(e));
    }
  }, [token]);

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
      const { task_id } = await api.syncComponents(token, body);
      const deadline = Date.now() + 10 * 60 * 1000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const t = await api.componentsCatalogTask(token, task_id);
        if (t.status === "succeeded") {
          setSync(`${t.gears} gears · ${t.versions} versions`);
          await reload();
          break;
        }
        if (t.status === "failed") {
          setSync(t.message || "sync failed");
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

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const cat = categoryFilter.trim().toLowerCase();
    const rows = (gears ?? [])
      .filter((g) => !kindFilter || String(g.value.kind ?? "gear") === kindFilter)
      .filter((g) => !hideSdk || !nameOf(g).endsWith("-sdk"))
      .filter((g) => !cat || componentCategory(g, profiles[nameOf(g)]).toLowerCase().includes(cat))
      .filter((g) => {
        if (!needle) return true;
        const name = String(g.value.name ?? "").toLowerCase();
        const desc = String(g.value.description ?? "").toLowerCase();
        return name.includes(needle) || desc.includes(needle);
      });
    rows.sort((a, b) => {
      if (sortMode === "downloads-desc") {
        return Number(b.value.downloads ?? 0) - Number(a.value.downloads ?? 0);
      }
      const cmp = nameOf(a).localeCompare(nameOf(b));
      return sortMode === "name-desc" ? -cmp : cmp;
    });
    return rows;
  }, [gears, query, kindFilter, hideSdk, sortMode, categoryFilter, profiles]);

  // Report the distinct categories present, so the filter rail can offer them.
  useEffect(() => {
    if (!onCategories) return;
    const set = new Set<string>();
    for (const g of gears ?? []) {
      const c = componentCategory(g, profiles[nameOf(g)]).trim();
      if (c) set.add(c);
    }
    onCategories(Array.from(set).sort((a, b) => a.localeCompare(b)));
  }, [gears, profiles, onCategories]);

  const selectedGear = useMemo(
    () => (selected ? (gears ?? []).find((g) => nameOf(g) === selected) ?? null : null),
    [selected, gears],
  );

  const [viewMode, setViewMode] = useState<"list" | "graph">("list");
  const graph = useMemo(() => buildComponentGraph(visible, profiles), [visible, profiles]);

  const syncing = sync.endsWith("…");
  const sourceSummary = [
    sources.gears.enabled && "gears",
    sources.frontx.enabled && "frontx",
    sources.cratesIo && "crates.io",
  ]
    .filter(Boolean)
    .join(" + ");

  return (
    <div className="gcat">
      <style>{GCAT_CSS}</style>

      {selectedGear ? (
        <GearDetail
          token={token}
          gear={selectedGear}
          profile={profiles[selected as string]}
          onBack={() => setSelected(null)}
          onSaved={(p) => setProfiles((cur) => ({ ...cur, [selected as string]: p }))}
        />
      ) : (
        <>
          <div className="gcat-topbar">
            <div className="crumb">
              <h1>Components</h1>
              <span className="asof">gears · frontx · crates.io</span>
            </div>
            <div className="tools">
              <div className="seg" role="tablist" aria-label="View mode">
                {(["list", "graph"] as const).map((v) => (
                  <button key={v} aria-pressed={viewMode === v} onClick={() => setViewMode(v)}>
                    {v === "list" ? "List" : "Graph"}
                  </button>
                ))}
              </div>
              <button
                className={`iconbtn${showSources ? " active" : ""}`}
                onClick={() => setShowSources((v) => !v)}
                aria-expanded={showSources}
              >
                Sources{sourceSummary ? ` · ${sourceSummary}` : ""}
              </button>
              <button className="iconbtn primary" disabled={busy} onClick={() => void runSync()}>
                {syncing ? "Syncing…" : "Sync"}
              </button>
            </div>
          </div>

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
            repository, and micro-frontends from FrontX — read through a connector, with crates.io
            adding published versions. Each component opens a page of grouped fields, traffic lights and
            sources; an empty cell is a finding, not an omission.
          </p>

          {sync && <p className="gcat-hint">Sync: {sync}</p>}
          {err && <p className="gcat-err">{err}</p>}

          {gears === null ? (
            <p className="gcat-empty">Loading components…</p>
          ) : visible.length === 0 ? (
            <p className="gcat-empty">
              {(gears?.length ?? 0) === 0
                ? "No components yet — open Sources, pick a repository, and Sync."
                : "No components match the current filter."}
            </p>
          ) : viewMode === "graph" ? (
            <ComponentGraph graph={graph} nodes={visible} />
          ) : (
            <div className="gcat-cards">
              {visible.map((g) => (
                <GearListCard
                  key={g.instance_id}
                  gear={g}
                  profile={profiles[nameOf(g)]}
                  onOpen={() => setSelected(nameOf(g))}
                />
              ))}
            </div>
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
          <span>Ref</span>
          <input
            placeholder="HEAD"
            value={sel.gitRef}
            disabled={!sel.enabled}
            onChange={(e) => onChange({ gitRef: e.target.value })}
          />
        </label>
        <p className="src-note">
          {note}
          {sel.enabled && !tenantId ? " — no workspace in context to list connections." : ""}
        </p>
      </div>
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
  setRepo: (which: "gears" | "frontx", patch: Partial<RepoSel>) => void;
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
        note="Micro-frontend packages from the FrontX repository."
        sel={sources.frontx}
        onChange={(p) => setRepo("frontx", p)}
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

function GearListCard({
  gear,
  profile,
  onOpen,
}: {
  gear: CatalogNode;
  profile: Record<string, unknown> | undefined;
  onOpen: () => void;
}) {
  const name = String(gear.value.name ?? gear.instance_id);
  const values = useMemo(() => buildValues(gear.value, profile), [gear.value, profile]);
  const filled = ALL_FIELDS.filter((f) => values[f.key]).length;
  const pct = Math.round((filled / ALL_FIELDS.length) * 100);
  const category = values.category?.b ?? "gear";
  const latest = String(gear.value.max_stable_version ?? gear.value.newest_version ?? "—");

  // one summary lamp: worst known across judged fields
  const lamps = ALL_FIELDS.map((f) => lampOf(f, values)).filter((l): l is Lamp => !!l);
  const bad = lamps.filter((l) => l === "bad").length;
  const watch = lamps.filter((l) => l === "watch").length;
  const good = lamps.filter((l) => l === "good").length;

  return (
    <button className="gcard" onClick={onOpen} title={`Open ${name}`}>
      <div className="gcard-head">
        <span className="gcard-name">{name}</span>
        <span className="pill">{category}</span>
      </div>
      {gear.value.description && <p className="gcard-desc">{String(gear.value.description)}</p>}
      <div className="gcard-meta">
        <span>
          <b>{latest}</b> latest
        </span>
        <span>
          <b>{numText(gear.value.num_versions)}</b> versions
        </span>
        <span>
          <b>{numText(gear.value.downloads)}</b> downloads
        </span>
      </div>
      <div className="gcard-foot">
        <span className="lampline">
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
          {good > 0 && (
            <span className="lchip">
              <span className="tl good" />
              {good}
            </span>
          )}
        </span>
        <span className="gcard-pct">{pct}% filled</span>
      </div>
    </button>
  );
}

// ── detail page ──────────────────────────────────────────────────────────────

function GearDetail({
  token,
  gear,
  profile,
  onBack,
  onSaved,
}: {
  token: string;
  gear: CatalogNode;
  profile: Record<string, unknown> | undefined;
  onBack: () => void;
  onSaved: (profile: Record<string, unknown>) => void;
}) {
  const name = String(gear.value.name ?? gear.instance_id);
  const [view, setView] = useState<View>("filled");
  const [versions, setVersions] = useState<CatalogNode[] | null>(null);
  const [editing, setEditing] = useState(false);

  const values = useMemo(() => {
    const base = buildValues(gear.value, profile);
    if (!base.licence) {
      const lic = licenceFromVersions(versions);
      if (lic) base.licence = { v: lic, b: lic };
    }
    return base;
  }, [gear.value, profile, versions]);
  const filled = ALL_FIELDS.filter((f) => values[f.key]).length;
  const pct = Math.round((filled / ALL_FIELDS.length) * 100);
  const derivable = ALL_FIELDS.filter((f) => f.source.class === "repo" || f.source.class === "api").length;

  useEffect(() => {
    let live = true;
    api
      .listComponentVersions(token, name)
      .then(({ nodes }) => {
        if (live) setVersions(sortVersions(nodes ?? []));
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
          <h1>{name}</h1>
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
                <b>{filled}</b> of {ALL_FIELDS.length} fields answered · {derivable} derivable from the
                repository
              </>
            )}
          </div>
        </div>
      </div>

      {gear.value.description && <p className="gcat-sub">{String(gear.value.description)}</p>}

      {view === "filled" && <HealthStrip values={values} />}
      {view === "filled" && <Kpis values={values} />}

      <div className="grid">
        {SCHEMA.groups.map((group) => (
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

function HealthStrip({ values }: { values: Values }) {
  const goTo = (id: string) => {
    document.getElementById(`panel-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  return (
    <div className="health">
      {SCHEMA.groups.map((group) => {
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

function Kpis({ values }: { values: Values }) {
  const parts = SCHEMA.composition.map((c) => ({ ...c, n: values[c.key]?.n ?? 0 }));
  const total = parts.reduce((a, p) => a + p.n, 0);
  const ratio = values.ratio?.b ?? values.ratio?.v ?? "—";
  const adr = values.adr?.n;

  return (
    <div className="kpis">
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
      <div className="facts">
        <Fact label="Total lines" value={total ? total.toLocaleString("en-US") : "—"} note="spec, code and tests" />
        <Fact label="Spec to code" value={ratio} note="lines of code per line of spec" />
        <Fact label="ADRs" value={adr === undefined ? "—" : String(adr)} note="recorded decisions" />
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
      const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
      try {
        m.initialize({
          startOnLoad: false,
          securityLevel: "loose",
          theme: dark ? "dark" : "default",
          fontFamily: "var(--studio-sans, Inter, system-ui, sans-serif)",
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
 *  Falls back to the OS preference when nothing opaque is found. */
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
  return !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
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
            fontFamily: "var(--studio-sans, Inter, system-ui, sans-serif)",
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
  lines.push("classDef gear stroke:#1a7f4b,stroke-width:2px");
  lines.push("classDef sdk stroke:#0065e3,stroke-width:2px");
  lines.push("classDef plugin stroke:#7147d2,stroke-width:2px");
  lines.push("classDef toolkit stroke:#9a6700,stroke-width:2px");
  lines.push("classDef frontx stroke:#b3261e,stroke-width:2px");
  lines.push("classDef other stroke:#8b90a3,stroke-width:1px");

  return {
    code: edges.length ? lines.join("\n") : "",
    edgeCount: edges.length,
    isolated: nodes.length - connected.size,
  };
}

const GRAPH_LEGEND: [string, string][] = [
  ["gear", "#1a7f4b"],
  ["sdk", "#0065e3"],
  ["plugin", "#7147d2"],
  ["toolkit", "#9a6700"],
  ["frontx", "#b3261e"],
];

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

function sortVersions(rows: CatalogNode[]): CatalogNode[] {
  const parts = (s: string) => s.split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
  return [...rows].sort((a, b) => {
    const pa = parts(String(a.value.num ?? ""));
    const pb = parts(String(b.value.num ?? ""));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pb[i] ?? 0) - (pa[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
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
.gcat {
  --studio-bg:#ffffff; --studio-chrome:#f0f2f5; --studio-surface:#ffffff;
  --studio-surface-raised:#f6f7f9; --studio-surface-sunken:#f0f2f5;
  --studio-text:#1f2328; --studio-muted:#616973; --studio-line:#e1e4e8;
  --studio-edge:#c8cfd9; --studio-accent:#0065e3; --studio-on-accent:#ffffff;
  --studio-verified:#1a7f4b; --studio-warning:#9a6700; --studio-danger:#b3261e;
  --studio-shadow:rgba(31,35,40,.14); --studio-radius:8px;
  --studio-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --studio-accent-soft:color-mix(in srgb,var(--studio-accent) 10%,var(--studio-bg));
  --dg-backend-fill:#e8f7ee; --dg-backend-stroke:#1a7f4b;
  --dg-db-fill:#f1ecfd; --dg-db-stroke:#7147d2;
  --dg-ext-fill:#f0f2f5; --dg-ext-stroke:#a8b0bc;
  --dg-sec-fill:#fdeceb; --dg-sec-stroke:#b3261e;
  --dg-bus-fill:#fdf3e0; --dg-bus-stroke:#9a6700;
  --dg-arrow:#616973; --dg-arrow-dash:#7147d2;
  color:var(--studio-text); font-size:13px; line-height:1.5;
}
@media (prefers-color-scheme: dark) {
  .gcat:not([data-theme="light"]) {
    --studio-bg:#14161c; --studio-chrome:#1a1c23; --studio-surface:#1a1c23;
    --studio-surface-raised:#23262f; --studio-surface-sunken:#0f1014;
    --studio-text:#e7e9ee; --studio-muted:#8b90a3; --studio-line:#2d303c;
    --studio-edge:#343a48; --studio-accent:#64a6f7; --studio-on-accent:#14161c;
    --studio-verified:#4bb96a; --studio-warning:#d8a63c; --studio-danger:#e5534b;
    --studio-shadow:rgba(0,0,0,.5);
    --dg-backend-fill:#16302a; --dg-backend-stroke:#4bb96a;
    --dg-db-fill:#241f38; --dg-db-stroke:#b092e6;
    --dg-ext-fill:#23262f; --dg-ext-stroke:#4c516a;
    --dg-sec-fill:#33211f; --dg-sec-stroke:#e5534b;
    --dg-bus-fill:#332a1a; --dg-bus-stroke:#d8a63c;
    --dg-arrow:#8b90a3; --dg-arrow-dash:#b092e6;
  }
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
  border:1px solid var(--studio-edge); border-radius:6px; padding:6px 10px;
}
.gcat input { min-width:200px; }
.gcat .iconbtn {
  border:1px solid var(--studio-edge); background:var(--studio-surface); color:var(--studio-text);
  border-radius:6px; padding:6px 12px; cursor:pointer; font:inherit; font-size:12.5px;
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

.gcat .seg { display:inline-flex; border:1px solid var(--studio-edge); border-radius:6px; overflow:hidden; background:var(--studio-surface); }
.gcat .seg button { font:inherit; font-size:12px; background:none; border:0; cursor:pointer; color:var(--studio-muted); padding:5px 13px; border-right:1px solid var(--studio-line); }
.gcat .seg button:last-child { border-right:0; }
.gcat .seg button[aria-pressed="true"] { background:var(--studio-accent); color:var(--studio-on-accent); font-weight:600; }

.gcat .gauge { display:flex; align-items:center; gap:10px; margin-left:auto; }
.gcat .ring { position:relative; width:40px; height:40px; flex:none; }
.gcat .ring svg { transform:rotate(-90deg); }
.gcat .ring .lab { position:absolute; inset:0; display:grid; place-items:center; font-family:var(--studio-mono); font-size:10.5px; font-weight:600; }
.gcat .gtxt { font-size:11.5px; color:var(--studio-muted); line-height:1.35; max-width:280px; }
.gcat .gtxt b { color:var(--studio-text); font-family:var(--studio-mono); }

.gcat .gcat-sub { font-size:14px; line-height:1.5; color:var(--studio-muted); max-width:82ch; margin:0 0 14px; }
.gcat .gcat-hint { font-size:11.5px; color:var(--studio-muted); margin:6px 0; }
.gcat .gcat-err { color:var(--studio-danger); font-size:12px; margin:6px 0; }
.gcat .gcat-empty { color:var(--studio-muted); font-style:italic; font-size:12.5px; padding:12px 0; }
.gcat code { font-family:var(--studio-mono); font-size:.92em; }

/* list cards */
.gcat .gcat-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
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
.gcat .q { display:inline-block; min-width:18px; text-align:center; font-family:var(--studio-mono); font-size:11px; color:var(--studio-muted); border:1px dashed var(--studio-edge); border-radius:999px; padding:0 6px; }
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
.gcat .pill { font-size:10.5px; padding:1px 8px; border-radius:999px; background:var(--studio-surface-sunken); border:1px solid var(--studio-line); color:var(--studio-text); white-space:nowrap; }
.gcat .pill.unset { border-style:dashed; color:var(--studio-muted); background:none; font-style:italic; }
.gcat .pill.ds-done { background:color-mix(in srgb,var(--studio-verified) 14%,var(--studio-bg)); border-color:color-mix(in srgb,var(--studio-verified) 40%,transparent); color:var(--studio-verified); }
.gcat .pill.ds-wip { background:color-mix(in srgb,var(--studio-warning) 16%,var(--studio-bg)); border-color:color-mix(in srgb,var(--studio-warning) 42%,transparent); color:var(--studio-warning); }
.gcat .pill.ds-na { background:none; border-style:dashed; color:var(--studio-muted); }

/* source chips */
.gcat .src { display:inline-block; font-family:var(--studio-mono); font-size:10.5px; padding:1px 7px; border-radius:999px; }
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
.gcat .mermaid-src { margin:0; padding:10px 12px; background:var(--studio-surface-sunken); border:1px solid var(--studio-line); border-radius:6px; font-family:var(--studio-mono); font-size:11px; overflow-x:auto; white-space:pre; }
.gcat .mermaid-empty { padding:14px 16px; background:var(--studio-surface-sunken); border:1px dashed var(--studio-line); border-radius:6px; color:var(--studio-muted); font-size:12px; line-height:1.5; }
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
.gcat .cgraph-chip { font-size:11.5px; padding:4px 10px; border-radius:999px; border:1px solid var(--studio-line); border-left-width:3px; background:var(--studio-surface-raised); color:var(--studio-text); white-space:nowrap; }
.gcat .cgraph-chip.gear { border-left-color:#1a7f4b; }
.gcat .cgraph-chip.sdk { border-left-color:#0065e3; }
.gcat .cgraph-chip.plugin { border-left-color:#7147d2; }
.gcat .cgraph-chip.toolkit { border-left-color:#9a6700; }
.gcat .cgraph-chip.frontx { border-left-color:#b3261e; }
.gcat .cgraph-chip.other { border-left-color:#8b90a3; }
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
