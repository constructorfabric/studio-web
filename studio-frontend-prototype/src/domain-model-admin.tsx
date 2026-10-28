// Administration › Domain model: the types an organization's screens show,
// and their fields, edited where they live (ADR-0051).
//
// A field added here is a field of every object of the type at once: the
// project and workspace screens draw their attributes from the live model
// (`domain-runtime.ts`), so the next render shows it, with no release. A
// field's edit is a numbered model version on the server, so it can be
// reverted there.

import { useEffect, useMemo, useState } from "react";

import { api } from "./api";
import { ancestorsOf, fieldsOfModel, reloadDomainModel, useDomainModel, type ModelField } from "./domain-runtime";
import { errText } from "./format";
import { linksOf, ORIGIN_ORDER, ORIGIN_TITLES, originOf, type Link, type OriginKey } from "./domain-origin";
import { useDomainRevision } from "./domain-live";
import { Modal } from "./modal";

/** The type expressions most fields need, offered by name; anything else can be typed. */
const COMMON_TYPES: { label: string; type: string }[] = [
  { label: "Text", type: "string" },
  { label: "Number", type: "decimal" },
  { label: "Whole number", type: "integer" },
  { label: "Yes / no", type: "boolean" },
  { label: "Date and time", type: "timestamp" },
  { label: "List of texts", type: "string[]" },
  { label: "Link", type: "url" },
];

function typeLabel(type: string): string {
  const bare = type.replace(/\?$/, "");
  const known = COMMON_TYPES.find((t) => t.type === bare);
  if (known) return known.label;
  if (bare.includes("|")) return `One of: ${bare.split("|").map((s) => s.trim()).join(", ")}`;
  return bare || "—";
}

export function DomainModelAdmin({ token, query = "" }: { token: string; query?: string }) {
  const model = useDomainModel(token);
  const [selected, setSelected] = useState<string>("project");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ModelField | null>(null);
  const [creating, setCreating] = useState(false);
  const [showInherited, setShowInherited] = useState(false);
  const [originFilter, setOriginFilter] = useState<OriginKey | "all">("all");
  const counts = useTypeCounts(token);

  const entity = model.byId.get(selected);
  // `id` is the store's key for every object, not a field to rename or drop.
  const fields = useMemo(
    () => (entity ? fieldsOfModel(model, entity.id).filter((f) => f.name !== "id") : []),
    [model, entity],
  );
  const own = fields.filter((f) => f.declaredBy === selected);
  const inherited = fields.filter((f) => f.declaredBy !== selected);

  const grouped = useMemo(() => {
    const term = query.trim().toLowerCase();
    const names = new Map(model.buckets.map((b) => [b.id, b.name]));
    const out = new Map<string, { id: string; name: string; abstract: boolean; origin: OriginKey }[]>();
    for (const e of model.entities) {
      const name = e.name ?? e.id;
      if (term && !`${e.id} ${name}`.toLowerCase().includes(term)) continue;
      const origin = originOf(model, e).key;
      if (originFilter !== "all" && origin !== originFilter) continue;
      const bucket = names.get(e.bucket ?? "") ?? e.bucket ?? "Other";
      if (!out.has(bucket)) out.set(bucket, []);
      out.get(bucket)!.push({ id: e.id, name, abstract: !!e.abstract, origin });
    }
    for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return [...out].sort(([a], [b]) => a.localeCompare(b));
  }, [model, query, originFilter]);

  /** How many types came from each source. */
  const byOrigin = useMemo(() => {
    const n = new Map<OriginKey, number>();
    for (const e of model.entities) {
      const k = originOf(model, e).key;
      n.set(k, (n.get(k) ?? 0) + 1);
    }
    return n;
  }, [model]);

  /** Run a model edit, then reload the model so every screen showing it follows. */
  const run = async (what: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await what();
      await reloadDomainModel(token);
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (model.source !== "server") return <p className="empty">Loading the domain model…</p>;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 280px) 1fr", gap: 12, alignItems: "start" }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "78vh", overflow: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h2 style={{ margin: 0, flex: 1 }}>Types</h2>
          {model.canEdit && (
            <button className="primary" onClick={() => setCreating(true)} disabled={busy}>
              New type
            </button>
          )}
        </div>
        <div className="dm-origins" role="group" aria-label="Where the types came from">
          <button className={originFilter === "all" ? "primary" : undefined} onClick={() => setOriginFilter("all")}>
            All {model.entities.length}
          </button>
          {ORIGIN_ORDER.filter((k) => byOrigin.get(k)).map((k) => (
            <button
              key={k}
              className={originFilter === k ? "primary" : undefined}
              onClick={() => setOriginFilter(k)}
            >
              <span className={`dm-dot origin-${k}`} aria-hidden="true" /> {ORIGIN_TITLES[k]} {byOrigin.get(k)}
            </button>
          ))}
        </div>
        {grouped.map(([bucket, list]) => (
          <div key={bucket} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div className="hint" style={{ textTransform: "uppercase", fontSize: 11, letterSpacing: ".06em" }}>
              {bucket}
            </div>
            {list.map((e) => (
              <button
                key={e.id}
                className={e.id === selected ? "primary" : undefined}
                style={{ textAlign: "left", justifyContent: "flex-start", display: "flex", gap: 6, alignItems: "center" }}
                onClick={() => setSelected(e.id)}
                title={e.id}
              >
                <span className={`dm-dot origin-${e.origin}`} title={ORIGIN_TITLES[e.origin]} aria-hidden="true" />
                <span style={{ flex: 1 }}>
                  {e.name}
                  {e.abstract && <span className="hint"> · base</span>}
                </span>
                {counts.counts && (
                  <span className="hint" title="Objects of this type in this organization">
                    {counts.counts[e.id] ?? 0}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {!entity ? (
          <p className="empty">Pick a type.</p>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <h2 style={{ margin: 0 }}>{entity.name ?? entity.id}</h2>
              <code>{entity.id}</code>
              {(() => {
                const o = originOf(model, entity);
                return (
                  <span className={`dm-origin origin-${o.key}`} title={o.hint}>
                    {o.label}
                  </span>
                );
              })()}
              <span className="hint" title="Objects of this type in this organization">
                {counts.counts
                  ? `${counts.counts[entity.id] ?? 0} object${(counts.counts[entity.id] ?? 0) === 1 ? "" : "s"}`
                  : counts.loading
                    ? "counting objects…"
                    : ""}
              </span>
              {ancestorsOf(model, entity.id).length > 1 && (
                <span className="hint">extends {ancestorsOf(model, entity.id).slice(1).join(" › ")}</span>
              )}
              {model.canEdit && (
                <button className="primary" style={{ marginLeft: "auto" }} onClick={() => setAdding(true)} disabled={busy}>
                  Add field
                </button>
              )}
            </div>
            {entity.description && <p className="hint" style={{ margin: 0 }}>{entity.description}</p>}
            <GtsIds model={model} id={entity.id} />
            {!model.canEdit && (
              <p className="hint">You can read the model. Changing it needs the organization administrator role.</p>
            )}
            {error && <p className="error">{error}</p>}

            <FieldTable
              fields={own}
              empty="No fields of its own yet. Add one, and every screen that shows this type shows it."
              onEdit={model.canEdit ? setEditing : undefined}
              onRemove={
                model.canEdit
                  ? (f) =>
                      void run(() => api.removeDomainField(token, entity.id, f.name))
                  : undefined
              }
            />
            {inherited.length > 0 && (
              <div>
                <button onClick={() => setShowInherited((v) => !v)}>
                  {showInherited ? "Hide" : "Show"} {inherited.length} inherited fields
                </button>
                {showInherited && <FieldTable fields={inherited} empty="" />}
              </div>
            )}
            <Relations
              model={model}
              id={entity.id}
              counts={counts.counts}
              onPick={(id) => {
                setOriginFilter("all");
                setSelected(id);
              }}
            />
          </>
        )}
      </div>

      {adding && entity && (
        <FieldDialog
          title={`Add a field to ${entity.name ?? entity.id}`}
          busy={busy}
          error={error}
          onCancel={() => {
            setAdding(false);
            setError(null);
          }}
          onSave={async (f) => {
            if (await run(() => api.addDomainField(token, entity.id, f))) setAdding(false);
          }}
        />
      )}
      {editing && entity && (
        <FieldDialog
          title={`Edit ${entity.name ?? entity.id}.${editing.name}`}
          initial={editing}
          busy={busy}
          error={error}
          onCancel={() => {
            setEditing(null);
            setError(null);
          }}
          onSave={async (f) => {
            const edit: { rename_to?: string; type?: string; required?: boolean; description?: string } = {};
            if (f.name !== editing.name) edit.rename_to = f.name;
            if (f.type !== editing.type) edit.type = f.type;
            if (f.required !== editing.required) edit.required = f.required;
            if (f.description !== editing.description) edit.description = f.description;
            if (await run(() => api.editDomainField(token, entity.id, editing.name, edit))) setEditing(null);
          }}
        />
      )}
      {creating && (
        <TypeDialog
          bases={model.entities.map((e) => ({ id: e.id, name: e.name ?? e.id }))}
          buckets={model.buckets}
          busy={busy}
          error={error}
          onCancel={() => {
            setCreating(false);
            setError(null);
          }}
          onSave={async (t) => {
            if (await run(() => api.createDomainType(token, t))) {
              setCreating(false);
              setSelected(t.id);
            }
          }}
        />
      )}
    </div>
  );
}

function FieldTable({
  fields,
  empty,
  onEdit,
  onRemove,
}: {
  fields: ModelField[];
  empty: string;
  onEdit?: (f: ModelField) => void;
  onRemove?: (f: ModelField) => void;
}) {
  if (fields.length === 0) return empty ? <p className="empty">{empty}</p> : null;
  return (
    <table className="table" style={{ width: "100%" }}>
      <thead>
        <tr>
          <th>Field</th>
          <th>Kind</th>
          <th>Required</th>
          <th>Description</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => (
          <tr key={`${f.declaredBy}.${f.name}`}>
            <td>
              <code>{f.name}</code>
              {onEdit === undefined && <span className="hint"> · {f.declaredBy}</span>}
              {f.heldBy && (
                <span className="hint" title={`${f.heldBy} writes this field; add a field beside it instead`}>
                  {" "}
                  · 🔒 {f.heldBy}
                </span>
              )}
            </td>
            <td title={f.type}>{typeLabel(f.type)}</td>
            <td>{f.required ? "yes" : ""}</td>
            <td className="hint">{f.description}</td>
            <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
              {onEdit && !f.heldBy && <button onClick={() => onEdit(f)}>Edit</button>}{" "}
              {onRemove && !f.heldBy && (
                <button onClick={() => onRemove(f)} title="Drop the field from the type. Stored values stay in the objects.">
                  Remove
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FieldDialog({
  title,
  initial,
  busy,
  error,
  onSave,
  onCancel,
}: {
  title: string;
  initial?: ModelField;
  busy: boolean;
  error: string | null;
  onSave: (f: { name: string; type: string; required: boolean; description: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState(initial?.type ?? "string");
  const [required, setRequired] = useState(initial?.required ?? false);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [choices, setChoices] = useState(() => (type.includes("|") ? type : ""));
  const custom = !COMMON_TYPES.some((t) => t.type === type) && !type.includes("|");
  const valid = /^[a-z][a-z0-9_]*$/.test(name) && type.trim() !== "";

  return (
    <Modal label={title} onClose={busy ? () => undefined : onCancel} cardStyle={{ width: "min(520px, 100%)" }}>
      <strong>{title}</strong>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Name
        <input value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="cost_center" />
        <span className="hint">Lower-case words joined by underscores.</span>
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Kind
        <select
          value={type.includes("|") ? "__choice" : custom ? "__custom" : type}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__choice") setType(choices || "low | medium | high");
            else if (v === "__custom") setType(type.includes("|") ? "string" : type);
            else setType(v);
          }}
        >
          {COMMON_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
          <option value="__choice">One of a list…</option>
          <option value="__custom">Another type expression…</option>
        </select>
      </label>
      {type.includes("|") && (
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Choices
          <input
            value={choices || type}
            onChange={(e) => {
              setChoices(e.target.value);
              setType(e.target.value);
            }}
            placeholder="low | medium | high"
          />
          <span className="hint">Lower-case values separated by |.</span>
        </label>
      )}
      {custom && (
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Type expression
          <input value={type} onChange={(e) => setType(e.target.value)} placeholder="EntityId" />
        </label>
      )}
      <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
        Required
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Description
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || !valid}
          onClick={() => onSave({ name, type: type.trim(), required, description })}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

function TypeDialog({
  bases,
  buckets,
  busy,
  error,
  onSave,
  onCancel,
}: {
  bases: { id: string; name: string }[];
  buckets: { id: string; name: string }[];
  busy: boolean;
  error: string | null;
  onSave: (t: { id: string; name: string; extends?: string; bucket?: string; description?: string }) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [base, setBase] = useState("managed-object");
  const [bucket, setBucket] = useState("");
  const [description, setDescription] = useState("");
  const valid = /^[a-z][a-z0-9-]*$/.test(id) && !id.endsWith("-");
  const sortedBases = useMemo(() => [...bases].sort((a, b) => a.name.localeCompare(b.name)), [bases]);

  return (
    <Modal label="New type" onClose={busy ? () => undefined : onCancel} cardStyle={{ width: "min(520px, 100%)" }}>
      <strong>New type</strong>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Name
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!id || id === slug(name)) setId(slug(e.target.value));
          }}
          placeholder="Workspace"
        />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Id
        <input value={id} onChange={(e) => setId(e.target.value.trim())} placeholder="workspace" />
        <span className="hint">Lower-case words joined by hyphens. It cannot change later.</span>
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Extends
        <select value={base} onChange={(e) => setBase(e.target.value)}>
          <option value="">— nothing —</option>
          {sortedBases.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} ({b.id})
            </option>
          ))}
        </select>
        <span className="hint">It inherits every field and relation of the type it extends.</span>
      </label>
      {buckets.length > 0 && (
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          Group
          <select value={bucket} onChange={(e) => setBucket(e.target.value)}>
            <option value="">The base type's group</option>
            {buckets.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        Description
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || !valid}
          onClick={() =>
            onSave({
              id,
              name: name.trim() || id,
              ...(base ? { extends: base } : {}),
              ...(bucket ? { bucket } : {}),
              ...(description.trim() ? { description: description.trim() } : {}),
            })
          }
        >
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </Modal>
  );
}

function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** How many objects of each type the organization holds: asked again while
 *  the read model fills, and after every change to the objects. */
function useTypeCounts(token: string): { counts: Record<string, number> | null; loading: boolean } {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const revision = useDomainRevision(["*"], { onModel: true });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = (left: number) => {
      api.domainTypeCounts(token).then(
        (r) => {
          if (!live) return;
          if (r.complete) {
            setCounts(r.counts);
            setLoading(false);
          } else if (left > 0) {
            timer = setTimeout(() => ask(left - 1), 2000);
          } else {
            setLoading(false);
          }
        },
        () => live && setLoading(false),
      );
    };
    ask(15);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [token, revision]);
  return { counts, loading };
}

/** A type's relations: a small map of it among the types it is tied to, and
 *  the same as two lists. Choosing a type opens it. */
function Relations({
  model,
  id,
  counts,
  onPick,
}: {
  model: ReturnType<typeof useDomainModel>;
  id: string;
  counts: Record<string, number> | null;
  onPick: (id: string) => void;
}) {
  const { out, in: into } = useMemo(() => linksOf(model, id), [model, id]);
  if (out.length === 0 && into.length === 0) {
    return (
      <div className="dm-relations">
        <h3>Relations</h3>
        <p className="hint">No relation to or from another type in this model.</p>
      </div>
    );
  }
  // One node per neighbour, around the type: what it points at on the
  // right half, what points at it on the left.
  const right = [...new Map(out.map((l) => [l.other, l])).values()];
  const left = [...new Map(into.filter((l) => !right.some((r) => r.other === l.other)).map((l) => [l.other, l])).values()];
  const rows = Math.max(right.length, left.length, 1);
  const H = Math.max(160, rows * 28 + 24);
  const W = 720;
  const cx = W / 2;
  const cy = H / 2;
  const y = (i: number, n: number) => (n === 1 ? cy : 20 + (i * (H - 40)) / (n - 1));
  const name = (t: string) => model.byId.get(t)?.name ?? t;
  const node = (t: string, x: number, yy: number, anchor: "start" | "end") => (
    <g key={`${anchor}-${t}`} className="dm-node" onClick={() => onPick(t)} role="button" tabIndex={0}>
      <title>{`${name(t)}${counts ? ` · ${counts[t] ?? 0} objects` : ""}`}</title>
      <circle cx={x} cy={yy} r={5} className={`origin-${originOf(model, model.byId.get(t)!).key}`} />
      <text x={anchor === "start" ? x + 9 : x - 9} y={yy + 4} textAnchor={anchor}>
        {name(t)}
      </text>
    </g>
  );
  const edge = (l: Link, x: number, yy: number, outward: boolean) => (
    <g key={`e-${outward}-${l.other}-${l.name}`}>
      <path
        d={`M${cx},${cy} C${(cx + x) / 2},${cy} ${(cx + x) / 2},${yy} ${x},${yy}`}
        className={`dm-edge${outward ? "" : " is-in"}${l.inherited ? " is-inherited" : ""}`}
        markerEnd={outward ? "url(#dm-arrow)" : undefined}
        markerStart={outward ? undefined : "url(#dm-arrow-back)"}
      />
    </g>
  );
  return (
    <div className="dm-relations">
      <h3>Relations</h3>
      <p className="hint">
        Right: what {name(id)} points at. Left: what points at it. Choose a type to open it; a dashed line is a relation it
        inherits from a base.
      </p>
      <div style={{ overflowX: "auto" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ maxWidth: "100%", height: "auto" }} role="img" aria-label={`Relations of ${name(id)}`}>
          <defs>
            <marker id="dm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" className="dm-arrowhead" />
            </marker>
            <marker id="dm-arrow-back" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M10,0 L0,5 L10,10 z" className="dm-arrowhead" />
            </marker>
          </defs>
          {right.map((l, i) => edge(l, W - 200, y(i, right.length), true))}
          {left.map((l, i) => edge(l, 200, y(i, left.length), false))}
          {right.map((l, i) => node(l.other, W - 200, y(i, right.length), "start"))}
          {left.map((l, i) => node(l.other, 200, y(i, left.length), "end"))}
          <g className="dm-center">
            <rect x={cx - 70} y={cy - 16} width={140} height={32} rx={8} />
            <text x={cx} y={cy + 5} textAnchor="middle">
              {name(id)}
            </text>
          </g>
        </svg>
      </div>
      <div className="dm-link-lists">
        <LinkList title={`${name(id)} points at`} links={out} model={model} onPick={onPick} />
        <LinkList title={`Points at ${name(id)}`} links={into} model={model} onPick={onPick} />
      </div>
    </div>
  );
}

/** The GTS ids the type and the edge kinds of its relations are registered
 *  under, as the server reports them: ours, and the one graph-storage keeps. */
function GtsIds({ model, id }: { model: ReturnType<typeof useDomainModel>; id: string }) {
  const type = model.gts.types[id];
  const kinds = useMemo(() => {
    const { out, in: into } = linksOf(model, id);
    return [...new Set([...out, ...into].map((l) => l.kind).filter((k): k is string => !!k))].sort();
  }, [model, id]);
  if (!type) return null;
  return (
    <details className="dm-gts">
      <summary>
        GTS <code>{type.type}</code>
      </summary>
      <table className="table" style={{ width: "100%" }}>
        <thead>
          <tr>
            <th>Registered as</th>
            <th>GTS type</th>
            <th>Stored in graph-storage as</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>node type</td>
            <td>
              <code>{type.type}</code>
            </td>
            <td>
              <code className="hint">{type.stored_as}</code>
            </td>
          </tr>
          {kinds.map((k) => {
            const edge = model.gts.relations[k];
            return (
              <tr key={k}>
                <td>edge type · {k}</td>
                <td>{edge ? <code>{edge.type}</code> : "—"}</td>
                <td>{edge ? <code className="hint">{edge.stored_as}</code> : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}

function LinkList({
  title,
  links,
  model,
  onPick,
}: {
  title: string;
  links: Link[];
  model: ReturnType<typeof useDomainModel>;
  onPick: (id: string) => void;
}) {
  return (
    <div>
      <div className="hint" style={{ fontWeight: 600 }}>
        {title} ({links.length})
      </div>
      {links.length === 0 ? (
        <p className="hint">—</p>
      ) : (
        <ul className="dm-links">
          {links.map((l) => (
            <li key={`${l.name}-${l.other}`}>
              <code>{l.name}</code> <span className="hint">{l.label !== l.name ? l.label : ""}</span>{" "}
              <button className="dm-link-button" onClick={() => onPick(l.other)}>
                {model.byId.get(l.other)?.name ?? l.other}
              </button>
              {l.kind && (
                <span className="hint" title={model.gts.relations[l.kind]?.type}>
                  {" "}
                  · {l.kind}
                </span>
              )}
              {l.inherited && <span className="hint"> · inherited</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
