// A scannable table of the registered GTS entities (types-registry/v1/entities)
// instead of a raw JSON dump: categorised by gts_id, searchable, filterable.
import { useEffect, useMemo, useState } from "react";

interface Segment { vendor?: string; package?: string; namespace?: string; type_name?: string; ver_major?: number }
interface Entity {
  id: string;
  gts_id: string;
  segments?: Segment[];
  is_schema?: boolean;
  content?: { title?: string; description?: string } & Record<string, unknown>;
  description?: string;
}

const CATEGORIES = ["Domain type", "Graph type", "Tenant type", "Tenant metadata", "Permission", "Plugin", "Other"] as const;
type Category = (typeof CATEGORIES)[number];

const CAT_COLOR: Record<Category, string> = {
  "Domain type": "#34d399", "Graph type": "#f472b6", "Tenant type": "#60a5fa",
  "Tenant metadata": "#22d3ee", Permission: "#f59e0b", Plugin: "#a78bfa", Other: "#94a3b8",
};

function categoryOf(g: string): Category {
  if (g.startsWith("gts.cf.core.graph")) return "Graph type";
  if (g.startsWith("gts.cf.studio.domain")) return "Domain type";
  if (g.includes("authz.permission")) return "Permission";
  if (g.includes(".plugins.plugin.")) return "Plugin";
  if (g.includes("am.tenant_type")) return "Tenant type";
  if (g.includes("am.tenant_metadata")) return "Tenant metadata";
  return "Other";
}

function titleize(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function displayName(e: Entity): string {
  if (e.content?.title) return e.content.title;
  const last = e.segments?.[e.segments.length - 1]?.type_name;
  return last ? titleize(last) : e.gts_id;
}

/** The leaf `gts` id (the derived tail) without the family ancestry, for a shorter cell. */
function leafId(g: string): string {
  const parts = g.split("~").filter(Boolean);
  const tail = parts[parts.length - 1] ?? g;
  return tail.endsWith("~") ? tail : tail + "~";
}

export function GtsEntitiesTable({ data }: { data: unknown }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<Category | null>(null);
  const [sel, setSel] = useState<Entity | null>(null);

  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel]);

  const rows = useMemo(() => {
    const d = data as { entities?: Entity[]; error?: string } | undefined;
    const list = d?.entities ?? [];
    return list.map((e) => ({
      e,
      name: displayName(e),
      cat: categoryOf(e.gts_id),
      desc: e.content?.description ?? e.description ?? "",
    }));
  }, [data]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.cat] = (c[r.cat] || 0) + 1;
    return c;
  }, [rows]);

  const err = (data as { error?: string } | undefined)?.error;
  const needle = q.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (cat === null || r.cat === cat) &&
      (needle === "" ||
        r.e.gts_id.toLowerCase().includes(needle) ||
        r.name.toLowerCase().includes(needle) ||
        r.desc.toLowerCase().includes(needle)),
  );

  if (err) return <p className="error">{err}</p>;

  return (
    <div className="gte">
      <style>{GTE_CSS}</style>
      <div className="gte-controls">
        <input className="gte-search" type="search" placeholder="Search types, ids, descriptions…"
          value={q} spellCheck={false} onChange={(e) => setQ(e.target.value)} />
        <div className="gte-chips">
          <button className={"gte-chip" + (cat === null ? " on" : "")} onClick={() => setCat(null)}>
            All <span className="gte-c">{rows.length}</span>
          </button>
          {CATEGORIES.filter((c) => counts[c]).map((c) => (
            <button key={c} className={"gte-chip" + (cat === c ? " on" : "")} onClick={() => setCat(cat === c ? null : c)}>
              <span className="gte-dot" style={{ background: CAT_COLOR[c] }} />{c} <span className="gte-c">{counts[c]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="gte-scroll">
        <table className="ptable gte-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Category</th>
              <th>GTS type</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.e.id} className="gte-row" onClick={() => setSel(r.e)} title="View schema">
                <td className="gte-name">{r.name}</td>
                <td>
                  <span className="gte-badge" style={{ borderColor: CAT_COLOR[r.cat], color: CAT_COLOR[r.cat] }}>
                    <span className="gte-dot" style={{ background: CAT_COLOR[r.cat] }} />{r.cat}
                  </span>
                </td>
                <td><code className="gte-id" title={r.e.gts_id}>{leafId(r.e.gts_id)}</code></td>
                <td className="gte-desc">{r.desc || <span className="gte-muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <p className="gte-muted" style={{ padding: 12 }}>No entities match.</p>}
      </div>
      <div className="gte-foot">
        Showing <b>{shown.length}</b> of {rows.length} registered entities.
      </div>

      {sel && (
        <div className="gte-modal" onClick={() => setSel(null)}>
          <div className="gte-dialog" onClick={(e) => e.stopPropagation()}>
            <button className="gte-close" aria-label="Close" onClick={() => setSel(null)}>×</button>
            <span className="gte-badge" style={{ borderColor: CAT_COLOR[categoryOf(sel.gts_id)], color: CAT_COLOR[categoryOf(sel.gts_id)] }}>
              <span className="gte-dot" style={{ background: CAT_COLOR[categoryOf(sel.gts_id)] }} />
              {categoryOf(sel.gts_id)}{sel.is_schema ? " · schema" : " · instance"}
            </span>
            <h3>{displayName(sel)}</h3>
            <code className="gte-id-full">{sel.gts_id}</code>
            {(sel.content?.description || sel.description) && (
              <p className="gte-modal-desc">{sel.content?.description || sel.description}</p>
            )}
            <h4>{sel.is_schema ? "Schema" : "Content"}</h4>
            <pre className="gte-json">{JSON.stringify(sel.content ?? {}, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

const GTE_CSS = `
.gte-controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 10px; }
.gte-search { flex: 1 1 220px; font: inherit; font-size: 13px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); outline: none; }
.gte-search:focus { border-color: var(--accent, #2563eb); }
.gte-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.gte-chip { font: inherit; font-size: 12px; display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg); color: var(--muted); cursor: pointer; }
.gte-chip:hover { color: var(--text); }
.gte-chip.on { background: var(--accent, #2563eb); border-color: var(--accent, #2563eb); color: #fff; }
.gte-chip.on .gte-c { color: #fff; }
.gte-dot { width: 9px; height: 9px; border-radius: 3px; flex: none; }
.gte-c { font-variant-numeric: tabular-nums; color: var(--muted); }
.gte-scroll { max-height: 460px; overflow: auto; border: 1px solid var(--border); border-radius: 10px; }
.gte-table thead th { position: sticky; top: 0; z-index: 1; background: var(--card, var(--bg)); }
.gte-table tbody td { font-size: 13px; }
.gte-name { font-weight: 550; }
.gte-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 2px 8px; border: 1px solid; border-radius: 999px; white-space: nowrap; }
.gte-id { font-size: 11.5px; color: var(--muted); word-break: break-all; }
.gte-desc { color: var(--muted); max-width: 420px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.gte-muted { color: var(--muted); }
.gte-foot { margin-top: 8px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.gte-row { cursor: pointer; }
.gte-modal { position: fixed; inset: 0; z-index: 60; background: rgba(10,15,25,0.5); display: grid; place-items: center; padding: 20px; }
.gte-dialog { position: relative; width: min(720px, 100%); max-height: 85vh; overflow: auto; background: var(--card, var(--bg)); border: 1px solid var(--border); border-radius: 14px; padding: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.35); }
.gte-close { position: absolute; top: 12px; right: 14px; border: none; background: none; font-size: 22px; line-height: 1; color: var(--muted); cursor: pointer; }
.gte-dialog h3 { margin: 8px 0 4px; font-size: 20px; }
.gte-id-full { font-size: 12px; color: var(--muted); word-break: break-all; }
.gte-modal-desc { font-size: 14px; line-height: 1.5; margin: 12px 0; }
.gte-dialog h4 { margin: 14px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.gte-json { margin: 0; padding: 12px; border-radius: 10px; background: var(--bg); border: 1px solid var(--border); font-size: 12px; line-height: 1.5; overflow: auto; max-height: 48vh; }
`;
