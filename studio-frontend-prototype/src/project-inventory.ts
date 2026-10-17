/* What a project is made of, in one list (project-components-view.tsx): the
 * components it takes from the platform and the organization, its own gears,
 * its own code that could become one, the services that are not gears, and
 * the gears its documents ask for that nobody has written yet. Read from what
 * the Product tab already reads; nothing here is stored. */
import type { Candidate, Conformance, PlanRow, RegistryEntry } from "./api";
import type { ProjectComponent } from "./project-checks";
import { candidateStrength, candidateTier, couldBecomeGear } from "./spec-coverage";

/** Whose a component is, or what it still is. */
export type InventoryRole = "platform" | "organization" | "ours" | "could" | "service" | "create";

export const ROLE_LABEL: Record<InventoryRole, string> = {
  platform: "Platform",
  organization: "Organization",
  ours: "This project",
  could: "Could be a gear",
  service: "Not a gear",
  create: "To create",
};

export interface InventoryRow {
  key: string;
  name: string;
  role: InventoryRole;
  /** `gear`, `tool`, a build tool's kind for a service. */
  kind: string;
  /** The capabilities it answers, or — for one to create — the one it would. */
  answers: string[];
  inProduct: boolean;
  inCode: boolean;
  /** Where it lives, when the project or the organization keeps it. */
  path?: string | null;
  candidate?: Candidate;
  service?: ProjectComponent;
  /** For a gear to create: the capability's row, for the scaffold. */
  need?: PlanRow;
}

/** One gear the project's own code declares. */
export interface OwnGear {
  name: string;
  kind: string;
  path?: string | null;
}

/** The registry states of a gear the code declares (not a candidate a
 *  detector guessed, nor one the organization turned down or folded away). */
const DECLARED = new Set(["declared", "registered", "published", "extracted"]);

/** The project's own gears out of the organization's registry: the entries
 *  declared in this project's repositories, with where. */
export function ownGearsOf(entries: readonly RegistryEntry[], projectId: string): OwnGear[] {
  return entries
    .filter((e) => DECLARED.has(e.state) && (e.kind === "gear" || e.kind === "plugin"))
    .flatMap((e) => {
      const here = e.occurrences.find((o) => o.project_id === projectId && o.declared_in !== "detected");
      return here ? [{ name: e.name, kind: e.kind, path: here.path }] : [];
    });
}

const ORDER: InventoryRole[] = ["ours", "could", "create", "organization", "platform", "service"];

function roleOf(c: Candidate): InventoryRole {
  if (couldBecomeGear(c)) return "could";
  const tier = candidateTier(c);
  return tier === "project" ? "ours" : tier === "organization" ? "organization" : "platform";
}

/** The project's components. A platform or organization component is in it
 *  when the product or the code takes it; one the specs merely offer stays on
 *  the Product tab. The project's own gears and the code that could become one
 *  are in it always; so is a gear to create for every capability `needsGear`
 *  says nothing built answers. */
export function inventory(
  plan: PlanRow[],
  code: Conformance | null,
  picks: string[],
  services: ProjectComponent[],
  needsGear: (row: PlanRow) => boolean,
  /** The gears the project's own code declares, as the organization's
   *  registry found them (a gear.gdl, or the toolkit's attribute): in it
   *  whether or not a capability offered them, and in its code by definition. */
  own: readonly OwnGear[] = [],
): InventoryRow[] {
  const inCode = new Set(code?.components_in_code ?? []);
  const inProduct = new Set(picks);
  const rows = new Map<string, InventoryRow>();
  for (const need of plan) {
    for (const c of need.candidates) {
      const role = roleOf(c);
      const taken = inProduct.has(c.name) || inCode.has(c.name);
      if (!taken && role !== "ours" && role !== "could") continue;
      const row = rows.get(c.name) ?? {
        key: c.name,
        name: c.name,
        role,
        kind: c.kind,
        answers: [],
        inProduct: inProduct.has(c.name),
        inCode: inCode.has(c.name),
        path: c.path,
        candidate: c,
      };
      // Only what it is known to do: a gear that merely mentions the words
      // answers nothing yet.
      if (candidateStrength(c) === "strong" && !row.answers.includes(need.capability)) row.answers.push(need.capability);
      rows.set(c.name, row);
    }
  }
  // The project's own, though no capability offered them: a project made of
  // forty gears showed the six its documents happened to name.
  for (const g of own) {
    const row = rows.get(g.name);
    if (row) {
      if (row.role === "ours") row.inCode = true;
      continue;
    }
    rows.set(g.name, {
      key: g.name,
      name: g.name,
      role: "ours",
      kind: g.kind,
      answers: [],
      inProduct: inProduct.has(g.name),
      inCode: true,
      path: g.path ?? null,
    });
  }
  // Taken, though no capability offered it.
  for (const name of [...inProduct, ...inCode]) {
    if (!rows.has(name))
      rows.set(name, { key: name, name, role: "platform", kind: "gear", answers: [], inProduct: inProduct.has(name), inCode: inCode.has(name) });
  }
  for (const need of plan.filter(needsGear)) {
    rows.set(`create:${need.capability}`, {
      key: `create:${need.capability}`,
      name: `A gear for ${need.label ?? need.capability}`,
      role: "create",
      kind: "gear",
      answers: [need.capability],
      inProduct: false,
      inCode: false,
      need,
    });
  }
  for (const s of services) {
    rows.set(`service:${s.repo}/${s.dir}`, {
      key: `service:${s.repo}/${s.dir}`,
      name: s.name,
      role: "service",
      kind: s.kind,
      answers: [],
      inProduct: false,
      inCode: true,
      path: `${s.repo}/${s.dir}`,
      service: s,
    });
  }
  return [...rows.values()].sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role) || a.name.localeCompare(b.name));
}
