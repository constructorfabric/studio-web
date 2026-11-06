// What a band draws of a level's tabs (level-tabs.ts): every tab the domain
// model gives the level, the names it hides, read from and written to its own
// settings document, and the one control at the end of every band -- a "⋯"
// that opens a small menu: pin this page, customize the tabs. Customizing
// lists each tab with the icon the band draws for it and a switch; a switch
// flipped shows in the band at once, before anything is saved. A tab the model
// adds that no screen answers lists the objects of its type.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { api } from "./api";
import type { DomainEntity } from "./domain-model.gen";
import type { DomainQuery } from "./domain-query";
import { useDomainRefresh } from "./domain-live";
import { fieldsOfModel, useDomainModel } from "./domain-runtime";
import { MoreIcon, PinIcon, SlidersIcon } from "./icons";
import { errText } from "./problem";
import { hiddenToSave, levelTabs, modelTabs, parseHiddenTabs, type GenericTab } from "./level-tabs";
import { MenuButton } from "./menu-button";

export type TabLevel = "organization" | "workspace" | "project";

/** Every tab `level` has, hidden or not: the model's `shows` relations on
 *  the built-in screens, plus a generic tab for each the portal has no
 *  screen for. */
export function useModelTabs<B extends { id: string; icon: string; label: string }>(
  token: string,
  level: TabLevel,
  builtIn: readonly B[],
): (B | GenericTab)[] {
  const model = useDomainModel(token);
  return useMemo(() => levelTabs(builtIn, modelTabs(model, level)), [builtIn, model, level]);
}

/** Read a level's document; null when it has none yet. */
function readSettings(token: string, level: TabLevel, tenantId: string): Promise<object | null> {
  return level === "project" ? api.projectConfig(token, tenantId) : api.workspaceSettings(token, tenantId);
}

/** The names `tenantId` hides from its band, and how to change them. Written
 *  as every other writer of the document does: read, changed, written back
 *  whole, so its other fields (icon, sources, ...) stay.
 *
 *  `shown` is what the band draws: while somebody is customizing it, the
 *  names they have switched off so far (`setPreview`), not saved; else what
 *  is saved. */
export function useHiddenTabs(token: string, level: TabLevel, tenantId: string | null) {
  const [hidden, setHidden] = useState<string[]>([]);
  const [preview, setPreview] = useState<string[] | null>(null);

  useEffect(() => {
    setHidden([]);
    setPreview(null);
    if (!tenantId) return;
    let alive = true;
    readSettings(token, level, tenantId)
      .then((doc) => {
        if (alive) setHidden(parseHiddenTabs(doc));
      })
      // Not readable here: every tab shows -- hiding is never the fallback.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [token, level, tenantId]);

  const save = useCallback(
    async (next: string[]) => {
      if (!tenantId) return;
      if (level === "project") {
        const current = (await api.projectConfig(token, tenantId)) ?? {};
        await api.putProjectConfig(token, tenantId, { ...current, hidden_tabs: next });
      } else {
        const current = (await api.workspaceSettings(token, tenantId)) ?? {};
        await api.putWorkspaceSettings(token, tenantId, { ...current, hidden_tabs: next });
      }
      setHidden(next);
    },
    [token, level, tenantId],
  );
  return { hidden, shown: preview ?? hidden, save, setPreview };
}

/** A tab as the editor lists it: the band's own id, label and icon name. */
export interface BandMenuTab {
  id: string;
  label: string;
  icon?: string;
}

/** The control at the end of a band: one "⋯" with Pin and Customize tabs. */
export function BandMenu({
  levelName,
  tabs,
  hidden,
  onSave,
  onPreview,
  icon,
  pin,
  note,
}: {
  levelName: TabLevel;
  /** Every tab the level could show, in its order; empty: nothing to customize. */
  tabs: readonly BandMenuTab[];
  hidden: readonly string[];
  /** Absent: the tabs are not this person's to customize here. */
  onSave?: (hidden: string[]) => Promise<void>;
  /** Told the names switched off while customizing, and null when done. */
  onPreview?: (hidden: string[] | null) => void;
  /** Draws a tab's icon as the band does. */
  icon: (name: string) => ReactNode;
  /** This page on the rail; absent where it cannot be pinned. */
  pin?: { pinned: boolean; toggle: () => void };
  /** What else decides the level's tabs, said in the editor. */
  note?: string;
}) {
  const [off, setOff] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement | null>(null);
  const editing = off !== null;
  const customizable = !!onSave && tabs.length > 0;

  const close = useCallback(() => {
    setOff(null);
    setError(null);
    onPreview?.(null);
  }, [onPreview]);

  // Escape, or a pointer down outside the editor, is Cancel.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: PointerEvent) => {
      if (panel.current && e.target instanceof Node && !panel.current.contains(e.target)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    panel.current?.querySelector<HTMLInputElement>("input:not([disabled])")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [editing, close]);

  if (!pin && !customizable) return null;

  const change = (next: Set<string>) => {
    setOff(next);
    onPreview?.([...next]);
  };
  const next = off ? hiddenToSave(tabs, off) : null;
  const showing = off ? tabs.filter((t) => !off.has(t.id)).length : tabs.length;

  return (
    <div className="band-end">
      <MenuButton
        label={`More for this ${levelName}`}
        buttonClassName="band-more"
        trigger={<MoreIcon />}
        items={[
          pin && {
            label: pin.pinned ? "Unpin" : "Pin this page",
            icon: <PinIcon />,
            title: pin.pinned ? "Take this page off the rail" : "Keep this page on the rail",
            onSelect: pin.toggle,
          },
          customizable && {
            label: "Customize tabs…",
            icon: <SlidersIcon />,
            title: `Choose which tabs the ${levelName} shows, for everyone in it`,
            onSelect: () => {
              setError(null);
              setOff(new Set(hidden));
            },
          },
        ]}
      />
      {off && (
        <div className="band-editor" ref={panel} role="dialog" aria-label={`Tabs of the ${levelName}`}>
          <div className="band-editor-head">
            <strong>Tabs of the {levelName}</strong>
            <span className="sub">
              Hidden for everyone in this {levelName}; nothing a tab shows is removed.{note ? ` ${note}` : ""}
            </span>
          </div>
          <ul className="band-editor-list">
            {tabs.map((t) => {
              const on = !off.has(t.id);
              // The last tab showing stays: a band is never empty.
              const last = on && showing <= 1;
              return (
                <li key={t.id}>
                  <label className="band-editor-row" title={last ? "Keep at least one tab" : undefined}>
                    <span className="band-editor-ico" aria-hidden>
                      {t.icon ? icon(t.icon) : null}
                    </span>
                    <span className="band-editor-label">{t.label}</span>
                    <span className="ui-toggle">
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={`Show ${t.label}`}
                        checked={on}
                        disabled={last}
                        onChange={(e) => {
                          const changed = new Set(off);
                          if (e.target.checked) changed.delete(t.id);
                          else changed.add(t.id);
                          change(changed);
                        }}
                      />
                      <span className="ui-switch" aria-hidden />
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {error && <p className="error">{error}</p>}
          <div className="band-editor-foot">
            <button type="button" className="ghost" disabled={off.size === 0} title="Show every tab" onClick={() => change(new Set())}>
              Reset
            </button>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || next === null}
              title={next === null ? "Keep at least one tab" : undefined}
              onClick={async () => {
                if (next === null || !onSave) return;
                setBusy(true);
                setError(null);
                try {
                  await onSave(next);
                  close();
                } catch (e) {
                  setError(errText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
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
