// Saved views: a screen that is data, not code.
//
// A view is an object of the domain model's own `view` entity. Its `query` is
// exactly the body of `POST /studio-domain-model/v1/query`, and its
// `presentation` is what the editor needs to reopen it. So a new list of the
// model's objects is something a person writes, and neither the portal nor the
// backend changes for it. That is the point of this screen
// (docs/domain-query-migration.md, step 6).
//
// This file is the part with no React: the shape of a view, what it compiles
// to, and how it is stored. `views.tsx` is the screen.

import {
  DOMAIN_BUCKETS,
  DOMAIN_FIELDS,
  DOMAIN_RELATION_TARGETS,
  type DomainEntity,
  type DomainFieldKind,
} from "./domain-model.gen";
import type { RawEdge, RawObj } from "./domain-model-graph";
import { currentModel, fieldsOfModel, relationsOfModel, type DomainModel } from "./domain-runtime";

/** One condition, as the editor holds it. Conditions are ANDed. */
export interface ViewCondition {
  field: string;
  op: ViewOp;
  /** As typed. Coerced by the field's kind when the query is built. */
  value: string;
}

export type ViewOp = "_eq" | "_neq" | "_contains" | "_gt" | "_lt" | "_is_null" | "_not_null";

export const VIEW_OPS: { op: ViewOp; label: string }[] = [
  { op: "_eq", label: "is" },
  { op: "_neq", label: "is not" },
  { op: "_contains", label: "contains" },
  { op: "_gt", label: "after / above" },
  { op: "_lt", label: "before / below" },
  { op: "_is_null", label: "is empty" },
  { op: "_not_null", label: "is set" },
];

/** A view as the screen works with it. */
export interface ViewSpec {
  /** Stable: the object's key, so saving again updates rather than duplicates. */
  id: string;
  name: string;
  type: DomainEntity;
  columns: string[];
  conditions: ViewCondition[];
  /** Relations shown as columns of the related objects' names. */
  relations: string[];
  sort: { field: string; direction: "asc" | "desc" } | null;
  /** A table of the objects, or a graph of them and their related objects. */
  kind: ViewKind;
}

export type ViewKind = "table" | "graph";

/** A query as sent: the generated types are too precise to hold a view whose
 *  type is only known at runtime, so the screen speaks this looser shape. */
export interface LooseQuery {
  type: string;
  where?: Record<string, unknown>;
  order_by?: { field: string; direction?: "asc" | "desc" }[];
  fields?: string[];
  include?: Record<string, LooseSelection>;
  limit?: number;
  offset?: number;
  cursor?: string;
  project_id?: string;
}

export interface LooseSelection {
  where?: Record<string, unknown>;
  order_by?: { field: string; direction?: "asc" | "desc" }[];
  fields?: string[];
  include?: Record<string, LooseSelection>;
  limit?: number;
}

export interface LooseRow {
  id: string;
  entity: string;
  value: Record<string, unknown>;
  relations: Record<string, { items: LooseRow[]; total: number; complete: boolean } | undefined>;
}

export interface LooseResult {
  items: LooseRow[];
  total: number;
  complete: boolean;
  warnings: string[];
  /** `read_model` once the organization's read model answers, `graph` before. */
  source?: "read_model" | "graph";
  /** Where the next page starts; absent on the last one. */
  next_cursor?: string;
}

/** Where each page of a query starts, as the page before it said. The table
 *  pages by number; the server pages by cursor (the platform's only way), so a
 *  page that follows one already read is asked by cursor, and only a jump to a
 *  page nobody has read yet goes by offset. */
export class PageCursors {
  private readonly starts = new Map<string, Map<number, string>>();

  private static key(q: LooseQuery): string {
    return JSON.stringify({ ...q, offset: undefined, limit: undefined, cursor: undefined });
  }

  /** `q` as sent: by cursor when its offset is a known page start. */
  place(q: LooseQuery): LooseQuery {
    const at = q.offset ?? 0;
    const cursor = at > 0 ? this.starts.get(PageCursors.key(q))?.get(at) : undefined;
    if (!cursor) return q;
    const out: LooseQuery = { ...q, cursor };
    delete out.offset;
    return out;
  }

  /** What a page of `q` (as built, with its offset) said about the next one. */
  note(q: LooseQuery, rows: number, next: string | undefined): void {
    if (!next) return;
    const key = PageCursors.key(q);
    const starts = this.starts.get(key) ?? new Map<number, string>();
    starts.set((q.offset ?? 0) + rows, next);
    this.starts.set(key, starts);
  }
}

/** Per loaded model, what has been derived from it: a new model (an edit
 *  reloaded it) starts empty. */
const derived = new WeakMap<DomainModel, Map<string, unknown>>();
function memo<T>(key: string, make: (m: DomainModel) => T): T {
  const m = currentModel();
  let cache = derived.get(m);
  if (!cache) derived.set(m, (cache = new Map()));
  if (!cache.has(key)) cache.set(key, make(m));
  return cache.get(key) as T;
}

/** Is `type` in the model? The live one once loaded, the build's seed before. */
export function isModelType(type: string): type is DomainEntity {
  const m = currentModel();
  return m.source === "server" ? m.byId.has(type) : type in DOMAIN_FIELDS;
}

/** The fields of an entity and their kinds, from the live model when it has
 *  loaded: a field an administrator adds shows up without a release. */
export function fieldsOf(type: DomainEntity): { readonly [field: string]: DomainFieldKind } {
  return memo(`fields:${type}`, (m) =>
    m.source === "server"
      ? Object.fromEntries(fieldsOfModel(m, type).map((f) => [f.name, f.kind]))
      : (DOMAIN_FIELDS[type] ?? {}),
  );
}

/** The entity's own relations (forwards), live model first. */
function forwardOf(type: DomainEntity): { readonly [relation: string]: DomainEntity } {
  return memo(`forward:${type}`, (m) =>
    m.source === "server"
      ? (relationsOfModel(m, type) as { [relation: string]: DomainEntity })
      : (DOMAIN_RELATION_TARGETS[type] ?? {}),
  );
}

/** The relations of an entity and the entity each reaches: its own, and
 *  backwards those other entities declare towards it, as `~source.relation`
 *  (the query follows those from their target, ADR-0051). */
export function relationsOf(type: DomainEntity): { readonly [relation: string]: DomainEntity } {
  return { ...forwardOf(type), ...reverseRelationsOf(type) };
}

/** How a relation reads in a column header or a picker: `delivers → project`
 *  forwards, and from the other end `team · delivers this`, which says who
 *  points here instead of spelling the query's `~team.delivers`. */
export function relationLabel(name: string, target: DomainEntity | undefined): string {
  const words = (s: string) => s.replace(/_\d+$/, "").replace(/_/g, " ");
  if (name.startsWith("~")) {
    const dot = name.indexOf(".");
    const relation = dot >= 0 ? name.slice(dot + 1) : name.slice(1);
    return `${target ?? name.slice(1, dot)} · ${words(relation)} this`;
  }
  return `${words(name)} → ${target ?? "?"}`;
}

/** The relations other entities declare towards `type`, each named for the
 *  query's reverse include and mapped to the entity it reaches back to. */
export function reverseRelationsOf(type: DomainEntity): { readonly [relation: string]: DomainEntity } {
  return memo(`reverse:${type}`, (m) => {
    const sources = (m.source === "server" ? m.entities.map((e) => e.id) : Object.keys(DOMAIN_RELATION_TARGETS)) as DomainEntity[];
    const out: { [relation: string]: DomainEntity } = {};
    for (const source of sources) {
      for (const [relation, target] of Object.entries(forwardOf(source))) {
        if (target === type) out[`~${source}.${relation}`] = source;
      }
    }
    return out;
  });
}

/** The field that names an object of `type`: `name`, else `title`, else its id. */
export function labelField(type: DomainEntity): string {
  const f = fieldsOf(type);
  if ("name" in f) return "name";
  if ("title" in f) return "title";
  return "id";
}

/** A new view of `type`, with its label field as the one column. */
export function blankView(type: DomainEntity, id: string): ViewSpec {
  return { id, name: "", type, columns: [labelField(type)], conditions: [], relations: [], sort: null, kind: "table" };
}

/** What is wrong with a view, in the words the editor shows. Empty when it can be saved. */
export function problems(spec: ViewSpec): string[] {
  const out: string[] = [];
  const fields = fieldsOf(spec.type);
  const rels = relationsOf(spec.type);
  if (!spec.name.trim()) out.push("Give the view a name.");
  if (spec.columns.length === 0 && spec.relations.length === 0) out.push("Pick at least one column.");
  for (const c of spec.columns) if (!(c in fields)) out.push(`\`${c}\` is not a field of ${spec.type}.`);
  for (const r of spec.relations) if (!(r in rels)) out.push(`\`${r}\` is not a relation of ${spec.type}.`);
  for (const c of spec.conditions) {
    if (!(c.field in fields) && c.field !== "id") out.push(`\`${c.field}\` is not a field of ${spec.type}.`);
    const needsValue = c.op !== "_is_null" && c.op !== "_not_null";
    if (needsValue && !c.value.trim()) out.push(`Give \`${c.field}\` a value.`);
    if (needsValue && fieldsOf(spec.type)[c.field]?.kind === "number" && Number.isNaN(Number(c.value))) {
      out.push(`\`${c.field}\` takes a number.`);
    }
  }
  return out;
}

/** A typed value as the field's kind wants it compared. */
function coerce(kind: DomainFieldKind | undefined, raw: string): unknown {
  const v = raw.trim();
  if (kind?.kind === "number") return Number(v);
  if (kind?.kind === "boolean") return v === "true";
  return v;
}

/** The conditions as a `where`, or nothing when there are none. */
export function toWhere(spec: ViewSpec): Record<string, unknown> | undefined {
  const fields = fieldsOf(spec.type);
  const parts = spec.conditions.map((c) => {
    switch (c.op) {
      case "_is_null":
        return { [c.field]: { _is_null: true } };
      case "_not_null":
        return { [c.field]: { _is_null: false } };
      default:
        return { [c.field]: { [c.op]: coerce(fields[c.field], c.value) } };
    }
  });
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : { _and: parts };
}

/** The view's query: the body `POST /query` takes, without paging. */
export function toQuery(spec: ViewSpec): LooseQuery {
  const rels = relationsOf(spec.type);
  const include: Record<string, LooseSelection> = {};
  for (const r of spec.relations) {
    const target = rels[r];
    if (!target) continue;
    const label = labelField(target);
    include[r] = { fields: [label], order_by: [{ field: label }], limit: 5 };
  }
  const q: LooseQuery = { type: spec.type, fields: spec.columns };
  const where = toWhere(spec);
  if (where) q.where = where;
  if (spec.sort) q.order_by = [{ field: spec.sort.field, direction: spec.sort.direction }];
  if (spec.relations.length) q.include = include;
  return q;
}

/** One page of the view: its query, the reader's sort and search, and the page. */
export function pageQuery(
  spec: ViewSpec,
  page: { q: string; sort: { key: string; dir: "asc" | "desc" } | null; offset: number; limit: number },
): LooseQuery {
  const q = toQuery(spec);
  if (page.sort && page.sort.key in fieldsOf(spec.type)) {
    q.order_by = [{ field: page.sort.key, direction: page.sort.dir }];
  }
  const term = page.q.trim();
  if (term) {
    const f = fieldsOf(spec.type);
    const searchable = ["name", "title", "description"].filter((k) => k in f);
    if (searchable.length) {
      const search = { _or: searchable.map((k) => ({ [k]: { _contains: term } })) };
      q.where = q.where ? { _and: [q.where, search] } : search;
    }
  }
  q.offset = page.offset;
  q.limit = page.limit;
  return q;
}

/** What the `view` object stores. `query` is the compiled query, so any reader
 *  of the model can run the view without this screen. */
export function toViewObject(spec: ViewSpec): Record<string, unknown> {
  return {
    id: spec.id,
    name: spec.name.trim(),
    // The model's own vocabulary: `object` is a list, `graph` a graph.
    view_kind: spec.kind === "graph" ? "graph" : "object",
    query: toQuery(spec),
    presentation: {
      columns: spec.columns,
      relations: spec.relations,
      conditions: spec.conditions,
      sort: spec.sort,
      kind: spec.kind,
    },
  };
}

/** A stored `view` back as a spec, or `null` for one this screen did not write. */
export function fromViewObject(value: Record<string, unknown>): ViewSpec | null {
  const query = value.query as LooseQuery | undefined;
  const p = value.presentation as Partial<ViewSpec> | undefined;
  const type = query?.type as DomainEntity | undefined;
  if (!type || !isModelType(type) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : "",
    type,
    columns: Array.isArray(p?.columns) ? p.columns : (query?.fields ?? []),
    conditions: Array.isArray(p?.conditions) ? p.conditions : [],
    relations: Array.isArray(p?.relations) ? p.relations : Object.keys(query?.include ?? {}),
    sort: p?.sort ?? null,
    kind: p?.kind === "graph" || value.view_kind === "graph" ? "graph" : "table",
  };
}

/** The query that lists the saved views: live ones (no `valid_to`), by name. */
export const LIST_VIEWS: LooseQuery = {
  type: "view",
  where: { valid_to: { _is_null: true } },
  fields: ["id", "name", "query", "presentation"],
  order_by: [{ field: "name" }],
  limit: 200,
};

/** How a cell shows a value of any kind. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.map(cellText).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** How many objects a graph view draws, and how many of each one's related
 *  objects: a graph past a few hundred nodes is a hairball, not an answer. */
export const GRAPH_LIMIT = 150;
export const GRAPH_RELATED_LIMIT = 20;

/** The view's query for a graph: the first objects and more of their relations. */
export function graphQuery(spec: ViewSpec): LooseQuery {
  const q = toQuery(spec);
  q.limit = GRAPH_LIMIT;
  for (const sel of Object.values(q.include ?? {})) sel.limit = GRAPH_RELATED_LIMIT;
  return q;
}

/** A query's answer as the graph draws it: each object a node, each included
 *  relation an edge from the object to the one it reaches. An object reached
 *  twice is one node. */
export function toGraph(spec: ViewSpec, res: LooseResult): { nodes: RawObj[]; edges: RawEdge[] } {
  const nodes = new Map<string, RawObj>();
  const edges: RawEdge[] = [];
  const add = (r: LooseRow) => {
    if (nodes.has(r.id)) return;
    const entity = r.entity as DomainEntity;
    const label = isModelType(entity) ? labelField(entity) : "name";
    nodes.set(r.id, {
      instance_id: r.id,
      entity: r.entity,
      bucket: DOMAIN_BUCKETS[entity] ?? "",
      name: cellText(r.value[label] ?? r.id),
      value: r.value,
    });
  };
  for (const r of res.items) {
    add(r);
    for (const name of spec.relations) {
      for (const child of r.relations[name]?.items ?? []) {
        add(child);
        edges.push({ type_id: name, from: r.id, to: child.id, payload: { relation: name } });
      }
    }
  }
  return { nodes: [...nodes.values()], edges };
}
