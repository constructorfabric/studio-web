//! REST surface for studio-documents, under `/studio-documents/v1`.
//!
//! Everything is addressed by the **workspace** tenant; a project is an extra
//! path segment on the two calls that differ (create and the effective list).
//! A single document is addressed by `(workspace_id, id)` because every
//! document — workspace- or project-level — shares the workspace tenant.

use std::sync::Arc;

use axum::{Extension, Router, extract::Path};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::model::{
    DocStatus, Document, DocumentType, Owner, Question, QuestionKind, Rules, Section, TemplateSpec,
};
use super::service::DocumentsService;
use super::validate::{SectionStatus, ValidationReport};

#[resource_error(gts_id!("cf.studio._.documents.v1~"))]
pub struct DocumentsError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

// ── DTOs ─────────────────────────────────────────────────────────────────────

#[derive(Debug)]
#[toolkit_macros::api_dto(request, response)]
pub struct SectionDto {
    pub key: String,
    pub title: String,
    pub required: bool,
    pub min_words: Option<i64>,
    pub description: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request, response)]
pub struct RulesDto {
    pub warn_unknown_sections: bool,
    pub front_matter: Vec<String>,
    pub forbid_placeholders: bool,
    pub min_title_words: i64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request, response)]
pub struct QuestionDto {
    pub id: String,
    pub prompt: String,
    /// "text" | "long_text" | "bool" | "single" | "multi".
    pub kind: String,
    pub options: Vec<String>,
    pub required: bool,
    pub capability: Option<String>,
    pub section: Option<String>,
    pub help: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DocumentTypeDto {
    pub key: String,
    pub name: String,
    pub description: String,
    pub gts_type_id: String,
    /// "builtin" or "workspace".
    pub owner: String,
    pub owner_tenant_id: Option<Uuid>,
    pub body: String,
    pub sections: Vec<SectionDto>,
    pub rules: RulesDto,
    /// Intake questionnaire (empty for types without one).
    pub questionnaire: Vec<QuestionDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DocumentTypeListDto {
    pub items: Vec<DocumentTypeDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DocumentDto {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub project_id: Option<Uuid>,
    /// True when this document is inherited from the workspace into a project
    /// view (i.e. listed for a project but owned at workspace level).
    pub inherited: bool,
    pub type_key: String,
    pub title: String,
    pub content: String,
    /// "draft", "review" or "approved".
    pub status: String,
    pub conforms: bool,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DocumentListDto {
    pub items: Vec<DocumentDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SectionStatusDto {
    pub key: String,
    pub title: String,
    pub present: bool,
    pub word_count: i64,
    pub required: bool,
    pub ok: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ValidationReportDto {
    pub conforms: bool,
    pub sections: Vec<SectionStatusDto>,
    pub issues: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct UpsertTypeDto {
    pub key: String,
    pub name: String,
    pub description: Option<String>,
    pub body: String,
    pub sections: Vec<SectionDto>,
    pub rules: Option<RulesDto>,
    /// Intake questionnaire; omitted or empty for types without one.
    pub questionnaire: Option<Vec<QuestionDto>>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CreateDocumentDto {
    pub type_key: String,
    pub title: String,
    pub content: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct UpdateDocumentDto {
    pub title: Option<String>,
    pub content: Option<String>,
    /// "draft", "review" or "approved" — forward-only.
    pub status: Option<String>,
}

// ── conversions ──────────────────────────────────────────────────────────────

impl From<Section> for SectionDto {
    fn from(s: Section) -> Self {
        Self {
            key: s.key,
            title: s.title,
            required: s.required,
            min_words: s.min_words.map(|w| w as i64),
            description: s.description,
        }
    }
}

impl From<Rules> for RulesDto {
    fn from(r: Rules) -> Self {
        Self {
            warn_unknown_sections: r.warn_unknown_sections,
            front_matter: r.front_matter,
            forbid_placeholders: r.forbid_placeholders,
            min_title_words: r.min_title_words as i64,
        }
    }
}

fn question_kind_str(k: QuestionKind) -> &'static str {
    match k {
        QuestionKind::Text => "text",
        QuestionKind::LongText => "long_text",
        QuestionKind::Bool => "bool",
        QuestionKind::Single => "single",
        QuestionKind::Multi => "multi",
    }
}

fn question_kind_from_str(s: &str) -> QuestionKind {
    match s {
        "long_text" => QuestionKind::LongText,
        "bool" => QuestionKind::Bool,
        "single" => QuestionKind::Single,
        "multi" => QuestionKind::Multi,
        _ => QuestionKind::Text,
    }
}

impl From<Question> for QuestionDto {
    fn from(q: Question) -> Self {
        Self {
            id: q.id,
            prompt: q.prompt,
            kind: question_kind_str(q.kind).to_string(),
            options: q.options,
            required: q.required,
            capability: q.capability,
            section: q.section,
            help: q.help,
        }
    }
}

fn question_from_dto(q: QuestionDto) -> Question {
    Question {
        kind: question_kind_from_str(&q.kind),
        id: q.id,
        prompt: q.prompt,
        options: q.options,
        required: q.required,
        capability: q.capability,
        section: q.section,
        help: q.help,
    }
}

impl From<DocumentType> for DocumentTypeDto {
    fn from(t: DocumentType) -> Self {
        let (owner, owner_tenant_id) = match t.owner {
            Owner::Builtin => ("builtin".to_string(), None),
            Owner::Workspace { tenant_id } => ("workspace".to_string(), Some(tenant_id)),
        };
        Self {
            key: t.key,
            name: t.name,
            description: t.description,
            gts_type_id: t.gts_type_id,
            owner,
            owner_tenant_id,
            body: t.template.body,
            sections: t.template.sections.into_iter().map(Into::into).collect(),
            rules: t.template.rules.into(),
            questionnaire: t
                .template
                .questionnaire
                .into_iter()
                .map(Into::into)
                .collect(),
        }
    }
}

impl From<ValidationReport> for ValidationReportDto {
    fn from(r: ValidationReport) -> Self {
        Self {
            conforms: r.conforms,
            sections: r.sections.into_iter().map(Into::into).collect(),
            issues: r.issues,
        }
    }
}

impl From<SectionStatus> for SectionStatusDto {
    fn from(s: SectionStatus) -> Self {
        Self {
            key: s.key,
            title: s.title,
            present: s.present,
            word_count: s.word_count as i64,
            required: s.required,
            ok: s.ok,
        }
    }
}

fn section_from_dto(s: SectionDto) -> Section {
    Section {
        key: s.key,
        title: s.title,
        required: s.required,
        min_words: s
            .min_words
            .and_then(|w| if w > 0 { Some(w as usize) } else { None }),
        description: s.description,
    }
}

fn rules_from_dto(r: RulesDto) -> Rules {
    Rules {
        warn_unknown_sections: r.warn_unknown_sections,
        front_matter: r.front_matter,
        forbid_placeholders: r.forbid_placeholders,
        min_title_words: r.min_title_words.max(0) as usize,
    }
}

fn status_str(s: DocStatus) -> &'static str {
    match s {
        DocStatus::Draft => "draft",
        DocStatus::Review => "review",
        DocStatus::Approved => "approved",
    }
}

fn parse_status(s: &str) -> Option<DocStatus> {
    match s.trim().to_ascii_lowercase().as_str() {
        "draft" => Some(DocStatus::Draft),
        "review" => Some(DocStatus::Review),
        "approved" => Some(DocStatus::Approved),
        _ => None,
    }
}

fn document_dto(d: Document, inherited: bool) -> DocumentDto {
    DocumentDto {
        id: d.id,
        tenant_id: d.tenant_id,
        project_id: d.project_id,
        inherited,
        type_key: d.type_key,
        title: d.title,
        content: d.content,
        status: status_str(d.status).to_string(),
        conforms: d.conforms,
        created_by: d.created_by,
        created_at: d.created_at,
        updated_at: d.updated_at,
    }
}

fn internal(error: anyhow::Error) -> CanonicalError {
    CanonicalError::internal(format!("documents failed: {error:#}")).create()
}

fn invalid(error: anyhow::Error) -> CanonicalError {
    DocumentsError::invalid_argument()
        .with_constraint(error.to_string())
        .create()
}

/// A tenant the caller cannot resolve reads as not-found rather than leaking
/// its existence (the endpoint refuses to be an existence oracle).
fn no_tenant(_error: anyhow::Error) -> CanonicalError {
    DocumentsError::not_found("workspace or project not found or not accessible")
        .with_resource("tenant")
        .create()
}

// ── handlers ─────────────────────────────────────────────────────────────────

async fn list_types(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(workspace_id): Path<Uuid>,
) -> ApiResult<JsonBody<DocumentTypeListDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    let items = service.list_types(workspace_id).await.map_err(internal)?;
    Ok(Json(DocumentTypeListDto {
        items: items.into_iter().map(Into::into).collect(),
    }))
}

async fn upsert_type(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(workspace_id): Path<Uuid>,
    Json(body): Json<UpsertTypeDto>,
) -> ApiResult<JsonBody<DocumentTypeDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    let ty = DocumentType {
        key: body.key,
        name: body.name,
        description: body.description.unwrap_or_default(),
        gts_type_id: String::new(),
        owner: Owner::Workspace {
            tenant_id: workspace_id,
        },
        template: TemplateSpec {
            body: body.body,
            sections: body.sections.into_iter().map(section_from_dto).collect(),
            rules: body.rules.map(rules_from_dto).unwrap_or_default(),
            questionnaire: body
                .questionnaire
                .unwrap_or_default()
                .into_iter()
                .map(question_from_dto)
                .collect(),
        },
    };
    let saved = service
        .upsert_type(workspace_id, ty)
        .await
        .map_err(invalid)?;
    Ok(Json(saved.into()))
}

async fn list_workspace_documents(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(workspace_id): Path<Uuid>,
) -> ApiResult<JsonBody<DocumentListDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    let items = service
        .list_documents(workspace_id, None)
        .await
        .map_err(internal)?;
    Ok(Json(DocumentListDto {
        items: items.into_iter().map(|d| document_dto(d, false)).collect(),
    }))
}

async fn list_project_documents(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, project_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<JsonBody<DocumentListDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    service
        .authorize(&ctx, project_id)
        .await
        .map_err(no_tenant)?;
    let items = service
        .list_documents(workspace_id, Some(project_id))
        .await
        .map_err(internal)?;
    Ok(Json(DocumentListDto {
        items: items
            .into_iter()
            .map(|d| {
                let inherited = d.project_id.is_none();
                document_dto(d, inherited)
            })
            .collect(),
    }))
}

async fn create_workspace_document(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(workspace_id): Path<Uuid>,
    Json(body): Json<CreateDocumentDto>,
) -> ApiResult<JsonBody<DocumentDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    let doc = service
        .create_document(
            workspace_id,
            None,
            &body.type_key,
            &body.title,
            body.content,
            ctx.subject_id().to_string(),
        )
        .await
        .map_err(invalid)?;
    Ok(Json(document_dto(doc, false)))
}

async fn create_project_document(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, project_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<CreateDocumentDto>,
) -> ApiResult<JsonBody<DocumentDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    service
        .authorize(&ctx, project_id)
        .await
        .map_err(no_tenant)?;
    let doc = service
        .create_document(
            workspace_id,
            Some(project_id),
            &body.type_key,
            &body.title,
            body.content,
            ctx.subject_id().to_string(),
        )
        .await
        .map_err(invalid)?;
    Ok(Json(document_dto(doc, false)))
}

async fn get_document(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<JsonBody<DocumentDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    let doc = service
        .get_document(workspace_id, id)
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            DocumentsError::not_found("no such document")
                .with_resource("document")
                .create()
        })?;
    Ok(Json(document_dto(doc, false)))
}

async fn update_document(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateDocumentDto>,
) -> ApiResult<JsonBody<DocumentDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    let status = match body.status {
        Some(s) => Some(parse_status(&s).ok_or_else(|| {
            DocumentsError::invalid_argument()
                .with_constraint("status must be draft, review or approved")
                .create()
        })?),
        None => None,
    };
    let doc = service
        .update_document(workspace_id, id, body.title, body.content, status)
        .await
        .map_err(invalid)?;
    Ok(Json(document_dto(doc, false)))
}

async fn validate_document(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<JsonBody<ValidationReportDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    let report = service
        .validate_document(workspace_id, id)
        .await
        .map_err(internal)?;
    Ok(Json(report.into()))
}

async fn delete_document(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    service
        .delete_document(workspace_id, id)
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

// ── registration ─────────────────────────────────────────────────────────────

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<DocumentsService>,
) -> Router {
    router = OperationBuilder::get("/studio-documents/v1/workspaces/{workspace_id}/types")
        .operation_id("studio_documents.list_types")
        .summary("List effective document types for a workspace")
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace tenant id")
        .handler(list_types)
        .json_response_with_schema::<DocumentTypeListDto>(openapi, StatusCode::OK, "Document types")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/workspaces/{workspace_id}/types")
        .operation_id("studio_documents.upsert_type")
        .summary("Define or replace a workspace document type")
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace tenant id")
        .json_request::<UpsertTypeDto>(openapi, "Document type")
        .handler(upsert_type)
        .json_response_with_schema::<DocumentTypeDto>(openapi, StatusCode::OK, "Saved type")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/workspaces/{workspace_id}/documents")
        .operation_id("studio_documents.list_workspace_documents")
        .summary("List workspace-level documents")
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace tenant id")
        .handler(list_workspace_documents)
        .json_response_with_schema::<DocumentListDto>(openapi, StatusCode::OK, "Documents")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get(
        "/studio-documents/v1/workspaces/{workspace_id}/projects/{project_id}/documents",
    )
    .operation_id("studio_documents.list_project_documents")
    .summary("List a project's effective documents (own + inherited)")
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace tenant id")
    .path_param("project_id", "Project tenant id")
    .handler(list_project_documents)
    .json_response_with_schema::<DocumentListDto>(openapi, StatusCode::OK, "Effective documents")
    .error_401(openapi)
    .error_403(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/workspaces/{workspace_id}/documents")
        .operation_id("studio_documents.create_workspace_document")
        .summary("Create a workspace-level document from a type")
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace tenant id")
        .json_request::<CreateDocumentDto>(openapi, "Document to create")
        .handler(create_workspace_document)
        .json_response_with_schema::<DocumentDto>(openapi, StatusCode::OK, "Created document")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post(
        "/studio-documents/v1/workspaces/{workspace_id}/projects/{project_id}/documents",
    )
    .operation_id("studio_documents.create_project_document")
    .summary("Create a project-level document from a type")
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace tenant id")
    .path_param("project_id", "Project tenant id")
    .json_request::<CreateDocumentDto>(openapi, "Document to create")
    .handler(create_project_document)
    .json_response_with_schema::<DocumentDto>(openapi, StatusCode::OK, "Created document")
    .error_400(openapi)
    .error_401(openapi)
    .error_403(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/workspaces/{workspace_id}/documents/{id}")
        .operation_id("studio_documents.get_document")
        .summary("Get one document")
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace tenant id")
        .path_param("id", "Document id")
        .handler(get_document)
        .json_response_with_schema::<DocumentDto>(openapi, StatusCode::OK, "Document")
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-documents/v1/workspaces/{workspace_id}/documents/{id}")
        .operation_id("studio_documents.update_document")
        .summary("Update a document's content, title or status")
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace tenant id")
        .path_param("id", "Document id")
        .json_request::<UpdateDocumentDto>(openapi, "Document changes")
        .handler(update_document)
        .json_response_with_schema::<DocumentDto>(openapi, StatusCode::OK, "Updated document")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post(
        "/studio-documents/v1/workspaces/{workspace_id}/documents/{id}/validate",
    )
    .operation_id("studio_documents.validate_document")
    .summary("Re-run the structural conformance check")
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace tenant id")
    .path_param("id", "Document id")
    .handler(validate_document)
    .json_response_with_schema::<ValidationReportDto>(openapi, StatusCode::OK, "Conformance report")
    .error_401(openapi)
    .error_403(openapi)
    .error_500(openapi)
    .register(router, openapi);

    OperationBuilder::delete("/studio-documents/v1/workspaces/{workspace_id}/documents/{id}")
        .operation_id("studio_documents.delete_document")
        .summary("Delete a document")
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace tenant id")
        .path_param("id", "Document id")
        .handler(delete_document)
        .no_content_response(StatusCode::NO_CONTENT, "Document deleted")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi)
        .layer(Extension(service))
}
