// What a band draws of the tabs an administrator turned off (level-tabs.ts):
// the names a level hides, read from and written to its own settings
// document, and the one control at the end of every band -- a "⋯" that opens
// a small menu: pin this page, customize the tabs. Customizing lists each tab
// with the icon the band draws for it and a switch; a switch flipped shows
// in the band at once, before anything is saved.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { api } from "./api";
import { MoreIcon, PinIcon, SlidersIcon } from "./icons";
import { errText } from "./problem";
import { hiddenToSave, parseHiddenTabs } from "./level-tabs";
import { MenuButton } from "./menu-button";

export type TabLevel = "organization" | "workspace" | "project";

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
