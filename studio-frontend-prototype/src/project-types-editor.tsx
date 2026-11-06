/* The workspace's "Project templates" tab: which templates its New project
 * card offers, what each fills in -- the sources, a brief, the kits, the tabs
 * its projects show -- and nothing more: a template does not say what the
 * product is (product-kind.ts). The model and its rules are
 * `project-types.ts`; this file is the form.
 *
 * Saved where the reader chooses: on this workspace, or on the organization so
 * every workspace of it inherits the list (the metadata is inherited, and the
 * nearest tenant wins). */

import { useEffect, useState } from "react";

import { api } from "./api";
import type { StudioKit } from "./api";
import { errText } from "./problem";
import type { ProjTab } from "./project-overview";
import { BUILTIN_TEMPLATES, PRESETS, keyFor, parseTemplates, templateFills, templatesProblem } from "./project-types";
import type { ProjectTemplate } from "./project-types";
import type { RepoRoad } from "./project-form";
import { useDomainRefresh } from "./domain-live";

const ROAD_WORDS: Record<RepoRoad, string> = {
  none: "no repository yet",
  new: "a new repository",
  existing: "a repository attached",
};

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
  const [types, setTypes] = useState<ProjectTemplate[] | null>(null);
  const [source, setSource] = useState<Source>("builtin");
  const [target, setTarget] = useState<"workspace" | "organization">("organization");
  const [kits, setKits] = useState<StudioKit[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useDomainRefresh(["project-type"], () => setReload((n) => n + 1));

  useEffect(() => {
    let alive = true;
    setErr(null);
    Promise.all([api.ownProjectTypes(token, workspace.id), api.ownProjectTypes(token, workspace.orgId)])
      .then(([own, org]) => {
        if (!alive) return;
        const from: Source = own ? "workspace" : org ? "organization" : "builtin";
        setSource(from);
        setTarget(from === "workspace" ? "workspace" : "organization");
        setTypes(parseTemplates(own ?? org, tabIds));
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
  if (!types) return <p style={{ opacity: 0.7 }}>Reading the project templates…</p>;

  const problem = templatesProblem(types);
  const edit = (i: number, patch: Partial<ProjectTemplate>) =>
    setTypes(types.map((t, k) => (k === i ? { ...t, ...patch } : t)));
  const sourceWords =
    source === "workspace"
      ? `this workspace's own list`
      : source === "organization"
        ? `the list of ${workspace.orgName}, which every workspace of it inherits`
        : "Studio's built-in templates: neither this workspace nor its organization has set any";

  async function save() {
    const problem = templatesProblem(types!);
    if (problem) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      // The phases share this document (project-phases.ts): kept as they are.
      const tenant = target === "workspace" ? workspace.id : workspace.orgId;
      const doc = ((await api.ownProjectTypes(token, tenant)) ?? {}) as Record<string, unknown>;
      await api.putProjectTypes(token, tenant, { ...doc, types: types! });
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
        <h3 style={{ margin: "0 0 4px" }}>Project templates</h3>
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8, lineHeight: 1.5 }}>
          What a new project may start from here. A template is optional and only fills in the New project card: the
          project&apos;s sources, a brief, the kits ticked, and which tabs its projects show. What the product is, is
          not a template&apos;s to say: Studio proposes it from the project&apos;s specs. Showing {sourceWords}. Projects
          already created keep their tabs; one whose template is removed shows every tab.
        </p>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 12, opacity: 0.7 }}>Start from</span>
        {PRESETS.map((p) => (
          <button key={p.id} type="button" onClick={() => setTypes(p.templates.map((t) => ({ ...t })))}>
            {p.title}
          </button>
        ))}
        <button
          type="button"
          onClick={() =>
            setTypes([
              ...types,
              { key: keyFor("New template", types.map((t) => t.key)), title: "New template", description: "" },
            ])
          }
        >
          + Add a template
        </button>
        <button type="button" disabled={types.length === 0} onClick={() => setTypes([])} title="Offer no template: every project starts empty">
          Offer none
        </button>
      </div>

      {types.map((t, i) => (
        <section
          key={i}
          data-template={t.key}
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
          <div style={{ fontSize: 12, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              Sources: starts with
              <select
                value={t.repository ?? "none"}
                onChange={(e) => {
                  const road = e.target.value as RepoRoad;
                  edit(i, road === "none" ? { repository: undefined, starter_gear: undefined } : { repository: road });
                }}
                data-template-repository
              >
                {(Object.keys(ROAD_WORDS) as RepoRoad[]).map((r) => (
                  <option key={r} value={r}>
                    {ROAD_WORDS[r]}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", gap: 4, alignItems: "center", opacity: t.repository ? 1 : 0.5 }}>
              <input
                type="checkbox"
                checked={!!t.starter_gear}
                disabled={!t.repository}
                onChange={(e) => edit(i, { starter_gear: e.target.checked || undefined })}
                data-template-starter-gear
              />
              with a starter gear
            </label>
            <span style={{ opacity: 0.7 }}>{templateFills(t)}</span>
          </div>
          <textarea
            aria-label="Brief"
            rows={2}
            value={t.brief ?? ""}
            placeholder="A brief the card starts with (optional): what a project from this template builds"
            onChange={(e) => edit(i, { brief: e.target.value || undefined })}
          />
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
      {source === "builtin" && types === BUILTIN_TEMPLATES && (
        <p style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>Nothing is stored until you save.</p>
      )}
    </div>
  );
}
