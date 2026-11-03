/* The shared parts every screen is built from (UI standard, wave 1).
 *
 *   - PageHeader: the screen's name, ONE line of status read from data, the
 *     explanation behind a "?", one primary action and a menu. There is no
 *     crumb in it: the top bar already says where you are.
 *   - InfoPopover: the "?" -- the explanation a screen used to print above
 *     every visit, or hide in a native title nobody finds, opened on demand.
 *   - StatusChip: a state as a pill, in one of six tones over `.badge`.
 *   - EmptyState: what a list says when there is nothing in it, and what would
 *     put something there.
 *   - KpiTile: one number with its label, over `.stat`; a "—" says why.
 *   - StepFlow: steps in the order they are done, as cards (a number or a
 *     tick, the title, where it stands; a done step folds) or as a strip of
 *     compact chips.
 *
 * Styles: the "UI standard" section of styles.css. */

import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from "react";

/* ── StatusChip ─────────────────────────────────────────────────────────── */

export type Tone = "ok" | "warn" | "danger" | "info" | "neutral" | "running";

/** A state as a pill. With `onClick` it is a button (it opens what it
 *  summarises); `expanded` then says whether that is open. */
export function StatusChip({
  tone = "neutral",
  children,
  onClick,
  expanded,
  className,
  ...rest
}: {
  tone?: Tone;
  children: ReactNode;
  onClick?: () => void;
  expanded?: boolean;
} & Omit<HTMLAttributes<HTMLElement>, "onClick" | "children">) {
  const cls = ["badge", tone, "ui-chip", onClick ? "ui-chip-btn" : "", className ?? ""].filter(Boolean).join(" ");
  if (onClick)
    return (
      <button type="button" className={cls} onClick={onClick} aria-expanded={expanded} data-status-chip={tone} {...rest}>
        {tone === "running" && <span className="ui-chip-pulse" aria-hidden />}
        {children}
      </button>
    );
  return (
    <span className={cls} data-status-chip={tone} {...rest}>
      {tone === "running" && <span className="ui-chip-pulse" aria-hidden />}
      {children}
    </span>
  );
}

/* ── InfoPopover ────────────────────────────────────────────────────────── */

/** A "?" that opens a small panel with the explanation, and a link to the
 *  docs or the ADR when there is one. Opens on click; Esc, a click outside or
 *  the button again close it. */
export function InfoPopover({
  children,
  label = "What is this?",
  doc,
  align = "start",
}: {
  children: ReactNode;
  /** The button's accessible name. */
  label?: string;
  doc?: { href: string; label: string };
  /** Which edge of the "?" the panel lines up with. */
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    const down = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", down);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("mousedown", down);
    };
  }, [open]);
  return (
    <span className="ui-info" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="ui-info-btn"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        data-info-popover
      >
        ?
      </button>
      {open && (
        <span id={id} role="dialog" aria-label={label} className={`ui-info-pop ${align}`} onClick={(e) => e.stopPropagation()}>
          <span className="ui-info-body">{children}</span>
          {doc && (
            <a className="ui-info-doc" href={doc.href} target="_blank" rel="noreferrer">
              {doc.label} ↗
            </a>
          )}
        </span>
      )}
    </span>
  );
}

/* ── PageHeader ─────────────────────────────────────────────────────────── */

/** A screen's header: [icon] Title (?) · status ……… primary action, menu. */
export function PageHeader({
  icon,
  title,
  status,
  info,
  actions,
  menu,
}: {
  icon?: ReactNode;
  title: string;
  /** One line, built from data: chips and short words, never a paragraph. */
  status?: ReactNode;
  /** The explanation, behind the "?". */
  info?: ReactNode;
  /** One primary action (and what has to sit beside it, like Stop). */
  actions?: ReactNode;
  /** Everything else, in a menu. */
  menu?: ReactNode;
}) {
  return (
    <header className="ui-page-header" data-page-header={title}>
      {icon && (
        <span className="ui-ph-icon" aria-hidden>
          {icon}
        </span>
      )}
      <h1 className="ui-ph-title">{title}</h1>
      {info && <InfoPopover label={`About ${title}`}>{info}</InfoPopover>}
      {status && (
        <div className="ui-ph-status" data-page-status>
          {status}
        </div>
      )}
      {(actions || menu) && (
        <div className="ui-ph-actions">
          {actions}
          {menu}
        </div>
      )}
    </header>
  );
}

/* ── EmptyState ─────────────────────────────────────────────────────────── */

/** What a list says when it holds nothing: what is missing and what would put
 *  something here. */
export function EmptyState({ title, body, action }: { title: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="dt-state dt-empty" data-empty-state>
      <div className="dt-empty-title">{title}</div>
      {body && <div className="dt-empty-body">{body}</div>}
      {action}
    </div>
  );
}

/* ── KpiTile ────────────────────────────────────────────────────────────── */

/** One number and its label. With `onOpen` the whole tile opens where the
 *  number comes from; `why` explains a "—" behind a "?". */
export function KpiTile({
  label,
  value,
  sub,
  tone,
  onOpen,
  why,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Extract<Tone, "ok" | "warn" | "danger">;
  onOpen?: () => void;
  why?: ReactNode;
}) {
  const unknown = value === "—" || value === null || value === undefined;
  return (
    <div className={["stat", "ui-kpi", tone ?? "", onOpen ? "opens" : ""].filter(Boolean).join(" ")} data-kpi={label}>
      <span className="stat-k">{label}</span>
      <span className="stat-n">
        {onOpen ? (
          <button type="button" className="ui-kpi-open" onClick={onOpen} aria-label={`${label}: open`}>
            {unknown ? "—" : value}
          </button>
        ) : unknown ? (
          "—"
        ) : (
          value
        )}
        {unknown && why && <InfoPopover label={`Why is ${label} unknown?`}>{why}</InfoPopover>}
      </span>
      {sub !== undefined && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

/* ── StepFlow ───────────────────────────────────────────────────────────── */

export type StepState = "done" | "current" | "todo" | "later" | "warn" | "failed";

export interface FlowStep {
  id: string;
  title: ReactNode;
  /** Where the step stands, in a line. */
  status?: ReactNode;
  state: StepState;
  /** What the step opens onto. */
  body?: ReactNode;
  /** Cards: never folds. */
  keepOpen?: boolean;
  /** Cards: starts folded though not done (read when wanted). */
  quiet?: boolean;
  /** Strip: the step goes elsewhere rather than opening below. */
  onSelect?: () => void;
}

const STRIP_TONE: Record<StepState, string> = { done: "ok", warn: "warn", failed: "bad", current: "current", todo: "", later: "" };
const STRIP_MARK: Record<StepState, string> = { done: "✓", warn: "!", failed: "✗", current: "•", todo: "", later: "" };

/** Steps in the order they are done. `cards`: each a card with a number (a
 *  tick once done), its title and status; a done or quiet step folds to that
 *  line until opened. `strip`: compact chips in a row; one opens below. */
export function StepFlow({
  steps,
  look = "cards",
  label,
  open,
  onOpen,
}: {
  steps: FlowStep[];
  look?: "cards" | "strip";
  /** The flow's accessible name. */
  label?: string;
  /** Strip: the step opened below (controlled); omitted, the strip keeps its own. */
  open?: string | null;
  onOpen?: (id: string | null) => void;
}) {
  const [own, setOwn] = useState<string | null>(null);
  if (look === "cards")
    return (
      <div className="ui-steps cards" role="group" aria-label={label} data-step-flow="cards">
        {steps.map((s, i) => (
          <StepCard key={s.id} n={i + 1} step={s} />
        ))}
      </div>
    );
  const opened = open !== undefined ? open : own;
  const pick = (id: string) => {
    const next = opened === id ? null : id;
    if (onOpen) onOpen(next);
    if (open === undefined) setOwn(next);
  };
  const shown = steps.find((s) => s.id === opened && s.body);
  return (
    <div className="ui-steps strip fc-steps" role="group" aria-label={label} data-step-flow="strip">
      <ol>
        {steps.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              className={`fc-step ${STRIP_TONE[s.state]}${opened === s.id ? " on" : ""}`}
              aria-expanded={s.body ? opened === s.id : undefined}
              onClick={() => (s.onSelect ? s.onSelect() : pick(s.id))}
              data-step={s.id}
              data-step-state={s.state}
            >
              <span className="fc-step-mark" aria-hidden>
                {STRIP_MARK[s.state]}
              </span>
              <span className="fc-step-n">{i + 1}</span>
              {s.title}
              {s.onSelect && <span aria-hidden> →</span>}
            </button>
          </li>
        ))}
      </ol>
      {shown && (
        <div className="fc-step-detail" data-step-detail={shown.id}>
          {shown.status && <div className="ui-step-status">{shown.status}</div>}
          {shown.body}
        </div>
      )}
    </div>
  );
}

function StepCard({ n, step }: { n: number; step: FlowStep }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const done = step.state === "done";
  const shown = !!step.body && (step.keepOpen || (open ?? !(done || step.quiet)));
  const foldable = !!step.body && !step.keepOpen;
  return (
    <section className={`card ui-step ${step.state}`} data-step={step.id} data-step-state={step.state}>
      <button
        type="button"
        className="ui-step-head"
        aria-expanded={step.body ? shown : undefined}
        disabled={!foldable}
        onClick={() => setOpen(!shown)}
      >
        <span className="ui-step-n">{done ? "✓" : step.state === "failed" ? "✗" : n}</span>
        <span className="ui-step-title">{step.title}</span>
        <span className="ui-step-status">{step.status}</span>
        {foldable && <span className="ui-step-toggle">{shown ? "Hide" : "Show"}</span>}
      </button>
      {shown && <div className="ui-step-body">{step.body}</div>}
    </section>
  );
}
