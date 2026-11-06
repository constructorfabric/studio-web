// Types for `POST /studio-domain-model/v1/query`, the experimental read over
// domain objects, built on the types generated from the model
// (`domain-model.gen.ts`, `scripts/gen-domain-client.mjs`).
//
// A field or a relation the model does not have fails here, at compile time,
// rather than as the query's 400. The call itself is `api.queryDomain`.

import type { DomainEntities, DomainEntity, DomainRelations } from "./domain-model.gen";

/** What a field the model types as `unknown` may be compared with. */
type Scalar = string | number | boolean;

/** The value an operator compares with: a list field compares its elements. */
type Operand<V> = unknown extends V ? Scalar : V extends readonly (infer I)[] ? I : V;

/**
 * Operators on one field, as the query takes them. A missing field matches no
 * comparison (SQL's reading); `_is_null: true` is how to ask for those.
 * `_contains` is a case-insensitive substring on text, membership on a list.
 */
export interface FieldOps<V> {
  _eq?: Operand<V>;
  _neq?: Operand<V>;
  _gt?: Operand<V>;
  _gte?: Operand<V>;
  _lt?: Operand<V>;
  _lte?: Operand<V>;
  _in?: Operand<V>[];
  _nin?: Operand<V>[];
  _contains?: Operand<V>;
  _is_null?: boolean;
}

/** A field of an entity, or `id`, the object's own id. */
export type DomainField<T extends DomainEntity> = (keyof DomainEntities[T] & string) | "id";

/** A boolean expression over an entity's fields. */
export type Where<T extends DomainEntity> = {
  [K in DomainField<T>]?: FieldOps<K extends keyof DomainEntities[T] ? NonNullable<DomainEntities[T][K]> : string>;
} & {
  _and?: Where<T>[];
  _or?: Where<T>[];
  _not?: Where<T>;
};

/** The entity a relation of `T` reaches. */
type Target<T extends DomainEntity, R extends keyof DomainRelations[T]> =
  DomainRelations[T][R] extends DomainEntity ? DomainRelations[T][R] : never;

/** What to read of one entity: the query's root, or one included relation. */
export interface DomainSelection<T extends DomainEntity> {
  where?: Where<T>;
  /** Rows without the field sort last; ties are broken by id. */
  order_by?: { field: DomainField<T>; direction?: "asc" | "desc" }[];
  /** The payload fields to return; omitted returns the whole payload. */
  fields?: DomainField<T>[];
  /** Relations to follow, by declared name, at most three levels deep. A
   *  leading `~` follows one backwards, from its target to its source
   *  (`~delivers` on a project: the teams that deliver it); the generated
   *  types do not know which entity that is, so its rows are loosely typed. */
  include?: { [R in keyof DomainRelations[T]]?: DomainSelection<Target<T, R>> } & {
    [reverse: `~${string}`]: LooseSelection | undefined;
  };
  /** 1..=200, default 50. Under `include` it is per parent row. */
  limit?: number;
}

/** A selection under a reverse relation: the far end's type is not known here. */
export interface LooseSelection {
  where?: Record<string, unknown>;
  order_by?: { field: string; direction?: "asc" | "desc" }[];
  fields?: string[];
  include?: Record<string, LooseSelection>;
  limit?: number;
}

export interface DomainQuery<T extends DomainEntity> extends DomainSelection<T> {
  type: T;
  /** The project (tenant id) the objects belong to. Root type only; included
   *  relations are narrowed by what the caller may read (ADR-0035). */
  project_id?: string;
  /** Kept while screens move to `cursor`; not with it. */
  offset?: number;
  /** The previous answer's `next_cursor`, under the same `type`, `project_id`,
   *  `where` and `order_by`. */
  cursor?: string;
  /** Counts of the matching objects by up to three fields, answered as `groups`. */
  aggregate?: { group_by: DomainField<T>[] };
}

/** One object, with the relations that were included. */
export interface DomainRow<T extends DomainEntity> {
  id: string;
  /** The object's own entity: `T`, or an entity that extends it. */
  entity: string;
  value: DomainEntities[T];
  relations: { [R in keyof DomainRelations[T]]?: DomainRowSet<Target<T, R>> } & {
    [reverse: `~${string}`]: LooseRowSet | undefined;
  };
}

export interface DomainRowSet<T extends DomainEntity> {
  items: DomainRow<T>[];
  /** Matches before `limit`. */
  total: number;
  /** False when the read behind `total` stopped early. */
  complete: boolean;
}

/** Rows of an entity the types do not know (a reverse relation's source). */
export interface LooseRowSet {
  items: { id: string; entity: string; value: Record<string, unknown>; relations: Record<string, LooseRowSet> }[];
  total: number;
  complete: boolean;
}

export interface DomainQueryResult<T extends DomainEntity> extends DomainRowSet<T> {
  /** Where the answer may be wrong. */
  warnings: string[];
  /** The aggregate's groups, largest first: the grouped values in order, `null` where absent. */
  groups?: { key: unknown[]; count: number }[];
  /** `read_model` once the organization's read model is filled; `graph` before. */
  source: "read_model" | "graph";
  /** Send as `cursor` for the rows after these; absent on the last page. */
  next_cursor?: string;
}

// ── Writing: POST /studio-domain-model/v1/mutate ──────────────────────────

/** Create or replace the object of `type` keyed by `key`. `as` names it for
 *  later operations of the same batch, which refer to it as `$name`. */
export interface DomainUpsert<T extends DomainEntity> {
  op: "upsert";
  type: T;
  key: string;
  value: Partial<DomainEntities[T]>;
  project_id?: string;
  if_absent?: boolean;
  as?: string;
}

/** One change to the model's objects or relations. An `id` is an object's id,
 *  or `$name` for one an earlier upsert of the batch named. */
export type DomainOperation =
  | { [T in DomainEntity]: DomainUpsert<T> }[DomainEntity]
  | { op: "patch"; id: string; set?: Record<string, unknown>; unset?: string[] }
  | { op: "delete"; id: string }
  | { op: "link" | "unlink"; relation: string; from: string; to: string };

export interface DomainMutation {
  operations: DomainOperation[];
  /** How hard payloads are checked; `warn` by default. */
  validate?: "off" | "warn" | "strict";
}

export interface DomainMutationResult {
  /** What each operation did, in order. */
  results: (
    | { op: "upsert" | "patch"; id: string; violations: { field: string; detail: string }[] }
    | { op: "delete"; id: string }
    | { op: "link"; relation: string; verb: string; from: string; to: string }
    | { op: "unlink"; from: string; to: string; removed: boolean }
  )[];
}
