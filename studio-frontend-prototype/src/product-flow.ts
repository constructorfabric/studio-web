/* The Product page's way from a configured product to a running one, as one
 * strip above its sections: configure the product (its infrastructure, its
 * backend, its frontend), save it as the product's description (product.gdl,
 * a revision Studio keeps), build it, deploy it. The sections change the
 * product; only the save writes product.gdl, and the build and the deploy take
 * what it wrote. Each step is read off what the project already holds, so the
 * strip says where the product stands and what comes next.
 *
 * Pure, so it is tested without a backend; product-flow-view.tsx gathers the
 * facts and draws them. */

import type { ProjectConfig, ProjectProduct } from "./api";
import { gearKey } from "./frontend-constructor";
import type { PipelineHint, PipelineTab } from "./pipeline";
import { FALLBACK_PROFILE, profileLabel, verdictOf } from "./product";
import type { Infrastructure, ProductSectionId } from "./product-sections";

/** `none`: a part the product may go without and does (no frontend): neither
 *  done nor waiting. */
export type FlowState = "done" | "todo" | "failed" | "unknown" | "none";

/** One of the parts the Configure step is made of: a section of the page. */
export interface FlowPart {
  id: Extract<ProductSectionId, "infrastructure" | "backend" | "frontend">;
  title: string;
  state: FlowState;
  status: string;
}

export interface FlowStep {
  id: "configure" | "save" | "build" | "deploy";
  title: string;
  state: FlowState;
  status: string;
  parts?: FlowPart[];
  /** The project tab that does this step, when it is not this page. */
  tab?: PipelineTab;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type ProductFacts = Pick<ProjectProduct, "gears" | "checks" | "last_preview" | "frontend"> | null;

/** Where the product runs, environment by environment: each runs the profile
 *  bound to it, and gives it a database or not. */
function infrastructurePart(infra: Infrastructure | null): FlowPart {
  const base = { id: "infrastructure" as const, title: "Infrastructure" };
  if (!infra) return { ...base, state: "unknown", status: "Could not read where the product runs." };
  if (infra.runsIn.length === 0) return { ...base, state: "todo", status: "No environment to run in yet." };
  const stops = infra.runsIn.filter((r) => r.missing.length > 0);
  if (stops.length > 0) {
    const where = stops.map((r) => r.environment).join(", ");
    return {
      ...base,
      state: "failed",
      status: `A deploy to ${where} will stop: it gives no database for the gears that keep data. Switch it to the product's own Postgres (Organization › Infrastructure).`,
    };
  }
  const bound = infra.runsIn.filter((r) => r.profile);
  if (bound.length === 0)
    return { ...base, state: "todo", status: "No environment runs a profile yet: bind one in Releases." };
  const unchecked = bound.filter((r) => r.unchecked);
  if (unchecked.length > 0) {
    return {
      ...base,
      state: "todo",
      status: `${unchecked.map((r) => `${r.environment}: ${r.unchecked}`).join("; ")}. Check it under Backend.`,
    };
  }
  return {
    ...base,
    state: "done",
    status: `${bound.map((r) => `${r.environment} runs ${r.profileLabel}`).join("; ")}.`,
  };
}

/** The gears, checked by the engine for every profile an environment runs
 *  (for `prod` when none is bound): done only while each of those checks is
 *  about the product as it is and resolves. */
function backendPart(product: ProductFacts, infra: Infrastructure | null): FlowPart {
  const base = { id: "backend" as const, title: "Backend" };
  const gears = product?.gears?.length ?? 0;
  if (gears === 0) return { ...base, state: "todo", status: "No gears picked yet." };
  // Each bound profile with the environments that run it.
  const where = new Map<string, string[]>();
  for (const r of infra?.runsIn ?? []) if (r.profile) where.set(r.profile, [...(where.get(r.profile) ?? []), r.environment]);
  if (where.size === 0) where.set(FALLBACK_PROFILE, []);
  const named = (p: string) => {
    const envs = where.get(p) ?? [];
    return envs.length > 0 ? `${profileLabel(p)} (${envs.join(", ")})` : profileLabel(p);
  };
  const verdicts = [...where.keys()].map((p) => ({ p, v: verdictOf(product, p) }));
  const failed = verdicts.filter(({ v }) => v.state === "failed");
  if (failed.length > 0) {
    return {
      ...base,
      state: "failed",
      status: `${plural(gears, "gear")}; ${failed.map(({ p, v }) => `${named(p)}: ${plural(v.errors, "error")}`).join("; ")} from the engine.`,
    };
  }
  const waiting = verdicts.filter(({ v }) => v.state === "unchecked" || v.state === "stale");
  if (waiting.length > 0) {
    return {
      ...base,
      state: "todo",
      status: `${plural(gears, "gear")}, not checked by the engine yet for ${waiting.map(({ p }) => named(p)).join(", ")}.`,
    };
  }
  return { ...base, state: "done", status: `${plural(gears, "gear")}; resolves for ${[...where.keys()].map(named).join(", ")}.` };
}

function frontendPart(product: ProductFacts, cfg: ProjectConfig | null | undefined): FlowPart {
  const base = { id: "frontend" as const, title: "Frontend" };
  const kept = product?.frontend;
  if (kept) {
    return {
      ...base,
      state: "done",
      status: `${plural(kept.mfes.length, "micro-frontend")} on ${kept.shell.path}.`,
    };
  }
  if (cfg?.frontend && typeof cfg.frontend === "object") {
    return { ...base, state: "todo", status: "Picked before the product kept it: save it to the product in Frontend." };
  }
  return { ...base, state: "none", status: "None: the product is its gears and their APIs. Add one when it needs screens." };
}

/** The Configure step's parts, in the order the page lists its sections. */
export function configureParts(
  product: ProductFacts,
  cfg: ProjectConfig | null | undefined,
  infra: Infrastructure | null,
): FlowPart[] {
  return [infrastructurePart(infra), backendPart(product, infra), frontendPart(product, cfg)];
}

/** The gears, plugins included, a description names (`use_gear("x"`,
 *  `plugin("x"`). */
function describedGears(text: string): Set<string> {
  return new Set([...text.matchAll(/\b(?:use_gear|plugin)\(\s*"([^"]+)"/g)].map((m) => gearKey(m[1])));
}

/** What the configured product has that its saved description does not say:
 *  picked gears it does not name, a frontend it does not have or one it
 *  still has. Empty when the description says the product as configured. */
export function describedGaps(product: ProductFacts, text: string): string[] {
  const gaps: string[] = [];
  const named = describedGears(text);
  const missing = (product?.gears ?? []).filter((g) => !named.has(gearKey(g)));
  if (missing.length > 0) gaps.push(`${plural(missing.length, "picked gear")} not in it`);
  const says = /\bfrontx_product\(/.test(text);
  if (product?.frontend && !says) gaps.push("the frontend");
  if (!product?.frontend && says) gaps.push("a frontend the product no longer has");
  return gaps;
}

function stateOf(hint: PipelineHint | null): FlowState {
  if (!hint) return "unknown";
  return hint.tone === "done" ? "done" : hint.tone === "failed" ? "failed" : "todo";
}

export interface FlowFacts {
  product: ProductFacts;
  cfg: ProjectConfig | null | undefined;
  infra: Infrastructure | null;
  /** The revision Studio keeps; `null` when there is none, `undefined` when
   *  it could not be read. */
  kept: { revision: number; text: string } | null | undefined;
  /** What Releases says of the builds and the deploys, or `null` when unread. */
  build: PipelineHint | null;
  deploy: PipelineHint | null;
}

/** The four steps, each with its state and one line from the data. */
export function productFlow(f: FlowFacts): FlowStep[] {
  const parts = configureParts(f.product, f.cfg, f.infra);
  const configure: FlowStep = {
    id: "configure",
    title: "Configure the product",
    state: parts.some((p) => p.state === "failed")
      ? "failed"
      : parts.some((p) => p.state === "todo")
        ? "todo"
        : parts.some((p) => p.state === "unknown")
          ? "unknown"
          : "done",
    status: parts.map((p) => `${p.title}: ${p.status}`).join(" "),
    parts,
  };

  let save: FlowStep;
  if (f.kept === undefined) {
    save = { id: "save", title: "Save to product.gdl", state: "unknown", status: "Could not read the saved description." };
  } else if (f.kept === null) {
    save = { id: "save", title: "Save to product.gdl", state: "todo", status: "Not saved yet: the build has nothing to take." };
  } else {
    const gaps = describedGaps(f.product, f.kept.text);
    save =
      gaps.length > 0
        ? {
            id: "save",
            title: "Save to product.gdl",
            state: "todo",
            status: `Revision ${f.kept.revision} does not say ${gaps.join(", ")}: save it again.`,
          }
        : { id: "save", title: "Save to product.gdl", state: "done", status: `Revision ${f.kept.revision} says the product.` };
  }

  return [
    configure,
    save,
    { id: "build", title: "Build", state: stateOf(f.build), status: f.build?.text ?? "Could not read the builds.", tab: "releases" },
    { id: "deploy", title: "Deploy", state: stateOf(f.deploy), status: f.deploy?.text ?? "Could not read the deploys.", tab: "releases" },
  ];
}

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

/** A line diff of `before` and `after` (longest common subsequence): what a
 *  save changes in the description. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: the common length of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: "del", text: a[i++] });
    else out.push({ kind: "add", text: b[j++] });
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

/** What a project tab flags in the bar: something failed there, or something
 *  waits for the person. */
export interface TabAttention {
  tone: "failed" | "todo";
  /** How many things: the errors, or the things waiting. */
  count: number;
  text: string;
}

/** Whether the Product tab needs a look, from the record alone: the engine's
 *  errors at the last check, or a frontend picked before the product kept it.
 *  `null`: nothing waits there. */
export function productAttention(
  product: Pick<ProjectProduct, "last_preview" | "frontend"> | null,
  cfg: ProjectConfig | null | undefined,
): TabAttention | null {
  const preview = product?.last_preview;
  if (preview && !preview.ok) {
    return {
      tone: "failed",
      count: Math.max(preview.errors, 1),
      text: `${plural(preview.errors, "error")} from the engine at the last check`,
    };
  }
  if (!product?.frontend && cfg?.frontend && typeof cfg.frontend === "object") {
    return { tone: "todo", count: 1, text: "A frontend picked before the product kept it: save it to the product" };
  }
  return null;
}
