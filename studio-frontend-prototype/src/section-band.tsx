/** The tabs of a section band (project, workspace), in the order the person
 *  keeps them. The order logic is tab-order.ts; this is the drawing and the
 *  two ways to change it: drag a tab, or Alt+Shift+←/→ on a focused one.
 *
 *  The band's own list stays the default and the only list a build edits; the
 *  stored order is read against it on every render, so a section added later
 *  shows up without anybody resetting anything. */
import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";

import { StatusChip } from "./ui-standard";
import { applyOrder, isDefaultOrder, moveTo, parseOrder, serializeOrder } from "./tab-order";
import { usePreference } from "./view-mode";

export interface BandTab<Id extends string> {
  id: Id;
  icon: string;
  label: string;
  hint?: string;
  /** Works, but is not settled: marked so nobody builds on it unawares. */
  experimental?: boolean;
  /** Something there needs a look: how many, in the tab, its reason on hover. */
  attention?: { tone: "failed" | "todo"; count: number; text: string } | null;
}

const REORDER_HINT = "Drag to reorder (Alt+Shift+←/→)";

export function OrderedSections<Id extends string>({
  prefKey,
  tabs,
  active,
  onOpen,
  icon,
}: {
  /** Names the band, not the project: one order for every project. */
  prefKey: string;
  tabs: readonly BandTab<Id>[];
  active: Id;
  onOpen: (id: Id) => void;
  icon: (name: string) => ReactNode;
}) {
  const [stored, setStored] = usePreference(prefKey);
  const ordered = applyOrder(tabs, parseOrder(stored));
  const order = ordered.map((t) => t.id as string);
  const [dragging, setDragging] = useState<string | null>(null);
  /** Where a drop would land: an index into the order without the dragged tab. */
  const [dropAt, setDropAt] = useState<number | null>(null);

  const save = (next: string[]) => setStored(isDefaultOrder(next, tabs) ? "" : serializeOrder(next));

  const slotFor = (e: DragEvent<HTMLButtonElement>, index: number) => {
    const box = e.currentTarget.getBoundingClientRect();
    const after = e.clientX > box.left + box.width / 2;
    const raw = index + (after ? 1 : 0);
    // The dragged tab leaves its own slot, so everything behind it moves up one.
    const from = dragging ? order.indexOf(dragging) : -1;
    return from >= 0 && raw > from ? raw - 1 : raw;
  };

  const endDrag = () => {
    setDragging(null);
    setDropAt(null);
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, id: string, index: number) => {
    if (!e.altKey || !e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const to = e.key === "ArrowLeft" ? index - 1 : index + 1;
    if (to < 0 || to >= order.length) return;
    save(moveTo(order, id, to));
    // Keep the focus on the tab that moved; it is re-rendered in its new slot.
    const band = e.currentTarget.parentElement;
    requestAnimationFrame(() => band?.querySelector<HTMLButtonElement>(`[data-tab="${id}"]`)?.focus());
  };

  return (
    <>
      {ordered.map((t, index) => {
        const from = dragging ? order.indexOf(dragging) : -1;
        // The slot index the indicator sits in front of, in the full order.
        // Nothing is drawn where the drop would change nothing.
        const marker =
          dropAt === null || dropAt === from ? null : from >= 0 && dropAt >= from ? dropAt + 1 : dropAt;
        const cls = [
          "psection",
          active === t.id ? "on" : "",
          dragging === t.id ? "dragging" : "",
          dragging && marker === index && dragging !== t.id ? "drop-before" : "",
          dragging && marker === order.length && index === order.length - 1 ? "drop-after" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            key={t.id}
            data-tab={t.id}
            className={cls}
            aria-current={active === t.id ? "page" : undefined}
            title={t.hint ? `${t.hint}\n${REORDER_HINT}` : REORDER_HINT}
            draggable
            onClick={() => onOpen(t.id)}
            onKeyDown={(e) => onKey(e, t.id, index)}
            onDragStart={(e) => {
              setDragging(t.id);
              e.dataTransfer.effectAllowed = "move";
              // Firefox starts no drag without data.
              e.dataTransfer.setData("text/plain", t.label);
            }}
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const at = slotFor(e, index);
              if (at !== dropAt) setDropAt(at);
            }}
            onDrop={(e) => {
              if (!dragging) return;
              e.preventDefault();
              const at = slotFor(e, index);
              if (at !== order.indexOf(dragging)) save(moveTo(order, dragging, at));
              endDrag();
            }}
            onDragEnd={endDrag}
          >
            <span className="ico" aria-hidden>
              {icon(t.icon)}
            </span>
            {t.label}
            {t.attention && (
              <StatusChip
                tone={t.attention.tone === "failed" ? "danger" : "warn"}
                className={`tab-attention ${t.attention.tone}`}
                title={t.attention.text}
                aria-label={t.attention.text}
                role="status"
                data-tab-attention={t.attention.tone}
              >
                {t.attention.count}
              </StatusChip>
            )}
            {t.experimental && (
              <StatusChip tone="warn" className="badge-experimental" title="Experimental: it works, and it may change or go">
                exp
              </StatusChip>
            )}
          </button>
        );
      })}
      {stored && !isDefaultOrder(order, tabs) && (
        <button
          className="psection psection-reset"
          title="Put the sections back in their default order"
          onClick={() => save(tabs.map((t) => t.id))}
        >
          <span className="ico" aria-hidden>
            ↺
          </span>
          Default order
        </button>
      )}
    </>
  );
}
