// Project › Timeline: the project's milestones on a time axis.
//
// Built on the domain model alone (ADR-0051): milestones are `milestone`
// objects in the project's scope, read with one `POST /query` (counted by
// status in the same request) and written with `POST /mutate`. No gear owns
// this screen, so a field an administrator adds to `milestone` in
// Administration › Domain model is a field here at once.

import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "./api";
import type { DomainEntity } from "./domain-model.gen";
import type { DomainOperation, DomainQuery } from "./domain-query";
import { fieldsOfModel, useDomainModel, type ModelField } from "./domain-runtime";
import { errText } from "./format";
import { Modal } from "./modal";
import { FieldInput, SYSTEM_BUCKET, asInput, parsed, shown } from "./object-attributes";
import { useDomainRefresh } from "./domain-live";

const ENTITY = "milestone";

interface Milestone {
  id: string;
  value: Record<string, unknown>;
}

/** The day a timestamp falls on, `YYYY-MM-DD`, or "" when there is none. */
function day(v: unknown): string {
  return typeof v === "string" ? v.slice(0, 10) : "";
}

const OPEN = new Set(["planned", "at_risk"]);

function statusClass(status: unknown, late: boolean): string {
  if (late) return "badge archived";
  switch (status) {
    case "achieved":
      return "badge ok";
    case "at_risk":
      return "badge selfmanaged";
    case "missed":
    case "cancelled":
      return "badge archived";
    default:
      return "badge";
  }
}

export function ProjectTimeline({ token, projectId }: { token: string; projectId: string }) {
  const model = useDomainModel(token);
  const [items, setItems] = useState<Milestone[] | null>(null);
  const [counts, setCounts] = useState<{ key: unknown[]; count: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Milestone | "new" | null>(null);

  const fields = useMemo(() => {
    if (!model.byId.has(ENTITY)) return [];
    const system = new Set(model.entities.filter((e) => e.bucket === SYSTEM_BUCKET).map((e) => e.id));
    return fieldsOfModel(model, ENTITY).filter((f) => !system.has(f.declaredBy) && f.name !== "id");
  }, [model]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const q = {
        type: ENTITY,
        project_id: projectId,
        order_by: [{ field: "target_at" }, { field: "name" }],
        limit: 200,
        aggregate: { group_by: ["status"] },
      } as unknown as DomainQuery<DomainEntity>;
      const res = await api.queryDomain(token, q);
      setItems(res.items.map((r) => ({ id: r.id, value: r.value as Record<string, unknown> })));
      setCounts(res.groups ?? []);
    } catch (e) {
      setError(errText(e));
      setItems([]);
    }
  }, [token, projectId]);
  useDomainRefresh([ENTITY], load);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (m: Milestone) => {
    setError(null);
    try {
      await api.mutateDomain(token, { operations: [{ op: "delete", id: m.id }] });
      await load();
    } catch (e) {
      setError(errText(e));
    }
  };

  const today = new Date().toISOString().slice(0, 10);
  const todayAt = items ? items.findIndex((m) => day(m.value.target_at) >= today) : -1;

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Timeline</h2>
        <span className="hint" style={{ flex: 1 }}>
          The project's milestones. They are <code>milestone</code> objects of the domain model, so their fields are
          whatever the model gives them.
        </span>
        {counts.map((g) => (
          <span key={String(g.key[0])} className="badge neutral">
            {g.key[0] === null ? "no status" : String(g.key[0]).replace(/_/g, " ")} · {g.count}
          </span>
        ))}
        <button className="primary" onClick={() => setEditing("new")} disabled={!model.byId.has(ENTITY)}>
          Add milestone
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {model.source === "server" && !model.byId.has(ENTITY) && (
        <p className="hint">The domain model has no <code>milestone</code> type, so there is nothing to show.</p>
      )}
      {items === null ? (
        <p className="empty">Loading milestones…</p>
      ) : items.length === 0 ? (
        <p className="empty">No milestones yet. Add the first one: a name and a date are enough.</p>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
          {items.map((m, i) => {
            const date = day(m.value.target_at);
            const late = !!date && date < today && OPEN.has(String(m.value.status ?? "planned"));
            return (
              <li key={m.id} style={{ display: "contents" }}>
                {i === todayAt && <TodayMark />}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "110px 18px 1fr auto",
                    gap: 10,
                    alignItems: "center",
                    padding: "8px 0",
                    borderTop: i === 0 ? undefined : "1px solid var(--border)",
                  }}
                >
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{date || "no date"}</span>
                  <span
                    aria-hidden
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: m.value.status === "achieved" ? "var(--success)" : late ? "var(--destructive, #c33)" : "var(--primary)",
                    }}
                  />
                  <span style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <strong>{shown(m.value.name ?? m.value.title)}</strong>
                    <span className={statusClass(m.value.status, late)}>
                      {late ? "late" : String(m.value.status ?? "planned").replace(/_/g, " ")}
                    </span>
                    {fields
                      .filter((f) => !["name", "title", "target_at", "status"].includes(f.name))
                      .filter((f) => m.value[f.name] !== undefined && m.value[f.name] !== null && m.value[f.name] !== "")
                      .map((f) => (
                        <span key={f.name} className="hint">
                          {f.name.replace(/_/g, " ")}: {shown(m.value[f.name])}
                        </span>
                      ))}
                  </span>
                  <span style={{ whiteSpace: "nowrap" }}>
                    <button onClick={() => setEditing(m)}>Edit</button> <button onClick={() => void remove(m)}>Delete</button>
                  </span>
                </div>
              </li>
            );
          })}
          {todayAt === -1 && <TodayMark />}
        </ol>
      )}
      {editing && (
        <MilestoneDialog
          token={token}
          projectId={projectId}
          fields={fields}
          milestone={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

function TodayMark() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--primary)", fontSize: 12 }}>
      <span style={{ flex: 1, borderTop: "1px dashed var(--primary)" }} />
      today
      <span style={{ flex: 1, borderTop: "1px dashed var(--primary)" }} />
    </div>
  );
}

function MilestoneDialog({
  token,
  projectId,
  fields,
  milestone,
  onClose,
  onSaved,
}: {
  token: string;
  projectId: string;
  fields: ModelField[];
  milestone: Milestone | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // The fields people fill first, then whatever else the model has.
  const first = ["name", "target_at", "status"];
  const ordered = [...first.map((n) => fields.find((f) => f.name === n)).filter((f): f is ModelField => !!f), ...fields.filter((f) => !first.includes(f.name) && f.name !== "title")];
  const [draft, setDraft] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      ordered.map((f) => {
        const v = milestone?.value[f.name];
        if (f.kind.kind === "boolean") return [f.name, v === true];
        return [f.name, f.name === "target_at" ? day(v) : asInput(v)];
      }),
    ),
  );
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = String(draft.name ?? "").trim();
  const date = String(draft.target_at ?? "");

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const values: Record<string, unknown> = {};
      for (const f of ordered) {
        const v = f.name === "target_at" ? (date ? `${date}T00:00:00Z` : null) : parsed(f, draft[f.name] ?? "");
        if (v !== null) values[f.name] = v;
      }
      // A milestone's title is its name: `managed-object` asks for one.
      values.title = name;
      let op: DomainOperation;
      if (milestone) {
        const unset = ordered.map((f) => f.name).filter((n) => !(n in values) && milestone.value[n] !== undefined);
        op = { op: "patch", id: milestone.id, set: values, unset };
      } else {
        op = {
          op: "upsert",
          type: ENTITY,
          key: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`,
          project_id: projectId,
          value: { ...values, status: values.status ?? "planned", tenant_id: projectId },
        } as DomainOperation;
      }
      await api.mutateDomain(token, { operations: [op] });
      onSaved();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const shownFields = more ? ordered : ordered.filter((f) => first.includes(f.name));
  return (
    <Modal label={milestone ? "Edit milestone" : "Add milestone"} onClose={busy ? () => undefined : onClose} cardStyle={{ width: "min(560px, 100%)" }}>
      <strong>{milestone ? "Edit milestone" : "Add milestone"}</strong>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 180px) 1fr", gap: "6px 12px", alignItems: "center" }}>
        {shownFields.map((f) =>
          f.name === "target_at" ? (
            <DateInput key={f.name} value={date} onChange={(v) => setDraft((d) => ({ ...d, target_at: v }))} />
          ) : (
            <FieldInput key={f.name} field={f} value={draft[f.name] ?? ""} onChange={(v) => setDraft((d) => ({ ...d, [f.name]: v }))} />
          ),
        )}
      </div>
      {ordered.length > first.length && (
        <button style={{ alignSelf: "flex-start" }} onClick={() => setMore((v) => !v)}>
          {more ? "Fewer fields" : `${ordered.length - shownFields.length} more fields from the model`}
        </button>
      )}
      {error && <p className="error">{error}</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="primary" onClick={() => void save()} disabled={busy || !name || !date}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

function DateInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <>
      <label className="hint" htmlFor="attr-target_at">
        date *
      </label>
      <input id="attr-target_at" type="date" value={value} onChange={(e) => onChange(e.target.value)} />
    </>
  );
}
