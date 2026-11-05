/* The one line a part of the product's way out opens on (pipeline.ts): where
 * the project stands, and a button to the tab that does what comes next --
 * none when that is the tab the line is on (`here`). */

import type { PipelineHint, PipelineTab } from "./pipeline";

const TAB_LABELS: Record<PipelineTab, string> = {
  components: "Product →",
  releases: "Releases →",
};

export function PipelineLine({
  hint,
  onOpenTab,
  here,
}: {
  hint: PipelineHint;
  onOpenTab?: (tab: PipelineTab) => void;
  /** The tab the line is drawn on: a button to it would go nowhere. */
  here?: PipelineTab;
}) {
  return (
    <div
      className={`next-step ${hint.tone}`}
      role="status"
      data-next-step={hint.tone}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "8px 12px",
        margin: "0 0 12px",
        background:
          hint.tone === "done" ? "var(--success-soft)" : hint.tone === "failed" ? "var(--destructive-soft)" : "var(--accent)",
      }}
    >
      <b style={{ fontSize: 13 }}>Next:</b>
      <span style={{ fontSize: 13 }}>{hint.text}</span>
      {hint.go && hint.go !== here && onOpenTab && (
        <button type="button" className="primary" style={{ marginLeft: "auto" }} onClick={() => onOpenTab(hint.go as PipelineTab)}>
          {TAB_LABELS[hint.go]}
        </button>
      )}
    </div>
  );
}
