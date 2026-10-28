// One diagnostic, rendered one way, wherever it is read.
//
// `Diagnostic[]` had five consumers and four renderers: the Conflicts screen's
// full row, the Product view's counts, the Add Gear panel's key-value lines, the
// catalogue's code-and-message, and `ResolutionMarkers` turning the same array
// into Problems markers. Four renderers of one array is four chances to
// disagree, and they did disagree about what a person is allowed to see: only
// the Conflicts screen showed `help`, `location`, `related` and `evidence`, so
// everywhere else a diagnostic was a sentence with no way to act on it.
//
// This is that row, extracted verbatim -- same DOM, same `data-conflict-*`
// attributes, so the claims that read the Conflicts screen keep reading exactly
// what they read before.
//
// **Density is visual only.** A `compact` list is the same information at a
// smaller weight, not a shorter version of it: the whole reason for one renderer
// is that the panel a diagnostic happens to appear in must not decide whether its
// remedy is visible. What `compact` changes is spacing, which is a CSS concern,
// which is where it lives.

import { codicon } from "@theia/core/lib/browser";
import React from "@theia/core/shared/react";

import type { Diagnostic } from "../../common/generated/Diagnostic";
import type { Location } from "../../common/generated/Location";
import type { Severity } from "../../common/generated/Severity";
import type { Selection } from "../shell/selection-service";
import { GEARBOX_DRAG_MIME } from "../ai/gearbox-context";

/** Worst first. A list that buries the error under three hints is sorted wrong. */
const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

const ICON: Record<Severity, string> = {
  error: "error",
  warning: "warning",
  info: "info",
  hint: "lightbulb",
};

export type Density = "comfortable" | "compact";

/**
 * The selection a diagnostic's `subject` names, if it names one this can select.
 *
 * `NodeId` is `{kind}:{payload}` and the format is part of the wire contract, so
 * parsing it here is reading the contract rather than guessing. An unrecognised
 * kind returns `undefined` and the row simply is not clickable -- a profile node
 * is a perfectly good subject and there is nothing for the Inspector to say about
 * it, which is different from a parse that failed.
 */
export function selectionOf(subject: string | null | undefined): Selection | undefined {
  if (subject === null || subject === undefined) return undefined;
  const at = subject.indexOf(":");
  if (at < 0) return undefined;
  const kind = subject.slice(0, at);
  const payload = subject.slice(at + 1);
  if (kind === "gear" || kind === "application") {
    return { kind, id: payload };
  }
  if (kind === "binding") {
    const bar = payload.indexOf("|");
    if (bar < 0) return undefined;
    return { kind: "binding", consumer: payload.slice(0, bar), contract: payload.slice(bar + 1) };
  }
  return undefined;
}

/** Worst first, without mutating the caller's array. */
export function worstFirst(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

export function errorsIn(diagnostics: readonly Diagnostic[]): number {
  return diagnostics.filter((d) => d.severity === "error").length;
}

/**
 * The most serious severity present, or `undefined` for an empty list.
 *
 * **Not `diagnostics[0].severity`, which is what two callers were using.** The
 * engine orders diagnostics by `(code, message)` for determinism, not by
 * severity, so the first element is the lowest code -- and a product carrying
 * `GBX0504` (info) and `GBX0602` (warning) reported itself as info. Ordering by
 * severity is what `worstFirst` is for, and this is the one-value form of it.
 */
export function worstOf(diagnostics: readonly Diagnostic[]): Severity | undefined {
  return worstFirst(diagnostics)[0]?.severity;
}

/** "3 conflicts" is wrong when two of them are hints. */
export function summarise(total: number, errors: number): string {
  if (total === 0) return "No conflicts";
  if (errors === 0) return `${total} ${total === 1 ? "diagnostic" : "diagnostics"}, none blocking`;
  const rest = total - errors;
  const head = `${errors} ${errors === 1 ? "conflict" : "conflicts"}`;
  return rest === 0
    ? head
    : `${head}, and ${rest} more ${rest === 1 ? "diagnostic" : "diagnostics"}`;
}

export interface DiagnosticsListProps {
  readonly diagnostics: readonly Diagnostic[];
  /** Spacing only -- see the note at the top of this file. */
  readonly density?: Density;
  /** Open the description at a location. Omitted where nothing can be opened. */
  readonly onReveal?: (location: Location) => void;
  /**
   * Point another panel at the node a diagnostic is about.
   *
   * Omitted where there is nothing to point: the `explain` control then does not
   * render, rather than rendering and doing nothing.
   */
  readonly onExplain?: (selection: Selection) => void;
  /**
   * Take the person to the control that would fix this, for a gear.
   *
   * **Separate from `onExplain`, because they are different destinations.**
   * `onExplain` points a panel at the subject so it can say *why*; this opens
   * the form that would change it. A warning about `event-broker`'s `mode` could
   * be explained and could be opened in the `.gdl`, and neither of those is the
   * numeric box that sets it -- so the way to the box was to remember the gear's
   * name, go to Composition and find it again.
   *
   * Omitted where there is no such destination, the way `onExplain` is: the
   * Conflicts panel offers it, the Add Gear preview does not.
   */
  readonly onConfigure?: (gear: string, field?: string) => void;
  /** Sorted worst-first unless the caller has already ordered it. */
  readonly sorted?: boolean;
}

export function DiagnosticsList(props: DiagnosticsListProps): React.ReactElement {
  const rows = props.sorted === true ? [...props.diagnostics] : worstFirst(props.diagnostics);
  const density = props.density ?? "comfortable";
  const important = rows.filter(d => d.severity === "error" || d.severity === "warning");
  const notes = rows.filter(d => d.severity === "info" || d.severity === "hint");
  const list = (entries: readonly Diagnostic[]) => <ul className={`gbx-conflicts-list gbx-conflicts-${density}`}>
    {entries.map((diagnostic, index) => <DiagnosticRow key={`${diagnostic.code}-${index}`} diagnostic={diagnostic}
      onReveal={props.onReveal} onExplain={props.onExplain} onConfigure={props.onConfigure} />)}
  </ul>;
  return <div className="gbx-diagnostics">
    {important.length > 0 && list(important)}
    {notes.length > 0 && <details className="gbx-diagnostic-notes" data-diagnostic-notes>
      <summary>Information and hints ({notes.length})</summary>{list(notes)}
    </details>}
  </div>;
}

export interface DiagnosticRowProps {
  readonly diagnostic: Diagnostic;
  readonly onReveal?: (location: Location) => void;
  readonly onExplain?: (selection: Selection) => void;
  readonly onConfigure?: (gear: string, field?: string) => void;
}

export function DiagnosticRow({
  diagnostic,
  onReveal,
  onExplain,
  onConfigure,
}: DiagnosticRowProps): React.ReactElement {
  const selection = selectionOf(diagnostic.subject);
  const help = diagnostic.help ?? undefined;
  return (
    <li
      className={`gbx-conflict gbx-conflict-${diagnostic.severity}`}
      data-conflict-code={diagnostic.code}
      data-conflict-severity={diagnostic.severity}
      data-conflict-subject={diagnostic.subject ?? ""}
    >
      <div className="gbx-conflict-head">
        <span className={`${codicon(ICON[diagnostic.severity])} gbx-conflict-icon`} />
        <span className="gbx-conflict-message">{diagnostic.message}</span>
      </div>

      {/* `help` is required for errors (`cpt-gearbox-nfr-actionable-diagnostics`),
          so its absence on one is worth seeing rather than smoothing over. */}
      {help !== undefined && <div className="gbx-conflict-help">{help}</div>}
      {diagnostic.severity === "error" && help === undefined && (
        <div className="gbx-conflict-help gbx-error" role="alert">
          This error carries no help text, which `cpt-gearbox-nfr-actionable-diagnostics` requires.
          That is a defect in the engine, not in the description.
        </div>
      )}

      <div className="gbx-conflict-links">
        {!(selection?.kind === "gear" && onConfigure) && diagnostic.location && onReveal &&
          <button type="button" className="gbx-choice" data-diagnostic-open-gdl onClick={() => onReveal(diagnostic.location!)}>Open GDL</button>}

        {/* **The form, not the file and not the explanation.** Offered only for a
            gear, because a gear is the only subject with a settings form; an
            application and a binding are things the resolver made, and there is
            no box to take anyone to. */}
        {selection?.kind === "gear" && onConfigure !== undefined && (
          <button
            type="button"
            className="gbx-conflict-explain"
            data-conflict-configure={selection.id}
            data-conflict-configure-field={diagnostic.config_key ?? undefined}
            onClick={() => onConfigure(selection.id, diagnostic.config_key ?? undefined)}
          >
            {/* The key when the diagnostic is about one, because "configure
                event-broker" and "configure event-broker's `mode`" are
                different distances from the fix. */}
            configure {diagnostic.config_key ? `${selection.id} · ${diagnostic.config_key}` : selection.id}
          </button>
        )}
      </div>
      <details className="gbx-diagnostic-details">
        <summary>Details</summary>
        <div className="gbx-diagnostic-metadata">
        {/* Draggable into the chat by the code alone, not the whole row: a
            draggable row turns every press-and-move into a drag, so its message
            and help could not be selected and copied. The payload is the code:
            the chat's `#gearboxDiagnostics` already carries every occurrence, so
            what a drag adds is which one the person meant. */}
        <span
          className="gbx-id gbx-drag-handle"
          title="Drag into the chat"
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(
              GEARBOX_DRAG_MIME,
              JSON.stringify({ kind: "diagnostic", code: diagnostic.code }),
            );
            event.dataTransfer.setData("text/plain", `${diagnostic.code}: ${diagnostic.message}`);
            event.dataTransfer.effectAllowed = "copy";
          }}
        >
          {diagnostic.code}
        </span>
        <Where location={diagnostic.location ?? undefined} preposition="in" onReveal={onReveal} />
        {(diagnostic.related ?? []).map((related, at) => (
          <span className="gbx-conflict-related" key={`${related.message}-${at}`}>
            {related.message}{" "}
            <Where location={related.location} preposition="at" onReveal={onReveal} />
          </span>
        ))}
        {selection !== undefined && onExplain !== undefined && (
          <button
            type="button"
            className="gbx-conflict-explain"
            data-conflict-explain={diagnostic.subject ?? ""}
            // The `subject` field exists for exactly this: "the graph node this
            // concerns, so a client can select it".
            onClick={() => onExplain(selection)}
          >
            explain {label(selection)}
          </button>
        )}
        {/* The `file:line` in `gears-rust` that substantiates a claim about a
            runtime limitation (`cpt-gearbox-nfr-evidence-cited`). Shown as text
            rather than as a link: it points into the corpus, which is a different
            tree from the descriptions, and a link that may not open is worse than
            a citation that reads. */}
        {diagnostic.evidence !== null && diagnostic.evidence !== undefined && (
          <span className="gbx-conflict-evidence" title="evidence in gears-rust">
            {diagnostic.evidence}
          </span>
        )}
        </div>
      </details>
    </li>
  );
}

function Where(props: {
  readonly location: Location | undefined;
  readonly preposition: string;
  readonly onReveal?: (location: Location) => void;
}): React.ReactElement | null {
  const { location, preposition, onReveal } = props;
  // eslint-disable-next-line no-null/no-null
  if (location === undefined || location === null || onReveal === undefined) return null;
  const line = location.range.start.line + 1;
  const name = location.uri.split("/").pop() ?? location.uri;
  return (
    <a
      className="gbx-conflict-where"
      href={location.uri}
      onClick={(event) => {
        event.preventDefault();
        onReveal(location);
      }}
    >
      {preposition} {name}:{line}
    </a>
  );
}

function label(selection: Selection): string {
  switch (selection.kind) {
    case "plugin": return `${selection.host} / ${selection.id}`;
    case "gear":
    case "catalogue-gear":
    case "application":
      return selection.id;
    case "binding":
      return `${selection.consumer} → ${selection.contract}`;
    case "catalogue-row":
      return selection.key;
  }
}
