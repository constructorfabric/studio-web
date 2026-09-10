// Tables for the System view: the running gears and the registered permissions,
// instead of a JSON dump / a bare id list.
import { useMemo, useState } from "react";

const TBL_CSS = `
.systbl-search { width: 100%; max-width: 340px; font: inherit; font-size: 13px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); outline: none; margin-bottom: 10px; }
.systbl-search:focus { border-color: var(--accent, #2563eb); }
.systbl-scroll { max-height: 460px; overflow: auto; border: 1px solid var(--border); border-radius: 10px; }
.systbl thead th { position: sticky; top: 0; z-index: 1; background: var(--card, var(--bg)); }
.systbl tbody td { font-size: 13px; vertical-align: top; }
.systbl-name { font-weight: 550; }
.systbl-pills { display: flex; flex-wrap: wrap; gap: 4px; }
.systbl-pill { font-size: 11px; padding: 1px 7px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); white-space: nowrap; }
.systbl-mono { font-size: 11.5px; color: var(--muted); word-break: break-all; }
.systbl-desc { color: var(--muted); max-width: 520px; }
.systbl-muted { color: var(--muted); }
.systbl-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
.systbl-foot { margin-top: 8px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
`;

// ── Gears ──────────────────────────────────────────────────────────────────
interface Gear {
  name: string;
  capabilities?: string[];
  dependencies?: string[];
  deployment_mode?: string;
  instances?: unknown[];
}

export function GearsTable({ data }: { data: unknown }) {
  const [q, setQ] = useState("");
  const gears = useMemo(() => {
    if (Array.isArray(data)) return data as Gear[];
    return ((data as { gears?: Gear[] } | undefined)?.gears ?? []) as Gear[];
  }, [data]);
  const err = (data as { error?: string } | undefined)?.error;
  if (err) return <p className="error">{err}</p>;

  const needle = q.trim().toLowerCase();
  const shown = gears.filter(
    (g) =>
      needle === "" ||
      g.name.toLowerCase().includes(needle) ||
      (g.capabilities ?? []).some((c) => c.toLowerCase().includes(needle)) ||
      (g.dependencies ?? []).some((d) => d.toLowerCase().includes(needle)),
  );

  return (
    <div>
      <style>{TBL_CSS}</style>
      <input className="systbl-search" type="search" placeholder="Search gears, capabilities, deps…"
        value={q} spellCheck={false} onChange={(e) => setQ(e.target.value)} />
      <div className="systbl-scroll">
        <table className="ptable systbl">
          <thead>
            <tr>
              <th>Gear</th>
              <th>Capabilities</th>
              <th>Dependencies</th>
              <th>Deployment</th>
              <th>Instances</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((g) => (
              <tr key={g.name}>
                <td className="systbl-name">{g.name}</td>
                <td>
                  <div className="systbl-pills">
                    {(g.capabilities ?? []).map((c) => <span key={c} className="systbl-pill">{c}</span>)}
                    {(g.capabilities ?? []).length === 0 && <span className="systbl-muted">—</span>}
                  </div>
                </td>
                <td>
                  <div className="systbl-pills">
                    {(g.dependencies ?? []).map((d) => <span key={d} className="systbl-pill">{d}</span>)}
                    {(g.dependencies ?? []).length === 0 && <span className="systbl-muted">—</span>}
                  </div>
                </td>
                <td><span className="systbl-badge">{(g.deployment_mode ?? "—").replace(/_/g, " ")}</span></td>
                <td style={{ fontVariantNumeric: "tabular-nums" }}>{(g.instances ?? []).length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="systbl-foot">Showing <b>{shown.length}</b> of {gears.length} gears.</div>
    </div>
  );
}

// ── Permissions ─────────────────────────────────────────────────────────────
interface Entity {
  gts_id: string;
  content?: { display_name?: string; action?: string; resource_type?: string; description?: string };
}

const PERM_BASE = "gts.cf.toolkit.authz.permission.v1~";

export function PermissionsTable({ data }: { data: unknown }) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const list = (data as { entities?: Entity[] } | undefined)?.entities ?? [];
    return list
      // Instances only (the derived permissions), not the base type.
      .filter((e) => e.gts_id?.includes("authz.permission") && e.gts_id !== PERM_BASE)
      .map((e) => {
        const short = e.gts_id.replace(PERM_BASE, "");
        return {
          id: e.gts_id,
          short,
          name: e.content?.display_name || short.replace(/\.v\d+$/, "").replace(/[._]+/g, " ").trim(),
          action: e.content?.action ?? "",
          resource: (e.content?.resource_type ?? "").replace(/^gts\./, ""),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  const needle = q.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      needle === "" ||
      r.name.toLowerCase().includes(needle) ||
      r.short.toLowerCase().includes(needle) ||
      r.action.toLowerCase().includes(needle) ||
      r.resource.toLowerCase().includes(needle),
  );

  if (rows.length === 0) return <p className="empty">No permission instances found in the types-registry.</p>;

  return (
    <div>
      <style>{TBL_CSS}</style>
      <input className="systbl-search" type="search" placeholder="Search permissions, actions, resources…"
        value={q} spellCheck={false} onChange={(e) => setQ(e.target.value)} />
      <div className="systbl-scroll">
        <table className="ptable systbl">
          <thead>
            <tr>
              <th>Permission</th>
              <th>Action</th>
              <th>Resource</th>
              <th>Id</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td className="systbl-name">{r.name}</td>
                <td>{r.action ? <span className="systbl-badge">{r.action}</span> : <span className="systbl-muted">—</span>}</td>
                <td><code className="systbl-mono" title={r.resource}>{r.resource || "—"}</code></td>
                <td><code className="systbl-mono" title={r.id}>{r.short}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="systbl-foot">Showing <b>{shown.length}</b> of {rows.length} permissions.</div>
    </div>
  );
}
