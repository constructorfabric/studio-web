/* ── Project lifecycle: where a project is, as a person says it ──────────────
 *
 * The one module that knows what a project's status and phases are: their
 * values, words, order and the moves between them. The shell reads them only
 * through `lifecycleField` (a field of project-filters.ts) and the views in
 * project-lifecycle-view.tsx, so the lifecycle can move into a kit that
 * extends the domain model without the shell changing. Nothing about it is
 * a backend type: it is stored in the project config metadata the project
 * already has.
 *
 * A project's STATUS is the phase it is in: "In development", "In testing",
 * "In production". Status and phase are one concept here, not two: the phases
 * are the ordered list a project moves through, and its status is the one it
 * is in now. One field holds it -- `project.config.status`, the field the
 * config always had for this (`draft` / `active` / `archived`, written at
 * creation and read by nothing). Those three are still read: a stored `draft`
 * is the first phase, `active` is Development and `archived` is the first
 * closing phase.
 *
 * Not the journey stages (ADR-0058): those are computed from the specs and
 * say whether a stage's documents are complete. A phase is a person's call:
 * nobody computes "in production" from a document.
 *
 * The list lives where the project templates do -- `cf.studio.project.types.v1~`
 * tenant metadata, as `phases` beside `types` -- so an organization sets it for
 * every workspace and a workspace may set its own. Nothing set anywhere means
 * BUILTIN_PHASES. A phase may be `closing` (Archived): a project leaves the
 * working ladder for it from any phase, and comes back from it to the last
 * working phase.
 *
 * Pure, so it is tested without a backend.
 */

import { attributeText, type ProjectFacts, type ProjectField } from "./project-filters";

export interface ProjectPhase {
  /** Stable id, stored on each project as `project.config.status`. */
  key: string;
  /** The phase's name: "Testing". */
  label: string;
  /** How a project in it is described: "In testing". */
  status: string;
  /** Outside the working ladder: reachable from any phase. */
  closing?: boolean;
}

export const BUILTIN_PHASES: ProjectPhase[] = [
  { key: "discovery", label: "Discovery", status: "In discovery" },
  { key: "development", label: "Development", status: "In development" },
  { key: "testing", label: "Testing", status: "In testing" },
  { key: "production", label: "Production", status: "In production" },
  { key: "archived", label: "Archived", status: "Archived", closing: true },
];

/** The status a phase is described with when its list does not say. */
export function defaultStatus(label: string, closing?: boolean): string {
  const l = label.trim();
  if (closing || !l) return l;
  return `In ${l.charAt(0).toLowerCase()}${l.slice(1)}`;
}

/** The phases a stored project-types document holds, or `null` when it holds
 *  none -- the caller then looks further up, and in the end uses the built-in
 *  list. Malformed entries are left out; a list with no working phase left is
 *  no list. */
export function parsePhases(raw: unknown): ProjectPhase[] | null {
  const list = raw && typeof raw === "object" ? (raw as { phases?: unknown }).phases : undefined;
  if (!Array.isArray(list)) return null;
  const seen = new Set<string>();
  const out: ProjectPhase[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const key = typeof p.key === "string" ? p.key.trim() : "";
    const label = typeof p.label === "string" ? p.label.trim() : "";
    if (!key || !label || seen.has(key)) continue;
    seen.add(key);
    const closing = p.closing === true;
    const status = typeof p.status === "string" && p.status.trim() ? p.status.trim() : defaultStatus(label, closing);
    out.push({ key, label, status, ...(closing ? { closing: true } : {}) });
  }
  return out.some((p) => !p.closing) ? out : null;
}

/** The phases that apply: the first of the documents, nearest first, that
 *  holds a list; else the built-in one. */
export function phasesOf(...docs: unknown[]): ProjectPhase[] {
  for (const d of docs) {
    const p = parsePhases(d);
    if (p) return p;
  }
  return BUILTIN_PHASES;
}

/** Why a list cannot be saved, or null. */
export function phasesProblem(phases: ProjectPhase[]): string | null {
  if (!phases.some((p) => !p.closing)) return "Keep at least one working phase.";
  const keys = new Set<string>();
  for (const p of phases) {
    if (!p.label.trim()) return "Every phase needs a name.";
    if (keys.has(p.key)) return `Two phases are called “${p.label}”.`;
    keys.add(p.key);
  }
  return null;
}

/** The working phases, in order. */
function ladder(phases: ProjectPhase[]): ProjectPhase[] {
  return phases.filter((p) => !p.closing);
}

/** The phase a stored value names. A value from before phases is read as the
 *  phase it meant; one the list no longer has is `unknown`, said as it is
 *  rather than guessed at. */
export function resolvePhase(
  phases: ProjectPhase[],
  stored: string | null | undefined,
): { phase: ProjectPhase | null; unknown: string | null } {
  const v = (stored ?? "").trim();
  if (!v) return { phase: null, unknown: null };
  const own = phases.find((p) => p.key === v);
  if (own) return { phase: own, unknown: null };
  const work = ladder(phases);
  const legacy =
    v === "draft"
      ? work[0]
      : v === "active"
        ? (work.find((p) => p.key === "development") ?? work[1] ?? work[0])
        : v === "archived"
          ? phases.find((p) => p.closing)
          : undefined;
  return legacy ? { phase: legacy, unknown: null } : { phase: null, unknown: v };
}

/** How a project's status reads: its phase's words, the raw value when the
 *  list no longer has it, or "No phase" when none was ever set. */
export function statusText(phases: ProjectPhase[], stored: string | null | undefined): string {
  const { phase, unknown } = resolvePhase(phases, stored);
  return phase ? phase.status : (unknown ?? "No phase");
}

/** The chip's tone: the last working phase is the one that is done well
 *  (production), a closing one is quiet, anything before is under way. */
export function phaseTone(
  phases: ProjectPhase[],
  stored: string | null | undefined,
): "ok" | "info" | "neutral" | "warn" {
  const { phase, unknown } = resolvePhase(phases, stored);
  if (unknown) return "warn";
  if (!phase || phase.closing) return "neutral";
  const work = ladder(phases);
  return work[work.length - 1]?.key === phase.key ? "ok" : "info";
}

export interface PhaseMoves {
  /** The next working phase, if any. */
  forward: ProjectPhase | null;
  /** The working phase before, if any. */
  back: ProjectPhase | null;
  /** Closing phases it may go to (not the one it is in). */
  close: ProjectPhase[];
  /** From a closing phase: the working phase it comes back to. */
  reopen: ProjectPhase | null;
  /** No phase yet, or one the list lost: any phase may be set. */
  any: ProjectPhase[];
}

/** Where a project may go from the phase it is in. One step along the ladder
 *  either way, out to a closing phase from anywhere, back from one to the last
 *  working phase. A project with no phase, or a phase the list no longer has,
 *  may be put in any. */
export function phaseMoves(phases: ProjectPhase[], stored: string | null | undefined): PhaseMoves {
  const none: PhaseMoves = { forward: null, back: null, close: [], reopen: null, any: [] };
  const { phase } = resolvePhase(phases, stored);
  if (!phase) return { ...none, any: [...phases] };
  const work = ladder(phases);
  if (phase.closing) {
    return { ...none, reopen: work[work.length - 1] ?? null };
  }
  const i = work.findIndex((p) => p.key === phase.key);
  return {
    ...none,
    forward: work[i + 1] ?? null,
    back: i > 0 ? work[i - 1] : null,
    close: phases.filter((p) => p.closing),
  };
}

/** Whether a project in `from` may be moved to `to`. */
export function canMove(phases: ProjectPhase[], from: string | null | undefined, to: string): boolean {
  const m = phaseMoves(phases, from);
  const targets = [m.forward, m.back, m.reopen, ...m.close, ...m.any].filter(Boolean) as ProjectPhase[];
  const current = resolvePhase(phases, from).phase?.key;
  return to !== current && targets.some((p) => p.key === to);
}

/** The phase a new project starts in. */
export function firstPhase(phases: ProjectPhase[]): ProjectPhase | null {
  return ladder(phases)[0] ?? null;
}

/** A key for a new phase named `label`, unique among `taken`. */
export function phaseKeyFor(label: string, taken: Iterable<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "phase";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
}

/** The lifecycle as a project field (project-filters.ts): the `status`
 *  attribute read as a phase, filtered and ordered by the phase list, shown
 *  as a chip in a Status column, moved one step at a time, and set to the
 *  first phase on a new project. */
export function lifecycleField(phases: ProjectPhase[]): ProjectField {
  const read = (f: ProjectFacts) => attributeText(f, "status");
  return {
    id: "phase",
    label: "Phase",
    allLabel: "All phases",
    claims: ["status"],
    noneLabel: "No phase",
    header: "Status",
    value: (f) => {
      const { phase, unknown } = resolvePhase(phases, read(f));
      return phase?.key ?? unknown;
    },
    choices: () => phases.map((p) => ({ value: p.key, label: p.label })),
    chip: (f) => {
      const stored = read(f);
      const { phase, unknown } = resolvePhase(phases, stored);
      return {
        key: phase?.key ?? unknown ?? "none",
        text: statusText(phases, stored),
        tone: phaseTone(phases, stored),
        title: unknown ? `“${unknown}” is not one of this workspace's phases` : phase ? `Phase: ${phase.label}` : "No phase set",
      };
    },
    moves: (f) => {
      const m = phaseMoves(phases, read(f));
      const to = (label: string, p: ProjectPhase) => ({ label, patch: { status: p.key } });
      return [
        ...(m.forward ? [to(`Move to ${m.forward.label} →`, m.forward)] : []),
        ...(m.back ? [to(`← Back to ${m.back.label}`, m.back)] : []),
        ...(m.reopen ? [to(`Reopen in ${m.reopen.label}`, m.reopen)] : []),
        ...m.close.map((p) => to(`Move to ${p.label}`, p)),
        ...m.any.map((p) => to(`Set: ${p.label}`, p)),
      ];
    },
    initial: () => {
      const first = firstPhase(phases);
      return first ? { status: first.key } : {};
    },
  };
}
