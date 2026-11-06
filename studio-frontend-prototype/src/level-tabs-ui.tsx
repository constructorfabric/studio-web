// What a band draws of the tabs an administrator turned off (level-tabs.ts):
// the names a level hides, read from and written to its own settings
// document, and the "Tabs" dialog that turns them on and off.

import { useCallback, useEffect, useState } from "react";

import { api } from "./api";
import { errText } from "./problem";
import { hiddenToSave, parseHiddenTabs } from "./level-tabs";
import { Modal } from "./modal";

export type TabLevel = "organization" | "workspace" | "project";

/** Read a level's document; null when it has none yet. */
function readSettings(token: string, level: TabLevel, tenantId: string): Promise<object | null> {
  return level === "project" ? api.projectConfig(token, tenantId) : api.workspaceSettings(token, tenantId);
}

/** The names `tenantId` hides from its band, and how to change them. Written
 *  as every other writer of the document does: read, changed, written back
 *  whole, so its other fields (icon, sources, ...) stay. */
export function useHiddenTabs(token: string, level: TabLevel, tenantId: string | null) {
  const [hidden, setHidden] = useState<string[]>([]);

  useEffect(() => {
    setHidden([]);
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
  return { hidden, save };
}

/** "Tabs": turn a level's tabs on and off for everyone in it. */
export function TabsSettings({
  levelName,
  tabs,
  hidden,
  onSave,
  note,
}: {
  levelName: TabLevel;
  /** Every tab the level could show, in its order. */
  tabs: readonly { id: string; label: string }[];
  hidden: readonly string[];
  onSave: (hidden: string[]) => Promise<void>;
  /** What else decides the level's tabs, said in the dialog. */
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = hiddenToSave(tabs, off);
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
            A tab turned off is hidden for everyone in this {levelName}; nothing it shows is removed.
            {note ? ` ${note}` : ""}
          </p>
          <div style={{ display: "grid", gap: 4, margin: "8px 0 12px" }}>
            {tabs.map((t) => (
              <label key={t.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={!off.has(t.id)}
                  onChange={(e) => {
                    const changed = new Set(off);
                    if (e.target.checked) changed.delete(t.id);
                    else changed.add(t.id);
                    setOff(changed);
                  }}
                />
                {t.label} <code className="hint">{t.id}</code>
              </label>
            ))}
          </div>
          {error && <p className="error">{error}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setOpen(false)}>Cancel</button>
            <button
              className="primary"
              disabled={busy || next === null}
              title={next === null ? "Keep at least one tab" : undefined}
              onClick={async () => {
                if (next === null) return;
                setBusy(true);
                setError(null);
                try {
                  await onSave(next);
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
