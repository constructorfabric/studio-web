/* The Components tab as one flow: what to do next, how to make the product
 * resolve, and what the code already says.
 *
 * Pure rules behind `kits.tsx`, kept here so they can be tested:
 *   - `nextStep`: the one sentence at the top of the page, in place of three
 *     tiles a person had to read and combine;
 *   - `fixesFrom`: the engine's completion (`POST /gearbox/complete`) turned
 *     into separate fixes, each applied on its own, instead of one "Make it
 *     resolve" that changes everything at once;
 *   - `productionFixes`: what completion cannot offer -- a production rule
 *     (GBX0325) broken by a gear that is there, not by one that is missing;
 *   - `codeDiff`: the product against what the code depends on, for "Take
 *     the product from the code";
 *   - `rowShortlist` / `alsoCovers`: section 1 shows one recommendation per
 *     capability and says when one gear answers several;
 *   - `plainText`: a statement quoted from a spec without its markdown. */

import type { Candidate, Conformance, GearConfig, GearboxDiagnostic, PlanRow, ProductChange } from "./api";
import { isPickable } from "./product";

/** A sentence from a document, without the markdown that was around it. */
export function plainText(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*#+\s*/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Fixes ────────────────────────────────────────────────────────────────

export type Fix =
  | { kind: "add"; gear: string; reason: string }
  | { kind: "remove"; gear: string; reason: string }
  | { kind: "config"; gear: string; field: string; value: unknown; reason: string }
  /** A picked gear the product is to configure: its settings, not a change. */
  | { kind: "setup"; gear: string; fields: string[]; reason: string }
  | { kind: "replace"; gear: string; with: string; reason: string };

/** The engine's completion of the current product, as separate fixes. */
export function fixesFrom(
  picks: readonly string[],
  config: GearConfig,
  completion: { gears: string[]; changes: ProductChange[]; config?: GearConfig },
): Fix[] {
  const out: Fix[] = [];
  const seen = new Set<string>();
  for (const c of completion.changes) {
    const key = `${c.added ? "+" : "-"}${c.gear}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (c.needs && c.needs.length > 0) {
      out.push({ kind: "setup", gear: c.gear, fields: c.needs, reason: c.reason });
      continue;
    }
    if (c.added && !picks.includes(c.gear)) out.push({ kind: "add", gear: c.gear, reason: c.reason });
    if (!c.added && picks.includes(c.gear)) out.push({ kind: "remove", gear: c.gear, reason: c.reason });
  }
  for (const [gear, fields] of Object.entries(completion.config ?? {})) {
    for (const [field, value] of Object.entries(fields)) {
      if (JSON.stringify(config[gear]?.[field]) === JSON.stringify(value)) continue;
      out.push({
        kind: "config",
        gear,
        field,
        value,
        reason: `the engine needs ${field} = ${typeof value === "string" ? value : JSON.stringify(value)}`,
      });
    }
  }
  return out;
}

/** A production rule a picked gear breaks, and the gear that keeps it. */
const PRODUCTION_SWAPS = [
  {
    // `accept_all`, its default mode, authenticates any non-empty token.
    code: "GBX0325",
    gear: "static-authn-plugin",
    with: "oidc-authn-plugin",
    reason: "static sign-in accepts any token; a production profile signs in with OIDC",
  },
];

/** Fixes for the production rules a preview reports broken: each swaps the
 *  pick that breaks one for the gear that keeps it. Picks are named as the
 *  catalogue names them (`cf-gears-static-authn-plugin`), errors by engine id. */
export function productionFixes(picks: readonly string[], diagnostics: readonly GearboxDiagnostic[]): Fix[] {
  const out: Fix[] = [];
  for (const swap of PRODUCTION_SWAPS) {
    const named = "`" + swap.gear + "`";
    const broken = diagnostics.some((d) => d.severity === "error" && d.code === swap.code && d.message.includes(named));
    const pick = picks.find((p) => p === swap.gear || p.endsWith("-" + swap.gear));
    if (!broken || !pick) continue;
    const keeper = pick.slice(0, pick.length - swap.gear.length) + swap.with;
    out.push(
      picks.includes(keeper)
        ? { kind: "remove", gear: pick, reason: swap.reason }
        : { kind: "replace", gear: pick, with: keeper, reason: swap.reason },
    );
  }
  return out;
}

/** The picks and configuration with one fix applied. */
export function applyFix(
  picks: readonly string[],
  config: GearConfig,
  fix: Fix,
): { picks: string[]; config: GearConfig } {
  if (fix.kind === "setup") return { picks: [...picks], config };
  if (fix.kind === "add") return { picks: picks.includes(fix.gear) ? [...picks] : [...picks, fix.gear], config };
  if (fix.kind === "remove" || fix.kind === "replace") {
    const next = { ...config };
    delete next[fix.gear];
    const kept = picks.filter((p) => p !== fix.gear);
    if (fix.kind === "replace" && !kept.includes(fix.with)) kept.push(fix.with);
    return { picks: kept, config: next };
  }
  return { picks: [...picks], config: { ...config, [fix.gear]: { ...(config[fix.gear] ?? {}), [fix.field]: fix.value } } };
}

// ── The code ─────────────────────────────────────────────────────────────

/** The gears the code depends on that a product can pick. */
export function codeGears(report: Pick<Conformance, "components_in_code">): string[] {
  return report.components_in_code.filter((n) => isPickable({ name: n, kind: "gear" }));
}

/** The product against the code: what taking the product from the code adds,
 *  drops and keeps. */
export function codeDiff(picks: readonly string[], code: readonly string[]): { add: string[]; drop: string[]; keep: string[] } {
  return {
    add: code.filter((n) => !picks.includes(n)),
    drop: picks.filter((n) => !code.includes(n)),
    keep: picks.filter((n) => code.includes(n)),
  };
}

/** What the code says about one capability: the gears in it that fill it. */
export function codeFor(
  report: Conformance | null,
  capability: string,
): { status: "implemented" | "missing"; by: { name: string; declared: boolean }[] } | null {
  const item = report?.items.find((i) => i.capability === capability);
  return item ? { status: item.status, by: item.implemented_by } : null;
}

// ── Section 1, shorter ───────────────────────────────────────────────────

/** The candidate a row recommends: built, pickable, not blocked, the engine's
 *  runnable ones first; else the first candidate. */
export function recommended(row: PlanRow): Candidate | undefined {
  const usable = row.candidates.filter((c) => c.built === "built" && isPickable(c) && c.composable !== "blocked");
  return usable.find((c) => c.composable === "runs") ?? usable[0] ?? row.candidates[0];
}

/** The candidates a collapsed row shows -- the ones in the product and the
 *  recommended one -- and how many are folded away. */
export function rowShortlist(row: PlanRow, picks: readonly string[], expanded: boolean): { shown: Candidate[]; hidden: number } {
  if (expanded) return { shown: row.candidates, hidden: 0 };
  const best = recommended(row);
  const shown = row.candidates.filter((c) => picks.includes(c.name) || c === best);
  return { shown, hidden: row.candidates.length - shown.length };
}

/** For each candidate, the capabilities it is offered for, so a gear that
 *  answers three rows can say so instead of looking like three answers. */
export function alsoCovers(plan: readonly PlanRow[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of plan) {
    for (const c of row.candidates) {
      const list = (out[c.name] ??= []);
      if (!list.includes(row.capability)) list.push(row.capability);
    }
  }
  return out;
}

// ── The next step ────────────────────────────────────────────────────────

/** `builds`: the product is written; building it is the Builds tab's. */
export type NextAction = "add-recommended" | "take-from-code" | "preview" | "fix" | "build" | "open" | "builds";

export interface NextStep {
  text: string;
  action?: NextAction;
  /** `done`: nothing left to do; `warn`: it can go on, with a gap said out loud. */
  tone: "todo" | "warn" | "done";
}

export interface FlowState {
  /** Capabilities the specs ask for; null while they are read. */
  capabilities: number | null;
  /** Of those a gear answers, how many the product closes, and how many
   *  only by a gear that mentions their words. */
  covered?: number;
  weak?: number;
  /** Capabilities no gear in the product closes. */
  open: number;
  picks: number;
  /** Gears the code already depends on; null while it is read. */
  inCode: number | null;
  /** The engine's verdict on the current product; null when not asked yet. */
  resolves: boolean | null;
  /** Fixes the engine offers for a product that does not resolve. */
  fixes: number;
  /** product.gdl is in the repository for the current product. */
  written: boolean;
  composing: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function nextStep(s: FlowState): NextStep {
  if (s.capabilities === null) return { text: "Reading what the specs ask for…", tone: "todo" };
  if (!s.composing) {
    return {
      text: "Composing a product needs the Gearbox engine, which is off here; the specs and the code can still be compared below.",
      tone: "warn",
    };
  }
  if (s.picks === 0) {
    if (s.inCode && s.inCode > 0) {
      return {
        text: `Start the product from the code: it already depends on ${plural(s.inCode, "gear", "gears")}.`,
        action: "take-from-code",
        tone: "todo",
      };
    }
    return { text: "Start the product: add the recommended gear for each capability.", action: "add-recommended", tone: "todo" };
  }
  if (s.resolves === null) return { text: "Check the product: ask the Gearbox engine whether it resolves.", action: "preview", tone: "todo" };
  if (!s.resolves) {
    return s.fixes > 0
      ? { text: `The product does not resolve. ${plural(s.fixes, "fix", "fixes")} below make it resolve.`, action: "fix", tone: "todo" }
      : { text: "The product does not resolve, and the engine offers no fix: see the errors below.", tone: "todo" };
  }
  const gap =
    s.open > 0
      ? ` ${plural(s.open, "capability", "capabilities")} the specs ask for ${s.open === 1 ? "is" : "are"} not closed yet.`
      : "";
  if (!s.written) return { text: `The product resolves: build it in Studio-ide.${gap}`, action: "build", tone: gap ? "warn" : "todo" };
  return {
    text: `Composed: product.gdl is in the repository. Next: build it, in Studio, the IDE or CI.${gap}`,
    action: "builds",
    tone: gap ? "warn" : "done",
  };
}

/** One step of the way from the specs to a built product. */
export interface ProductStep {
  id: "needs" | "product" | "build";
  title: string;
  /** Where it stands, in a few words. */
  status: string;
  /** `done`; `current`: the first not done; `todo`: after it; `off`: the
   *  deployment cannot do it. */
  state: "done" | "current" | "todo" | "off";
}

/** The three steps — what the specs ask for, the product composed and
 *  checked, the product built — each with where it stands. A step is done
 *  when the next can start on it: gears picked, the product resolving,
 *  product.gdl written. */
export function productSteps(s: FlowState): ProductStep[] {
  const closing =
    s.composing && s.picks > 0 && s.covered !== undefined
      ? [`${s.covered} closed`, s.weak ? `${s.weak} only by words` : "", s.open ? `${s.open} not closed` : ""].filter(Boolean).join(", ")
      : "";
  const caps =
    s.capabilities === null
      ? "reading the specs…"
      : `${plural(s.capabilities, "capability", "capabilities")}${closing ? ` · ${closing}` : ""}`;
  const compose =
    s.picks === 0
      ? "nothing in it yet"
      : s.resolves === null
        ? `${plural(s.picks, "gear", "gears")}, not checked`
        : s.resolves
          ? `${plural(s.picks, "gear", "gears")}, resolves`
          : `does not resolve${s.fixes > 0 ? ` · ${plural(s.fixes, "fix", "fixes")}` : ""}`;
  const steps: Omit<ProductStep, "state">[] = [
    { id: "needs", title: "What the specs ask for", status: caps },
    { id: "product", title: "Compose and check", status: compose },
    {
      id: "build",
      title: "Build in Studio-ide",
      status: !s.written ? "not built yet" : s.resolves === true ? "product.gdl in the repository" : "built earlier · build again once it resolves",
    },
  ];
  // A step is done only on the steps before it: a product built earlier is
  // not built while it no longer resolves.
  const own = [s.composing && s.picks > 0, s.composing && s.resolves === true, s.composing && s.written];
  const done = own.map((d, i) => d && own.slice(0, i).every(Boolean));
  const current = done.findIndex((d) => !d);
  return steps.map((step, i) => ({
    ...step,
    state: i > 0 && !s.composing ? "off" : done[i] ? "done" : i === current ? "current" : "todo",
  }));
}
