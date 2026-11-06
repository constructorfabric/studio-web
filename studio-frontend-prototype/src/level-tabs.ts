// The tabs a level shows -- organization, workspace, project -- after an
// administrator turned some off. A level keeps the names it hides
// (`hidden_tabs`) in its own settings document: the workspace settings on an
// organization or a workspace, the project config on a project. A project's
// template decides first which of its tabs exist (project-types.ts); what the
// project hides narrows that further. A level never ends up with no tab: when
// everything would go, everything stays. Pure, so it is tested without a server.

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
