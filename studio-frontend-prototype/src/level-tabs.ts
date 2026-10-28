// The tabs of a level — organization, workspace, project — read from the
// domain model: every relation of kind `shows` on the level's type is a tab,
// in the order the type declares them. A tab whose name the portal has a
// screen for opens that screen; any other opens the objects of the type the
// relation points at. An administrator turns tabs off per level
// (`hidden_tabs`); the relation stays in the model. Pure, so it is tested
// without a server.

import type { DomainModel } from "./domain-runtime";

/** The relation kind that makes a tab. */
export const SHOWS = "shows";

/** A tab the model names that no screen of the portal answers. */
export interface GenericTab {
  id: `type:${string}`;
  icon: string;
  label: string;
  /** The type whose objects it lists. */
  target: string;
}

export interface ModelTab {
  /** The relation's name: a built-in tab's id, or a new tab's. */
  name: string;
  label: string;
  target: string;
}

/** The `shows` relations of `level`'s type, in its order. */
export function modelTabs(model: DomainModel, level: string): ModelTab[] {
  return (model.byId.get(level)?.properties ?? [])
    .filter((p) => p.relationType === SHOWS && p.name)
    .map((p) => ({
      name: p.name,
      label: p.relationLabel || p.name,
      target: String((p as { relation?: string }).relation ?? p.type ?? ""),
    }));
}

export function isGeneric(id: string): id is GenericTab["id"] {
  return id.startsWith("type:");
}

/** The tabs a level shows: the model's, each on the portal's own screen when
 *  there is one (with the model's label), else a generic one; without a
 *  `shows` relation in the model, the built-in list as it is. Hidden names go. */
export function levelTabs<B extends { id: string; icon: string; label: string }>(
  builtIn: readonly B[],
  fromModel: readonly ModelTab[],
  hidden: readonly string[] = [],
): (B | GenericTab)[] {
  const off = new Set(hidden);
  if (fromModel.length === 0) return builtIn.filter((t) => !off.has(t.id));
  const byId = new Map(builtIn.map((t) => [t.id, t]));
  const out: (B | GenericTab)[] = [];
  for (const m of fromModel) {
    if (off.has(m.name)) continue;
    const own = byId.get(m.name);
    if (own) out.push({ ...own, label: m.label || own.label });
    else if (m.target) {
      const generic: GenericTab = { id: `type:${m.name}`, icon: "grid", label: m.label, target: m.target };
      out.push(generic);
    }
  }
  return out;
}

/** Every tab a level could show, hidden or not: what the settings list. */
export function allLevelTabs<B extends { id: string; icon: string; label: string }>(
  builtIn: readonly B[],
  fromModel: readonly ModelTab[],
): { name: string; label: string }[] {
  if (fromModel.length === 0) return builtIn.map((t) => ({ name: t.id, label: t.label }));
  return fromModel.map((m) => ({ name: m.name, label: m.label }));
}
