import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { CatalogNode, ComponentMetrics, ComponentSpecInput } from "./api";
import { errText } from "./format";

/* ============================================================================
 * Delivery activity per Gear, from Constructor Insight.
 *
 * Insight keys its git metrics by *repository*; a gear is a directory inside
 * one (`gears/system/api-gateway/…` in `constructorfabric/gears-rust`). The
 * studio-insight gear closes that gap: we send the component names we know and
 * it matches them as whole path segments, so nobody has to maintain a map from
 * crate to directory. One request per repository answers the whole list.
 *
 * What arrives is deliberately narrow — commits, files, lines, authors, and a
 * weekly series. Cycle time, review latency and CI outcomes are not here: those
 * belong to a pull request and a pipeline run, which are repository-level
 * entities, and inventing a per-gear number for them would be a lie with a
 * chart around it.
 * ==========================================================================*/

/** One gear's numbers over the selected window. */
export interface GearActivity {
  commits: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  authors: number;
  /** Ascending by date, gaps filled with zeros so a quiet week reads as quiet
   *  rather than as missing. */
  points: { date: string; added: number; removed: number; commits: number }[];
}

export interface ActivityIndex {
  status: "off" | "loading" | "ready" | "error";
  /** Present when `status === "error"` — the message is shown, not swallowed. */
  error?: string;
  /** The window Insight actually used. */
  from?: string;
  to?: string;
  byGear: Map<string, GearActivity>;
  /** True when Insight capped a page: the ranking is a prefix. */
  truncated: boolean;
}

const EMPTY: ActivityIndex = {
  status: "off",
  byGear: new Map(),
  truncated: false,
};

/** Windows offered in the UI. */
export const ACTIVITY_WINDOWS = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "12 months" },
] as const;

/** At most this many repositories are queried per render — each is one round
 *  trip to Insight, and a catalogue spanning a dozen repos should not open a
 *  dozen connections on page load. */
const REPO_LIMIT = 3;
/** The backend refuses more than 200 declared components in one request. */
const MAX_COMPONENTS = 200;

/** `https://github.com/constructorfabric/gears-rust` → `constructorfabric/gears-rust`. */
export function normalizeRepo(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  const path = url
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const parts = path.split("/");
  if (parts.length < 3) return null;
  const [, owner, name] = parts;
  if (!owner || !name) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name)) return null;
  return `${owner}/${name}`;
}

/** The directory a gear's crate most likely lives in: `cf-gears-api-gateway`
 *  publishes from `gears/system/api-gateway/`. Collisions are resolved by the
 *  caller, which falls back to the full crate name. */
export function gearSegment(crate: string): string {
  return crate.replace(/^cf-gears-/, "").replace(/^cf-/, "");
}

/** YYYY-MM-DD, `days` before today, in the browser's timezone. */
function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - (days - 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Group the catalogue by repository, and name each gear's directory. */
function planRequests(gears: CatalogNode[]): { repository: string; components: ComponentSpecInput[] }[] {
  const byRepo = new Map<string, ComponentSpecInput[]>();
  const seen = new Map<string, Set<string>>();
  for (const g of gears) {
    const name = String(g.value.name ?? "").trim();
    const repo = normalizeRepo(g.value.repository);
    if (!name || !repo) continue;
    const taken = seen.get(repo) ?? new Set<string>();
    // Two crates that strip to the same directory name would both match the
    // same files and the second would silently read zero — fall back to the
    // full crate name, which is unique, rather than report a wrong number.
    const stripped = gearSegment(name);
    const segment = taken.has(stripped) ? name : stripped;
    taken.add(segment);
    seen.set(repo, taken);
    const list = byRepo.get(repo) ?? [];
    if (list.length < MAX_COMPONENTS) list.push({ key: name, path_segment: segment });
    byRepo.set(repo, list);
  }
  return [...byRepo.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, REPO_LIMIT)
    .map(([repository, components]) => ({ repository, components }));
}

/** Every bucket start between two dates, so the chart can draw a quiet week as
 *  a gap in the bars instead of skipping it and compressing time. */
function weekStarts(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  // Snap to Monday, the boundary the backend buckets on.
  const day = start.getUTCDay();
  start.setUTCDate(start.getUTCDate() - ((day + 6) % 7));
  const out: string[] = [];
  for (let d = start; d <= end && out.length < 80; d.setUTCDate(d.getUTCDate() + 7)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function indexOf(pages: ComponentMetrics[]): ActivityIndex {
  const byGear = new Map<string, GearActivity>();
  let truncated = false;
  const from = pages[0]?.from;
  const to = pages[0]?.to;
  for (const page of pages) {
    truncated = truncated || page.truncated;
    const buckets = weekStarts(page.from, page.to);
    const series = new Map<string, Map<string, { added: number; removed: number; commits: number }>>();
    for (const p of page.series) {
      const perGear = series.get(p.component) ?? new Map();
      perGear.set(p.date, {
        added: p.lines_added,
        removed: p.lines_removed,
        commits: p.commits,
      });
      series.set(p.component, perGear);
    }
    for (const row of page.components) {
      const points = buckets.map((date) => {
        const hit = series.get(row.component)?.get(date);
        return {
          date,
          added: hit?.added ?? 0,
          removed: hit?.removed ?? 0,
          commits: hit?.commits ?? 0,
        };
      });
      byGear.set(row.component, {
        commits: row.commits,
        filesChanged: row.files_changed,
        linesAdded: row.lines_added,
        linesRemoved: row.lines_removed,
        authors: row.authors,
        points,
      });
    }
  }
  return { status: "ready", from, to, byGear, truncated };
}

/**
 * Load per-gear activity for every repository the catalogue spans.
 *
 * Keyed on the gear names and the window, so re-rendering the list (a filter, a
 * profile edit) does not re-query Insight.
 */
export function useGearActivity(token: string, gears: CatalogNode[] | null, days: number): ActivityIndex {
  const plan = useMemo(() => planRequests(gears ?? []), [gears]);
  const planKey = useMemo(
    () => plan.map((p) => `${p.repository}:${p.components.map((c) => c.key).join(",")}`).join("|"),
    [plan],
  );
  const [state, setState] = useState<ActivityIndex>(EMPTY);

  useEffect(() => {
    if (!token || plan.length === 0) {
      setState(EMPTY);
      return;
    }
    let live = true;
    setState((cur) => ({ ...cur, status: "loading" }));
    const from = daysAgo(days);
    Promise.all(
      plan.map((p) =>
        api.insightComponentMetrics(token, {
          repository: p.repository,
          from,
          components: p.components,
          include_other: false,
          bucket: "week",
          limit: Math.min(p.components.length, 500),
        }),
      ),
    )
      .then((pages) => {
        if (live) setState(indexOf(pages));
      })
      .catch((e) => {
        if (live) setState({ ...EMPTY, status: "error", error: errText(e) });
      });
    return () => {
      live = false;
    };
    // planKey stands in for plan: the array identity changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, planKey, days]);

  return state;
}

// ── formatting ───────────────────────────────────────────────────────────────

/** 1,284 · 12.9K · 1.2M — a stat tile's value, never a raw 1284000. */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toLocaleString("en-US");
}

function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// ── the chart ────────────────────────────────────────────────────────────────

/**
 * Weekly change: lines added above the zero rule, lines removed below it.
 *
 * One scale for both arms — same unit, opposite sign — so the two halves are
 * comparable by eye. A diverging blue/red pair carries the polarity (validated
 * for contrast and colour-vision separation in both themes); the legend and the
 * tooltip carry identity, so nothing depends on telling the two hues apart.
 */
export function ChurnChart({ points, label }: { points: GearActivity["points"]; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const scale = Math.max(1, ...points.map((p) => Math.max(p.added, p.removed)));
  const busiest = points.reduce(
    (best, p, i) => (p.added + p.removed > points[best]?.added + points[best]?.removed ? i : best),
    0,
  );
  const active = hover ?? busiest;
  const shown = points[active];

  if (points.length === 0 || scale <= 1) {
    return <p className="act-empty">No commits in this window.</p>;
  }

  return (
    <figure className="act-fig">
      <figcaption className="act-cap">
        <span className="act-title">{label}</span>
        <span className="act-legend">
          <span className="act-key">
            <i className="sw added" /> Lines added
          </span>
          <span className="act-key">
            <i className="sw removed" /> Lines removed
          </span>
        </span>
      </figcaption>

      <div className="act-plot" onMouseLeave={() => setHover(null)}>
        <div className="act-scale">
          <span>+{compact(scale)}</span>
          <span>0</span>
          <span>−{compact(scale)}</span>
        </div>
        <div className="act-cols">
          {points.map((p, i) => (
            <div
              key={p.date}
              className={`act-col${i === active ? " on" : ""}`}
              onMouseEnter={() => setHover(i)}
              tabIndex={0}
              onFocus={() => setHover(i)}
              role="img"
              aria-label={`Week of ${dayLabel(p.date)}: ${p.commits} commits, ${p.added} lines added, ${p.removed} removed`}
            >
              <span className="half up">
                <span className="bar added" style={{ height: `${(p.added / scale) * 100}%` }} />
              </span>
              <span className="half down">
                <span className="bar removed" style={{ height: `${(p.removed / scale) * 100}%` }} />
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="act-axis">
        <span>{dayLabel(points[0].date)}</span>
        <span className="act-readout">
          <b>{dayLabel(shown.date)}</b> · {compact(shown.commits)} commits ·{" "}
          <span className="ink-added">+{compact(shown.added)}</span>{" "}
          <span className="ink-removed">−{compact(shown.removed)}</span>
        </span>
        <span>{dayLabel(points[points.length - 1].date)}</span>
      </div>

      <details className="act-table">
        <summary>Table</summary>
        <div className="tablewrap">
          <table className="vtable">
            <thead>
              <tr>
                <th>Week of</th>
                <th>Commits</th>
                <th>Added</th>
                <th>Removed</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.date}>
                  <td>{dayLabel(p.date)}</td>
                  <td>{p.commits.toLocaleString("en-US")}</td>
                  <td>{p.added.toLocaleString("en-US")}</td>
                  <td>{p.removed.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/** The 12-week trend that rides a list card: one series, churn per week, the
 *  most recent week in the accent and the rest receding. No axis, no legend —
 *  it is a shape, and the numbers beside it carry the values. */
export function MiniChurn({ points }: { points: GearActivity["points"] }) {
  const tail = points.slice(-12);
  const scale = Math.max(1, ...tail.map((p) => p.added + p.removed));
  if (tail.length === 0) return null;
  return (
    <span className="act-mini" aria-hidden="true">
      {tail.map((p, i) => (
        <span
          key={p.date}
          className={`act-tick${i === tail.length - 1 ? " now" : ""}`}
          style={{ height: `${Math.max(6, ((p.added + p.removed) / scale) * 100)}%` }}
        />
      ))}
    </span>
  );
}

/** The five numbers, as stat tiles. */
export function ActivityTiles({ activity }: { activity: GearActivity }) {
  const tiles: { label: string; value: string; tone?: "added" | "removed" }[] = [
    { label: "Commits", value: compact(activity.commits) },
    { label: "Lines added", value: `+${compact(activity.linesAdded)}`, tone: "added" },
    { label: "Lines removed", value: `−${compact(activity.linesRemoved)}`, tone: "removed" },
    { label: "Files touched", value: compact(activity.filesChanged) },
    { label: "Authors", value: compact(activity.authors) },
  ];
  return (
    <div className="act-tiles">
      {tiles.map((t) => (
        <div className="act-tile" key={t.label}>
          <span className="act-label">{t.label}</span>
          <span className={`act-value${t.tone ? ` ink-${t.tone}` : ""}`}>{t.value}</span>
        </div>
      ))}
    </div>
  );
}

/* ── styles ───────────────────────────────────────────────────────────────────
 * Scoped under `.gcat` like the rest of the page, and appended to its stylesheet.
 *
 * The two data colours are a validated diverging pair (blue ↔ red): warm/cool
 * poles that read as opposite, with a neutral rule at zero. Both steps clear the
 * lightness band, the chroma floor, ≥3:1 against the surface they sit on, and
 * ΔE 21.6 (light) / 19.2 (dark) under simulated protanopia — checked with the
 * palette validator rather than by eye, once per theme.
 */
export const ACTIVITY_CSS = `
.gcat {
  --act-added:#2a78d6; --act-removed:#e34948;
  --act-added-soft:color-mix(in srgb,var(--act-added) 30%,var(--studio-surface));
}
@media (prefers-color-scheme: dark) {
  .gcat:not([data-theme="light"]) {
    --act-added:#3987e5; --act-removed:#e66767;
  }
}

.gcat .act-panel { min-width:0; border:1px solid var(--studio-line); border-radius:var(--studio-radius);
  background:var(--studio-surface); padding:14px 16px 12px; margin:14px 0; }
.gcat .act-panel > header { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:2px; }
.gcat .act-panel > header h2 { font-size:13px; font-weight:600; margin:0; }
.gcat .act-note { color:var(--studio-muted); font-size:11.5px; margin:0 0 12px; }
.gcat .act-note code { font-family:var(--studio-mono); font-size:11px; }
.gcat .act-empty { color:var(--studio-muted); font-size:12px; margin:8px 0; }

.gcat .act-tiles { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
.gcat .act-tile { flex:1 1 84px; min-width:0; background:var(--studio-surface-raised);
  border-radius:6px; padding:8px 10px; display:flex; flex-direction:column; gap:2px; }
.gcat .act-label { font-size:10.5px; color:var(--studio-muted); }
.gcat .act-value { font-size:17px; font-weight:600; letter-spacing:-.01em; }
.gcat .ink-added { color:var(--act-added); }
.gcat .ink-removed { color:var(--act-removed); }

.gcat .act-fig { margin:0; min-width:0; }
.gcat .act-cap { display:flex; align-items:baseline; justify-content:space-between;
  gap:12px; flex-wrap:wrap; margin-bottom:8px; }
.gcat .act-title { font-size:11.5px; color:var(--studio-muted); }
.gcat .act-legend { display:flex; gap:12px; }
.gcat .act-key { display:inline-flex; align-items:center; gap:5px; font-size:11px; color:var(--studio-muted); }
.gcat .act-key .sw { width:9px; height:9px; border-radius:2px; display:inline-block; }
.gcat .act-key .sw.added { background:var(--act-added); }
.gcat .act-key .sw.removed { background:var(--act-removed); }

.gcat .act-plot { display:flex; gap:8px; }
.gcat .act-scale { display:flex; flex-direction:column; justify-content:space-between;
  font-size:10px; color:var(--studio-muted); font-variant-numeric:tabular-nums;
  text-align:right; min-width:30px; height:132px; }
.gcat .act-cols { flex:1; display:flex; gap:2px; align-items:stretch; height:132px;
  min-width:0; position:relative; }
/* One hairline across the whole plot. Drawn per column it came out looking
   dashed, which reads as a styled gridline rather than the zero baseline. */
.gcat .act-cols::before { content:""; position:absolute; left:0; right:0; top:50%;
  height:1px; background:var(--studio-line); pointer-events:none; }
.gcat .act-col { flex:1 1 0; min-width:0; display:flex; flex-direction:column;
  cursor:default; outline:none; border-radius:3px; }
.gcat .act-col .half { flex:1 1 0; display:flex; justify-content:center; min-height:0;
  position:relative; }
.gcat .act-col .half.up { align-items:flex-end; }
.gcat .act-col .half.down { align-items:flex-start; }
.gcat .act-col .bar { width:100%; max-width:24px; display:block; }
.gcat .act-col .bar.added { background:var(--act-added); border-radius:4px 4px 0 0; }
.gcat .act-col .bar.removed { background:var(--act-removed); border-radius:0 0 4px 4px; }
.gcat .act-col.on { background:color-mix(in srgb,var(--studio-accent) 8%,transparent); }
.gcat .act-col:focus-visible { box-shadow:inset 0 0 0 1px var(--studio-accent); }

.gcat .act-axis { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:4px 10px;
  margin-top:6px; font-size:10.5px; color:var(--studio-muted); }
.gcat .act-readout { color:var(--studio-text); font-size:11px; text-align:center; flex:1;
  font-variant-numeric:tabular-nums; }

.gcat .act-table { margin-top:10px; }
.gcat .act-table summary { font-size:11px; color:var(--studio-muted); cursor:pointer; }
.gcat .act-table .vtable td { font-variant-numeric:tabular-nums; }

.gcat .act-mini { display:flex; align-items:flex-end; gap:2px; height:18px; width:74px; flex:none; }
.gcat .act-mini .act-tick { flex:1 1 0; background:var(--act-added-soft); border-radius:1.5px 1.5px 0 0; }
.gcat .act-mini .act-tick.now { background:var(--act-added); }

.gcat .act-card { display:flex; align-items:center; gap:8px; font-size:11px;
  color:var(--studio-muted); font-variant-numeric:tabular-nums; }
.gcat .act-card b { color:var(--studio-text); font-weight:600; }
`;
