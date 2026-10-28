// Saved views over the domain model: pick a type, its columns, conditions and
// related objects, save it, and it is a screen. Nothing here is specific to any
// one type, and nothing behind it changes when a view is added (views-model.ts).

import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "./api";
import { DataTable, type Column, type PageRequest } from "./data-table";
import { DomainModelGraph, type GraphSource } from "./domain-model-graph";
import { DOMAIN_ENTITIES, type DomainEntity } from "./domain-model.gen";
import { useCurrentModel, useDomainModel } from "./domain-runtime";
import type { DomainOperation, DomainQuery } from "./domain-query";
import { errText } from "./format";
import { Modal } from "./modal";
import {
  LIST_VIEWS,
  VIEW_OPS,
  blankView,
  cellText,
  fieldsOf,
  fromViewObject,
  graphQuery,
  labelField,
  pageQuery,
  PageCursors,
  problems,
  relationLabel,
  relationsOf,
  toGraph,
  toViewObject,
  type LooseQuery,
  type LooseResult,
  type LooseRow,
  type ViewCondition,
  type ViewSpec,
} from "./views-model";
import { useDomainRefresh, useDomainRevision } from "./domain-live";

/** The query endpoint is typed per entity; a view's type is only known at
 *  runtime, so the screen sends the loose shape and reads the loose answer. */
async function runQuery(token: string, q: LooseQuery): Promise<LooseResult> {
  const res = await api.queryDomain(token, q as unknown as DomainQuery<DomainEntity>);
  return res as unknown as LooseResult;
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function ViewsScreen({ token }: { token: string }) {
  // Fields and relations come from the live model, so a field added in
  // Administration › Domain model can be a column at once.
  useDomainModel(token);
  const [views, setViews] = useState<ViewSpec[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ViewSpec | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const res = await runQuery(token, LIST_VIEWS);
      const specs = res.items
        .map((r) => fromViewObject(r.value))
        .filter((v): v is ViewSpec => v !== null);
      setViews(specs);
      setSelectedId((id) => (id && specs.some((v) => v.id === id) ? id : (specs[0]?.id ?? null)));
    } catch (e) {
      setError(errText(e));
      setViews([]);
    }
  }, [token]);
  useDomainRefresh(["view"], reload);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selected = views?.find((v) => v.id === selectedId) ?? null;

  const store = async (spec: ViewSpec, extra?: Record<string, unknown>) => {
    // The view's stored shape is the editor's, not the generated type's.
    const upsert = { op: "upsert", type: "view", key: spec.id, value: { ...toViewObject(spec), ...extra } };
    await api.mutateDomain(token, { validate: "off", operations: [upsert as DomainOperation] });
  };

  const save = async (spec: ViewSpec) => {
    setBusy(true);
    setSaveError(null);
    try {
      await store(spec);
      setEditing(null);
      setSelectedId(spec.id);
      await reload();
    } catch (e) {
      setSaveError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  // A view is retired, not deleted: the model's `valid_to` says it ended, the
  // list reads live views only, and a deleted graph key could never be reused.
  const retire = async (spec: ViewSpec) => {
    setError(null);
    try {
      await store(spec, { valid_to: new Date().toISOString() });
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <div className="views-screen" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>Views</h2>
          <span className="hint" style={{ flex: 1 }}>
            Lists of the domain model's objects, defined here and stored as <code>view</code>{" "}
            objects. A new one needs no release.
          </span>
          <button className="primary" onClick={() => setEditing(blankView("project", newId()))}>
            New view
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {views === null ? (
          <p className="empty">Loading views…</p>
        ) : views.length === 0 ? (
          <p className="empty">No views yet. A view is a type, its columns and its conditions.</p>
        ) : (
          <div role="tablist" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {views.map((v) => (
              <button
                key={v.id}
                role="tab"
                aria-selected={v.id === selectedId}
                className={v.id === selectedId ? "primary" : undefined}
                onClick={() => setSelectedId(v.id)}
                title={`${v.type} · ${v.columns.length} columns`}
              >
                {v.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <strong>{selected.name}</strong>
            <span className="hint">
              {selected.type} · {selected.kind}
              {selected.conditions.length > 0 && ` · ${selected.conditions.length} conditions`}
            </span>
            <span style={{ flex: 1 }} />
            <button onClick={() => setEditing(selected)}>Edit</button>
            <button onClick={() => void retire(selected)}>Retire</button>
          </div>
          {selected.kind === "graph" ? (
            <ViewGraph token={token} spec={selected} />
          ) : (
            <ViewTable token={token} spec={selected} />
          )}
        </div>
      )}

      {editing && (
        <ViewEditor
          initial={editing}
          busy={busy}
          error={saveError}
          onCancel={() => {
            setEditing(null);
            setSaveError(null);
          }}
          onSave={(s) => void save(s)}
        />
      )}
    </div>
  );
}

/** One view, rendered: its query paged, sorted and searched by the backend. */
export function ViewTable({ token, spec }: { token: string; spec: ViewSpec }) {
  const [notes, setNotes] = useState<string[]>([]);
  const fields = fieldsOf(spec.type);
  const rels = relationsOf(spec.type);

  const columns = useMemo<Column<LooseRow>[]>(
    () => [
      ...spec.columns.map((f) => ({
        id: f,
        header: f,
        cell: (r: LooseRow) => cellText(r.value[f]),
        serverSort: true,
        num: fields[f]?.kind === "number",
      })),
      ...spec.relations.map((name) => ({
        id: `rel:${name}`,
        header: relationLabel(name, rels[name]),
        cell: (r: LooseRow) => {
          const set = r.relations[name];
          if (!set || set.total === 0) return "—";
          const target = rels[name];
          const label = target ? labelField(target) : "id";
          const shown = set.items.map((i) => cellText(i.value[label] ?? i.id)).join(", ");
          return set.total > set.items.length ? `${shown} +${set.total - set.items.length}` : shown;
        },
      })),
    ],
    [spec, fields, rels],
  );

  // The view's type and every type it includes: a change to any of them
  // re-reads the page, as does a change to the model its columns come from.
  const revision = useDomainRevision([spec.type, ...Object.values(rels)], { onModel: true });
  const cursors = useMemo(() => new PageCursors(), []);
  const load = useCallback(
    async (req: PageRequest) => {
      const q = pageQuery(spec, req);
      const res = await runQuery(token, cursors.place(q));
      cursors.note(q, res.items.length, res.next_cursor);
      const said = [...res.warnings];
      if (!res.complete) said.push("The type has more objects than one query reads; this list covers the first 5,000.");
      setNotes(said);
      return { items: res.items, total: res.total };
    },
    [token, spec, cursors],
  );

  return (
    <>
      {notes.length > 0 && (
        // One line, the detail on request: the warnings are true (a relation
        // can share its edge type with another, gears-rust#5240) and long, and
        // three paragraphs above a table bury the table.
        <details className="hint">
          <summary>
            ⚠ This list may be incomplete or include more than it says ({notes.length})
          </summary>
          <ul style={{ margin: "4px 0 0" }}>
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}
      <DataTable<LooseRow>
        list={`view-${spec.id}`}
        columns={columns}
        rowKey={(r) => r.id}
        rowLabel={(r) => cellText(r.value[labelField(spec.type)] ?? r.id)}
        load={load}
        reloadKey={`${JSON.stringify(spec)}:${revision}`}
        search={{ placeholder: `Search ${spec.type}` }}
        empty={{ title: `No ${spec.type} matches this view.` }}
      />
    </>
  );
}

/** One view as a graph: its objects and the related objects it includes, with
 *  the relations between them. The same canvas the model graph uses. */
export function ViewGraph({ token, spec }: { token: string; spec: ViewSpec }) {
  const source = useMemo<GraphSource>(
    () => ({
      key: JSON.stringify(spec),
      load: async () => toGraph(spec, await runQuery(token, graphQuery(spec))),
    }),
    [token, spec],
  );
  return <DomainModelGraph token={token} source={source} />;
}

/** The view editor: type, columns, conditions, related objects, order. */
export function ViewEditor({
  initial,
  busy,
  error,
  onSave,
  onCancel,
}: {
  initial: ViewSpec;
  busy: boolean;
  error: string | null;
  onSave: (spec: ViewSpec) => void;
  onCancel: () => void;
}) {
  const [spec, setSpec] = useState<ViewSpec>(initial);
  const fields = fieldsOf(spec.type);
  const fieldNames = useMemo(() => Object.keys(fields).sort(), [fields]);
  const rels = relationsOf(spec.type);
  const issues = problems(spec);
  const model = useCurrentModel();
  const types = useMemo(
    () => (model.source === "server" ? model.entities.filter((e) => !e.abstract).map((e) => e.id as DomainEntity) : [...DOMAIN_ENTITIES]).sort(),
    [model],
  );

  const toggle = (list: string[], item: string) =>
    list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
  const setCondition = (i: number, patch: Partial<ViewCondition>) =>
    setSpec((s) => ({
      ...s,
      conditions: s.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    }));

  return (
    <Modal label={initial.name ? `Edit ${initial.name}` : "New view"} onClose={busy ? () => undefined : onCancel} cardStyle={{ width: "min(760px, 100%)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>{initial.name ? `Edit ${initial.name}` : "New view"}</span>
        <button onClick={onCancel} disabled={busy} style={{ marginLeft: "auto" }} aria-label="Close">
          ✕
        </button>
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Name
        <input value={spec.name} onChange={(e) => setSpec({ ...spec, name: e.target.value })} placeholder="Active projects" />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Objects of type
        <select
          value={spec.type}
          onChange={(e) => {
            const type = e.target.value as DomainEntity;
            // Fields and relations belong to a type; another type starts over.
            setSpec({ ...blankView(type, spec.id), name: spec.name });
          }}
        >
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>

      <fieldset style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
        <legend>Columns</legend>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 4 }}>
          {fieldNames.map((f) => (
            <label key={f} style={{ fontSize: 12 }}>
              <input
                type="checkbox"
                checked={spec.columns.includes(f)}
                onChange={() => setSpec({ ...spec, columns: toggle(spec.columns, f) })}
              />{" "}
              {f}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
        <legend>Conditions (all must hold)</legend>
        {spec.conditions.map((c, i) => {
          const kind = fields[c.field];
          const needsValue = c.op !== "_is_null" && c.op !== "_not_null";
          return (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <select value={c.field} onChange={(e) => setCondition(i, { field: e.target.value, value: "" })}>
                {fieldNames.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <select value={c.op} onChange={(e) => setCondition(i, { op: e.target.value as ViewCondition["op"] })}>
                {VIEW_OPS.map((o) => (
                  <option key={o.op} value={o.op}>
                    {o.label}
                  </option>
                ))}
              </select>
              {needsValue &&
                (kind?.kind === "enum" || kind?.kind === "boolean" ? (
                  <select value={c.value} onChange={(e) => setCondition(i, { value: e.target.value })}>
                    <option value="">—</option>
                    {(kind.kind === "enum" ? kind.values : ["true", "false"]).map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={c.value}
                    onChange={(e) => setCondition(i, { value: e.target.value })}
                    placeholder={kind?.kind === "number" ? "a number" : "a value"}
                  />
                ))}
              <button
                aria-label="Remove condition"
                onClick={() => setSpec({ ...spec, conditions: spec.conditions.filter((_, j) => j !== i) })}
              >
                ✕
              </button>
            </div>
          );
        })}
        <div>
          <button
            onClick={() =>
              setSpec({
                ...spec,
                conditions: [...spec.conditions, { field: labelField(spec.type), op: "_contains", value: "" }],
              })
            }
          >
            Add condition
          </button>
        </div>
      </fieldset>

      {Object.keys(rels).length > 0 && (
        <fieldset style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
          <legend>Related objects</legend>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 4 }}>
            {Object.entries(rels)
              // Its own relations first, then those pointing at it.
              .sort(([a], [b]) => Number(a.startsWith("~")) - Number(b.startsWith("~")) || a.localeCompare(b))
              .map(([name, target]) => (
                <label key={name} style={{ fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={spec.relations.includes(name)}
                    onChange={() => setSpec({ ...spec, relations: toggle(spec.relations, name) })}
                  />{" "}
                  {relationLabel(name, target)}
                </label>
              ))}
          </div>
        </fieldset>
      )}

      <label style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        Order by
        <select
          value={spec.sort?.field ?? ""}
          onChange={(e) =>
            setSpec({
              ...spec,
              sort: e.target.value ? { field: e.target.value, direction: spec.sort?.direction ?? "asc" } : null,
            })
          }
        >
          <option value="">id</option>
          {fieldNames.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        {spec.sort && (
          <select
            value={spec.sort.direction}
            onChange={(e) =>
              setSpec({ ...spec, sort: { field: spec.sort!.field, direction: e.target.value as "asc" | "desc" } })
            }
          >
            <option value="asc">ascending</option>
            <option value="desc">descending</option>
          </select>
        )}
      </label>

      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
        Show as
        <select value={spec.kind} onChange={(e) => setSpec({ ...spec, kind: e.target.value as ViewSpec["kind"] })}>
          <option value="table">a table</option>
          <option value="graph">a graph, with the related objects</option>
        </select>
      </label>

      {issues.length > 0 && (
        <ul className="hint" style={{ margin: 0 }}>
          {issues.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="primary" disabled={busy || issues.length > 0} onClick={() => onSave(spec)}>
          {busy ? "Saving…" : "Save view"}
        </button>
      </div>
    </Modal>
  );
}
