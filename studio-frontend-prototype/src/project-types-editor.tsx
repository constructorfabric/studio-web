/* The workspace's "Project types" tab: which kinds of project its New project
 * card offers, what each creates and which tabs its projects show. The model
 * and its rules are `project-types.ts`; this file is the form.
 *
 * Saved where the reader chooses: on this workspace, or on the organization so
 * every workspace of it inherits the list (the metadata is inherited, and the
 * nearest tenant wins). */

import { useEffect, useState } from "react";

import { api } from "./api";
import type { StudioKit } from "./api";
import { errText } from "./problem";
import type { ProjTab } from "./project-overview";
import { BUILTIN_TYPES, PRESETS, RECIPES, keyFor, parseTypes, typesProblem } from "./project-types";
import type { ProjectType } from "./project-types";

type Source = "workspace" | "organization" | "builtin";

export function ProjectTypesTab({
  token,
  workspace,
  tabs,
}: {
  token: string;
  workspace: { id: string; name: string; orgId: string; orgName: string };
  /** Every project tab, in the tab bar's order — passed in, not imported, so
   *  this file does not depend on the screen that draws the bar. */
  tabs: readonly { id: ProjTab; label: string }[];
}) {
  const tabIds = tabs.map((t) => t.id);
  const [types, setTypes] = useState<ProjectType[] | null>(null);
  const [source, setSource] = useState<Source>("builtin");
  const [target, setTarget] = useState<"workspace" | "organization">("organization");
  const [kits, setKits] = useState<StudioKit[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setErr(null);
    Promise.all([api.ownProjectTypes(token, workspace.id), api.ownProjectTypes(token, workspace.orgId)])
      .then(([own, org]) => {
        if (!alive) return;
        const from: Source = own ? "workspace" : org ? "organization" : "builtin";
        setSource(from);
        setTarget(from === "workspace" ? "workspace" : "organization");
        setTypes(parseTypes(own ?? org, tabIds));
      })
      .catch((e) => alive && setErr(errText(e)));
    api
      .kits(token)
      .then((r) => alive && setKits(r.items))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // tabIds is derived from a constant list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, workspace.id, workspace.orgId, reload]);

  if (err && !types) return <div className="error">{err}</div>;
  if (!types) return <p style={{ opacity: 0.7 }}>Reading the project types…</p>;

  const problem = typesProblem(types);
  const edit = (i: number, patch: Partial<ProjectType>) =>
    setTypes(types.map((t, k) => (k === i ? { ...t, ...patch } : t)));
  const sourceWords =
    source === "workspace"
      ? `this workspace's own list`
      : source === "organization"
        ? `the list of ${workspace.orgName}, which every workspace of it inherits`
        : "Studio's built-in types: neither this workspace nor its organization has set any";

  async function save() {
    const problem = typesProblem(types!);
    if (problem) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await api.putProjectTypes(token, target === "workspace" ? workspace.id : workspace.orgId, { types: types! });
      setNote(target === "workspace" ? "Saved for this workspace." : `Saved for ${workspace.orgName}.`);
      setReload((n) => n + 1);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function dropOwn() {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await api.deleteProjectTypes(token, workspace.id);
      setNote("This workspace now uses what it inherits.");
      setReload((n) => n + 1);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 12, maxWidth: 980 }}>
      <div>
        <h3 style={{ margin: "0 0 4px" }}>Project types</h3>
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8, lineHeight: 1.5 }}>
          What the New project card offers here, what each type creates, and which tabs its projects show. Showing{" "}
          {sourceWords}. Projects already created keep their type; one whose type is removed shows every tab.
        </p>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 12, opacity: 0.7 }}>Start from</span>
        {PRESETS.map((p) => (
          <button key={p.id} type="button" onClick={() => setTypes(p.types.map((t) => ({ ...t })))}>
            {p.title}
          </button>
        ))}
        <button
          type="button"
          onClick={() =>
            setTypes([
              ...types,
              { key: keyFor("New type", types.map((t) => t.key)), title: "New type", description: "", recipe: "existing" },
            ])
          }
        >
          + Add a type
        </button>
      </div>

      {types.map((t, i) => (
        <section
          key={i}
          data-type={t.key}
          style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              aria-label="Title"
              value={t.title}
              onChange={(e) => edit(i, { title: e.target.value })}
              style={{ flex: "1 1 220px", fontWeight: 600 }}
            />
            <label style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
              key
              <input
                aria-label="Key"
                value={t.key}
                onChange={(e) => edit(i, { key: e.target.value.trim() })}
                style={{ width: 160, fontFamily: "var(--font-mono)" }}
              />
            </label>
            <button
              type="button"
              disabled={i === 0}
              onClick={() => setTypes([...types.slice(0, i - 1), t, types[i - 1], ...types.slice(i + 1)])}
              aria-label="Move up"
            >
              ↑
            </button>
            <button type="button" onClick={() => setTypes(types.filter((_, k) => k !== i))}>
              Remove
            </button>
          </div>
          <textarea
            aria-label="Description"
            rows={2}
            value={t.description}
            placeholder="One line the New project card shows under the title"
            onChange={(e) => edit(i, { description: e.target.value })}
          />
          <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            Creating one makes
            <select value={t.recipe} onChange={(e) => edit(i, { recipe: e.target.value as ProjectType["recipe"] })}>
              {RECIPES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </select>
            <span style={{ opacity: 0.7 }}>— {RECIPES.find((r) => r.id === t.recipe)?.creates}</span>
          </label>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontSize: 12, marginBottom: 4 }}>
              Tabs its projects show{" "}
              <button
                type="button"
                style={{ border: 0, background: "none", padding: 0, color: "var(--link-foreground)", cursor: "pointer", fontSize: 12 }}
                onClick={() => edit(i, { tabs: undefined, first_tab: undefined })}
              >
                all
              </button>
            </legend>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px" }}>
              {tabs.map((tab) => {
                const on = !t.tabs || t.tabs.includes(tab.id);
                return (
                  <label key={tab.id} style={{ fontSize: 12, display: "flex", gap: 4, alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        const current = t.tabs ?? tabIds;
                        const next = on ? current.filter((x) => x !== tab.id) : tabIds.filter((x) => x === tab.id || current.includes(x));
                        edit(i, {
                          tabs: next.length === tabIds.length ? undefined : next,
                          first_tab: t.first_tab && next.includes(t.first_tab) ? t.first_tab : undefined,
                        });
                      }}
                    />
                    {tab.label}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              Opens on
              <select
                value={t.first_tab ?? ""}
                onChange={(e) => edit(i, { first_tab: (e.target.value || undefined) as ProjTab | undefined })}
              >
                <option value="">its first tab</option>
                {tabs
                  .filter((tab) => !t.tabs || t.tabs.includes(tab.id))
                  .map((tab) => (
                    <option key={tab.id} value={tab.id}>
                      {tab.label}
                    </option>
                  ))}
              </select>
            </label>
            {kits.length > 0 && (
              <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                Kits ticked at creation:
                {kits.map((k) => {
                  const on = (t.kits ?? []).includes(k.slug);
                  return (
                    <label key={k.slug} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => {
                          const next = on ? (t.kits ?? []).filter((s) => s !== k.slug) : [...(t.kits ?? []), k.slug];
                          edit(i, { kits: next.length > 0 ? next : undefined });
                        }}
                      />
                      {k.name}
                    </label>
                  );
                })}
              </span>
            )}
          </div>
        </section>
      ))}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
          Save for
          <select value={target} onChange={(e) => setTarget(e.target.value as "workspace" | "organization")}>
            <option value="organization">the whole organization ({workspace.orgName})</option>
            <option value="workspace">only this workspace ({workspace.name})</option>
          </select>
        </label>
        <button type="button" className="primary" disabled={busy || problem !== null} onClick={save}>
          Save
        </button>
        {source === "workspace" && (
          <button type="button" disabled={busy} onClick={dropOwn}>
            Use the inherited list here
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => setReload((n) => n + 1)}>
          Discard changes
        </button>
        {problem && <span className="error" style={{ fontSize: 12 }}>{problem}</span>}
        {note && <span style={{ fontSize: 12, opacity: 0.8 }}>{note}</span>}
        {err && <span className="error" style={{ fontSize: 12 }}>{err}</span>}
      </div>
      {source === "builtin" && types === BUILTIN_TYPES && (
        <p style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>Nothing is stored until you save.</p>
      )}
    </div>
  );
}
