// A tenant's attributes as the domain model defines them (ADR-0051).
//
// A project, a workspace, an organization is a tenant in account-management:
// its id, name and place in the tree are the core and stay there. Everything
// else an organization wants to say about one — a cost centre, a phase, a
// customer — is a field of a model type, added in Administration › Domain
// model. This card shows the fields the live model has for the type, reads
// the one object that describes the tenant, and saves through the one write.
//
// That object is the type's object keyed `self` in the tenant's own scope,
// carrying the tenant's id in `tenant_id` (a field every model type inherits),
// which is what the query finds it by.

import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "./api";
import type { DomainEntity } from "./domain-model.gen";
import type { DomainOperation, DomainQuery } from "./domain-query";
import { fieldsOfModel, heldByOf, openFieldsOf, reloadDomainModel, useDomainModel, type ModelField } from "./domain-runtime";
import { errText } from "./format";
import { useDomainRefresh } from "./domain-live";

/** The model's primitives: fields every object has for the store, not for people. */
export const SYSTEM_BUCKET = "system-primitives";

/** A stored value as text, for reading. */
export function shown(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.map(shown).join(", ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** What the input holds, back as the value the field's kind stores. */
export function parsed(field: ModelField, raw: string | boolean): unknown {
  if (typeof raw === "boolean") return raw;
  const v = raw.trim();
  if (v === "") return null;
  switch (field.kind.kind) {
    case "number":
      return Number.isNaN(Number(v)) ? v : Number(v);
    case "list":
      return v.split(",").map((s) => s.trim()).filter(Boolean);
    case "unknown":
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    default:
      return v;
  }
}

export function asInput(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function ObjectAttributes({
  token,
  entity,
  tenantId,
  title,
  name,
}: {
  token: string;
  /** The model type that describes this kind of tenant (`project`, `workspace`). */
  entity: string;
  tenantId: string;
  title?: string;
  /** The tenant's own name, written to the object so lists can show it. */
  name?: string;
}) {
  const model = useDomainModel(token);
  const [value, setValue] = useState<Record<string, unknown> | null>(null);
  const [objectId, setObjectId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);

  const known = model.byId.has(entity);
  const fields = useMemo(() => {
    if (!known) return [];
    const system = new Set(model.entities.filter((e) => e.bucket === SYSTEM_BUCKET).map((e) => e.id));
    return fieldsOfModel(model, entity).filter((f) => !system.has(f.declaredBy) && f.name !== "id" && f.name !== "hidden_tabs");
  }, [model, entity, known]);
  /** What the tenant already says about itself (account-management): shown,
   *  and written with the first save, so nobody types the name twice. */
  const facts = useMemo<Record<string, unknown>>(
    () => (name ? { name, title: name } : {}),
    [name],
  );
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    if (!known) return;
    setError(null);
    try {
      const q = {
        type: entity,
        project_id: tenantId,
        where: { tenant_id: { _eq: tenantId } },
        limit: 1,
      } as unknown as DomainQuery<DomainEntity>;
      const res = await api.queryDomain(token, q);
      const row = res.items[0];
      setObjectId(row?.id ?? null);
      setValue((row?.value as Record<string, unknown> | undefined) ?? {});
    } catch (e) {
      setError(errText(e));
      setValue({});
    }
  }, [token, entity, tenantId, known]);
  useDomainRefresh([entity], load);

  useEffect(() => {
    void load();
  }, [load]);

  /** The stored value, else what the tenant says. */
  const valueOf = (f: ModelField): unknown => value?.[f.name] ?? (f.name in facts ? facts[f.name] : undefined);
  const filledField = (f: ModelField) => {
    const v = valueOf(f);
    return v !== undefined && v !== null && v !== "";
  };
  /** The type's own fields, and any field that holds something, come first;
   *  what a base type declares for the model's machinery (scope, provenance,
   *  version …) waits behind a toggle until somebody fills it. */
  const primary = fields.filter((f) => f.declaredBy === entity || filledField(f) || f.name in facts);
  const shownFields = showAll ? fields : primary;

  const startEdit = () => {
    setDraft(Object.fromEntries(fields.map((f) => [f.name, f.kind.kind === "boolean" ? valueOf(f) === true : asInput(valueOf(f))])));
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const set: Record<string, unknown> = {};
      const unset: string[] = [];
      for (const f of fields) {
        const next = parsed(f, draft[f.name] ?? "");
        const before = value?.[f.name] ?? null;
        // A fact taken from the tenant is written too, the first time.
        if (JSON.stringify(next) === JSON.stringify(before) && !(f.name in facts && before === null)) continue;
        if (next === null) unset.push(f.name);
        else set[f.name] = next;
      }
      const op = objectId
        ? { op: "patch", id: objectId, set, unset }
        : {
            op: "upsert",
            type: entity,
            key: "self",
            project_id: tenantId,
            value: { ...set, tenant_id: tenantId, ...(name ? { name } : {}) },
          };
      await api.mutateDomain(token, { operations: [op as DomainOperation] });
      setEditing(false);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (model.source !== "server") return null;

  if (!known) {
    return (
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <strong>{title ?? "Attributes"}</strong>
        <p className="hint" style={{ margin: 0 }}>
          The domain model has no <code>{entity}</code> type yet, so there is nothing to record here.
          {model.canEdit ? " Create it, then give it fields in Administration › Domain model." : ""}
        </p>
        {model.canEdit && (
          <button
            className="primary"
            style={{ alignSelf: "flex-start" }}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.createDomainType(token, { id: entity, name: entity[0].toUpperCase() + entity.slice(1), extends: "managed-object" });
                await reloadDomainModel(token);
              } catch (e) {
                setError(errText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Create the {entity} type
          </button>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  const filled = fields.filter(filledField);
  const empty = (showAll ? fields : primary).filter((f) => !filled.includes(f));
  const hidden = fields.length - primary.length;

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ flex: 1 }}>{title ?? "Attributes"}</strong>
        <span className="hint">
          {fields.length} fields from the <code>{entity}</code> type
        </span>
        {!editing && (
          <button onClick={startEdit} disabled={value === null}>
            Edit
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {value === null ? (
        <p className="empty">Loading…</p>
      ) : editing ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(140px, 220px) 1fr", gap: "6px 12px", alignItems: "center" }}>
          {shownFields.map((f) => (
            <FieldInput
              key={f.name}
              field={f}
              value={draft[f.name] ?? ""}
              onChange={(v) => setDraft((d) => ({ ...d, [f.name]: v }))}
            />
          ))}
          <div />
          <div style={{ display: "flex", gap: 8 }}>
            {fields.length > primary.length && (
              <button onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Only this type's fields" : `All ${fields.length} fields`}
              </button>
            )}
            <button className="primary" onClick={() => void save()} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {filled.length === 0 ? (
            <p className="empty" style={{ margin: 0 }}>
              Nothing recorded yet.
            </p>
          ) : (
            <dl style={{ display: "grid", gridTemplateColumns: "minmax(140px, 220px) 1fr", gap: "4px 12px", margin: 0 }}>
              {filled.map((f) => (
                <FieldRow
                  key={f.name}
                  field={f}
                  value={valueOf(f)}
                  from={value?.[f.name] === undefined && f.name in facts ? "from the tenant" : undefined}
                />
              ))}
            </dl>
          )}
          {(empty.length > 0 || hidden > 0) && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {empty.length > 0 && (
                <button onClick={() => setShowEmpty((v) => !v)}>
                  {showEmpty ? "Hide" : "Show"} {empty.length} empty fields
                </button>
              )}
              {hidden > 0 && (
                <button
                  onClick={() => {
                    setShowAll((v) => !v);
                    setShowEmpty(true);
                  }}
                  title="Fields the base types declare for the model itself: scope, provenance, version, validity…"
                >
                  {showAll ? "Hide" : "Show"} {hidden} fields of the base types
                </button>
              )}
              <div style={{ flexBasis: "100%" }} />
              {showEmpty && (
                <dl style={{ display: "grid", gridTemplateColumns: "minmax(140px, 220px) 1fr", gap: "4px 12px", margin: "6px 0 0" }}>
                  {empty.map((f) => (
                    <FieldRow key={f.name} field={f} value={undefined} />
                  ))}
                </dl>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FieldRow({ field, value, from }: { field: ModelField; value: unknown; from?: string }) {
  return (
    <>
      <dt className="hint" title={field.description || field.type}>
        {field.name.replace(/_/g, " ")}
        {field.required && " *"}
      </dt>
      <dd style={{ margin: 0 }}>
        {shown(value)}
        {from && <span className="hint"> · {from}</span>}
      </dd>
    </>
  );
}

export function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ModelField;
  value: string | boolean;
  onChange: (v: string | boolean) => void;
}) {
  const label = (
    <label className="hint" htmlFor={`attr-${field.name}`} title={field.description || field.type}>
      {field.name.replace(/_/g, " ")}
      {field.required && " *"}
    </label>
  );
  const k = field.kind;
  let input;
  if (k.kind === "boolean") {
    input = <input id={`attr-${field.name}`} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  } else if (k.kind === "enum") {
    input = (
      <select id={`attr-${field.name}`} value={String(value)} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {k.values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  } else {
    input = (
      <input
        id={`attr-${field.name}`}
        type={k.kind === "number" ? "number" : "text"}
        value={String(value)}
        placeholder={k.kind === "list" ? "a, b, c" : field.type}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <>
      {label}
      {input}
    </>
  );
}

/**
 * The fields an organization added to a gear's record type, on the gear's own
 * screen (ADR-0051 §8a). The gear writes its fields; these are the ones beside
 * them, filled in here and kept across the gear's own writes. Nothing renders
 * until somebody adds such a field — except a pointer for whoever may.
 */
export function ModelFields({
  token,
  entity,
  where,
  title,
}: {
  token: string;
  /** The model type the gear keeps the record as (`deployment-environment`). */
  entity: string;
  /** Which object: a domain-query filter that names exactly one. */
  where: Record<string, unknown>;
  title?: string;
}) {
  const model = useDomainModel(token);
  const [value, setValue] = useState<Record<string, unknown> | null>(null);
  const [objectId, setObjectId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fields = useMemo(() => (model.byId.has(entity) ? openFieldsOf(model, entity) : []), [model, entity]);
  const key = JSON.stringify(where);

  const load = useCallback(async () => {
    if (fields.length === 0) return;
    setError(null);
    try {
      const q = { type: entity, where: JSON.parse(key), limit: 1 } as unknown as DomainQuery<DomainEntity>;
      const res = await api.queryDomain(token, q);
      setObjectId(res.items[0]?.id ?? null);
      setValue((res.items[0]?.value as Record<string, unknown> | undefined) ?? {});
    } catch (e) {
      setError(errText(e));
    }
  }, [token, entity, key, fields.length]);
  useDomainRefresh([entity], load);
  useEffect(() => {
    void load();
  }, [load]);

  if (model.source !== "server" || !model.byId.has(entity)) return null;
  if (fields.length === 0) {
    if (!model.canEdit) return null;
    return (
      <p className="hint" style={{ margin: 0 }}>
        Need more on a {model.byId.get(entity)?.name ?? entity}? Add fields to <code>{entity}</code> in Administration › Domain
        model; they show here{heldByOf(model, entity) ? ` and ${heldByOf(model, entity)} keeps them` : ""}.
      </p>
    );
  }

  const save = async () => {
    if (!objectId) return;
    setBusy(true);
    setError(null);
    try {
      const set: Record<string, unknown> = {};
      const unset: string[] = [];
      for (const f of fields) {
        const next = parsed(f, draft[f.name] ?? "");
        if (JSON.stringify(next) === JSON.stringify(value?.[f.name] ?? null)) continue;
        if (next === null) unset.push(f.name);
        else set[f.name] = next;
      }
      await api.mutateDomain(token, { operations: [{ op: "patch", id: objectId, set, unset } as DomainOperation] });
      setEditing(false);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ flex: 1 }}>{title ?? "More"}</strong>
        {!editing && objectId && (
          <button
            onClick={() => {
              setDraft(Object.fromEntries(fields.map((f) => [f.name, f.kind.kind === "boolean" ? value?.[f.name] === true : asInput(value?.[f.name])])));
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {editing ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(140px, 220px) 1fr", gap: "6px 12px", alignItems: "center" }}>
          {fields.map((f) => (
            <FieldInput key={f.name} field={f} value={draft[f.name] ?? ""} onChange={(v) => setDraft((d) => ({ ...d, [f.name]: v }))} />
          ))}
          <div />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="primary" onClick={() => void save()} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <dl style={{ display: "grid", gridTemplateColumns: "minmax(140px, 220px) 1fr", gap: "4px 12px", margin: 0 }}>
          {fields.map((f) => (
            <FieldRow key={f.name} field={f} value={value?.[f.name]} />
          ))}
        </dl>
      )}
    </div>
  );
}
