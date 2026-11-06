// The project lifecycle's screens: where its phase list is read from, and the
// editor a workspace or an organization keeps it with. The rules are
// project-lifecycle.ts; the shell reaches both only through
// project-fields-view.tsx.

import { useEffect, useState } from "react";

import { api } from "./api";
import { errText } from "./problem";
import {
  BUILTIN_PHASES,
  defaultStatus,
  phaseKeyFor,
  phasesOf,
  phasesProblem,
  type ProjectPhase,
} from "./project-lifecycle";

/** The phases that apply under a workspace: its own list, else its
 *  organization's, else the built-in one. Both documents are the project
 *  templates' (`cf.studio.project.types.v1~`), read as they are stored. */
export async function loadPhases(token: string, workspaceId: string | null, orgId: string | null): Promise<ProjectPhase[]> {
  const [own, org] = await Promise.all([
    workspaceId ? api.ownProjectTypes(token, workspaceId).catch(() => null) : null,
    orgId ? api.ownProjectTypes(token, orgId).catch(() => null) : null,
  ]);
  return phasesOf(own, org);
}

/** The phases a workspace's projects move through, edited where its project
 *  templates are and saved into the same document beside them. */
export function PhasesEditor({
  token,
  workspace,
  onSaved,
}: {
  token: string;
  workspace: { id: string; orgId: string; orgName: string };
  onSaved?: () => void;
}) {
  const [phases, setPhases] = useState<ProjectPhase[] | null>(null);
  const [source, setSource] = useState<"workspace" | "organization" | "builtin">("builtin");
  const [target, setTarget] = useState<"workspace" | "organization">("organization");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([api.ownProjectTypes(token, workspace.id), api.ownProjectTypes(token, workspace.orgId)])
      .then(([own, org]) => {
        if (!alive) return;
        const ownList = phasesOf(own) !== BUILTIN_PHASES;
        const orgList = phasesOf(org) !== BUILTIN_PHASES;
        setSource(ownList ? "workspace" : orgList ? "organization" : "builtin");
        setTarget(ownList ? "workspace" : "organization");
        setPhases(phasesOf(own, org).map((p) => ({ ...p })));
      })
      .catch((e) => alive && setErr(errText(e)));
    return () => {
      alive = false;
    };
  }, [token, workspace.id, workspace.orgId, reload]);

  if (!phases) return err ? <div className="error">{err}</div> : <p className="sub">Reading the phases…</p>;
  const problem = phasesProblem(phases);
  const edit = (i: number, patch: Partial<ProjectPhase>) => setPhases(phases.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const swap = (i: number, j: number) => {
    if (j < 0 || j >= phases.length) return;
    const next = [...phases];
    [next[i], next[j]] = [next[j], next[i]];
    setPhases(next);
  };

  async function save(list: ProjectPhase[]) {
    if (phasesProblem(list)) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    const tenant = target === "workspace" ? workspace.id : workspace.orgId;
    try {
      // The templates' document: what is there is kept and only `phases`
      // changes. A document without `types` still reads as the built-in
      // templates, so saving phases alone does not empty that list.
      const doc = ((await api.ownProjectTypes(token, tenant)) ?? {}) as Record<string, unknown>;
      await api.putProjectTypes(token, tenant, { ...doc, phases: list });
      setNote(target === "workspace" ? "Saved for this workspace." : `Saved for ${workspace.orgName}.`);
      setReload((n) => n + 1);
      onSaved?.();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card phases-editor" data-phases-editor>
      <h3 style={{ margin: "0 0 4px" }}>Project phases</h3>
      <p className="sub" style={{ margin: "0 0 10px", lineHeight: 1.5 }}>
        The lifecycle a project moves through. Its status is the phase it is in (&ldquo;In development&rdquo;), set by a
        member from the status chip in the project&apos;s tab bar, one step at a time; a closing phase such as Archived
        is reachable from any phase. Showing{" "}
        {source === "workspace"
          ? "this workspace's own list"
          : source === "organization"
            ? `the list of ${workspace.orgName}`
            : "Studio's built-in phases"}
        .
      </p>
      <table className="phases-table">
        <thead>
          <tr>
            <th>Phase</th>
            <th>Status reads</th>
            <th>Closing</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {phases.map((p, i) => (
            <tr key={p.key}>
              <td>
                <input
                  aria-label="Phase name"
                  value={p.label}
                  onChange={(e) =>
                    edit(i, {
                      label: e.target.value,
                      // A status nobody typed follows the name.
                      ...(p.status === defaultStatus(p.label, p.closing) ? { status: defaultStatus(e.target.value, p.closing) } : {}),
                    })
                  }
                />{" "}
                <code className="sub">{p.key}</code>
              </td>
              <td>
                <input aria-label="Status" value={p.status} onChange={(e) => edit(i, { status: e.target.value })} />
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label="Closing phase"
                  checked={!!p.closing}
                  onChange={(e) => edit(i, { closing: e.target.checked || undefined })}
                />
              </td>
              <td style={{ whiteSpace: "nowrap" }}>
                <button className="ghost" aria-label="Earlier" disabled={i === 0} onClick={() => swap(i, i - 1)}>
                  ↑
                </button>
                <button className="ghost" aria-label="Later" disabled={i === phases.length - 1} onClick={() => swap(i, i + 1)}>
                  ↓
                </button>
                <button className="ghost" aria-label={`Remove ${p.label}`} onClick={() => setPhases(phases.filter((_, k) => k !== i))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
        <button
          type="button"
          onClick={() => {
            const key = phaseKeyFor("New phase", phases.map((p) => p.key));
            setPhases([...phases, { key, label: "New phase", status: defaultStatus("New phase") }]);
          }}
        >
          + Phase
        </button>
        <button type="button" className="ghost" onClick={() => setPhases(BUILTIN_PHASES.map((p) => ({ ...p })))}>
          Built-in phases
        </button>
        <span style={{ flex: 1 }} />
        <label className="sub" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          Save for
          <select value={target} onChange={(e) => setTarget(e.target.value as "workspace" | "organization")}>
            <option value="organization">{workspace.orgName}</option>
            <option value="workspace">this workspace only</option>
          </select>
        </label>
        <button className="primary" disabled={busy || !!problem} title={problem ?? undefined} onClick={() => void save(phases)}>
          {busy ? "Saving…" : "Save phases"}
        </button>
      </div>
      <p className="sub" style={{ margin: "8px 0 0" }}>
        A project in a phase removed from the list keeps it, and says it as it was stored until somebody moves it.
      </p>
      {problem && <p className="error">{problem}</p>}
      {err && <p className="error">{err}</p>}
      {note && <p className="sub">{note}</p>}
    </div>
  );
}
