//! REST surface for studio-documents, under `/studio-documents/v1`.
//!
//! Everything is addressed by the **workspace** tenant; a project is an extra
//! path segment on the two calls that differ (create and the effective list).
//! A single document is addressed by `(workspace_id, id)` because every
//! document — workspace- or project-level — shares the workspace tenant.

use std::sync::Arc;

use axum::extract::Query;
use axum::{Extension, Router, extract::Path};
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::intake::Answer;
use super::model::{Analysis, AnalysisState, StageStatus};
use super::model::{
    Capability, DetectionSource, DocStatus, Document, DocumentBinding, DocumentType, Owner,
    Question, QuestionKind, Rules, Section, Stage, TemplateSpec,
};
use super::service::{BindingAction, BindingDecision, DocumentsService, IngestedFile};
use super::validate::{SectionStatus, ValidationReport};
use crate::pagination::PageQuery;

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
    /// The GTS type this entry is an INSTANCE of — the same value for every
    /// entry (`gts.cf.studio.doc.document_type.v1~`). It is not an identifier
    /// for this particular type; `key` is. Per-key ids were retired by
    /// ADR-0014 §2 and a client must not derive one.
    pub gts_type_id: String,
    /// "builtin", "organization" or "workspace".
    pub owner: String,
    pub owner_tenant_id: Option<Uuid>,
    pub body: String,
    pub sections: Vec<SectionDto>,
    pub rules: RulesDto,
    /// Intake questionnaire (empty for types without one).
    pub questionnaire: Vec<QuestionDto>,
    /// A tombstone. Never true in a listing -- hidden entries are removed from
    /// the effective catalogue -- but returned by the write that set it, so a
    /// client can tell "hidden" apart from "refused".
    pub hidden: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DocumentTypeListDto {
    pub items: Vec<DocumentTypeDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CapabilityDto {
    pub key: String,
    pub label: String,
    /// Words that make a component a candidate. Empty means "match the key".
    pub terms: Vec<String>,
    /// "builtin", "organization" or "workspace".
    pub owner: String,
    pub owner_tenant_id: Option<Uuid>,
    /// A tombstone. Never true in a listing.
    pub hidden: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CapabilityListDto {
    pub items: Vec<CapabilityDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct UpsertCapabilityDto {
    pub key: String,
    pub label: String,
    pub terms: Option<Vec<String>>,
    pub hidden: Option<bool>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AnalysisDto {
    pub document_id: Uuid,
    /// `bloat`, `purpose`, `leak`, `traceability` -- whatever the spec-quality
    /// service offers. Not an enum: the upstream owns that list.
    pub detector: String,
    /// `pending`, `passed` or `failed`.
    pub state: String,
    /// The upstream task this verdict came from.
    pub task_id: Option<String>,
    pub summary: String,
    pub updated_at: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AnalysisListDto {
    pub items: Vec<AnalysisDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct RecordAnalysisDto {
    /// `pending`, `passed` or `failed`.
    pub state: String,
    pub task_id: Option<String>,
    pub summary: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RequirementDto {
    pub type_key: String,
    pub present: bool,
    pub conforms: bool,
    /// Detectors that have not passed for this document: missing, pending or
    /// failed. Empty when the stage gates nothing, or when everything passed.
    pub analyses_outstanding: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct StageStatusDto {
    pub key: String,
    pub label: String,
    pub required: bool,
    pub complete: bool,
    pub requirements: Vec<RequirementDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct StageStatusListDto {
    pub items: Vec<StageStatusDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct StageDto {
    pub key: String,
    /// What a screen renders. Not derived from the key: `prd_spec` is
    /// "PRD-Spec" and `brd` is "BRD", and no casing rule gets there.
    pub label: String,
    /// A required stage cannot be dropped from a project's selection.
    pub required: bool,
    /// Position in the catalogue. The list is already sorted by it; it is
    /// returned so a client can render an insertion point.
    pub position: i32,
    /// Document-type keys this stage is not complete without.
    pub requires: Vec<String>,
    /// Detectors every required document must pass before the stage completes.
    pub gates: Vec<String>,
    /// "builtin", "organization" or "workspace".
    pub owner: String,
    pub owner_tenant_id: Option<Uuid>,
    /// A tombstone. Never true in a listing.
    pub hidden: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct StageListDto {
    pub items: Vec<StageDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct UpsertStageDto {
    pub key: String,
    pub label: String,
    pub required: Option<bool>,
    pub position: Option<i32>,
    pub requires: Option<Vec<String>>,
    pub gates: Option<Vec<String>>,
    /// Hide the key this entry overrides instead of replacing it.
    pub hidden: Option<bool>,
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
    /// Capability keys the document declares, from its front matter. The
    /// composer reads these; a client must not parse the body itself.
    pub capabilities: Vec<String>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DocumentListDto {
    pub items: Vec<DocumentDto>,
    /// Documents in this workspace/project scope across every page, so a
    /// caller can show "N of M" and knows a next page exists exactly when
    /// `offset + items.len() < total`.
    pub total: u32,
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
    /// Hide the key this entry overrides instead of replacing it. A tombstone
    /// still needs a `name` and a `body`; neither is ever rendered.
    pub hidden: Option<bool>,
}

/// One questionnaire answer. Exactly one value field is meaningful per question
/// kind; the rest are omitted.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct AnswerDto {
    pub question_id: String,
    /// `text`, `long_text` and `single`.
    pub text: Option<String>,
    /// `multi`.
    pub choices: Option<Vec<String>>,
    /// `bool`.
    pub flag: Option<bool>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct CreateDocumentDto {
    pub type_key: String,
    pub title: String,
    /// The document body, verbatim. Omit it to start from the type's template.
    pub content: Option<String>,
    /// Answers to the type's questionnaire, composed into the body server-side.
    /// Mutually exclusive with `content` — sending both is refused rather than
    /// silently dropping one.
    pub answers: Option<Vec<AnswerDto>>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct UpdateDocumentDto {
    pub title: Option<String>,
    pub content: Option<String>,
    /// "draft", "review" or "approved" — forward-only.
    pub status: Option<String>,
}

// ── ingested-document bindings ───────────────────────────────────────────────

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct IngestedFileDto {
    /// Instance id of the artifact-graph file node holding this content.
    pub node_id: String,
    /// Repository path, e.g. `docs/adr/0007-shell-tokens.md`.
    pub path: String,
    /// The file's current text. Read to classify and validate; never stored.
    pub content: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ClassifyRequestDto {
    pub files: Vec<IngestedFileDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct TypeCandidateDto {
    pub type_key: String,
    /// 0.0–1.0.
    pub confidence: f64,
    /// Why this type scored what it did, in words, for the person deciding.
    pub why: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DocumentBindingDto {
    pub id: Uuid,
    pub tenant_id: Uuid,
    pub project_id: Option<Uuid>,
    /// True when this binding is inherited from the workspace into a project
    /// view (listed for a project but owned at workspace level).
    pub inherited: bool,
    pub node_id: String,
    pub path: String,
    /// The bound type, absent while undetermined.
    pub type_key: Option<String>,
    /// "detected" | "confirmed" | "manual" | "unknown" | "not_a_document".
    pub state: String,
    pub confidence: Option<f64>,
    /// "front_matter" | "heuristic" | "spec_quality" | "manual".
    pub source: Option<String>,
    /// What else it might be — what to offer when correcting the type.
    pub candidates: Vec<TypeCandidateDto>,
    /// Absent when the binding has no type and so nothing to be judged against.
    pub conforms: Option<bool>,
    /// The last validation in full — which sections are missing or thin.
    pub validation: Option<ValidationReportDto>,
    /// Digest of the content these verdicts were computed from, so a caller can
    /// tell a current verdict from one that predates a re-sync.
    pub content_sha: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DocumentBindingListDto {
    pub items: Vec<DocumentBindingDto>,
    /// Bindings in this scope across every page.
    pub total: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ClassifyResultDto {
    pub items: Vec<DocumentBindingDto>,
    /// Files that were not prose at all and so got no binding.
    pub skipped: i64,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct DecideBindingDto {
    /// What is being decided:
    /// - `confirm` — accept the proposed type;
    /// - `set` — bind `type_key`;
    /// - `reject` — this file is not a document;
    /// - `reset` — back to undetermined, so classification may propose again.
    pub action: String,
    /// Required for `set`.
    pub type_key: Option<String>,
    /// Who decided. Omit for a person; pass `spec_quality` when recording the
    /// external detector's verdict, which stays a proposal awaiting a person.
    pub source: Option<String>,
    /// The detector's confidence, for `source: spec_quality`.
    pub confidence: Option<f64>,
    /// The file's current text, to re-check conformance in the same call.
    pub content: Option<String>,
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

fn answers_from_dto(items: Vec<AnswerDto>) -> Vec<Answer> {
    items
        .into_iter()
        .map(|a| Answer {
            question_id: a.question_id,
            text: a.text,
            choices: a.choices,
            flag: a.flag,
        })
        .collect()
}

impl From<Capability> for CapabilityDto {
    fn from(c: Capability) -> Self {
        let (owner, owner_tenant_id) = match c.owner {
            Owner::Builtin => ("builtin".to_string(), None),
            Owner::Organization { tenant_id } => ("organization".to_string(), Some(tenant_id)),
            Owner::Workspace { tenant_id } => ("workspace".to_string(), Some(tenant_id)),
        };
        Self {
            key: c.key,
            label: c.label,
            terms: c.terms,
            owner,
            owner_tenant_id,
            hidden: c.hidden,
        }
    }
}

impl From<Analysis> for AnalysisDto {
    fn from(a: Analysis) -> Self {
        Self {
            document_id: a.document_id,
            detector: a.detector,
            state: a.state.as_str().to_string(),
            task_id: a.task_id,
            summary: a.summary,
            updated_at: a.updated_at,
        }
    }
}

impl From<StageStatus> for StageStatusDto {
    fn from(st: StageStatus) -> Self {
        Self {
            key: st.key,
            label: st.label,
            required: st.required,
            complete: st.complete,
            requirements: st
                .requirements
                .into_iter()
                .map(|r| RequirementDto {
                    type_key: r.type_key,
                    present: r.present,
                    conforms: r.conforms,
                    analyses_outstanding: r.analyses_outstanding,
                })
                .collect(),
        }
    }
}

impl From<Stage> for StageDto {
    fn from(st: Stage) -> Self {
        let (owner, owner_tenant_id) = match st.owner {
            Owner::Builtin => ("builtin".to_string(), None),
            Owner::Organization { tenant_id } => ("organization".to_string(), Some(tenant_id)),
            Owner::Workspace { tenant_id } => ("workspace".to_string(), Some(tenant_id)),
        };
        Self {
            key: st.key,
            label: st.label,
            required: st.required,
            position: st.position,
            requires: st.requires,
            gates: st.gates,
            owner,
            owner_tenant_id,
            hidden: st.hidden,
        }
    }
}

impl From<DocumentType> for DocumentTypeDto {
    fn from(t: DocumentType) -> Self {
        let (owner, owner_tenant_id) = match t.owner {
            Owner::Builtin => ("builtin".to_string(), None),
            Owner::Organization { tenant_id } => ("organization".to_string(), Some(tenant_id)),
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
            hidden: t.hidden,
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
        capabilities: d.capabilities,
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
    let items = service
        .list_types(&ctx, workspace_id)
        .await
        .map_err(internal)?;
    Ok(Json(DocumentTypeListDto {
        items: items.into_iter().map(Into::into).collect(),
    }))
}

/// List what an organization publishes to the workspaces under it.
async fn list_organization_types(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(organization_id): Path<Uuid>,
) -> ApiResult<JsonBody<DocumentTypeListDto>> {
    let items = service
        .list_organization_types(&ctx, organization_id)
        .await
        .map_err(no_tenant)?;
    Ok(Json(DocumentTypeListDto {
        items: items.into_iter().map(Into::into).collect(),
    }))
}

async fn upsert_workspace_type(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(workspace_id): Path<Uuid>,
    Json(body): Json<UpsertTypeDto>,
) -> ApiResult<JsonBody<DocumentTypeDto>> {
    upsert_type_at(
        ctx,
        service,
        Owner::Workspace {
            tenant_id: workspace_id,
        },
        workspace_id,
        body,
    )
    .await
}

async fn upsert_organization_type(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(organization_id): Path<Uuid>,
    Json(body): Json<UpsertTypeDto>,
) -> ApiResult<JsonBody<DocumentTypeDto>> {
    upsert_type_at(
        ctx,
        service,
        Owner::Organization {
            tenant_id: organization_id,
        },
        organization_id,
        body,
    )
    .await
}

/// The level a type lands on is the ROUTE's, never the payload's: an
/// organization-level write is authorized against the organization tenant, so
/// a workspace member cannot reach it by setting a field.
async fn upsert_type_at(
    ctx: SecurityContext,
    service: Arc<DocumentsService>,
    owner: Owner,
    tenant_id: Uuid,
    body: UpsertTypeDto,
) -> ApiResult<JsonBody<DocumentTypeDto>> {
    service
        .authorize(&ctx, tenant_id)
        .await
        .map_err(no_tenant)?;
    let ty = DocumentType {
        key: body.key,
        name: body.name,
        description: body.description.unwrap_or_default(),
        gts_type_id: String::new(),
        owner: owner.clone(),
        hidden: body.hidden.unwrap_or(false),
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
    let saved = service.upsert_type(owner, ty).await.map_err(invalid)?;
    Ok(Json(saved.into()))
}

/// The stages a workspace's projects may pass through, in catalogue order.
async fn list_stages(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(workspace_id): Path<Uuid>,
) -> ApiResult<JsonBody<StageListDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    let items = service
        .list_stages(&ctx, workspace_id)
        .await
        .map_err(internal)?;
    Ok(Json(StageListDto {
        items: items.into_iter().map(Into::into).collect(),
    }))
}

async fn list_organization_stages(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(organization_id): Path<Uuid>,
) -> ApiResult<JsonBody<StageListDto>> {
    let items = service
        .list_organization_stages(&ctx, organization_id)
        .await
        .map_err(no_tenant)?;
    Ok(Json(StageListDto {
        items: items.into_iter().map(Into::into).collect(),
    }))
}

async fn upsert_workspace_stage(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(workspace_id): Path<Uuid>,
    Json(body): Json<UpsertStageDto>,
) -> ApiResult<JsonBody<StageDto>> {
    upsert_stage_at(
        ctx,
        service,
        Owner::Workspace {
            tenant_id: workspace_id,
        },
        workspace_id,
        body,
    )
    .await
}

async fn upsert_organization_stage(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(organization_id): Path<Uuid>,
    Json(body): Json<UpsertStageDto>,
) -> ApiResult<JsonBody<StageDto>> {
    upsert_stage_at(
        ctx,
        service,
        Owner::Organization {
            tenant_id: organization_id,
        },
        organization_id,
        body,
    )
    .await
}

/// As for document types, the level is the ROUTE's and never the payload's.
async fn upsert_stage_at(
    ctx: SecurityContext,
    service: Arc<DocumentsService>,
    owner: Owner,
    tenant_id: Uuid,
    body: UpsertStageDto,
) -> ApiResult<JsonBody<StageDto>> {
    service
        .authorize(&ctx, tenant_id)
        .await
        .map_err(no_tenant)?;
    let st = Stage {
        key: body.key,
        label: body.label,
        required: body.required.unwrap_or(false),
        position: body.position.unwrap_or(0),
        requires: body.requires.unwrap_or_default(),
        gates: body.gates.unwrap_or_default(),
        owner: owner.clone(),
        hidden: body.hidden.unwrap_or(false),
    };
    let saved = service.upsert_stage(owner, st).await.map_err(invalid)?;
    Ok(Json(saved.into()))
}

/// Record one detector's verdict on a document.
///
/// The caller submits to `studio-spec-quality` and polls it -- that gear is a
/// stateless passthrough and always was. This is where the answer is kept, so
/// "the documentation passed analysis" becomes something a stage can depend on.
async fn record_analysis(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, id, detector)): Path<(Uuid, Uuid, String)>,
    Json(body): Json<RecordAnalysisDto>,
) -> ApiResult<JsonBody<AnalysisDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    let state = AnalysisState::parse(&body.state)
        .ok_or_else(|| invalid(anyhow::anyhow!("state must be pending, passed or failed")))?;
    let saved = service
        .record_analysis(
            workspace_id,
            id,
            &detector,
            state,
            body.task_id,
            body.summary.unwrap_or_default(),
        )
        .await
        .map_err(invalid)?;
    Ok(Json(saved.into()))
}

async fn list_project_analyses(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, project_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<JsonBody<AnalysisListDto>> {
    service
        .authorize(&ctx, project_id)
        .await
        .map_err(no_tenant)?;
    let items = service
        .list_analyses(workspace_id, Some(project_id))
        .await
        .map_err(internal)?;
    Ok(Json(AnalysisListDto {
        items: items.into_iter().map(Into::into).collect(),
    }))
}

/// Where a project stands against its workspace's stages.
async fn project_stage_status(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, project_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<JsonBody<StageStatusListDto>> {
    service
        .authorize(&ctx, project_id)
        .await
        .map_err(no_tenant)?;
    let items = service
        .stage_status(&ctx, workspace_id, project_id)
        .await
        .map_err(internal)?;
    Ok(Json(StageStatusListDto {
        items: items.into_iter().map(Into::into).collect(),
    }))
}

/// The capability vocabulary for a workspace.
async fn list_capabilities(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(workspace_id): Path<Uuid>,
) -> ApiResult<JsonBody<CapabilityListDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    let items = service
        .list_capabilities(&ctx, workspace_id)
        .await
        .map_err(internal)?;
    Ok(Json(CapabilityListDto {
        items: items.into_iter().map(Into::into).collect(),
    }))
}

async fn list_organization_capabilities(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(organization_id): Path<Uuid>,
) -> ApiResult<JsonBody<CapabilityListDto>> {
    let items = service
        .list_organization_capabilities(&ctx, organization_id)
        .await
        .map_err(no_tenant)?;
    Ok(Json(CapabilityListDto {
        items: items.into_iter().map(Into::into).collect(),
    }))
}

async fn upsert_workspace_capability(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(workspace_id): Path<Uuid>,
    Json(body): Json<UpsertCapabilityDto>,
) -> ApiResult<JsonBody<CapabilityDto>> {
    upsert_capability_at(
        ctx,
        service,
        Owner::Workspace {
            tenant_id: workspace_id,
        },
        workspace_id,
        body,
    )
    .await
}

async fn upsert_organization_capability(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(organization_id): Path<Uuid>,
    Json(body): Json<UpsertCapabilityDto>,
) -> ApiResult<JsonBody<CapabilityDto>> {
    upsert_capability_at(
        ctx,
        service,
        Owner::Organization {
            tenant_id: organization_id,
        },
        organization_id,
        body,
    )
    .await
}

async fn upsert_capability_at(
    ctx: SecurityContext,
    service: Arc<DocumentsService>,
    owner: Owner,
    tenant_id: Uuid,
    body: UpsertCapabilityDto,
) -> ApiResult<JsonBody<CapabilityDto>> {
    service
        .authorize(&ctx, tenant_id)
        .await
        .map_err(no_tenant)?;
    let cap = Capability {
        key: body.key,
        label: body.label,
        terms: body.terms.unwrap_or_default(),
        owner: owner.clone(),
        hidden: body.hidden.unwrap_or(false),
    };
    let saved = service
        .upsert_capability(owner, cap)
        .await
        .map_err(invalid)?;
    Ok(Json(saved.into()))
}

async fn delete_workspace_capability(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, key)): Path<(Uuid, String)>,
) -> ApiResult<StatusCode> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    service
        .delete_capability(
            Owner::Workspace {
                tenant_id: workspace_id,
            },
            &key,
        )
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_organization_capability(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((organization_id, key)): Path<(Uuid, String)>,
) -> ApiResult<StatusCode> {
    service
        .authorize(&ctx, organization_id)
        .await
        .map_err(no_tenant)?;
    service
        .delete_capability(
            Owner::Organization {
                tenant_id: organization_id,
            },
            &key,
        )
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Revert this level's entry for a key, so the level below shows through.
///
/// Idempotent: the request names a desired state ("this level defines nothing
/// for `key`"), so a second call, or a call for a key this level never
/// overrode, still answers 204. It never touches another level's row -- the
/// delete is scoped to the tenant in the path.
async fn delete_workspace_type(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, key)): Path<(Uuid, String)>,
) -> ApiResult<StatusCode> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    service
        .delete_type(
            Owner::Workspace {
                tenant_id: workspace_id,
            },
            &key,
        )
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_organization_type(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((organization_id, key)): Path<(Uuid, String)>,
) -> ApiResult<StatusCode> {
    service
        .authorize(&ctx, organization_id)
        .await
        .map_err(no_tenant)?;
    service
        .delete_type(
            Owner::Organization {
                tenant_id: organization_id,
            },
            &key,
        )
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_workspace_stage(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, key)): Path<(Uuid, String)>,
) -> ApiResult<StatusCode> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    service
        .delete_stage(
            Owner::Workspace {
                tenant_id: workspace_id,
            },
            &key,
        )
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_organization_stage(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((organization_id, key)): Path<(Uuid, String)>,
) -> ApiResult<StatusCode> {
    service
        .authorize(&ctx, organization_id)
        .await
        .map_err(no_tenant)?;
    service
        .delete_stage(
            Owner::Organization {
                tenant_id: organization_id,
            },
            &key,
        )
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_workspace_documents(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(workspace_id): Path<Uuid>,
    Query(page): Query<PageQuery>,
) -> ApiResult<JsonBody<DocumentListDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    let (items, total) = service
        .list_documents(workspace_id, None, page)
        .await
        .map_err(internal)?;
    Ok(Json(DocumentListDto {
        items: items.into_iter().map(|d| document_dto(d, false)).collect(),
        total,
    }))
}

async fn list_project_documents(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, project_id)): Path<(Uuid, Uuid)>,
    Query(page): Query<PageQuery>,
) -> ApiResult<JsonBody<DocumentListDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    service
        .authorize(&ctx, project_id)
        .await
        .map_err(no_tenant)?;
    let (items, total) = service
        .list_documents(workspace_id, Some(project_id), page)
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
        total,
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
            &ctx,
            workspace_id,
            None,
            &body.type_key,
            &body.title,
            body.content,
            body.answers.map(answers_from_dto),
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
            &ctx,
            workspace_id,
            Some(project_id),
            &body.type_key,
            &body.title,
            body.content,
            body.answers.map(answers_from_dto),
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
        .update_document(&ctx, workspace_id, id, body.title, body.content, status)
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
        .validate_document(&ctx, workspace_id, id)
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

// ── ingested-document bindings ───────────────────────────────────────────────

fn binding_dto(b: DocumentBinding, inherited: bool) -> DocumentBindingDto {
    DocumentBindingDto {
        id: b.id,
        tenant_id: b.tenant_id,
        project_id: b.project_id,
        inherited,
        node_id: b.node_id,
        path: b.path,
        type_key: b.type_key,
        state: b.state.as_str().to_string(),
        confidence: b.confidence.map(f64::from),
        source: b.source.map(|s| s.as_str().to_string()),
        candidates: b
            .candidates
            .into_iter()
            .map(|c| TypeCandidateDto {
                type_key: c.type_key,
                confidence: f64::from(c.confidence),
                why: c.why,
            })
            .collect(),
        conforms: b.conforms,
        validation: b.validation.map(Into::into),
        content_sha: b.content_sha,
        created_at: b.created_at,
        updated_at: b.updated_at,
    }
}

fn ingested_files(body: ClassifyRequestDto) -> Vec<IngestedFile> {
    body.files
        .into_iter()
        .map(|f| IngestedFile {
            node_id: f.node_id,
            path: f.path,
            content: f.content,
        })
        .collect()
}

/// Parse the decision, rejecting the combinations that cannot mean anything —
/// a `set` with no type, or a source the caller is not allowed to claim.
fn binding_decision(body: DecideBindingDto) -> Result<BindingDecision, CanonicalError> {
    let action = match body.action.trim() {
        "confirm" => BindingAction::Confirm,
        "set" => {
            let type_key = body.type_key.clone().unwrap_or_default();
            if type_key.trim().is_empty() {
                return Err(DocumentsError::invalid_argument()
                    .with_constraint("action \"set\" requires type_key")
                    .create());
            }
            BindingAction::Set { type_key }
        }
        "reject" => BindingAction::Reject,
        "reset" => BindingAction::Reset,
        other => {
            return Err(DocumentsError::invalid_argument()
                .with_constraint(format!(
                    "unknown action \"{other}\" — expected confirm, set, reject or reset"
                ))
                .create());
        }
    };
    // Only the two sources a caller can legitimately speak for: itself
    // (`manual`) or the external detector whose verdict it is relaying.
    let source = match body.source.as_deref().map(str::trim) {
        None | Some("") | Some("manual") => None,
        Some("spec_quality") => Some(DetectionSource::SpecQuality),
        Some(other) => {
            return Err(DocumentsError::invalid_argument()
                .with_constraint(format!(
                    "source \"{other}\" cannot be claimed here — expected manual or spec_quality"
                ))
                .create());
        }
    };
    Ok(BindingDecision {
        action,
        source,
        confidence: body.confidence.map(|c| c as f32),
        content: body.content,
    })
}

async fn classify_workspace_files(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(workspace_id): Path<Uuid>,
    Json(body): Json<ClassifyRequestDto>,
) -> ApiResult<JsonBody<ClassifyResultDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    let outcome = service
        .classify_ingested(&ctx, workspace_id, None, ingested_files(body))
        .await
        .map_err(internal)?;
    Ok(Json(ClassifyResultDto {
        items: outcome
            .bindings
            .into_iter()
            .map(|b| binding_dto(b, false))
            .collect(),
        skipped: outcome.skipped as i64,
    }))
}

async fn classify_project_files(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, project_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<ClassifyRequestDto>,
) -> ApiResult<JsonBody<ClassifyResultDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    service
        .authorize(&ctx, project_id)
        .await
        .map_err(no_tenant)?;
    let outcome = service
        .classify_ingested(&ctx, workspace_id, Some(project_id), ingested_files(body))
        .await
        .map_err(internal)?;
    Ok(Json(ClassifyResultDto {
        items: outcome
            .bindings
            .into_iter()
            .map(|b| binding_dto(b, false))
            .collect(),
        skipped: outcome.skipped as i64,
    }))
}

async fn list_workspace_bindings(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(workspace_id): Path<Uuid>,
    Query(page): Query<PageQuery>,
) -> ApiResult<JsonBody<DocumentBindingListDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    let (items, total) = service
        .list_bindings(workspace_id, None, page)
        .await
        .map_err(internal)?;
    Ok(Json(DocumentBindingListDto {
        items: items.into_iter().map(|b| binding_dto(b, false)).collect(),
        total,
    }))
}

async fn list_project_bindings(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, project_id)): Path<(Uuid, Uuid)>,
    Query(page): Query<PageQuery>,
) -> ApiResult<JsonBody<DocumentBindingListDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    service
        .authorize(&ctx, project_id)
        .await
        .map_err(no_tenant)?;
    let (items, total) = service
        .list_bindings(workspace_id, Some(project_id), page)
        .await
        .map_err(internal)?;
    Ok(Json(DocumentBindingListDto {
        items: items
            .into_iter()
            .map(|b| {
                let inherited = b.project_id.is_none();
                binding_dto(b, inherited)
            })
            .collect(),
        total,
    }))
}

async fn decide_binding(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<DecideBindingDto>,
) -> ApiResult<JsonBody<DocumentBindingDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    let decision = binding_decision(body)?;
    let binding = service
        .decide_binding(&ctx, workspace_id, id, decision)
        .await
        .map_err(invalid)?;
    Ok(Json(binding_dto(binding, false)))
}

async fn delete_binding(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    service
        .delete_binding(workspace_id, id)
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
        .description(
            "Returns the document types this workspace actually sees: the \
             organization's, plus the workspace's own definitions and overrides, \
             minus the ones it hides.",
        )
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
        .summary("Define, replace or hide a document type in one workspace")
        .description(
            "Defines a document type for this workspace, replaces its definition, \
             or hides an inherited one with a tombstone. The level is the route's \
             and never the payload's, so a workspace member cannot reach the \
             organization level by setting a field.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace tenant id")
        .json_request::<UpsertTypeDto>(openapi, "Document type")
        .handler(upsert_workspace_type)
        .json_response_with_schema::<DocumentTypeDto>(openapi, StatusCode::OK, "Saved type")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/organizations/{organization_id}/types")
        .operation_id("studio_documents.list_organization_types")
        .summary("List the document types an organization publishes")
        .description(
            "The organization's own editing view: the platform catalogue overlaid by its              entries. Not what a workspace sees -- a workspace may replace or hide any of it.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("organization_id", "Organization tenant id")
        .handler(list_organization_types)
        .json_response_with_schema::<DocumentTypeListDto>(openapi, StatusCode::OK, "Document types")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/organizations/{organization_id}/types")
        .operation_id("studio_documents.upsert_organization_type")
        .summary("Define, replace or hide a document type for every workspace in an organization")
        .description(
            "Defines or replaces a document type for every workspace in the \
             organization; a workspace can still override or hide it. Authorized \
             against the organization tenant, because the level is the route's.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("organization_id", "Organization tenant id")
        .json_request::<UpsertTypeDto>(openapi, "Document type")
        .handler(upsert_organization_type)
        .json_response_with_schema::<DocumentTypeDto>(openapi, StatusCode::OK, "Saved type")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::put(
        "/studio-documents/v1/workspaces/{workspace_id}/documents/{id}/analyses/{detector}",
    )
    .operation_id("studio_documents.record_analysis")
    .summary("Record one detector's verdict on a document")
    .description(
        "studio-spec-quality is a stateless passthrough: the caller submits the analysis \
         and polls it, then records the outcome here. Keeping the verdict is what lets a \
         stage depend on it.",
    )
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace tenant id")
    .path_param("id", "Document id")
    .path_param("detector", "Detector name, e.g. bloat")
    .json_request::<RecordAnalysisDto>(openapi, "Verdict")
    .handler(record_analysis)
    .json_response_with_schema::<AnalysisDto>(openapi, StatusCode::OK, "Recorded verdict")
    .error_400(openapi)
    .error_401(openapi)
    .error_403(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::get(
        "/studio-documents/v1/workspaces/{workspace_id}/projects/{project_id}/analyses",
    )
    .operation_id("studio_documents.list_project_analyses")
    .summary("Every recorded verdict for a project's effective documents")
    .description(
        "Returns every quality verdict recorded against the documents this \
         project sees, its own and the ones inherited from the workspace, so a \
         stage gate can be answered without re-running the detectors.",
    )
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace tenant id")
    .path_param("project_id", "Project tenant id")
    .handler(list_project_analyses)
    .json_response_with_schema::<AnalysisListDto>(openapi, StatusCode::OK, "Verdicts")
    .error_401(openapi)
    .error_403(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::get(
        "/studio-documents/v1/workspaces/{workspace_id}/projects/{project_id}/stage-status",
    )
    .operation_id("studio_documents.project_stage_status")
    .summary("Where a project stands against its workspace's stages")
    .description(
        "Per stage: the document types it requires, whether each is present and conforming, \
         and which gating detectors have not passed. Computed, never stored -- a stored \
         completion flag goes stale the moment a document is edited.",
    )
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace tenant id")
    .path_param("project_id", "Project tenant id")
    .handler(project_stage_status)
    .json_response_with_schema::<StageStatusListDto>(openapi, StatusCode::OK, "Stage status")
    .error_401(openapi)
    .error_403(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/workspaces/{workspace_id}/stages")
        .operation_id("studio_documents.list_stages")
        .summary("List the journey stages a workspace's projects may pass through")
        .description(
            "In catalogue order. Replaces the client-side `JOURNEY_STAGES` constant two              frontends have been carrying since the studio-project gear was retired              (ADR-0010, ADR-0014 section 7).",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace tenant id")
        .handler(list_stages)
        .json_response_with_schema::<StageListDto>(openapi, StatusCode::OK, "Journey stages")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/workspaces/{workspace_id}/stages")
        .operation_id("studio_documents.upsert_stage")
        .summary("Define, replace or hide a journey stage in one workspace")
        .description(
            "Defines a journey stage for this workspace, replaces it, or hides an \
             inherited one. Order is part of the definition, so rewriting a stage \
             moves it in place.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace tenant id")
        .json_request::<UpsertStageDto>(openapi, "Journey stage")
        .handler(upsert_workspace_stage)
        .json_response_with_schema::<StageDto>(openapi, StatusCode::OK, "Saved stage")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/organizations/{organization_id}/stages")
        .operation_id("studio_documents.list_organization_stages")
        .summary("List the journey stages an organization publishes")
        .description(
            "Returns the journey stages the organization publishes to its \
             workspaces, before any workspace override.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("organization_id", "Organization tenant id")
        .handler(list_organization_stages)
        .json_response_with_schema::<StageListDto>(openapi, StatusCode::OK, "Journey stages")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/organizations/{organization_id}/stages")
        .operation_id("studio_documents.upsert_organization_stage")
        .summary("Define, replace or hide a journey stage for every workspace in an organization")
        .description(
            "Defines or replaces a journey stage for every workspace in the \
             organization; a workspace can override or hide it.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("organization_id", "Organization tenant id")
        .json_request::<UpsertStageDto>(openapi, "Journey stage")
        .handler(upsert_organization_stage)
        .json_response_with_schema::<StageDto>(openapi, StatusCode::OK, "Saved stage")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/workspaces/{workspace_id}/capabilities")
        .operation_id("studio_documents.list_capabilities")
        .summary("List the capability vocabulary for a workspace")
        .description(
            "A questionnaire answer seeds a capability, and the composer resolves it to              candidate components through this entry's search terms. Replaces the              `CAP_KEYWORDS` table the prototype carried in a UI file.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace tenant id")
        .handler(list_capabilities)
        .json_response_with_schema::<CapabilityListDto>(openapi, StatusCode::OK, "Capabilities")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/organizations/{organization_id}/capabilities")
        .operation_id("studio_documents.list_organization_capabilities")
        .summary("List the capability vocabulary an organization publishes")
        .description(
            "A questionnaire answer seeds a capability, and the composer resolves it to              candidate components through this entry's search terms. Replaces the              `CAP_KEYWORDS` table the prototype carried in a UI file.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("organization_id", "Organization tenant id")
        .handler(list_organization_capabilities)
        .json_response_with_schema::<CapabilityListDto>(openapi, StatusCode::OK, "Capabilities")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/workspaces/{workspace_id}/capabilities")
        .operation_id("studio_documents.upsert_capability")
        .summary("Define, replace or hide a capability in one workspace")
        .description(
            "Defines what a document may claim at a stage in this workspace, \
             replaces it, or hides an inherited capability.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace tenant id")
        .json_request::<UpsertCapabilityDto>(openapi, "Capability")
        .handler(upsert_workspace_capability)
        .json_response_with_schema::<CapabilityDto>(openapi, StatusCode::OK, "Saved capability")
        .error_400(openapi)
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router =
        OperationBuilder::post("/studio-documents/v1/organizations/{organization_id}/capabilities")
            .operation_id("studio_documents.upsert_organization_capability")
            .summary("Define, replace or hide a capability for every workspace in an organization")
            .description(
                "The same for every workspace in the organization. A capability \
                 and a stage may share a key: they are separate namespaces.",
            )
            .tag("StudioDocuments")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("organization_id", "Organization tenant id")
            .json_request::<UpsertCapabilityDto>(openapi, "Capability")
            .handler(upsert_organization_capability)
            .json_response_with_schema::<CapabilityDto>(openapi, StatusCode::OK, "Saved capability")
            .error_400(openapi)
            .error_401(openapi)
            .error_403(openapi)
            .error_500(openapi)
            .register(router, openapi);

    router = OperationBuilder::delete(
        "/studio-documents/v1/workspaces/{workspace_id}/capabilities/{key}",
    )
    .operation_id("studio_documents.delete_capability")
    .summary("Revert a workspace's own capability, falling back to what it inherits")
    .description(
        "Drops this workspace's own definition of a capability, so it falls back \
         to what the organization publishes. Reverting a key the workspace never \
         overrode is not an error.",
    )
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace tenant id")
    .path_param("key", "Catalogue entry key")
    .handler(delete_workspace_capability)
    .no_content_response(StatusCode::NO_CONTENT, "Reverted")
    .error_401(openapi)
    .error_403(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::delete(
        "/studio-documents/v1/organizations/{organization_id}/capabilities/{key}",
    )
    .operation_id("studio_documents.delete_organization_capability")
    .summary("Revert an organization's own capability, falling back to the platform catalogue")
    .description(
        "Drops the organization's own definition of a capability, so it falls \
         back to the platform catalogue. Workspaces that override it keep their \
         own.",
    )
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("organization_id", "Organization tenant id")
    .path_param("key", "Catalogue entry key")
    .handler(delete_organization_capability)
    .no_content_response(StatusCode::NO_CONTENT, "Reverted")
    .error_401(openapi)
    .error_403(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::delete("/studio-documents/v1/workspaces/{workspace_id}/types/{key}")
        .operation_id("studio_documents.delete_type")
        .summary("Revert a workspace's own document type, falling back to what it inherits")
        .description(
            "Removes only this level's row. Idempotent: a key this level never              overrode still answers 204, because the request names a desired state.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace tenant id")
        .path_param("key", "Catalogue entry key")
        .handler(delete_workspace_type)
        .no_content_response(StatusCode::NO_CONTENT, "Reverted")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-documents/v1/organizations/{organization_id}/types/{key}")
        .operation_id("studio_documents.delete_organization_type")
        .summary("Revert an organization's own document type, falling back to the platform catalogue")
        .description(
            "Removes only this level's row. Idempotent: a key this level never              overrode still answers 204, because the request names a desired state.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("organization_id", "Organization tenant id")
        .path_param("key", "Catalogue entry key")
        .handler(delete_organization_type)
        .no_content_response(StatusCode::NO_CONTENT, "Reverted")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-documents/v1/workspaces/{workspace_id}/stages/{key}")
        .operation_id("studio_documents.delete_stage")
        .summary("Revert a workspace's own journey stage, falling back to what it inherits")
        .description(
            "Removes only this level's row. Idempotent: a key this level never              overrode still answers 204, because the request names a desired state.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace tenant id")
        .path_param("key", "Catalogue entry key")
        .handler(delete_workspace_stage)
        .no_content_response(StatusCode::NO_CONTENT, "Reverted")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-documents/v1/organizations/{organization_id}/stages/{key}")
        .operation_id("studio_documents.delete_organization_stage")
        .summary("Revert an organization's own journey stage, falling back to the platform catalogue")
        .description(
            "Removes only this level's row. Idempotent: a key this level never              overrode still answers 204, because the request names a desired state.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("organization_id", "Organization tenant id")
        .path_param("key", "Catalogue entry key")
        .handler(delete_organization_stage)
        .no_content_response(StatusCode::NO_CONTENT, "Reverted")
        .error_401(openapi)
        .error_403(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/workspaces/{workspace_id}/documents")
        .operation_id("studio_documents.list_workspace_documents")
        .summary("List workspace-level documents")
        .description(
            "Returns the workspace-level documents — the ones every project in \
             the workspace inherits. A project's own documents are under the \
             project route.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("workspace_id", "Workspace tenant id")
        .query_param_typed(
            "offset",
            false,
            "Zero-based index of the first document",
            "integer",
        )
        .query_param_typed("limit", false, "Page size, 1..=200 (default 50)", "integer")
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
    .description(
        "Returns the documents this project effectively has: its own, plus the \
         workspace-level ones it inherits. Inheritance is a column filter, not a \
         cross-tenant read.",
    )
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace tenant id")
    .path_param("project_id", "Project tenant id")
    .query_param_typed(
        "offset",
        false,
        "Zero-based index of the first document",
        "integer",
    )
    .query_param_typed("limit", false, "Page size, 1..=200 (default 50)", "integer")
    .handler(list_project_documents)
    .json_response_with_schema::<DocumentListDto>(openapi, StatusCode::OK, "Effective documents")
    .error_401(openapi)
    .error_403(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/workspaces/{workspace_id}/documents")
        .operation_id("studio_documents.create_workspace_document")
        .summary("Create a workspace-level document from a type")
        .description(
            "Creates a workspace-level document from a type, seeded with that \
             type's markdown template and section checklist.",
        )
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
    .description(
        "Creates a document owned by this project rather than by the workspace, \
         seeded from its type's template and section checklist.",
    )
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
        .description("Returns one document with its content, type, stage and status.")
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
        .description(
            "Updates a document's content, title or status. Fields left out of \
             the body are left as they are.",
        )
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
    .description(
        "Re-runs the type's structural rules and section checklist against the \
         document as it stands now, and records the verdict. Nothing about the \
         document changes.",
    )
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

    router =
        OperationBuilder::delete("/studio-documents/v1/workspaces/{workspace_id}/documents/{id}")
            .operation_id("studio_documents.delete_document")
            .summary("Delete a document")
            .description(
                "Deletes the document, and the quality verdicts recorded against it \
             with it.",
            )
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
            .register(router, openapi);

    // ── ingested-document bindings ──────────────────────────────────────────
    // Classification reads content the caller already holds (it loaded the
    // files to show them) rather than reaching into the artifact graph itself:
    // this gear owns document types, not the graph, and staying a pure function
    // of (path, content, catalogue) keeps it testable and keeps the graph the
    // single copy of the bytes.
    const CLASSIFY_DESC: &str = "Classify ingested files against the workspace's effective \
         document types and record the result as bindings. A binding a person has \
         already ruled on keeps its type; only its conformance is refreshed. Files \
         whose path is not prose (source, images, lockfiles) get no binding and are \
         counted as skipped. Send a few dozen files per call — the whole repository \
         in one body exceeds the gateway's request-size limit.";

    router = OperationBuilder::post(
        "/studio-documents/v1/workspaces/{workspace_id}/document-bindings/classify",
    )
    .operation_id("studio_documents.classify_workspace_files")
    .summary("Classify ingested files at workspace level")
    .description(CLASSIFY_DESC)
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace tenant id")
    .json_request::<ClassifyRequestDto>(openapi, "Ingested files to classify")
    .handler(classify_workspace_files)
    .json_response_with_schema::<ClassifyResultDto>(
        openapi,
        StatusCode::OK,
        "Bindings written, and how many files were skipped",
    )
    .error_400(openapi)
    .error_401(openapi)
    .error_403(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::post(
        "/studio-documents/v1/workspaces/{workspace_id}/projects/{project_id}/document-bindings/classify",
    )
    .operation_id("studio_documents.classify_project_files")
    .summary("Classify ingested files for a project")
    .description(CLASSIFY_DESC)
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace tenant id")
    .path_param("project_id", "Project tenant id")
    .json_request::<ClassifyRequestDto>(openapi, "Ingested files to classify")
    .handler(classify_project_files)
    .json_response_with_schema::<ClassifyResultDto>(
        openapi,
        StatusCode::OK,
        "Bindings written, and how many files were skipped",
    )
    .error_400(openapi)
    .error_401(openapi)
    .error_403(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router =
        OperationBuilder::get("/studio-documents/v1/workspaces/{workspace_id}/document-bindings")
            .operation_id("studio_documents.list_workspace_bindings")
            .summary("List workspace-level document bindings")
            .description(
                "What the workspace's own ingested files were decided to be: the type                  bound to each, how it was decided, and how it fared against that                  type's template. A project's own bindings are not here — read those                  through the project route, which also returns these as inherited.",
            )
            .tag("StudioDocuments")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("workspace_id", "Workspace tenant id")
            .query_param_typed(
                "offset",
                false,
                "Zero-based index of the first binding",
                "integer",
            )
            .query_param_typed("limit", false, "Page size, 1..=200 (default 50)", "integer")
            .handler(list_workspace_bindings)
            .json_response_with_schema::<DocumentBindingListDto>(
                openapi,
                StatusCode::OK,
                "Workspace-level bindings",
            )
            .error_401(openapi)
            .error_403(openapi)
            .error_500(openapi)
            .register(router, openapi);

    router = OperationBuilder::get(
        "/studio-documents/v1/workspaces/{workspace_id}/projects/{project_id}/document-bindings",
    )
    .operation_id("studio_documents.list_project_bindings")
    .summary("List a project's effective document bindings")
    .description(
        "The project's own bindings plus the workspace-level ones it inherits \
         (flagged `inherited`).",
    )
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace tenant id")
    .path_param("project_id", "Project tenant id")
    .query_param_typed(
        "offset",
        false,
        "Zero-based index of the first binding",
        "integer",
    )
    .query_param_typed("limit", false, "Page size, 1..=200 (default 50)", "integer")
    .handler(list_project_bindings)
    .json_response_with_schema::<DocumentBindingListDto>(
        openapi,
        StatusCode::OK,
        "Effective bindings for the project",
    )
    .error_401(openapi)
    .error_403(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::put(
        "/studio-documents/v1/workspaces/{workspace_id}/document-bindings/{id}",
    )
    .operation_id("studio_documents.decide_binding")
    .summary("Confirm, correct, reject or reset a document binding")
    .description(
        "Rule on what an ingested file is. `confirm` accepts the proposed type, \
                 `set` binds one outright, `reject` marks the file as not a document, and \
                 `reset` puts it back in the undecided queue. Pass `content` to re-check \
                 conformance against the new type in the same call. A binding a person has \
                 ruled on is never re-guessed by a later classification run.",
    )
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace tenant id")
    .path_param("id", "Binding id")
    .json_request::<DecideBindingDto>(openapi, "The decision to apply")
    .handler(decide_binding)
    .json_response_with_schema::<DocumentBindingDto>(
        openapi,
        StatusCode::OK,
        "The binding after the decision",
    )
    .error_400(openapi)
    .error_401(openapi)
    .error_403(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router = OperationBuilder::delete(
        "/studio-documents/v1/workspaces/{workspace_id}/document-bindings/{id}",
    )
    .operation_id("studio_documents.delete_binding")
    .summary("Forget a document binding")
    .description(
        "Removes the record only — the file itself lives in the artifact graph and is \
         untouched. A later classification run may propose a type for it again.",
    )
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace tenant id")
    .path_param("id", "Binding id")
    .handler(delete_binding)
    .no_content_response(StatusCode::NO_CONTENT, "Binding forgotten")
    .error_401(openapi)
    .error_403(openapi)
    .error_500(openapi)
    .register(router, openapi);

    router.layer(Extension(service))
}
