//! REST surface for the domain model.
//!
//! Five operations cover the three goals:
//!   * `GET  /types`               — the stored ontology (frontend regen source).
//!   * `POST /objects`             — create an object of a domain type.
//!   * `GET  /objects`             — read objects back.
//!   * `POST /relations`           — relate two objects.
//!   * `POST /types/{id}/fields`   — extend a type with a new field.

use std::sync::Arc;

use axum::extract::{Path, Query};
use axum::{Extension, Router};
use serde_json::Value;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;

use super::ontology::FieldSpec;
use super::service::{DomainModelService, WriteOptions};
use super::validate::ValidateMode;

/// Errors attributable to a domain-model resource (e.g. an unknown type).
#[resource_error(gts_id!("cf.studio._.domain_model.v1~"))]
pub struct StudioDomainModelError;

/// Service handle carried in the router.
#[derive(Clone)]
pub struct Handle(pub Arc<DomainModelService>);

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

// ── DTOs ──────────────────────────────────────────────────────────────────

/// The stored ontology — every domain type with its fields and relations.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct TypesResponse {
    /// The domain-entity document, the shape the model UI renders from.
    #[schema(value_type = Object)]
    pub ontology: Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CreateObjectRequest {
    /// The type to instantiate: an ontology id (`role-assignment`), a node type
    /// id (`gts.cf.studio.domain.role_assignment.v1~`) or its leaf.
    #[serde(rename = "type")]
    pub type_ref: String,
    /// A caller-chosen stable key; the same `(type, key, scope)` upserts.
    pub key: String,
    /// Optional workspace/project scope. The same key in different scopes is
    /// different objects; omitted = unscoped (tenant-wide).
    #[serde(default)]
    pub scope: Option<String>,
    /// How hard to check the payload against the type: `off`, `warn` (the
    /// default) or `strict`. The report comes back either way; `strict` also
    /// refuses the write. `warn` is the default because the model declares
    /// fields the graph supplies rather than the caller, and 560 required
    /// fields across the model would otherwise refuse nearly every object.
    #[serde(default)]
    pub validate: Option<String>,
    /// Refuse the write if the object already exists, instead of replacing it.
    /// The only conditional write the graph can express: it takes an expected
    /// version on write but reports none on read, so an `if_version` for a
    /// read-then-update has nothing to pass back (`docs/gears-rust-issues.md`
    /// §5). Default false — the historical upsert.
    #[serde(default)]
    pub if_absent: bool,
    /// The object payload. A `name` field, if present, is used as the node's
    /// display name.
    #[schema(value_type = Object)]
    pub value: Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CreateObjectResponse {
    /// Whether the write was conditional on the object not already existing.
    pub if_absent: bool,
    /// The mode the payload was checked in.
    pub validate: String,
    /// Where the payload disagrees with the type — empty when it fits. Reported
    /// in `warn` too, where the write went ahead anyway.
    pub violations: Vec<ViolationDto>,
    /// Fields the payload carries that the type does not declare. Legal — the
    /// payload is open — and worth seeing: it is the model falling behind what
    /// is actually stored.
    pub undeclared: Vec<String>,
    pub type_id: String,
    pub instance_id: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ViolationDto {
    /// The field, empty when the payload itself is at fault.
    pub field: String,
    /// `missing` | `type` | `enum`.
    pub kind: String,
    pub detail: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct EffectivePropertyDto {
    pub name: String,
    /// The declared type expression, verbatim.
    #[serde(rename = "type")]
    pub type_expr: String,
    pub required: bool,
    pub description: String,
    /// The entity that declares it — the type itself, or the base it comes
    /// from.
    pub declared_by: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct EffectiveTypeResponse {
    pub id: String,
    pub name: String,
    pub description: String,
    pub bucket: String,
    /// The type and every base it extends, nearest first.
    pub ancestors: Vec<String>,
    /// Every field the type has, own and inherited, base-first.
    pub properties: Vec<EffectivePropertyDto>,
    /// Relations declared on the type or on any of its bases.
    pub relations: Vec<DeclaredRelationDto>,
}

#[derive(Debug, serde::Deserialize)]
pub struct ObjectsQuery {
    /// Filter to one type (ontology id, node type id or leaf). Omitted = every
    /// domain type.
    #[serde(default)]
    pub r#type: Option<String>,
    /// Filter to one workspace/project scope. Omitted = every scope.
    #[serde(default)]
    pub scope: Option<String>,
}

/// One stored object.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ObjectDto {
    pub type_id: String,
    pub instance_id: String,
    #[schema(value_type = Object)]
    pub value: Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ObjectListResponse {
    pub objects: Vec<ObjectDto>,
    pub total: u32,
}

/// One relation as registered, with its endpoint typing.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RelationDto {
    /// Relation verb: `member`, `owns`, `references` or `composes`.
    pub relation: String,
    /// GTS edge type id.
    pub type_id: String,
    /// Node type ids allowed as the source (empty = unconstrained).
    pub src_types: Vec<String>,
    /// Node type ids allowed as the target (empty = unconstrained).
    pub dst_types: Vec<String>,
}

/// A relation target that names an entity outside the current ontology.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct UnresolvedTargetDto {
    /// The source entity declaring the relation.
    pub source: String,
    /// The target entity name, not yet resolvable (a cross-bucket type).
    pub target: String,
}

/// One declared relation with its cardinality.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeclaredRelationDto {
    pub source: String,
    pub name: String,
    pub verb: String,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_entity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cardinality: Option<String>,
    pub label: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RelationCatalogResponse {
    /// Every relation verb with its endpoint typing (how relations are synced).
    pub relations: Vec<RelationDto>,
    /// Every declared relation as a named row, with its cardinality/label.
    pub declared: Vec<DeclaredRelationDto>,
    /// Cross-bucket targets omitted from `dst_types` until their buckets are
    /// synced — the relations that reach beyond the current slice.
    pub unresolved: Vec<UnresolvedTargetDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CreateRelationRequest {
    /// Relation kind: `member`, `owns`, `references` or `composes`.
    pub relation: String,
    /// Instance id of the source object.
    pub from: String,
    /// Instance id of the target object.
    pub to: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CreateRelationResponse {
    /// The relation verb the edge type is for.
    pub verb: String,
    /// The declared relation's property name in the model.
    pub name: Option<String>,
    /// Its human label from the model.
    pub label: Option<String>,
    /// The cardinality the model states for it.
    pub cardinality: Option<String>,
    pub type_id: String,
    pub from: String,
    pub to: String,
}

/// What a model-graph sync wrote.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ModelSyncResponse {
    /// The model version now stored.
    pub version: u64,
    /// Type ids that kept the schema they were first registered with because
    /// the model now declares different search paths for them. Their payloads
    /// still store and read normally; only the indexing is pinned, and moving
    /// it is a graph-storage type migration.
    pub pinned_types: Vec<String>,
    /// Object-type nodes upserted (one per entity).
    pub object_types: u64,
    /// `inherits` edges upserted.
    pub inherits: u64,
    /// `declares` edges upserted.
    pub declares: u64,
    /// Endpoints skipped because they named no modeled entity.
    pub skipped_endpoints: u64,
}

/// Upload a domain model to make it the active ontology.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ImportModelRequest {
    /// The domain-entity document (same shape as `GET /types` returns).
    #[schema(value_type = Object)]
    pub ontology: Value,
}

/// What an import loaded.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ImportModelResponse {
    pub entities: u64,
    pub buckets: u64,
    pub node_types: u64,
    pub edge_types: u64,
}

/// One object-type node of the model graph, read back from the store.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ModelGraphNodeDto {
    /// Node key (deterministic id of the object type).
    pub key: String,
    /// Entity display name.
    pub name: String,
    /// The object-type payload (id, bucket, extends, field/relation counts…).
    #[schema(value_type = Object)]
    pub payload: Value,
}

/// One model-graph edge (inherits/declares), endpoints by node key.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ModelGraphEdgeDto {
    pub type_id: String,
    pub from: String,
    pub to: String,
    /// Edge properties (declares: name/verb/cardinality/label; else empty).
    #[schema(value_type = Object)]
    pub payload: Value,
}

/// The model graph read back out of Graph Storage.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ModelGraphResponse {
    pub nodes: Vec<ModelGraphNodeDto>,
    pub edges: Vec<ModelGraphEdgeDto>,
}

/// One created object as a graph node.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ObjectGraphNodeDto {
    pub instance_id: String,
    /// Entity type id (e.g. `team`).
    pub entity: String,
    pub bucket: String,
    pub name: String,
    /// The object's stored payload (its document in Graph Storage).
    #[schema(value_type = Object)]
    pub value: Value,
}

/// The instance graph: created objects and the relations between them.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ObjectsGraphResponse {
    pub nodes: Vec<ObjectGraphNodeDto>,
    pub edges: Vec<ModelGraphEdgeDto>,
    /// Nodes returned (never above `limit`).
    pub total: u32,
    /// True when the bound cut the result: narrow with `type`/`scope`, or raise
    /// `limit`, to see the rest.
    pub truncated: bool,
}

#[derive(Debug, serde::Deserialize)]
pub struct ObjectsGraphQuery {
    /// Filter to one type (ontology id, node type id or leaf). Omitted = every
    /// domain type.
    #[serde(default)]
    pub r#type: Option<String>,
    /// Filter to one workspace/project scope. Omitted = every scope.
    #[serde(default)]
    pub scope: Option<String>,
    /// Node ceiling. Default 500, capped at 5000; a rendered graph stops being
    /// readable long before either.
    #[serde(default)]
    pub limit: Option<usize>,
}

/// Default and ceiling for the instance graph's node bound.
const OBJECTS_GRAPH_LIMIT: usize = 500;
const OBJECTS_GRAPH_MAX_LIMIT: usize = 5000;

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct AddFieldRequest {
    /// Field name.
    pub name: String,
    /// Field type (a domain-model type expression, e.g. `string`, `EntityId`).
    #[serde(rename = "type")]
    pub type_name: String,
    /// Optional human description.
    #[serde(default)]
    pub description: Option<String>,
    /// Whether the field is required.
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AddFieldResponse {
    /// The updated entity definition.
    #[schema(value_type = Object)]
    pub entity: Value,
    /// The model version this edit produced.
    pub version: u64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RevisionDto {
    /// The version number. Also its position in the history.
    pub version: u64,
    /// RFC-3339, when the change was made.
    pub at: String,
    /// The subject that made it.
    pub by: String,
    /// `seed` | `add_field` | `import` | `revert`.
    pub op: String,
    /// The entity it touched; empty for a whole-model change.
    pub target: String,
    /// One line describing the change.
    pub summary: String,
    /// The RFC-6902 patch that made it, over the ontology document.
    #[schema(value_type = Object)]
    pub patch: Value,
    /// Its inverse. Empty when the change cannot be undone (an import
    /// replaces the whole document), which also blocks reverting past it.
    #[schema(value_type = Object)]
    pub undo: Value,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RevisionsResponse {
    /// The history, newest first.
    pub revisions: Vec<RevisionDto>,
    /// The current version.
    pub head: u64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct RevertRequest {
    /// The version to restore the model to.
    pub to: u64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RevertResponse {
    /// The new head. A revert is recorded as a version of its own, so history
    /// is appended to rather than rewritten.
    pub version: u64,
    /// The versions it undid, newest first.
    pub undone: Vec<u64>,
}

// ── Handlers ──────────────────────────────────────────────────────────────

async fn list_types(
    Extension(ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
) -> ApiResult<JsonBody<TypesResponse>> {
    let ontology = handle
        .0
        .ontology_document(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(TypesResponse { ontology }))
}

async fn get_type(
    Extension(ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
    Path(id): Path<String>,
) -> ApiResult<JsonBody<EffectiveTypeResponse>> {
    let t = handle
        .0
        .effective_type(&ctx, id.trim())
        .await
        .map_err(|e| {
            StudioDomainModelError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?;
    Ok(Json(EffectiveTypeResponse {
        id: t.entity_id,
        name: t.name,
        description: t.description,
        bucket: t.bucket,
        ancestors: t.ancestors,
        properties: t
            .properties
            .into_iter()
            .map(|p| EffectivePropertyDto {
                name: p.name,
                type_expr: p.type_expr,
                required: p.required,
                description: p.description,
                declared_by: p.declared_by,
            })
            .collect(),
        relations: t
            .relations
            .into_iter()
            .map(|d| DeclaredRelationDto {
                source: d.source,
                name: d.name,
                verb: d.verb,
                target: d.target,
                target_entity: d.target_entity,
                cardinality: d.cardinality,
                label: d.label,
            })
            .collect(),
    }))
}

async fn create_object(
    Extension(ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
    Json(req): Json<CreateObjectRequest>,
) -> ApiResult<JsonBody<CreateObjectResponse>> {
    let validate = ValidateMode::parse(req.validate.as_deref().unwrap_or("")).map_err(|e| {
        StudioDomainModelError::invalid_argument()
            .with_constraint(e)
            .create()
    })?;
    let created = handle
        .0
        .create_object(
            &ctx,
            req.type_ref.trim(),
            req.key.trim(),
            WriteOptions {
                scope: req.scope.as_deref(),
                if_absent: req.if_absent,
                validate,
            },
            req.value,
        )
        .await
        .map_err(|e| {
            StudioDomainModelError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?;
    Ok(Json(CreateObjectResponse {
        type_id: created.type_id,
        instance_id: created.instance_id,
        if_absent: req.if_absent,
        validate: validate.as_str().to_string(),
        violations: created
            .report
            .violations
            .into_iter()
            .map(|v| ViolationDto {
                field: v.field,
                kind: v.kind.to_string(),
                detail: v.detail,
            })
            .collect(),
        undeclared: created.report.undeclared,
    }))
}

async fn list_objects(
    Extension(ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
    Query(q): Query<ObjectsQuery>,
) -> ApiResult<JsonBody<ObjectListResponse>> {
    let filter = q.r#type.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let scope = q.scope.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let objects = handle
        .0
        .list_objects(&ctx, filter, scope)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let objects: Vec<ObjectDto> = objects
        .into_iter()
        .map(|n| ObjectDto {
            type_id: n.type_id,
            instance_id: n.instance_id,
            value: n.value,
        })
        .collect();
    let total = objects.len() as u32;
    Ok(Json(ObjectListResponse { objects, total }))
}

async fn relation_catalog(
    Extension(ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
) -> ApiResult<JsonBody<RelationCatalogResponse>> {
    let catalog = handle
        .0
        .relation_catalog(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(RelationCatalogResponse {
        relations: catalog
            .relations
            .into_iter()
            .map(|r| RelationDto {
                relation: r.relation_kind,
                type_id: r.type_id,
                src_types: r.src_type_ids,
                dst_types: r.dst_type_ids,
            })
            .collect(),
        declared: catalog
            .declared
            .into_iter()
            .map(|d| DeclaredRelationDto {
                source: d.source,
                name: d.name,
                verb: d.verb,
                target: d.target,
                target_entity: d.target_entity,
                cardinality: d.cardinality,
                label: d.label,
            })
            .collect(),
        unresolved: catalog
            .unresolved
            .into_iter()
            .map(|(source, target)| UnresolvedTargetDto { source, target })
            .collect(),
    }))
}

async fn create_relation(
    Extension(ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
    Json(req): Json<CreateRelationRequest>,
) -> ApiResult<JsonBody<CreateRelationResponse>> {
    let created = handle
        .0
        .create_relation(&ctx, req.relation.trim(), req.from.trim(), req.to.trim())
        .await
        .map_err(|e| {
            StudioDomainModelError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?;
    Ok(Json(CreateRelationResponse {
        type_id: created.type_id,
        verb: created.verb,
        name: created.name,
        label: created.label,
        cardinality: created.cardinality,
        from: req.from,
        to: req.to,
    }))
}

async fn sync_model(
    Extension(ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
) -> ApiResult<JsonBody<ModelSyncResponse>> {
    let r = handle
        .0
        .sync_model(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(ModelSyncResponse {
        version: r.version,
        pinned_types: r.pinned_types,
        object_types: r.object_types,
        inherits: r.inherits,
        declares: r.declares,
        skipped_endpoints: r.skipped_endpoints,
    }))
}

async fn import_model(
    Extension(ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
    Json(req): Json<ImportModelRequest>,
) -> ApiResult<JsonBody<ImportModelResponse>> {
    let s = handle
        .0
        .import_model(&ctx, req.ontology)
        .await
        .map_err(|e| {
            StudioDomainModelError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?;
    Ok(Json(ImportModelResponse {
        entities: s.entities,
        buckets: s.buckets,
        node_types: s.node_types,
        edge_types: s.edge_types,
    }))
}

async fn model_graph(
    Extension(ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
) -> ApiResult<JsonBody<ModelGraphResponse>> {
    let (nodes, edges) = handle
        .0
        .model_graph_view(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    Ok(Json(ModelGraphResponse {
        nodes: nodes
            .into_iter()
            .map(|n| ModelGraphNodeDto {
                key: n.instance_id,
                name: n
                    .value
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                payload: n.value,
            })
            .collect(),
        edges: edges
            .into_iter()
            .map(|e| ModelGraphEdgeDto {
                type_id: e.type_id,
                from: e.from,
                to: e.to,
                payload: e.payload,
            })
            .collect(),
    }))
}

async fn objects_graph(
    Extension(ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
    Query(q): Query<ObjectsGraphQuery>,
) -> ApiResult<JsonBody<ObjectsGraphResponse>> {
    let limit = q
        .limit
        .unwrap_or(OBJECTS_GRAPH_LIMIT)
        .clamp(1, OBJECTS_GRAPH_MAX_LIMIT);
    let type_ref = q.r#type.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let scope = q.scope.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let (nodes, edges, truncated) = handle
        .0
        .objects_graph(&ctx, limit, type_ref, scope)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let total = nodes.len() as u32;
    Ok(Json(ObjectsGraphResponse {
        total,
        truncated,
        nodes: nodes
            .into_iter()
            .map(|n| ObjectGraphNodeDto {
                instance_id: n.instance_id,
                entity: n.entity,
                bucket: n.bucket,
                name: n.name,
                value: n.value,
            })
            .collect(),
        edges: edges
            .into_iter()
            .map(|e| ModelGraphEdgeDto {
                type_id: e.type_id,
                from: e.from,
                to: e.to,
                payload: serde_json::json!({}),
            })
            .collect(),
    }))
}

async fn add_field(
    Extension(ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
    Path(id): Path<String>,
    Json(req): Json<AddFieldRequest>,
) -> ApiResult<JsonBody<AddFieldResponse>> {
    let entity = handle
        .0
        .add_field(
            &ctx,
            id.trim(),
            FieldSpec {
                name: req.name.trim().to_string(),
                type_name: req.type_name.trim().to_string(),
                description: req.description,
                required: req.required,
            },
        )
        .await
        .map_err(|e| {
            StudioDomainModelError::invalid_argument()
                .with_constraint(format!("{e:#}"))
                .create()
        })?;
    let (entity, version) = entity;
    Ok(Json(AddFieldResponse { entity, version }))
}

async fn list_revisions(
    Extension(ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
) -> ApiResult<JsonBody<RevisionsResponse>> {
    let revisions = handle
        .0
        .revisions(&ctx)
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;
    let head = revisions.first().map(|r| r.version).unwrap_or(0);
    Ok(Json(RevisionsResponse {
        head,
        revisions: revisions
            .into_iter()
            .map(|r| RevisionDto {
                version: r.version,
                at: r.at,
                by: r.by,
                op: r.op,
                target: r.target,
                summary: r.summary,
                patch: r.patch,
                undo: r.undo,
            })
            .collect(),
    }))
}

async fn revert_model(
    Extension(ctx): Extension<SecurityContext>,
    Extension(handle): Extension<Handle>,
    Json(req): Json<RevertRequest>,
) -> ApiResult<JsonBody<RevertResponse>> {
    let r = handle.0.revert(&ctx, req.to).await.map_err(|e| {
        StudioDomainModelError::invalid_argument()
            .with_constraint(format!("{e:#}"))
            .create()
    })?;
    Ok(Json(RevertResponse {
        version: r.version,
        undone: r.undone,
    }))
}

// ── Route registration ────────────────────────────────────────────────────

pub fn register_routes(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<DomainModelService>,
) -> Router {
    let router = OperationBuilder::get("/studio-domain-model/v1/types")
        .operation_id("studio_domain_model.list_types")
        .summary("The stored domain-model ontology")
        .description(
            "Returns every domain type with its fields and relations — the \
             domain-entity document the model UI renders from, so the frontend \
             can be regenerated from the stored model.",
        )
        .tag("StudioDomainModel")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_types)
        .json_response_with_schema::<TypesResponse>(openapi, StatusCode::OK, "The ontology")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-domain-model/v1/types/{id}")
        .operation_id("studio_domain_model.get_type")
        .summary("One domain type, with everything it inherits")
        .description(
            "The type as it actually is: every field it has — its own and the \
             ones its bases declare, each marked with where it comes from — and \
             every relation it or its bases take part in. `GET /types` returns \
             the model verbatim, where most of a type's fields live on its \
             bases and the consumer has to walk `extends` itself.",
        )
        .tag("StudioDomainModel")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Domain type id (ontology id or node type id)")
        .handler(get_type)
        .json_response_with_schema::<EffectiveTypeResponse>(
            openapi,
            StatusCode::OK,
            "The effective type",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-domain-model/v1/objects")
        .operation_id("studio_domain_model.create_object")
        .summary("Create an object of a domain type")
        .description(
            "Upserts one object of a domain type into the graph, keyed on a \
             caller-chosen stable key. The registered graph type is open, so the \
             payload may carry fields the ontology has not (yet) declared.",
        )
        .tag("StudioDomainModel")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<CreateObjectRequest>(openapi, "Type, key and payload")
        .handler(create_object)
        .json_response_with_schema::<CreateObjectResponse>(
            openapi,
            StatusCode::OK,
            "Created object ids",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-domain-model/v1/objects")
        .operation_id("studio_domain_model.list_objects")
        .summary("List stored domain objects")
        .description("Reads back the objects created via POST /objects, optionally of one type.")
        .tag("StudioDomainModel")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_objects)
        .json_response_with_schema::<ObjectListResponse>(openapi, StatusCode::OK, "Stored objects")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-domain-model/v1/relations")
        .operation_id("studio_domain_model.relation_catalog")
        .summary("The relation catalog with endpoint typing")
        .description(
            "Every domain relation as registered in the graph and the \
             type-registry — its verb, edge type id and the node types allowed \
             at each end — plus the cross-bucket targets still pending a wider \
             sync.",
        )
        .tag("StudioDomainModel")
        .authenticated()
        .require_license_features::<License>([])
        .handler(relation_catalog)
        .json_response_with_schema::<RelationCatalogResponse>(
            openapi,
            StatusCode::OK,
            "Relation catalog",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-domain-model/v1/relations")
        .operation_id("studio_domain_model.create_relation")
        .summary("Relate two domain objects")
        .description(
            "Upserts a relation (member/owns/references/composes) between two \
             existing objects, addressed by their instance ids.",
        )
        .tag("StudioDomainModel")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<CreateRelationRequest>(openapi, "Relation kind and endpoints")
        .handler(create_relation)
        .json_response_with_schema::<CreateRelationResponse>(
            openapi,
            StatusCode::OK,
            "Created relation",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-domain-model/v1/model/sync")
        .operation_id("studio_domain_model.sync_model")
        .summary("Sync the domain model into the graph as a graph")
        .description(
            "Materializes the model itself: one object-type node per entity, \
             joined by `inherits` (extends) and `declares` (relation) edges, so \
             the domain model with its relations is queryable in the graph. \
             Idempotent — deterministic keys, so a re-sync converges.",
        )
        .tag("StudioDomainModel")
        .authenticated()
        .require_license_features::<License>([])
        .handler(sync_model)
        .json_response_with_schema::<ModelSyncResponse>(
            openapi,
            StatusCode::OK,
            "Model sync counts",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-domain-model/v1/model/import")
        .operation_id("studio_domain_model.import_model")
        .summary("Upload a domain model to make it the active ontology")
        .description(
            "Replaces the active ontology with an uploaded domain-entity \
             document (the shape GET /types returns) and registers its types, \
             so the model can be loaded through the UI rather than only from the \
             embedded default. Follow with POST /model/sync to materialize it.",
        )
        .tag("StudioDomainModel")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<ImportModelRequest>(openapi, "The domain model to load")
        .handler(import_model)
        .json_response_with_schema::<ImportModelResponse>(
            openapi,
            StatusCode::OK,
            "What was loaded",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-domain-model/v1/model/graph")
        .operation_id("studio_domain_model.model_graph")
        .summary("Read the model graph back out of Graph Storage")
        .description(
            "Returns the object-type nodes and their inherits/declares edges as \
             materialized by POST /model/sync — read from the graph store, not \
             the embedded ontology. The read side of the sync, and the data a \
             model visualization renders.",
        )
        .tag("StudioDomainModel")
        .authenticated()
        .require_license_features::<License>([])
        .handler(model_graph)
        .json_response_with_schema::<ModelGraphResponse>(openapi, StatusCode::OK, "The model graph")
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-domain-model/v1/objects/graph")
        .operation_id("studio_domain_model.objects_graph")
        .summary("The instance graph: created objects and their relations")
        .description(
            "Returns the objects created via POST /objects and the relations \
             between them (member/owns/references/composes/derives) — the \
             instance layer, distinct from the type/model graph. Bounded by \n             `limit` (default 500, max 5000) and narrowable by \n             `type`/`scope`; only edges with both endpoints on the page \n             are returned, and `truncated` says whether the bound cut \n             the result.",
        )
        .tag("StudioDomainModel")
        .authenticated()
        .require_license_features::<License>([])
        .handler(objects_graph)
        .json_response_with_schema::<ObjectsGraphResponse>(
            openapi,
            StatusCode::OK,
            "The instance graph",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-domain-model/v1/types/{id}/fields")
        .operation_id("studio_domain_model.add_field")
        .summary("Extend a domain type with a new field")
        .description(
            "Appends a field to a domain type's definition. Because the graph \
             type is open, this is a pure ontology edit — no migration and no \
             re-registration — and the new field is immediately available to \
             new objects and to the regenerated frontend.",
        )
        .tag("StudioDomainModel")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Domain type id (ontology id or node type id)")
        .json_request::<AddFieldRequest>(openapi, "Field to add")
        .handler(add_field)
        .json_response_with_schema::<AddFieldResponse>(
            openapi,
            StatusCode::OK,
            "The updated type definition",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-domain-model/v1/model/versions")
        .operation_id("studio_domain_model.list_revisions")
        .summary("The model's change history")
        .description(
            "Every recorded change to the model, newest first: who made it, \
             when, a one-line summary, and the RFC-6902 patch that made it \
             together with its inverse. The history is what makes a model edit \
             auditable and reversible.",
        )
        .tag("StudioDomainModel")
        .authenticated()
        .require_license_features::<License>([])
        .handler(list_revisions)
        .json_response_with_schema::<RevisionsResponse>(
            openapi,
            StatusCode::OK,
            "The change history",
        )
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-domain-model/v1/model/revert")
        .operation_id("studio_domain_model.revert_model")
        .summary("Restore the model to an earlier version")
        .description(
            "Undoes every change back to the requested version by applying \
             their inverse patches, and records the result as a new version — \
             history is appended to, never rewritten. Refused when a change in \
             the range records no inverse (an import replaces the whole \
             document, so nothing can undo it).",
        )
        .tag("StudioDomainModel")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<RevertRequest>(openapi, "The version to restore")
        .handler(revert_model)
        .json_response_with_schema::<RevertResponse>(
            openapi,
            StatusCode::OK,
            "The new head and what it undid",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(Handle(service)))
}
