// The domain model as the server holds it now, not as it was when the portal
// was built.
//
// `domain-model.gen.ts` is generated from the seed model at build time, which
// is right for types a developer writes against and wrong for a screen that
// shows what an organization has made of its model: a field an administrator
// adds in Administration › Domain model has to appear on the project screen
// without a release. So screens that show a model-defined object read the
// model from `GET /studio-domain-model/v1/types` through here, and fall back
// to the generated tables until it has loaded.
//
// The walk over `extends` and the field kinds are the generator's
// (`scripts/gen-domain-client.mjs`), so a field reads the same either way.

import { useEffect, useState } from "react";

import { api, currentRequestOrganization } from "./api";
import { DOMAIN_ENTITIES, DOMAIN_FIELDS, DOMAIN_RELATION_TARGETS, type DomainFieldKind } from "./domain-model.gen";

/** One property of an entity as the model document has it. */
export interface ModelProperty {
  name: string;
  type?: string;
  description?: string;
  required?: boolean;
  extends?: string;
  relationType?: string;
  relationLabel?: string;
  /** The gear that writes this field (ADR-0051 §8a): not to be renamed,
   *  retyped or dropped, nor set from a screen. */
  held_by?: string;
}

/** One entity as the model document has it. */
export interface ModelEntity {
  id: string;
  name?: string;
  description?: string;
  bucket?: string;
  extends?: string | null;
  abstract?: boolean;
  properties?: ModelProperty[];
  /** `held_by`: the gear whose records this type's objects are; `origin`
   *  (`upload`, `organization`, `studio`) and `upload`: where it came from. */
  meta?: { held_by?: string; origin?: string; upload?: string } | null;
}

/** A payload field of an entity, own or inherited, with what a screen needs to edit it. */
export interface ModelField {
  name: string;
  /** The declared type expression (`string`, `planned | active`, `timestamp?`). */
  type: string;
  kind: DomainFieldKind;
  required: boolean;
  description: string;
  /** The entity that declares it: this one, or a base. */
  declaredBy: string;
  /** The gear that writes it, when one does. */
  heldBy?: string;
}

export interface DomainModel {
  entities: ModelEntity[];
  byId: Map<string, ModelEntity>;
  buckets: { id: string; name: string }[];
  /** Whether the caller may change the model (`domain.model`, ADR-0035). */
  canEdit: boolean;
  /** Studio's own types: what every organization starts with. */
  studioTypes: Set<string>;
  /** Where it came from: the server, or the build's seed while that loads. */
  source: "server" | "seed";
  /** The GTS ids the server registers each type and relation kind under;
   *  empty for the seed. */
  gts: GtsCatalog;
}

/** One GTS id: ours, and the one graph-storage keeps with its family. */
export interface GtsId {
  type: string;
  stored_as: string;
}

export interface GtsCatalog {
  types: Record<string, GtsId>;
  relations: Record<string, GtsId>;
}

const isRelation = (p: ModelProperty) => p.extends === "edge" || p.extends === "link";
const normalize = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** A type expression's kind: the generator's `fieldKind`, at runtime. */
export function kindOf(expr: string | undefined): DomainFieldKind {
  let t = String(expr ?? "").trim().replace(/\?$/, "").trim();
  if (t.endsWith("[]")) return { kind: "list" };
  if (t.includes("|")) {
    const parts = t.split("|").map((s) => s.trim());
    if (parts.every((s) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(s) && /^[a-z]/.test(s))) {
      return { kind: "enum", values: parts };
    }
    return { kind: "unknown" };
  }
  t = t.toLowerCase();
  if (/^(string|text|url|uri|hash|sha|textcontent|email)$/.test(t)) return { kind: "string" };
  if (/^timestamp|date-?time|date$/.test(t)) return { kind: "string" };
  if (/^(integer|int|number|decimal|float)$/.test(t) || /^\d+\.\.\d+$/.test(t)) return { kind: "number" };
  if (/^bool(ean)?$/.test(t)) return { kind: "boolean" };
  if (/(id|ref)$/.test(t)) return { kind: "string" };
  return { kind: "unknown" };
}

function build(
  entities: ModelEntity[],
  buckets: { id: string; name: string }[],
  canEdit: boolean,
  source: DomainModel["source"],
  studioTypes: string[] = [],
  gts: GtsCatalog = { types: {}, relations: {} },
): DomainModel {
  return { entities, byId: new Map(entities.map((e) => [e.id, e])), buckets, canEdit, source, studioTypes: new Set(studioTypes), gts };
}

/** The entity and every base it extends, nearest first; stops on a cycle. */
export function ancestorsOf(model: DomainModel, id: string): string[] {
  const chain = [id];
  for (let at = id; ; ) {
    const base = model.byId.get(at)?.extends;
    if (!base || !model.byId.has(base) || chain.includes(base)) return chain;
    chain.push(base);
    at = base;
  }
}

/** Own and inherited payload fields, root first, nearest declaration wins. */
export function fieldsOfModel(model: DomainModel, id: string): ModelField[] {
  const out: ModelField[] = [];
  for (const a of ancestorsOf(model, id).reverse()) {
    for (const p of model.byId.get(a)?.properties ?? []) {
      if (isRelation(p) || !p.name) continue;
      const field: ModelField = {
        name: p.name,
        type: p.type ?? "",
        kind: kindOf(p.type),
        required: !!p.required,
        description: p.description ?? "",
        declaredBy: a,
        heldBy: p.held_by,
      };
      const at = out.findIndex((x) => x.name === p.name);
      if (at >= 0) out[at] = field;
      else out.push(field);
    }
  }
  return out;
}

/** The gear whose records a type's objects are, when one keeps them. */
export function heldByOf(model: DomainModel, id: string): string | undefined {
  return model.byId.get(id)?.meta?.held_by || undefined;
}

/** The fields a person may fill in on an object of `id`: for a type a gear
 *  keeps, those added beside the gear's own on the type itself; otherwise
 *  every field. Never the model's system fields. */
export function openFieldsOf(model: DomainModel, id: string, systemBucket = "system-primitives"): ModelField[] {
  const system = new Set(model.entities.filter((e) => e.bucket === systemBucket).map((e) => e.id));
  const fields = fieldsOfModel(model, id).filter((f) => !system.has(f.declaredBy) && f.name !== "id");
  if (!heldByOf(model, id)) return fields;
  return fields.filter((f) => f.declaredBy === id && !f.heldBy);
}

/** The entity a relation property points at, by its name or id. */
function targetOf(model: DomainModel, type: string | undefined): string | null {
  const t = normalize(type);
  if (!t) return null;
  return model.entities.find((e) => normalize(e.name) === t || normalize(e.id) === t)?.id ?? null;
}

/** The relations `include` follows from `id`, by name, and the entity each reaches. */
export function relationsOfModel(model: DomainModel, id: string): Record<string, string> {
  const chain = new Set(ancestorsOf(model, id));
  const found: Record<string, string> = {};
  const ambiguous = new Set<string>();
  for (const e of model.entities) {
    if (!chain.has(e.id)) continue;
    for (const p of e.properties ?? []) {
      if (!isRelation(p) || !p.name) continue;
      const target = targetOf(model, p.type);
      if (!target) continue;
      if (p.name in found && found[p.name] !== target) ambiguous.add(p.name);
      else found[p.name] = target;
    }
  }
  for (const a of ambiguous) delete found[a];
  return found;
}

/** The seed the portal was built with: what screens show until the server answers. */
function seed(): DomainModel {
  const entities: ModelEntity[] = DOMAIN_ENTITIES.map((id) => ({
    id,
    properties: [
      ...Object.entries(DOMAIN_FIELDS[id]).map(([name, k]) => ({
        name,
        type: k.kind === "enum" ? k.values.join(" | ") : k.kind,
      })),
      ...Object.entries(DOMAIN_RELATION_TARGETS[id]).map(([name, target]) => ({
        name,
        type: target,
        extends: "edge",
      })),
    ],
  }));
  return build(entities, [], false, "seed");
}

let current: DomainModel = seed();
let loading: Promise<DomainModel> | null = null;
/** The organization the load in flight is for: a model is an organization's,
 *  and one asked for another must not stand in for it. */
let loadingFor: string | undefined;
/** The organization the model on hand is. */
let loadedFor: string | undefined;
const listeners = new Set<(m: DomainModel) => void>();

/** The model as last loaded; the build's seed before the first load. */
export function currentModel(): DomainModel {
  return current;
}

/** Read the model from the server, once per call to [`reloadDomainModel`]. */
export function loadDomainModel(token: string): Promise<DomainModel> {
  if (current.source === "server" && loadedFor === currentRequestOrganization()) return Promise.resolve(current);
  return reloadDomainModel(token);
}

/** Read the model again — after an edit — and tell every screen showing it. */
export function reloadDomainModel(token: string): Promise<DomainModel> {
  const org = currentRequestOrganization();
  if (loading && loadingFor === org) return loading;
  loadingFor = org;
  const mine = api
    .domainModelTypes(token)
    .then((res) => {
      // A later load for another organization is the one that counts.
      if (loadingFor !== org) return current;
      loadedFor = org;
      const doc = res.ontology as { entities?: ModelEntity[]; buckets?: { id: string; name?: string }[] };
      current = build(
        doc.entities ?? [],
        (doc.buckets ?? []).map((b) => ({ id: b.id, name: b.name ?? b.id })),
        res.can_edit_model,
        "server",
        (doc.entities ?? []).filter((e) => e.meta?.origin === "studio").map((e) => e.id),
        res.gts,
      );
      for (const l of listeners) l(current);
      return current;
    })
    .finally(() => {
      if (loading === mine) loading = null;
    });
  loading = mine;
  return mine;
}

/** The live model for a component, re-rendered when an edit reloads it. */
export function useDomainModel(token: string): DomainModel {
  const [model, setModel] = useState<DomainModel>(current);
  useEffect(() => {
    listeners.add(setModel);
    void loadDomainModel(token).then(setModel).catch(() => undefined);
    return () => {
      listeners.delete(setModel);
    };
  }, [token]);
  return model;
}

/** The model as loaded, re-rendered on every reload, for a component that does
 *  not load it itself (its screen does, with [`useDomainModel`]). */
export function useCurrentModel(): DomainModel {
  const [model, setModel] = useState<DomainModel>(current);
  useEffect(() => {
    listeners.add(setModel);
    setModel(current);
    return () => {
      listeners.delete(setModel);
    };
  }, []);
  return model;
}
