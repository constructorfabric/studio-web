/* ── Project fields: what a list of projects can be filtered by ──────────────
 *
 * A shell mechanism. A project carries fields -- the short top-level values
 * of its configuration (`project.config`), which the rollups row brings as
 * `attributes`, and the counts the row has of its own (`repos`). A FIELD here
 * says how to read one of them, what its choices are called and in what
 * order, and optionally how a row shows it (a chip) and where it may move
 * (`moves`, written back into the config).
 *
 * Fields come from two places:
 *
 *   - registered ones, which know what a value means: the template a project
 *     was created from (`templateField`), whether it has a repository
 *     (`reposField`), and those a kit brings -- the project lifecycle
 *     (project-lifecycle.ts) is the first, claiming `status`;
 *   - every other attribute the rows carry, offered as it is stored
 *     (`attributeFields`), so a value a kit writes is filterable before
 *     anybody teaches the portal what it means.
 *
 * Pure, so it is tested without a backend.
 */

import type { Tone } from "./ui-standard";

/** What a field reads of a project: its rollups row's attributes and counts. */
export interface ProjectFacts {
  attributes?: Record<string, unknown> | null;
  repos?: number | null;
}

export interface FieldOption {
  value: string;
  label: string;
  count?: number;
}

/** One way to change a project's field: the words, and what is written into
 *  its config. */
export interface FieldMove {
  label: string;
  patch: Record<string, unknown>;
}

export interface ProjectField {
  /** The filter's id, as it appears in the address (`?f.phase=testing`). */
  id: string;
  /** "Phase". */
  label: string;
  /** The "all" choice: "All phases". */
  allLabel: string;
  /** Attribute keys this field reads, so no generic field repeats them. */
  claims?: string[];
  /** The value a filter compares, `null` when none is set. */
  value: (f: ProjectFacts) => string | null;
  /** The choices in their order, with their words; absent: the values the
   *  rows carry, sorted. */
  choices?: () => FieldOption[];
  /** What "none set" is called; absent: "Not set". */
  noneLabel?: string;
  /** How a row shows it, when it has a column of its own. */
  chip?: (f: ProjectFacts) => { text: string; tone: Tone; title?: string; key: string };
  /** The column's header, when it has one. */
  header?: string;
  /** Where a project may move from what it carries. */
  moves?: (f: ProjectFacts) => FieldMove[];
  /** What a new project's config starts with. */
  initial?: () => Record<string, unknown>;
}

/** The value for "none set" in a filter. */
export const NONE = "none";

/** A project's facts from its rollups row. */
export function factsOf(row: { attributes?: Record<string, unknown> | null; repos?: number | null } | undefined): ProjectFacts | undefined {
  return row ? { attributes: row.attributes ?? null, repos: row.repos ?? null } : undefined;
}

/** A text attribute, trimmed; null when absent or blank. */
export function attributeText(f: ProjectFacts, key: string): string | null {
  const v = f.attributes?.[key];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** Whether `facts` passes `field` set to `value`. A project whose row was not
 *  read passes nothing. */
export function matchField(field: ProjectField, facts: ProjectFacts | undefined, value: string): boolean {
  if (!facts) return false;
  const v = field.value(facts);
  return value === NONE ? v === null : v === value;
}

/** Whether `facts` passes every one of `fields` set in `filters`; any other
 *  key in `filters` (a list's own filter) is not this function's to judge. */
export function matchesFields(
  fields: ProjectField[],
  facts: ProjectFacts | undefined,
  filters: Record<string, string>,
): boolean {
  return fields.every((f) => !filters[f.id] || matchField(f, facts, filters[f.id]));
}

/** Whether any of `fields` is set in `filters`. */
export function anyFieldSet(fields: ProjectField[], filters: Record<string, string>): boolean {
  return fields.some((f) => !!filters[f.id]);
}

/** A field's choices counted over `rows`: its own in their order, then any
 *  value the rows carry that it does not list, then "none" when some row
 *  has none. A choice nobody carries stays offered with a 0. */
export function fieldOptions(field: ProjectField, rows: (ProjectFacts | undefined)[]): FieldOption[] {
  const count = (value: string) => rows.filter((r) => matchField(field, r, value)).length;
  const own = field.choices?.() ?? [];
  const listed = new Set(own.map((o) => o.value));
  const carried = [
    ...new Set(rows.map((r) => (r ? field.value(r) : null)).filter((v): v is string => v !== null && !listed.has(v))),
  ].sort((a, b) => a.localeCompare(b));
  const out: FieldOption[] = [
    ...own.map((o) => ({ ...o, count: count(o.value) })),
    ...carried.map((v) => ({ value: v, label: v, count: count(v) })),
  ];
  const none = count(NONE);
  if (none > 0) out.push({ value: NONE, label: field.noneLabel ?? "Not set", count: none });
  return out;
}

/** Attribute keys never offered as a filter: free text, or the shape of a
 *  value only a screen of its own makes sense of. */
const NOT_FILTERS = new Set(["brief", "source_git_url", "name", "description"]);

/** At most this many distinct values for an attribute to be a filter: past
 *  it, it is an identifier or free text, not a category. */
const MAX_CHOICES = 12;

/** "product_kind" → "Product kind". */
export function words(key: string): string {
  const s = key.replace(/[_.-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

/** A field for every attribute the rows carry that no registered field
 *  claims, has a few distinct values, and is not free text. */
export function attributeFields(registered: ProjectField[], rows: (ProjectFacts | undefined)[]): ProjectField[] {
  const claimed = new Set(registered.flatMap((f) => [f.id, ...(f.claims ?? [])]));
  const values = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r?.attributes ?? {})) {
      if (claimed.has(k) || NOT_FILTERS.has(k) || v === null || v === undefined) continue;
      const set = values.get(k) ?? new Set<string>();
      set.add(String(v));
      values.set(k, set);
    }
  }
  return [...values.entries()]
    .filter(([, vs]) => vs.size > 0 && vs.size <= MAX_CHOICES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key]) => ({
      id: key,
      label: words(key),
      allLabel: `Any ${words(key).toLowerCase()}`,
      claims: [key],
      value: (f: ProjectFacts) => attributeText(f, key),
    }));
}

/** The registered fields, then the generic ones the rows add. */
export function projectFields(registered: ProjectField[], rows: (ProjectFacts | undefined)[]): ProjectField[] {
  return [...registered, ...attributeFields(registered, rows)];
}

/** The template a project was created from (`type`, project-types.ts). */
export function templateField(templates: { key: string; title: string }[]): ProjectField {
  return {
    id: "template",
    label: "Template",
    allLabel: "Any template",
    claims: ["type"],
    noneLabel: "No template",
    value: (f) => attributeText(f, "type"),
    choices: () => templates.map((t) => ({ value: t.key, label: t.title })),
  };
}

/** Whether the project has a repository yet. A count that could not be read
 *  matches neither choice. */
export const reposField: ProjectField = {
  id: "repos",
  label: "Repositories",
  allLabel: "Any repositories",
  noneLabel: "Not counted",
  value: (f) => (f.repos === null || f.repos === undefined ? null : f.repos > 0 ? "with" : "without"),
  choices: () => [
    { value: "with", label: "Has a repository" },
    { value: "without", label: "No repository yet" },
  ],
};

/** A field's choice by its value, in its own words. */
export function choiceLabel(field: ProjectField, value: string | null): string | null {
  if (value === null) return null;
  return field.choices?.().find((c) => c.value === value)?.label ?? value;
}

/** Everything `fields` would start a new project's config with. */
export function initialAttributes(fields: ProjectField[]): Record<string, unknown> {
  return Object.assign({}, ...fields.map((f) => f.initial?.() ?? {}));
}

/** The short top-level values of a config, as the rollups row carries them
 *  (`attributes`): for a server from before it did. */
export function scalarAttributes(config: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!config) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if ((typeof v === "string" && [...v].length <= 120) || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}
