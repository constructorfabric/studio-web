//! The project types an organization or a workspace offers, kept as domain
//! objects (ADR-0066 §8a).
//!
//! They were one account-management metadata row per tenant that the portal
//! wrote itself. Now each type is a `project-type` object kept by this gear,
//! read and written through these routes with the caller's own rights on the
//! tenant (the domain-object PDP), and inherited as before: a tenant without
//! its own list offers its nearest ancestor's. The first read of a tenant
//! moves the old row in (`crate::model_metadata`).

use std::sync::Arc;

use account_management_sdk::{AccountManagementClient, UpsertMetadataRequest};
use axum::{Extension, Router};
use gts::GtsTypeId;
use serde_json::Value;
use toolkit::api::canonical_prelude::*;
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::rest::OrganizationError;

/// The account-management row the types were kept in, and are moved from.
pub const PROJECT_TYPES_METADATA_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.project.types.v1~";

pub(crate) static MODEL_KINDS: &[crate::model_metadata::Kind] = {
    use crate::model_metadata::{Kind, Part};
    &[Kind {
        type_id: PROJECT_TYPES_METADATA_TYPE,
        gear: "studio-organizations",
        parts: &[Part {
            field: "types",
            entity: "project-type",
            name: "Project Type",
            description: "A kind of project a workspace offers: what creating one provisions, which tabs it shows, which kits it starts with.",
            key: &["key"],
        }],
    }]
};

/// Where the types are read and written.
#[derive(Clone)]
pub struct ProjectTypes(pub Arc<dyn AccountManagementClient>);

/// A tenant's project types.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProjectTypesDocDto {
    /// The types, in the order the New project card offers them.
    #[schema(value_type = Vec<Object>)]
    pub types: Vec<Value>,
}

/// What a tenant sets: its types, the phases its projects move through, or
/// both. A field left out keeps what the tenant has.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ProjectTypesWriteDto {
    /// The types, in the order the New project card offers them.
    #[serde(default)]
    #[schema(value_type = Option<Vec<Object>>)]
    pub types: Option<Vec<Value>>,
    /// The phases its projects move through, in order (the portal's
    /// `project-lifecycle.ts`).
    #[serde(default)]
    #[schema(value_type = Option<Vec<Object>>)]
    pub phases: Option<Vec<Value>>,
}

/// What applies at a tenant and what it sets itself.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProjectTypesDto {
    /// What the tenant sets itself; absent when it inherits.
    pub own: Option<ProjectTypesDocDto>,
    /// What applies: its own, else its nearest ancestor's; absent when nobody
    /// set any and the built-in types apply.
    pub resolved: Option<ProjectTypesDocDto>,
    /// The phases the tenant sets itself; absent when it sets none.
    #[schema(value_type = Option<Vec<Object>>)]
    pub own_phases: Option<Vec<Value>>,
    /// The phases that apply: its own, else those of the nearest document
    /// above it; absent when nobody set any and the built-in phases apply.
    #[schema(value_type = Option<Vec<Object>>)]
    pub resolved_phases: Option<Vec<Value>>,
}

#[derive(Debug, serde::Deserialize)]
struct TenantQuery {
    tenant_id: Option<String>,
}

fn tenant_of(q: &TenantQuery) -> ApiResult<Uuid> {
    q.tenant_id
        .as_deref()
        .and_then(|t| Uuid::parse_str(t).ok())
        .ok_or_else(|| {
            OrganizationError::invalid_argument()
                .with_constraint("tenant_id must be a tenant id")
                .create()
        })
}

/// The list a stored document keeps under `field`, if it keeps one.
fn list(value: &Value, field: &str) -> Option<Vec<Value>> {
    value.get(field).and_then(Value::as_array).cloned()
}

fn doc(value: &Value) -> Option<ProjectTypesDocDto> {
    list(value, "types").map(|types| ProjectTypesDocDto { types })
}

fn type_id() -> GtsTypeId {
    GtsTypeId::new(PROJECT_TYPES_METADATA_TYPE)
}

/// The tenant's own document; null when it has none.
async fn own_document(
    store: &ProjectTypes,
    ctx: &SecurityContext,
    tenant: Uuid,
) -> ApiResult<Option<Value>> {
    match store.0.get_metadata(ctx, tenant, type_id()).await {
        Ok(entry) => Ok(Some(entry.value)),
        Err(CanonicalError::NotFound { .. }) => Ok(None),
        Err(e) => Err(e),
    }
}

async fn get_project_types(
    Extension(ctx): Extension<SecurityContext>,
    Extension(store): Extension<Option<ProjectTypes>>,
    axum::extract::Query(query): axum::extract::Query<TenantQuery>,
) -> ApiResult<JsonBody<ProjectTypesDto>> {
    let store = available(store)?;
    let tenant = tenant_of(&query)?;
    let own_doc = own_document(&store, &ctx, tenant).await?;
    let own = own_doc.as_ref().and_then(doc);
    let own_phases = own_doc.as_ref().and_then(|v| list(v, "phases"));
    let above = if own.is_none() || own_phases.is_none() {
        store.0.resolve_metadata(&ctx, tenant, type_id()).await?
    } else {
        None
    };
    let resolved = match &own {
        Some(o) => Some(ProjectTypesDocDto {
            types: o.types.clone(),
        }),
        None => above.as_ref().and_then(|e| doc(&e.value)),
    };
    let resolved_phases = own_phases
        .clone()
        .or_else(|| above.as_ref().and_then(|e| list(&e.value, "phases")));
    Ok(Json(ProjectTypesDto {
        own,
        resolved,
        own_phases,
        resolved_phases,
    }))
}

async fn put_project_types(
    Extension(ctx): Extension<SecurityContext>,
    Extension(store): Extension<Option<ProjectTypes>>,
    axum::extract::Query(query): axum::extract::Query<TenantQuery>,
    Json(body): Json<ProjectTypesWriteDto>,
) -> ApiResult<JsonBody<ProjectTypesDocDto>> {
    let store = available(store)?;
    let tenant = tenant_of(&query)?;
    let mut seen = std::collections::HashSet::new();
    for t in body.types.iter().flatten() {
        let key = t.get("key").and_then(Value::as_str).unwrap_or_default();
        if key.is_empty() || !seen.insert(key.to_owned()) {
            return Err(OrganizationError::invalid_argument()
                .with_constraint("every project type has a key of its own")
                .create());
        }
    }
    // What the write leaves out stays as the tenant has it, so a writer of
    // the types keeps the phases and the other way round.
    let mut value = match own_document(&store, &ctx, tenant).await? {
        Some(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    if let Some(types) = &body.types {
        value.insert("types".to_owned(), Value::Array(types.clone()));
    }
    if let Some(phases) = &body.phases {
        value.insert("phases".to_owned(), Value::Array(phases.clone()));
    }
    let types = list(&Value::Object(value.clone()), "types").unwrap_or_default();
    store
        .0
        .upsert_metadata(
            &ctx,
            tenant,
            UpsertMetadataRequest::new(type_id(), Value::Object(value)),
        )
        .await?;
    Ok(Json(ProjectTypesDocDto { types }))
}

async fn delete_project_types(
    Extension(ctx): Extension<SecurityContext>,
    Extension(store): Extension<Option<ProjectTypes>>,
    axum::extract::Query(query): axum::extract::Query<TenantQuery>,
) -> ApiResult<StatusCode> {
    let store = available(store)?;
    let tenant = tenant_of(&query)?;
    match store.0.delete_metadata(&ctx, tenant, type_id()).await {
        Ok(()) | Err(CanonicalError::NotFound { .. }) => Ok(StatusCode::NO_CONTENT),
        Err(e) => Err(e),
    }
}

fn available(store: Option<ProjectTypes>) -> ApiResult<ProjectTypes> {
    store.ok_or_else(|| {
        CanonicalError::service_unavailable()
            .with_detail("account-management is not available, so project types cannot be kept")
            .create()
    })
}

pub fn register(
    router: Router,
    openapi: &dyn OpenApiRegistry,
    store: Option<ProjectTypes>,
) -> Router {
    let router = OperationBuilder::get("/studio-organizations/v1/project-types")
        .operation_id("studio_organizations.get_project_types")
        .summary("The project types a tenant offers")
        .description(
            "What the tenant sets itself, and what applies there: its own types, else its \
             nearest ancestor's. Read with the caller's rights on the tenant's domain objects.",
        )
        .tag("StudioOrganizations")
        .authenticated()
        .require_license_features::<super::rest::License>([])
        .query_param_typed("tenant_id", true, "The organization or workspace", "string")
        .handler(get_project_types)
        .json_response_with_schema::<ProjectTypesDto>(openapi, StatusCode::OK, "The types")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::put("/studio-organizations/v1/project-types")
        .operation_id("studio_organizations.upsert_project_types")
        .summary("Set the project types a tenant offers")
        .description(
            "Sets the tenant's own types, the phases its projects move through, or both; \
             a field left out keeps what the tenant has. Its workspaces inherit them unless \
             they set their own. Each type is kept as a `project-type` domain object; who \
             may write the tenant's domain objects may.",
        )
        .tag("StudioOrganizations")
        .authenticated()
        .require_license_features::<super::rest::License>([])
        .query_param_typed("tenant_id", true, "The organization or workspace", "string")
        .json_request::<ProjectTypesWriteDto>(openapi, "The types, the phases, or both")
        .handler(put_project_types)
        .json_response_with_schema::<ProjectTypesDocDto>(openapi, StatusCode::OK, "The types kept")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::delete("/studio-organizations/v1/project-types")
        .operation_id("studio_organizations.delete_project_types")
        .summary("Drop a tenant's own project types")
        .description(
            "What it inherits applies again. Answers 204 with no body, also when it set none.",
        )
        .tag("StudioOrganizations")
        .authenticated()
        .require_license_features::<super::rest::License>([])
        .query_param_typed("tenant_id", true, "The organization or workspace", "string")
        .handler(delete_project_types)
        .no_content_response(StatusCode::NO_CONTENT, "Dropped")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(store))
}
