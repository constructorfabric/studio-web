// The pieces of model-driven tabs a screen draws: the tabs of a level with
// what an administrator turned off, the dialog that turns them on and off,
// and the generic tab that lists a type's objects (see level-tabs.ts).

import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "./api";
import type { DomainEntity } from "./domain-model.gen";
import type { DomainOperation, DomainQuery } from "./domain-query";
import { fieldsOfModel, reloadDomainModel, useDomainModel } from "./domain-runtime";
import { useDomainRefresh } from "./domain-live";
import { errText } from "./format";
import { allLevelTabs, levelTabs, modelTabs, type GenericTab } from "./level-tabs";
import { Modal } from "./modal";

/** The level's own object (`self` of its type, keyed by its tenant id): where
 *  its `hidden_tabs` are kept. */
function useHiddenTabs(token: string, entity: string, tenantId: string | null) {
  const [hidden, setHidden] = useState<string[]>([]);
  const [objectId, setObjectId] = useState<string | null>(null);
  const model = useDomainModel(token);
  const known = model.byId.has(entity);

  const load = useCallback(async () => {
    if (!tenantId || !known) return;
    try {
      const q = {
        type: entity,
        project_id: tenantId,
        where: { tenant_id: { _eq: tenantId } },
        limit: 1,
      } as unknown as DomainQuery<DomainEntity>;
      const row = (await api.queryDomain(token, q)).items[0];
      setObjectId(row?.id ?? null);
      const value = (row?.value ?? {}) as { hidden_tabs?: unknown };
      setHidden(Array.isArray(value.hidden_tabs) ? value.hidden_tabs.map(String) : []);
    } catch {
      setHidden([]);
    }
  }, [token, entity, tenantId, known]);
  useDomainRefresh([entity], load);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (next: string[]) => {
    if (!tenantId) return;
    const op = objectId
      ? { op: "patch", id: objectId, set: { hidden_tabs: next } }
      : { op: "upsert", type: entity, key: "self", project_id: tenantId, value: { tenant_id: tenantId, hidden_tabs: next } };
    await api.mutateDomain(token, { operations: [op as DomainOperation] });
    setHidden(next);
    await load();
  };
  return { hidden, save };
}

/** A level's tabs from the model, without the ones turned off; `tenantId` is
 *  the level's own tenant (null where another setting decides, as a project
 *  type does for projects). */
export function useLevelTabs<B extends { id: string; icon: string; label: string }>(
  token: string,
  level: "organization" | "workspace" | "project",
  builtIn: readonly B[],
  tenantId: string | null,
) {
  const model = useDomainModel(token);
  const fromModel = useMemo(() => modelTabs(model, level), [model, level]);
  const { hidden, save } = useHiddenTabs(token, level, tenantId);
  const tabs = useMemo(() => levelTabs(builtIn, fromModel, hidden), [builtIn, fromModel, hidden]);
  const all = useMemo(() => allLevelTabs(builtIn, fromModel), [builtIn, fromModel]);
  const builtInIds = useMemo(() => builtIn.map((t) => t.id), [builtIn]);
  return { tabs, all, hidden, saveHidden: save, canEdit: model.canEdit && tenantId !== null, level, builtInIds };
}

/** "Tabs…": an administrator turns a level's tabs on and off. */
export function TabsSettings({
  token,
  level,
  builtInIds,
  all,
  hidden,
  onSave,
  levelName,
}: {
  token: string;
  /** The level's type, which the tabs are relations of. */
  level: string;
  /** Tabs the portal has a screen for: they can be turned off, not removed. */
  builtInIds: string[];
  all: { name: string; label: string }[];
  hidden: string[];
  onSave: (hidden: string[]) => Promise<void>;
  levelName: string;
}) {
  const model = useDomainModel(token);
  const [adding, setAdding] = useState({ target: "", label: "", name: "" });
  const types = useMemo(
    () =>
      [...model.entities]
        .filter((e) => !e.abstract)
        .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)),
    [model],
  );
  const addTab = async () => {
    setBusy(true);
    setError(null);
    try {
      const name = adding.name || slug(adding.label || adding.target);
      await api.addDomainTab(token, level, { name, label: adding.label || undefined, target: adding.target });
      await reloadDomainModel(token);
      setAdding({ target: "", label: "", name: "" });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const removeTab = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.removeDomainField(token, level, name);
      await reloadDomainModel(token);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const [open, setOpen] = useState(false);
  const [off, setOff] = useState<Set<string>>(new Set(hidden));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        className="psection psection-pin"
        title={`Choose which tabs the ${levelName} shows`}
        onClick={() => {
          setOff(new Set(hidden));
          setError(null);
          setOpen(true);
        }}
      >
        <span className="ico" aria-hidden>
          ⚙
        </span>
        Tabs
      </button>
      {open && (
        <Modal label={`Tabs of the ${levelName}`} onClose={() => setOpen(false)}>
          <h2 style={{ marginTop: 0 }}>Tabs of the {levelName}</h2>
          <p className="hint">
            Every tab is a <code>shows</code> relation of the {levelName} type in the domain model; add one there and it
            appears here. A tab turned off is hidden for everyone in this {levelName}; its relation stays.
          </p>
          <div style={{ display: "grid", gap: 4, margin: "8px 0 12px" }}>
            {all.map((t) => (
              <label key={t.name} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={!off.has(t.name)}
                  onChange={(e) => {
                    const next = new Set(off);
                    if (e.target.checked) next.delete(t.name);
                    else next.add(t.name);
                    setOff(next);
                  }}
                />
                {t.label} <code className="hint">{t.name}</code>
                {!builtInIds.includes(t.name) && (
                  <button
                    style={{ marginLeft: "auto" }}
                    disabled={busy}
                    title="Remove this tab's relation from the domain model"
                    onClick={(e) => {
                      e.preventDefault();
                      void removeTab(t.name);
                    }}
                  >
                    Remove
                  </button>
                )}
              </label>
            ))}
          </div>
          <fieldset style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, display: "grid", gap: 6 }}>
            <legend className="hint">Add a tab</legend>
            <p className="hint" style={{ margin: 0 }}>
              Lists the objects of a type in this {levelName}. It is a <code>shows</code> relation of the {levelName} type,
              so every {levelName} of the organization gets it.
            </p>
            <select value={adding.target} onChange={(e) => setAdding({ ...adding, target: e.target.value })}>
              <option value="">Choose a type…</option>
              {types.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name ?? e.id}
                </option>
              ))}
            </select>
            <input
              placeholder="Tab label, e.g. Risks"
              value={adding.label}
              onChange={(e) => setAdding({ ...adding, label: e.target.value })}
            />
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button disabled={busy || !adding.target} onClick={() => void addTab()}>
                Add tab
              </button>
            </div>
          </fieldset>
          {error && <p className="error">{error}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setOpen(false)}>Cancel</button>
            <button
              className="primary"
              disabled={busy || off.size >= all.length}
              title={off.size >= all.length ? "Keep at least one tab" : undefined}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await onSave(all.map((t) => t.name).filter((n) => off.has(n)));
                  setOpen(false);
                } catch (e) {
                  setError(errText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** A tab the model added and no screen answers: the objects of its type in
 *  this level, with the type's own fields as columns. */
export function TypeObjectsTab({
  token,
  tab,
  tenantId,
}: {
  token: string;
  tab: GenericTab;
  /** The level's tenant, to narrow to its objects; null for the organization. */
  tenantId: string | null;
}) {
  const model = useDomainModel(token);
  const entity = model.byId.get(tab.target);
  const [rows, setRows] = useState<{ id: string; value: Record<string, unknown> }[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const columns = useMemo(
    () =>
      entity
        ? fieldsOfModel(model, entity.id)
            .filter((f) => f.declaredBy === entity.id && f.name !== "id" && f.kind.kind !== "unknown")
            .slice(0, 6)
        : [],
    [model, entity],
  );

  const load = useCallback(async () => {
    if (!entity) return;
    setError(null);
    try {
      const q = {
        type: entity.id,
        ...(tenantId ? { project_id: tenantId } : {}),
        limit: 100,
      } as unknown as DomainQuery<DomainEntity>;
      const res = await api.queryDomain(token, q);
      setRows(res.items.map((r) => ({ id: String(r.id), value: (r.value ?? {}) as Record<string, unknown> })));
      setTotal((res as { total?: number }).total ?? res.items.length);
    } catch (e) {
      setError(errText(e));
      setRows([]);
    }
  }, [token, entity, tenantId]);
  useDomainRefresh(entity ? [entity.id] : [], load);
  useEffect(() => {
    void load();
  }, [load]);

  if (!entity) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{tab.label}</h2>
        <p className="hint">
          This tab shows <code>{tab.target}</code>, which the domain model does not define. Add the type in
          Administration › Domain model, or change the tab&apos;s relation.
        </p>
      </div>
    );
  }
  return (
    <div className="card" style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>{tab.label}</h2>
        <span className="hint">
          {entity.name ?? entity.id} · {rows === null ? "loading…" : `${total} object${total === 1 ? "" : "s"}`}
        </span>
      </div>
      <p className="hint" style={{ margin: 0 }}>
        A tab the domain model adds: the objects of <code>{entity.id}</code>
        {tenantId ? " in this place" : " in the organization"}. Its fields are the type&apos;s, edited in Administration ›
        Domain model.
      </p>
      {error && <p className="error">{error}</p>}
      {rows && rows.length === 0 && !error && <p className="empty">Nothing here yet.</p>}
      {rows && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                {(columns.length ? columns.map((c) => c.name) : ["id"]).map((c) => (
                  <th key={c}>{c.replace(/_/g, " ")}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {(columns.length ? columns.map((c) => c.name) : ["id"]).map((c) => (
                    <td key={c}>{show(c === "id" ? r.id : r.value[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.map(show).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** The generic tab `id` (`type:<name>`) of `level`, found in the model. */
export function LevelGenericTab({
  token,
  level,
  id,
  tenantId,
}: {
  token: string;
  level: "organization" | "workspace" | "project";
  id: string;
  tenantId: string | null;
}) {
  const model = useDomainModel(token);
  const name = id.replace(/^type:/, "");
  const found = modelTabs(model, level).find((t) => t.name === name);
  if (!found) return <p className="empty">This tab is no longer in the domain model.</p>;
  return (
    <TypeObjectsTab
      token={token}
      tab={{ id: `type:${found.name}`, icon: "grid", label: found.label, target: found.target }}
      tenantId={tenantId}
    />
  );
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}
