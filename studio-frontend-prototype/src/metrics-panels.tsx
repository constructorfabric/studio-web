/* The metrics board's parts (wave 4D): a panel and its charts, a row of
 * panels and the time-range picker. Scope-free: the organization's Overview
 * draws them, and a project's Overview can draw the same ones.
 *
 *   - MetricPanel: title, "?" (what the number is and where it comes from),
 *     source, the headline with its trend against the previous period, a
 *     small chart, and a click-through to the screen behind it. A panel with
 *     no number says why in an EmptyState rather than showing a zero.
 *   - Spark: a small time series as columns or a line (inline SVG, one
 *     series, one hue), with a y-axis top and zero, first and last bucket
 *     labels, and a hover readout per bucket.
 *   - RankBars: up to five labelled horizontal bars.
 *   - RangePicker: 7d / 30d / 90d, for every panel at once.
 *
 * The model (what each panel says) is `metrics-model.ts`; styles are the
 * "wave 4D" section of styles.css. */

import { useId, useState } from "react";

import type { MetricsRange } from "./api";
import { dayLabel, type BoardRow, type Panel, type PanelTarget, type Point, type Trend } from "./metrics-model";
import { EmptyState, InfoPopover, StatusChip } from "./ui-standard";

export const RANGES: { id: MetricsRange; label: string }[] = [
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
];

/** 7d / 30d / 90d, as one segmented control. */
export function RangePicker({ value, onChange }: { value: MetricsRange; onChange: (r: MetricsRange) => void }) {
  return (
    <div className="mb-range" role="group" aria-label="Time range" data-range-picker>
      {RANGES.map((r) => (
        <button
          key={r.id}
          type="button"
          className={value === r.id ? "on" : ""}
          aria-pressed={value === r.id}
          onClick={() => onChange(r.id)}
          data-range={r.id}
        >
          {r.id}
          <span className="mb-sr">, {r.label}</span>
        </button>
      ))}
    </div>
  );
}

const TARGET_LABEL: Record<PanelTarget, string> = {
  projects: "Workspaces",
  people: "People",
  costs: "Costs",
  environments: "Infrastructure",
  reports: "Reports",
  tasks: "Background work",
};

function TrendChip({ trend, against }: { trend: Trend; against: string }) {
  const arrow = trend.dir === "up" ? "▲" : trend.dir === "down" ? "▼" : "■";
  return (
    <span className={`mb-trend ${trend.tone}`} title={`against ${against}`} data-trend-tone={trend.tone}>
      <span aria-hidden>{arrow}</span> {trend.text}
      <span className="mb-trend-vs"> vs {against}</span>
    </span>
  );
}

/** One panel. `against` names the previous period ("previous 30 d"). */
export function MetricPanel({ panel, against, onOpen }: { panel: Panel; against: string; onOpen?: (t: PanelTarget) => void }) {
  const ok = panel.state === "ok";
  return (
    <section className={`card mb-panel state-${panel.state}`} data-panel={panel.key} data-panel-state={panel.state}>
      <header className="mb-panel-head">
        <h4 className="mb-panel-title">{panel.title}</h4>
        <InfoPopover label={`About ${panel.title}`}>
          {panel.info}
          {panel.why && !ok && (
            <>
              <br />
              <br />
              <b>Now:</b> {panel.why}
            </>
          )}
        </InfoPopover>
        <span className="mb-source" data-source={panel.source}>
          {panel.source}
        </span>
      </header>
      {panel.state === "loading" ? (
        <div className="mb-loading" aria-busy="true">
          <StatusChip tone="running">reading…</StatusChip>
        </div>
      ) : !ok ? (
        <EmptyState
          title={panel.state === "hidden" ? "Not yours to see" : panel.state === "empty" ? "No data" : "Not available"}
          body={panel.why}
        />
      ) : (
        <>
          <div className="mb-headline">
            {onOpen ? (
              <button type="button" className="mb-value" onClick={() => onOpen(panel.target)} aria-label={`${panel.title}: ${panel.value}, open ${TARGET_LABEL[panel.target]}`}>
                {panel.value}
              </button>
            ) : (
              <span className="mb-value">{panel.value}</span>
            )}
            {panel.unit && <span className="mb-unit">{panel.unit}</span>}
          </div>
          <div className="mb-meta">
            {panel.trend ? <TrendChip trend={panel.trend} against={against} /> : <span className="mb-trend none">no trend: a count of now</span>}
          </div>
          {panel.sub && <div className="mb-sub">{panel.sub}</div>}
          {panel.chart &&
            (panel.chart.kind === "rank" ? (
              <RankBars rows={panel.chart.rows} format={panel.chart.format} label={panel.title} />
            ) : (
              <Spark kind={panel.chart.kind} points={panel.chart.points} format={panel.chart.format} label={panel.title} />
            ))}
        </>
      )}
      {onOpen && (
        <button type="button" className="linklike mb-open" onClick={() => onOpen(panel.target)}>
          {TARGET_LABEL[panel.target]} →
        </button>
      )}
    </section>
  );
}

/** A row of panels under its title, like a dashboard row. */
export function PanelRow({ row, against, onOpen }: { row: BoardRow; against: string; onOpen?: (t: PanelTarget) => void }) {
  return (
    <section className="mb-row" data-board-row={row.key} aria-label={row.title}>
      <h3 className="mb-row-title">{row.title}</h3>
      <div className="mb-grid">
        {row.panels.map((p) => (
          <MetricPanel key={p.key} panel={p} against={against} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

/* ── Charts ─────────────────────────────────────────────────────────────── */

const W = 260;
const H = 84;
const PAD = { top: 12, right: 6, bottom: 16, left: 6 };

/** A small time series: columns (counts) or a line (timings, shares). A null
 *  is a gap. Hover or focus reads one bucket out. */
export function Spark({
  kind,
  points,
  format,
  label,
}: {
  kind: "line" | "bars";
  points: Point[];
  format: (v: number) => string;
  label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (points.length === 0 || values.length === 0)
    return <div className="mb-chart-none">Nothing to measure in any bucket of the range.</div>;
  if (values.every((v) => v === 0)) return <div className="mb-chart-none">Zero in every bucket of the range.</div>;
  const max = Math.max(...values, 0);
  const top = max > 0 ? max : 1;
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const band = iw / points.length;
  const x = (i: number) => PAD.left + band * i + band / 2;
  const y = (v: number) => PAD.top + ih - (v / top) * ih;
  const base = PAD.top + ih;
  const barW = Math.min(24, Math.max(2, band - 2));

  // Line segments, broken at gaps.
  const segments: string[] = [];
  let cur = "";
  points.forEach((p, i) => {
    if (p.value === null) {
      if (cur) segments.push(cur);
      cur = "";
      return;
    }
    cur += `${cur ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`;
  });
  if (cur) segments.push(cur);
  const last = [...points.keys()].reverse().find((i) => points[i].value !== null);
  const h = hover !== null ? points[hover] : null;

  return (
    <figure className="mb-chart" aria-labelledby={`${id}-cap`}>
      <figcaption id={`${id}-cap`} className="mb-sr">
        {label}, per bucket: {points.map((p) => `${dayLabel(p.bucket)} ${p.value === null ? "none" : format(p.value)}`).join("; ")}
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mb-svg"
        role="img"
        aria-hidden
        onMouseLeave={() => setHover(null)}
      >
        <line className="mb-grid-line" x1={PAD.left} x2={W - PAD.right} y1={PAD.top} y2={PAD.top} />
        <line className="mb-axis" x1={PAD.left} x2={W - PAD.right} y1={base} y2={base} />
        {kind === "bars"
          ? points.map((p, i) => {
              if (p.value === null || p.value <= 0) return null;
              const bx = x(i) - barW / 2;
              const by = y(p.value);
              const bh = base - by;
              const r = Math.min(4, bh, barW / 2);
              return (
                <path
                  key={p.bucket}
                  className={`mb-mark${hover === i ? " hot" : ""}`}
                  d={`M${bx},${base}V${by + r}Q${bx},${by} ${bx + r},${by}H${bx + barW - r}Q${bx + barW},${by} ${bx + barW},${by + r}V${base}Z`}
                />
              );
            })
          : (
              <>
                {segments.map((d, k) => (
                  <path key={`a${k}`} className="mb-area" d={`${d}V${base}H${d.match(/^M([\d.]+)/)?.[1] ?? PAD.left}Z`} />
                ))}
                {segments.map((d, k) => (
                  <path key={`l${k}`} className="mb-line" d={d} />
                ))}
                {last !== undefined && points[last].value !== null && (
                  <circle className="mb-dot" cx={x(last)} cy={y(points[last].value as number)} r={4} />
                )}
              </>
            )}
        {hover !== null && <line className="mb-cross" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={base} />}
        {hover !== null && kind === "line" && h?.value !== null && h && (
          <circle className="mb-dot" cx={x(hover)} cy={y(h.value as number)} r={4} />
        )}
        {points.map((p, i) => (
          <rect
            key={`h${p.bucket}`}
            className="mb-hit"
            x={PAD.left + band * i}
            y={0}
            width={band}
            height={H}
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      <div className="mb-ylab" aria-hidden>
        {format(max)}
      </div>
      <div className="mb-xlab" aria-hidden>
        <span>{dayLabel(points[0].bucket)}</span>
        <span>{dayLabel(points[points.length - 1].bucket)}</span>
      </div>
      <div className={`mb-tip${h ? " on" : ""}`} aria-hidden>
        {h ? `${dayLabel(h.bucket)}: ${h.value === null ? "none" : format(h.value)}` : " "}
      </div>
    </figure>
  );
}

/** Up to five labelled bars, longest first as given. */
export function RankBars({ rows, format, label }: { rows: { label: string; value: number }[]; format: (v: number) => string; label: string }) {
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  return (
    <ul className="mb-rank" aria-label={label}>
      {rows.slice(0, 5).map((r, k) => (
        <li key={`${r.label}-${k}`} title={`${r.label}: ${format(r.value)}`}>
          <span className="mb-rank-label">{r.label}</span>
          <span className="mb-rank-track">
            <span className="mb-rank-bar" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
          </span>
          <span className="mb-rank-value">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}
