// The tabs of a level -- organization, workspace, project. Two things decide
// them, each in one place:
//
// * Which tabs exist is the domain model's (ADR-0068): every relation of kind
//   `shows` on the level's type is a tab, in the order the type declares them.
//   A tab whose name the portal has a screen for opens that screen; any other
//   opens the objects of the type the relation points at, so a kit can add a
//   tab without the portal knowing it. A project's template narrows its tabs
//   first (project-types.ts).
// * Which of them an administrator turned off is the level's own settings
//   document (`hidden_tabs`): the workspace settings on an organization or a
//   workspace, the project config on a project. A level never ends up with no
//   tab: when everything would go, everything stays.
//
// Pure, so it is tested without a server.

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

/** Every tab a level has, hidden or not: the model's, each on the portal's own
 *  screen when there is one (with the model's label), else a generic one;
 *  without a `shows` relation in the model, the built-in list as it is. */
export function levelTabs<B extends { id: string; icon: string; label: string }>(
  builtIn: readonly B[],
  fromModel: readonly ModelTab[],
): (B | GenericTab)[] {
  if (fromModel.length === 0) return [...builtIn];
  const byId = new Map(builtIn.map((t) => [t.id, t]));
  const out: (B | GenericTab)[] = [];
  for (const m of fromModel) {
    const own = byId.get(m.name);
    if (own) out.push({ ...own, label: m.label || own.label });
    else if (m.target) {
      const generic: GenericTab = { id: `type:${m.name}`, icon: "grid", label: m.label, target: m.target };
      out.push(generic);
    }
  }
  return out;
}

/** The names stored under `hidden_tabs`, whatever the document holds. */
export function parseHiddenTabs(value: unknown): string[] {
  const raw = (value as { hidden_tabs?: unknown } | null | undefined)?.hidden_tabs;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((n): n is string => typeof n === "string" && n !== ""))];
}

/** The tabs a level shows: `tabs` without the hidden ones, in their order --
 *  or all of them, when hiding would leave none. */
export function shownTabs<T extends { id: string }>(tabs: readonly T[], hidden: readonly string[]): T[] {
  const off = new Set(hidden);
  const shown = tabs.filter((t) => !off.has(t.id));
  return shown.length > 0 ? shown : [...tabs];
}

/** What to store: the names among `tabs` that are off, in the tabs' order.
 *  A name the level no longer has is dropped; null when nothing would show. */
export function hiddenToSave(tabs: readonly { id: string }[], off: ReadonlySet<string>): string[] | null {
  const hidden = tabs.filter((t) => off.has(t.id)).map((t) => t.id);
  return hidden.length < tabs.length ? hidden : null;
}

/** The tab to stay on: `active` while it shows, else `fallback` if it shows,
 *  else the first that does. */
export function tabToOpen<Id extends string>(shown: readonly { id: Id }[], active: Id, fallback?: Id): Id {
  if (shown.some((t) => t.id === active)) return active;
  if (fallback !== undefined && shown.some((t) => t.id === fallback)) return fallback;
  return shown[0]?.id ?? active;
}
