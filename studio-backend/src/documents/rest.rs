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
    BindingState, Capability, DetectionSource, DocStatus, Document, DocumentBinding, DocumentType,
    Owner, Question, QuestionKind, Rules, Section, Stage, TemplateSpec,
};
use super::review_guide::{ReviewGuide, effective_guide, parse_checklist};
use super::service::{BindingAction, BindingDecision, DocumentsService, IngestedFile};
use super::validate::{SectionStatus, ValidationReport};
use crate::pagination::{PageQuery, page_of};

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
    /// Other headings that count as this section; omitted when there are none.
    pub aliases: Option<Vec<String>>,
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
    /// The Studio document this verdict is about, when it is about one.
    pub document_id: Option<Uuid>,
    /// The bound repository file it is about, when it is about one of those.
    /// Exactly one of the two is set.
    pub binding_id: Option<Uuid>,
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
    /// Verdicts recorded for this project across every page, so a caller can
    /// show "N of M" and knows a next page exists exactly when
    /// `offset + items.len() < total`.
    pub total: u32,
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
    pub status: DocStatus,
    pub conforms: bool,
    /// Capability keys the document declares, from its front matter. The
    /// composer reads these; a client must not parse the body itself.
    pub capabilities: Vec<String>,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
    /// Where this document would go in a repository: `docs/<type>/<slug>.md`.
    ///
    /// A SUGGESTION, not a contract — the publish form shows it in a field
    /// somebody can edit, and the write takes whatever path it is given. It is
    /// served because the convention is one: it decided where every document
    /// this product has written ended up, and it lived only in one portal's
    /// source. A second portal inventing its own would scatter the same
    /// documents across two layouts in one repository.
    pub suggested_path: String,
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
    /// This entry's own review checklist, markdown in the kit's shape (one
    /// `### <ID>: <title>` heading per criterion). Omit both review fields to
    /// keep the entry's current guide; send both empty to clear it, so the
    /// built-in guide for the key applies again. A guide is replaced whole,
    /// never merged.
    pub review_checklist: Option<String>,
    /// This entry's own review rules, markdown, served as-is.
    pub review_rules: Option<String>,
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
    pub state: BindingState,
    pub confidence: Option<f64>,
    pub source: Option<DetectionSource>,
    /// What else it might be — what to offer when correcting the type.
    pub candidates: Vec<TypeCandidateDto>,
    /// Absent when the binding has no type and so nothing to be judged against.
    pub conforms: Option<bool>,
    /// The last validation in full — which sections are missing or thin.
    pub validation: Option<ValidationReportDto>,
    /// The capability keys the file's front matter declares (`capabilities:
    /// a, b`). What the Composer reads from a bound file.
    pub capabilities: Vec<String>,
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
    /// Files recorded as not documents, by their path.
    pub not_documents: i64,
    /// Files left as they were, because a person had ruled on them or Spec
    /// Quality had paid for the answer.
    pub kept: i64,
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
            aliases: (!s.aliases.is_empty()).then_some(s.aliases),
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
            binding_id: a.binding_id,
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
        aliases: s.aliases.unwrap_or_default(),
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

fn parse_status(s: &str) -> Option<DocStatus> {
    match s.trim().to_ascii_lowercase().as_str() {
        "draft" => Some(DocStatus::Draft),
        "review" => Some(DocStatus::Review),
        "approved" => Some(DocStatus::Approved),
        _ => None,
    }
}

fn document_dto(d: Document, inherited: bool) -> DocumentDto {
    // Read before the fields move into the DTO below.
    let suggested_path = super::paths::suggested_path(&d.type_key, &d.title);
    DocumentDto {
        id: d.id,
        tenant_id: d.tenant_id,
        project_id: d.project_id,
        inherited,
        type_key: d.type_key,
        title: d.title,
        content: d.content,
        status: d.status,
        conforms: d.conforms,
        capabilities: d.capabilities,
        suggested_path,
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
            review: match (body.review_checklist, body.review_rules) {
                (None, None) => None,
                (checklist, rules) => Some(ReviewGuide {
                    checklist: checklist.unwrap_or_default(),
                    rules: rules.unwrap_or_default(),
                }),
            },
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

/// The same for a document that lives in the repository: the verdict is
/// recorded against its binding, which is what a stage gate reads.
async fn record_binding_analysis(
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
        .record_binding_analysis(
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
    Query(page): Query<PageQuery>,
) -> ApiResult<JsonBody<AnalysisListDto>> {
    service
        .authorize(&ctx, project_id)
        .await
        .map_err(no_tenant)?;
    let items = service
        .list_analyses(workspace_id, Some(project_id))
        .await
        .map_err(internal)?;
    // This is the collection here that grows without a ceiling: one row per
    // detector per document per run, kept so a stage gate never has to re-run
    // them. A project that has been analysed for a year answers with a year of
    // verdicts unless the response is bounded.
    let items: Vec<AnalysisDto> = items.into_iter().map(Into::into).collect();
    let (items, total) = page_of(items, page);
    Ok(Json(AnalysisListDto { items, total }))
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

/// A document that declares a capability.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CapabilitySourceDto {
    /// `document` (held by Studio) or `file` (a bound repository file).
    pub kind: String,
    pub id: Uuid,
    /// The document's title, or the file's repository path.
    pub label: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeclaredCapabilityDto {
    /// The capability key, as the vocabulary names it (`auth`, `storage`, …).
    pub key: String,
    pub sources: Vec<CapabilitySourceDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeclaredCapabilityListDto {
    pub items: Vec<DeclaredCapabilityDto>,
    /// Every capability is in `items`: the set is small and read whole.
    pub total: u32,
}

async fn list_declared_capabilities(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Query(query): Query<SpecScopeQuery>,
) -> ApiResult<JsonBody<DeclaredCapabilityListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let items: Vec<DeclaredCapabilityDto> = service
        .declared_capabilities(workspace_id, project_id)
        .await
        .map_err(internal)?
        .into_iter()
        .map(|c| DeclaredCapabilityDto {
            key: c.key,
            sources: c
                .sources
                .into_iter()
                .map(|s| CapabilitySourceDto {
                    kind: s.kind,
                    id: s.id,
                    label: s.label,
                })
                .collect(),
        })
        .collect();
    let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
    Ok(Json(DeclaredCapabilityListDto { items, total }))
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
        state: b.state,
        confidence: b.confidence.map(f64::from),
        source: b.source,
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
        capabilities: b.capabilities,
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
        not_documents: outcome.not_documents as i64,
        kept: outcome.kept as i64,
    }))
}

/// What the quality route resolves per request.
///
/// Lazily, and separately from the service, for the reason the components
/// catalogue does the same: neither the checkout reader nor the task queue is
/// this gear's, and holding a handle from `init` would make this gear care
/// about which gear initialised first. Absent is a normal state with a plain
/// answer rather than a panic.
#[derive(Clone)]
pub struct Quality {
    hub: Arc<toolkit::client_hub::ClientHub>,
}

impl Quality {
    fn reader(&self) -> ApiResult<Arc<dyn crate::artifact_ingest::port::RepoFileReader>> {
        self.hub
            .get::<dyn crate::artifact_ingest::port::RepoFileReader>()
            .map_err(|_| {
                CanonicalError::service_unavailable()
                    .with_detail(
                        "documents cannot be analysed in this deployment: nothing here \
                         holds a checkout to read them from",
                    )
                    .create()
            })
    }

    /// The ingested files, for the Specs list.
    ///
    /// Absent is not fatal here and must not be: a project with no ingest gear
    /// still has its authored documents and its bindings, and losing the
    /// never-classified files costs one queue rather than the screen. The
    /// caller is told which, through `files_known`.
    fn files(&self) -> Option<Arc<dyn crate::artifact_ingest::port::ArtifactFiles>> {
        self.hub
            .get::<dyn crate::artifact_ingest::port::ArtifactFiles>()
            .ok()
    }

    fn queue(&self) -> ApiResult<Arc<dyn crate::tasks::TaskQueue>> {
        self.hub
            .get_scoped::<dyn crate::tasks::TaskQueue>(&toolkit::client_hub::ClientScope::gts_id(
                crate::tasks::TASK_QUEUE_INSTANCE_ID,
            ))
            .map_err(|_| {
                CanonicalError::service_unavailable()
                    .with_detail(
                        "documents cannot be analysed in this deployment \
                         (studio-tasks has no database configured)",
                    )
                    .create()
            })
    }
}

/// Which bindings to analyse. Their TEXT is not here, and that is the point —
/// except for `documents`, which is text the server cannot have.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct AnalyzeBindingsRequest {
    /// Bindings this run should cover. Naming them is the caller's decision —
    /// which documents deserve a detector is policy, and only the reading of
    /// them moved to the server.
    #[serde(default)]
    pub binding_ids: Vec<Uuid>,
    /// Documents written in Studio this run should cover too. Their text is
    /// the document's own, and each is named in the run by
    /// `studio-doc/<id>.md`, the path its verdict comes back under.
    #[serde(default)]
    pub document_ids: Vec<Uuid>,
    /// Texts the caller holds and the server does not: an editor's unsaved
    /// buffer, or a desktop checkout that is ahead of the server's. Each is
    /// analysed as given, under its `path`, which the run echoes back; one
    /// whose path is also a named binding's replaces that binding's copy
    /// rather than being judged beside it. Bounded — see
    /// `quality::MAX_INLINE_DOCUMENTS` and the byte caps next to it.
    #[serde(default)]
    pub documents: Vec<InlineDocumentDto>,
}

/// One text to analyse as it stands on the caller's screen.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct InlineDocumentDto {
    /// Repo-relative path, or `studio-doc/<id>.md` for a document written in
    /// Studio. The id the run reports this document's verdict under.
    pub path: String,
    /// The text itself, verbatim.
    pub text: String,
    /// The type it is judged against, for the detector that needs one
    /// (`leak`). Omitted, it takes the type of the binding at the same path,
    /// when the request names one.
    pub type_key: Option<String>,
}

/// The run doing the work.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct AnalyzeEnqueuedDto {
    pub run_id: String,
    /// Where to follow it, the same way every other run in the assembly is
    /// followed.
    pub poll: String,
    /// How many documents the run will actually analyse. Lower than the
    /// bindings asked for when a checkout does not hold one of them.
    pub documents: i64,
}

async fn analyze_project_documents(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Path((workspace_id, project_id, detector)): Path<(Uuid, Uuid, String)>,
    Json(body): Json<AnalyzeBindingsRequest>,
) -> ApiResult<JsonBody<AnalyzeEnqueuedDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    service
        .authorize(&ctx, project_id)
        .await
        .map_err(no_tenant)?;

    let detector = crate::documents::quality::Detector::parse(&detector).ok_or_else(|| {
        DocumentsError::invalid_argument()
            .with_constraint("detector must be one of purpose, leak, bloat, traceability")
            .create()
    })?;

    // Refused before anything is read: an oversized body is the caller's
    // mistake, and walking a checkout to find that out would be ours.
    let inline = crate::documents::quality::inline_docs(
        body.documents
            .into_iter()
            .map(|d| crate::documents::quality::InlineDoc {
                path: d.path,
                text: d.text,
                doc_type: d.type_key,
            })
            .collect(),
    )
    .map_err(|why| {
        DocumentsError::invalid_argument()
            .with_constraint(why)
            .create()
    })?;

    // Inline texts alone need no checkout, so a deployment without one can
    // still analyse what an editor sends it.
    let reader = if body.binding_ids.is_empty() {
        None
    } else {
        Some(quality.reader()?)
    };
    let mut docs = match reader {
        Some(reader) => service
            .quality_docs(
                &ctx,
                workspace_id,
                Some(project_id),
                &body.binding_ids,
                reader.as_ref(),
            )
            .await
            .map_err(internal)?,
        None => Vec::new(),
    };
    docs.extend(
        service
            .quality_documents(workspace_id, project_id, &body.document_ids)
            .await
            .map_err(internal)?,
    );
    let docs = crate::documents::quality::with_inline(docs, inline);
    if docs.is_empty() {
        return Err(DocumentsError::invalid_argument()
            .with_constraint(
                "none of those documents has text — sync the repository or open the \
                 project in the IDE to clone it, or write something in the document first",
            )
            .create());
    }

    let documents = docs.len() as i64;
    let items = crate::documents::quality::build_items(detector, &docs, &project_id.to_string());
    let payload = serde_json::json!({
        "detector": detector.as_str(),
        "items": items
            .into_iter()
            .map(|i| serde_json::json!({ "id": i.id, "payload": i.payload }))
            .collect::<Vec<_>>(),
    });

    let run_id = quality
        .queue()?
        .enqueue(
            &ctx,
            crate::tasks::service::NewRun {
                tenant: ctx.subject_tenant_id(),
                task_type: crate::spec_quality::batch_task::BATCH_TASK_TYPE,
                payload,
                partition_key: None,
                idempotency_key: None,
                // Nothing to tell an IDE session about: this run's result is
                // read on the Specs screen that asked for it.
                notify_workspace_id: None,
            },
        )
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;

    Ok(Json(AnalyzeEnqueuedDto {
        poll: format!("/studio-tasks/v1/runs/{run_id}"),
        run_id: run_id.to_string(),
        documents,
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
        not_documents: outcome.not_documents as i64,
        kept: outcome.kept as i64,
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
    Extension(quality): Extension<Quality>,
    Path((workspace_id, id)): Path<(Uuid, Uuid)>,
    Json(body): Json<DecideBindingDto>,
) -> ApiResult<JsonBody<DocumentBindingDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    let mut decision = binding_decision(body)?;

    // A decision that names a type changes what conformance MEANS for this
    // file, so the old verdict is about the wrong template the moment the
    // decision lands. The caller used to send the text along to have it
    // recomputed; it no longer holds any, so the server reads the file the
    // decision is about -- the same checkout the detectors read.
    //
    // Best effort by design: a deployment with no checkout, or a file the
    // clone does not have, must not cost the person their decision. The
    // binding keeps its previous verdict, exactly as it did when `content`
    // was omitted.
    if decision.content.is_none()
        && matches!(
            decision.action,
            BindingAction::Set { .. } | BindingAction::Confirm
        )
        && let Ok(reader) = quality.reader()
    {
        match service
            .binding_text(&ctx, workspace_id, id, reader.as_ref())
            .await
        {
            Ok(text) => decision.content = text,
            Err(error) => {
                tracing::warn!(%error, %id, "studio-documents: conformance not re-checked");
            }
        }
    }
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

// ── the Specs list, folded here rather than in a page ────────────────────────

#[derive(Debug, serde::Deserialize)]
pub struct SpecScopeQuery {
    /// The project whose specs these are. Its parent workspace is resolved
    /// here, because bindings are stored against the workspace and scoped to
    /// the project — a caller should not have to know that.
    pub project_id: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecRowDto {
    /// Unique across all three kinds a row can be.
    pub id: String,
    /// `repository` or `authored` — where the bytes live, which is the one
    /// thing the two kinds genuinely differ in.
    pub origin: String,
    pub name: String,
    /// Empty for an authored document: it has no path until somebody commits it.
    pub path: String,
    /// Null when nothing has decided a type yet.
    pub type_key: Option<String>,
    /// Graph node id for a repository row — what findings are keyed on.
    pub node_id: Option<String>,
    /// `detected`, `confirmed`, `manual`, `unknown`, `not_a_document`; null for
    /// an authored document, which nobody has to decide the type of.
    pub state: Option<String>,
    /// `draft`, `review` or `approved` for an authored row; null otherwise — a
    /// repository file has no editorial status, only a type decision.
    pub status: Option<String>,
    pub conforms: Option<bool>,
    pub updated_at: String,
    /// The repository the file was ingested from. Empty for an authored row.
    pub repo: String,
    /// Which queues this row is in, out of `not-scanned`, `needs-review`,
    /// `bound` and `not-documents`.
    ///
    /// Carried per row rather than left to the caller to work out: which queue
    /// a row belongs in is the rule this endpoint exists to own, and a second
    /// portal deciding it again is how two screens start disagreeing about
    /// what needs review.
    pub queues: Vec<String>,
}

/// How many rows are in each queue.
///
/// Counted from the same list they label, so the chips and the table cannot
/// disagree — which they did when each was worked out separately.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecCountDto {
    /// `not-scanned`, `needs-review`, `bound`, `not-documents` or `all`.
    pub queue: String,
    pub count: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecRowsSourcesDto {
    /// Whether the never-classified files could be read at all. False means
    /// nobody could ask, so `not-scanned` is empty for that reason rather than
    /// because the project has none — a distinction a screen must not collapse.
    pub files_known: bool,
    pub counts: Vec<SpecCountDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecRowListDto {
    pub items: Vec<SpecRowDto>,
    pub total: u32,
    pub sources: SpecRowsSourcesDto,
}

/// One document under a type.
///
/// `conforms` travels with it so a screen holding a FRESHER verdict than the
/// record — a "Validate all" run that supersedes what was written at the last
/// save — can apply its own without asking again. That override is screen
/// state; which documents are eligible to be counted at all is not, and that
/// part is decided here.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PipelineEntryDto {
    pub id: String,
    /// An authored document's title, or a bound file's last path segment.
    pub name: String,
    pub conforms: Option<bool>,
    /// `draft`, `review` or `approved` for an authored document; null for a
    /// repository file, which has no editorial status.
    pub status: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PipelineRowDto {
    pub type_key: String,
    pub type_name: String,
    /// What the type is for. The only thing there is to say about a type
    /// nothing has started yet.
    pub type_description: String,
    /// The documents written in Studio.
    pub authored: Vec<PipelineEntryDto>,
    /// The bindings a person decided on.
    pub bound: Vec<PipelineEntryDto>,
    /// The bindings the scanner only proposed. Shown, and deliberately NOT in
    /// `total`.
    pub proposed: Vec<PipelineEntryDto>,
    /// Nothing of this type and nothing proposed — the only state that
    /// honestly reads "not started".
    pub untouched: bool,
    /// Of `total`, how many passed their type's checks. A document nobody has
    /// checked has not passed anything.
    pub valid: u32,
    /// `authored` + `bound`, never the proposals.
    pub total: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PipelineListDto {
    pub items: Vec<PipelineRowDto>,
    pub total: u32,
}

/// The workspace a project's rows are stored against.
///
/// Bindings and documents live on the PARENT workspace and are scoped to the
/// project. Without the parent nothing can be read, and reading the wrong rows
/// would be worse than saying so.
async fn parent_workspace(
    service: &Arc<DocumentsService>,
    ctx: &SecurityContext,
    project_id: Uuid,
) -> ApiResult<Uuid> {
    service
        .authorize(ctx, project_id)
        .await
        .map_err(no_tenant)?;
    let parent = service
        .parent_of(ctx, project_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            DocumentsError::not_found("that project has no parent workspace to read specs from")
                .with_resource("tenant")
                .create()
        })?;
    service.authorize(ctx, parent).await.map_err(no_tenant)?;
    Ok(parent)
}

/// Everything a project has of both kinds, in one list.
async fn list_spec_rows(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<SpecScopeQuery>,
) -> ApiResult<JsonBody<SpecRowListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;

    let (bindings, authored) = read_both(&service, workspace_id, project_id).await?;

    // The never-classified files, and their provenance. Absent when no ingest
    // gear is here, which costs one queue rather than the screen.
    let (candidates, repos, files_known) = match quality.files() {
        Some(files) => match files.list_files(&ctx, &project_id.to_string()).await {
            Ok(found) => {
                let repos: std::collections::HashMap<String, String> = found
                    .iter()
                    .map(|f| (f.node_id.clone(), f.repo.clone()))
                    .collect();
                let candidates: Vec<super::spec_rows::Candidate> = found
                    .into_iter()
                    .map(|f| super::spec_rows::Candidate {
                        node_id: f.node_id,
                        path: f.path,
                    })
                    .collect();
                (candidates, repos, true)
            }
            Err(_) => (Vec::new(), std::collections::HashMap::new(), false),
        },
        None => (Vec::new(), std::collections::HashMap::new(), false),
    };

    let repo_of = |node: &str| repos.get(node).cloned().unwrap_or_default();
    let rows = super::spec_rows::rows(&bindings, &authored, &candidates, &repo_of);
    let counts = super::spec_rows::counts(&rows)
        .into_iter()
        .map(|(queue, count)| SpecCountDto {
            queue: queue.as_str().to_owned(),
            count,
        })
        .collect();

    let items: Vec<SpecRowDto> = rows
        .into_iter()
        .map(|r| SpecRowDto {
            queues: super::spec_rows::queues_of(&r)
                .into_iter()
                .map(|q| q.as_str().to_owned())
                .collect(),
            id: r.id,
            origin: r.origin.as_str().to_owned(),
            name: r.name,
            path: r.path,
            type_key: r.type_key,
            node_id: r.node_id,
            state: r.state.map(|s| s.as_str().to_owned()),
            status: r.status,
            conforms: r.conforms,
            updated_at: r.updated_at,
            repo: r.repo,
        })
        .collect();

    Ok(Json(SpecRowListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        sources: SpecRowsSourcesDto {
            files_known,
            counts,
        },
    }))
}

/// What the project has of each declared type.
async fn list_spec_pipeline(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Query(query): Query<SpecScopeQuery>,
) -> ApiResult<JsonBody<PipelineListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;

    let (bindings, authored) = read_both(&service, workspace_id, project_id).await?;
    let types: Vec<super::spec_rows::PipelineType> = service
        .list_types(&ctx, workspace_id)
        .await
        .map_err(internal)?
        .into_iter()
        .map(|t| super::spec_rows::PipelineType {
            key: t.key,
            name: t.name,
            description: t.description,
        })
        .collect();

    let items: Vec<PipelineRowDto> = super::spec_rows::pipeline(&types, &authored, &bindings)
        .into_iter()
        .map(|r| PipelineRowDto {
            type_key: r.type_key,
            type_name: r.type_name,
            type_description: r.type_description,
            authored: r.authored.into_iter().map(entry_dto).collect(),
            bound: r.bound.into_iter().map(entry_dto).collect(),
            proposed: r.proposed.into_iter().map(entry_dto).collect(),
            untouched: r.untouched,
            valid: r.valid,
            total: r.total,
        })
        .collect();

    Ok(Json(PipelineListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

/// The two record sets both folds need, read the same way for both.
///
/// Every row, not a page: a fold that saw half its inputs would answer a
/// different question, and both of these are per-project lists rather than
/// something anybody scrolls.
async fn read_both(
    service: &Arc<DocumentsService>,
    workspace_id: Uuid,
    project_id: Uuid,
) -> ApiResult<(
    Vec<super::spec_rows::Binding>,
    Vec<super::spec_rows::Authored>,
)> {
    // The whole set, not a page: `PageQuery::limit()` clamps to 200, so a
    // paged read here showed a project with more files than that as mostly
    // "not scanned" -- its bindings existed, the page just did not reach them.
    let bindings = service
        .all_bindings(workspace_id, Some(project_id))
        .await
        .map_err(internal)?;
    let documents = service
        .all_documents(workspace_id, Some(project_id))
        .await
        .map_err(internal)?;

    let bindings = bindings
        .into_iter()
        .map(|b| super::spec_rows::Binding {
            id: b.id.to_string(),
            state: super::spec_rows::BindingState::parse(b.state.as_str())
                .unwrap_or(super::spec_rows::BindingState::Unknown),
            node_id: b.node_id,
            path: b.path,
            type_key: b.type_key,
            conforms: b.conforms,
            updated_at: b.updated_at,
        })
        .collect();
    let documents = documents
        .into_iter()
        .map(|d| super::spec_rows::Authored {
            id: d.id.to_string(),
            title: d.title,
            type_key: Some(d.type_key),
            status: doc_status(d.status).to_owned(),
            // Always a verdict on this side: the column is a `bool`, so
            // `false` means checked and not conforming rather than unchecked.
            conforms: Some(d.conforms),
            updated_at: d.updated_at,
        })
        .collect();
    Ok((bindings, documents))
}

/// The wire spelling of a status, the one the DTOs already serialise.
fn doc_status(status: DocStatus) -> &'static str {
    match status {
        DocStatus::Draft => "draft",
        DocStatus::Review => "review",
        DocStatus::Approved => "approved",
    }
}

fn entry_dto(e: super::spec_rows::PipelineEntry) -> PipelineEntryDto {
    PipelineEntryDto {
        id: e.id,
        name: e.name,
        conforms: e.conforms,
        status: e.status,
    }
}

fn parse_project_id(raw: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(raw.trim()).map_err(|_| {
        DocumentsError::invalid_argument()
            .with_field_violation("project_id", "must be a uuid".to_owned(), "INVALID")
            .create()
    })
}

// ── the review criteria a type is judged by ──────────────────────────────────

#[derive(Debug, serde::Deserialize)]
pub struct ReviewCriteriaQuery {
    /// The document type whose criteria to read (`prd`, `adr`, …).
    pub type_key: String,
    /// Read the criteria as this project's workspace sees them, overlays
    /// included. Omitted, the platform's built-in guide is read.
    #[serde(default)]
    pub project_id: Option<String>,
}

/// One criterion of a type's review checklist.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReviewCriterionDto {
    /// The id the checklist gives it (`BIZ-PRD-001`). Stable across refreshes
    /// of the checklist; a review verdict cites it.
    pub id: String,
    pub title: String,
    /// The enclosing top-level heading: `MUST HAVE`, `MUST NOT HAVE`, or a
    /// group the checklist names without a requirement keyword.
    pub group: String,
    /// The enclosing second-level heading (`BUSINESS Expertise (BIZ)`);
    /// absent when the criterion sits directly under its group.
    pub section: Option<String>,
    /// The RFC 2119 keyword its group or section states (`MUST`, `MUST NOT`,
    /// `SHOULD`, …); absent when neither states one.
    pub level: Option<String>,
    /// `CRITICAL`, `HIGH`, `MEDIUM` or `LOW`, as the checklist states it.
    pub severity: Option<String>,
    /// The individual checks, one line each.
    pub checks: Vec<String>,
    /// The criterion's body as markdown, verbatim.
    pub text: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReviewCriterionListDto {
    pub items: Vec<ReviewCriterionDto>,
    pub total: u32,
    pub type_key: String,
    /// Where the guide came from: "builtin", "organization" or "workspace".
    pub owner: String,
    pub owner_tenant_id: Option<Uuid>,
    /// The guide's authoring and review rules, markdown, verbatim. Empty when
    /// the type has no guide.
    pub rules_markdown: String,
}

async fn list_review_criteria(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Query(query): Query<ReviewCriteriaQuery>,
) -> ApiResult<JsonBody<ReviewCriterionListDto>> {
    let key = query.type_key.trim();
    if key.is_empty() {
        return Err(DocumentsError::invalid_argument()
            .with_field_violation(
                "type_key",
                "must name a document type".to_owned(),
                "REQUIRED",
            )
            .create());
    }
    let ty = match query.project_id.as_deref() {
        Some(raw) => {
            let project_id = parse_project_id(raw)?;
            let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
            service
                .get_type(&ctx, workspace_id, key)
                .await
                .map_err(internal)?
        }
        None => super::model::builtin_types()
            .into_iter()
            .find(|t| t.key == key),
    };
    let ty = ty.ok_or_else(|| {
        DocumentsError::not_found("no document type with that key")
            .with_resource(key.to_owned())
            .create()
    })?;
    let (guide, owner) =
        effective_guide(&ty).unwrap_or_else(|| (ReviewGuide::default(), ty.owner.clone()));
    let (owner, owner_tenant_id) = match owner {
        Owner::Builtin => ("builtin".to_string(), None),
        Owner::Organization { tenant_id } => ("organization".to_string(), Some(tenant_id)),
        Owner::Workspace { tenant_id } => ("workspace".to_string(), Some(tenant_id)),
    };
    let items: Vec<ReviewCriterionDto> = parse_checklist(&guide.checklist)
        .into_iter()
        .map(|c| ReviewCriterionDto {
            id: c.id,
            title: c.title,
            group: c.group,
            section: c.section,
            level: c.level,
            severity: c.severity,
            checks: c.checks,
            text: c.text,
        })
        .collect();
    Ok(Json(ReviewCriterionListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        type_key: ty.key,
        owner,
        owner_tenant_id,
        rules_markdown: guide.rules,
    }))
}

// ── how many specs each repository holds ─────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
pub struct SpecsPerSourceQuery {
    /// Workspace or project tenant whose repositories these are.
    pub scope: String,
}

/// One repository, and how many of this scope's specs came out of it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecsPerSourceDto {
    /// Instance id of the repo node — how a caller joins this to its row.
    pub repo: String,
    /// Files in it that somebody DECIDED are documents. A scanner's guess is
    /// not a spec, and `not_a_document` is a decision that it never was.
    pub specs: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecsPerSourceListDto {
    pub items: Vec<SpecsPerSourceDto>,
    pub total: u32,
    /// False when the ingested files could not be read, so every count is
    /// missing rather than zero. A screen must render that as `—`.
    pub files_known: bool,
}

/// GET /studio-documents/v1/specs-per-source — specs by the repository they
/// came from.
///
/// TWO SOURCES AND NO JOIN BETWEEN THEM, which is why this exists here. The
/// artifact graph holds the file and which repository it came from; this gear
/// holds the binding that says what the file IS. The only thing tying them
/// together is the file node's id, so somebody has to hold both — and it used
/// to be the browser, which walked the whole file listing to do it.
async fn specs_per_source(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<SpecsPerSourceQuery>,
) -> ApiResult<JsonBody<SpecsPerSourceListDto>> {
    let scope = query.scope.trim();
    let scope_id = Uuid::parse_str(scope).map_err(|_| {
        DocumentsError::invalid_argument()
            .with_field_violation("scope", "must be a uuid".to_owned(), "INVALID")
            .create()
    })?;
    service.authorize(&ctx, scope_id).await.map_err(no_tenant)?;

    // Which repository each ingested file came from. Absent means the count is
    // UNKNOWN — a screen must not draw that as zero, because "no specs here"
    // and "nobody could tell me" are different sentences.
    let (repo_of, files_known) = match quality.files() {
        Some(files) => match files.list_files(&ctx, scope).await {
            Ok(found) => (
                found
                    .into_iter()
                    .filter(|f| !f.repo.is_empty())
                    .map(|f| (f.node_id, f.repo))
                    .collect::<std::collections::HashMap<String, String>>(),
                true,
            ),
            Err(_) => (std::collections::HashMap::new(), false),
        },
        None => (std::collections::HashMap::new(), false),
    };

    // The bindings of this scope. A workspace reads its own; a project reads
    // its own plus what it inherits, which is the pairing every other Documents
    // read uses and the one this has to repeat to count the same rows.
    //
    // A workspace counts its projects' bindings too. A repository's files are
    // bound in the project that synced them, so the workspace's own rows alone
    // made every source on the workspace's Sources table read "0 specs".
    let bindings = match service.parent_of(&ctx, scope_id).await {
        Ok(Some(parent)) => service.all_bindings(parent, Some(scope_id)).await,
        _ => service.every_binding_under(scope_id).await,
    }
    .map_err(internal)?;

    let mut counts: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
    for binding in bindings {
        // Only a file somebody decided about counts.
        if !matches!(binding.state.as_str(), "confirmed" | "manual") {
            continue;
        }
        if let Some(repo) = repo_of.get(&binding.node_id) {
            *counts.entry(repo.clone()).or_insert(0) += 1;
        }
    }

    let items: Vec<SpecsPerSourceDto> = counts
        .into_iter()
        .map(|(repo, specs)| SpecsPerSourceDto { repo, specs })
        .collect();
    Ok(Json(SpecsPerSourceListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        files_known,
    }))
}

pub fn register_routes(
    mut router: Router,
    openapi: &dyn OpenApiRegistry,
    service: Arc<DocumentsService>,
    hub: Arc<toolkit::client_hub::ClientHub>,
) -> Router {
    router = OperationBuilder::get("/studio-documents/v1/specs-per-source")
        .operation_id("studio_documents.list_specs_per_source")
        .summary("How many specs came out of each repository")
        .description(
            "Two sources and no join between them, which is the whole reason this is an \
             operation rather than something a caller assembles. The artifact graph holds the \
             file and which repository it was ingested from; this gear holds the binding that \
             says what that file IS. The only thing tying the two together is the file node's \
             id, so somebody has to hold both — and it used to be the browser, which paged the \
             entire file listing to do it.\n\n\
             ONLY A FILE SOMEBODY DECIDED ABOUT COUNTS. A binding in `confirmed` or `manual` \
             state is a decision; `detected` is the scanner's guess, still in the review queue, \
             and `not_a_document` is a decision that it never was one. Counting a guess would \
             credit a repository with specs the project has not agreed to.\n\n\
             `files_known` is false when the ingested files could not be read at all. Every \
             count is then MISSING rather than zero, and a screen must render `—`: `no specs \
             here` and `nobody could tell me` are different sentences.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("scope", true, "Workspace or project tenant to count within")
        .handler(specs_per_source)
        .json_response_with_schema::<SpecsPerSourceListDto>(
            openapi,
            StatusCode::OK,
            "Specs per repository",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/spec-rows")
        .operation_id("studio_documents.list_spec_rows")
        .summary("Every spec a project has, however it got there")
        .description(
            "One list for both kinds of document a project can have. Somebody writes one in \
             Studio — an authored document, whose content is a Postgres column — or the \
             repository already had one and a sync bound the file to a type, in which case the \
             content is in the artifact graph. Where the bytes live is an implementation detail; \
             the question a reader has is what specs exist and whether they are any good, and \
             answering it used to mean reading two lists and merging them by eye.\n\n\
             The third kind is a file the sync ingested that NOTHING has classified yet. Those \
             exist the moment a repository is synced, long before anyone presses Scan, and \
             showing them is the difference between `this project has 5785 files, none analysed` \
             and an empty screen that reads as `there is nothing here`. A candidate disappears \
             the moment a binding exists for the same node — that is the same file one step \
             further along, and listing both would count one file twice.\n\n\
             Newest first, with an authored document ahead of a repository file at the same \
             instant, and an unreadable date LAST rather than first. `sources.counts` labels \
             each queue, counted from this same list so the chips and the table cannot disagree. \
             `not-scanned` is files nothing has looked at; `needs-review` is files a detector \
             already had an opinion about — two different queues, and a queue that lists things \
             nobody can act on stops being read.\n\n\
             `sources.files_known` is false when the ingest gear is not in this deployment: \
             `not-scanned` is then empty because nobody could ask, which is not the same fact as \
             the project having none.\n\n\
             This fold used to run in the portal, which had to page the whole artifact file \
             graph to do it — the projection cannot narrow by a payload field, so each page is a \
             slice of the tenant's entire typed node set.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project whose specs to list")
        .handler(list_spec_rows)
        .json_response_with_schema::<SpecRowListDto>(openapi, StatusCode::OK, "The specs")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/spec-pipeline")
        .operation_id("studio_documents.list_spec_pipeline")
        .summary("What a project has of each document type it declares")
        .description(
            "One row per type the workspace declares, in the order it declares them — the \
             workspace decides that order and this does not reshuffle it. A binding naming a \
             type the workspace no longer declares is dropped rather than invented into a row: \
             the type list is the authority on what types exist.\n\n\
             WHAT COUNTS AS COVERAGE is the rule to read twice. `bound` is repository files a \
             PERSON decided the type of; `proposed` is files the scanner only thinks are that \
             type. Both are shown, and only `bound` and `authored` are in `total` — folding a \
             guess in would report coverage the project has not agreed to. `untouched` means \
             nothing of the type exists and nothing has been proposed, which is the only state \
             that honestly reads `not started`.\n\n\
             `valid` counts those of `total` that passed their type's checks. A document nobody \
             has checked has not passed anything, so an absent verdict counts as not-valid. A \
             screen holding a fresher verdict than the record — a `Validate all` run that \
             supersedes what was written at the last save — still applies it itself; that is \
             screen state, and it is the one part of this fold that stays in the browser.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project whose pipeline to read")
        .handler(list_spec_pipeline)
        .json_response_with_schema::<PipelineListDto>(openapi, StatusCode::OK, "The pipeline")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/review-criteria")
        .operation_id("studio_documents.list_review_criteria")
        .summary("The semantic review criteria a document type is judged by")
        .description(
            "Validation asks whether a document's sections are THERE; these criteria ask \
             whether what is in them is any good. Each carries the id its checklist gives it \
             (`BIZ-PRD-001`), which is stable across refreshes of the checklist, so a verdict — a \
             reviewer's or a model's — can cite exactly what it failed.\n\n\
             The five built-in types serve the SDLC kit's checklist and rules, vendored \
             verbatim. With `project_id`, the type is resolved as that project's workspace sees \
             it: an organization or workspace entry that states its own guide replaces the \
             kit's WHOLE (never merged), and one that states none keeps the kit's guide for its \
             key. `owner` says which of the two answered.\n\n\
             A known type with no guide at all answers an empty list, not 404: `nothing to \
             review against` is a fact about the type. An unknown `type_key` is 404.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("type_key", true, "The document type whose criteria to read")
        .query_param(
            "project_id",
            false,
            "Resolve the type as this project's workspace sees it; omitted, the built-in guide",
        )
        .handler(list_review_criteria)
        .json_response_with_schema::<ReviewCriterionListDto>(
            openapi,
            StatusCode::OK,
            "The criteria",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post(
        "/studio-documents/v1/workspaces/{workspace_id}/projects/{project_id}/quality/{detector}",
    )
    .operation_id("studio_documents.analyze_project_documents")
    .summary("Run a Spec Quality detector over a project's documents")
    .description(
        "Hands the named bindings to Spec Quality as one background run. The          request carries binding ids, NOT text: the server reads the documents          from the checkout a sync left on disk, which is where they already are.          The one exception is `documents`: texts the server cannot have, such as          an editor's unsaved buffer, each analysed under its own `path` and          replacing the named binding at the same path. At most 20 of them, 256 KiB          each and 1 MiB together; more is a 400.          `bloat` and `traceability` judge a set and become one analysis over all          of them; `purpose` and `leak` judge a document and become one each.          Which bindings deserve a detector is the caller's decision and is not          made here. Follow the run at the returned `poll`.",
    )
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace tenant id")
    .path_param("project_id", "Project tenant id")
    .path_param("detector", "purpose | leak | bloat | traceability")
    .json_request::<AnalyzeBindingsRequest>(openapi, "Bindings to analyse")
    .handler(analyze_project_documents)
    .json_response_with_schema::<AnalyzeEnqueuedDto>(
        openapi,
        StatusCode::OK,
        "The run doing the analysis",
    )
    .error_400(openapi)
    .error_401(openapi)
    .error_403(openapi)
    // The path names a workspace, a project and a detector, and any of the
    // three can fail to resolve — so 404 is a real outcome and the conventions
    // ask for it to be declared (B8).
    .error_404(openapi)
    .error_500(openapi)
    .register(router, openapi);

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
    .query_param_typed(
        "offset",
        false,
        "Zero-based index of the first verdict",
        "integer",
    )
    .query_param_typed("limit", false, "Page size, 1..=200 (default 50)", "integer")
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

    router = OperationBuilder::get("/studio-documents/v1/declared-capabilities")
        .operation_id("studio_documents.list_declared_capabilities")
        .summary("The capabilities a project's documents declare")
        .description(
            "Every capability key declared in the front matter of the project's \
             documents -- the ones Studio holds and the repository files bound to a \
             type -- with the documents declaring each. What the Composer composes \
             from. A repository file still awaiting review does not count.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project whose capabilities to read")
        .handler(list_declared_capabilities)
        .json_response_with_schema::<DeclaredCapabilityListDto>(
            openapi,
            StatusCode::OK,
            "Declared capabilities",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
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

    router = OperationBuilder::put(
        "/studio-documents/v1/workspaces/{workspace_id}/document-bindings/{id}/analyses/{detector}",
    )
    .operation_id("studio_documents.record_binding_analysis")
    .summary("Record one detector's verdict on a bound repository file")
    .description(
        "The counterpart of recording a verdict on a document Studio holds, for a          document that lives in the repository instead. The full finding belongs in the          artifact graph, joined to the file node; this is the index a stage gate reads,          so a stage can depend on a detector having passed whichever of the two kinds of          document answers for the type it requires.",
    )
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace tenant id")
    .path_param("id", "Binding id")
    .path_param("detector", "Detector name, e.g. purpose")
    .json_request::<RecordAnalysisDto>(openapi, "Verdict")
    .handler(record_binding_analysis)
    .json_response_with_schema::<AnalysisDto>(openapi, StatusCode::OK, "Recorded verdict")
    .error_400(openapi)
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
         whose path is not prose (source, images, lockfiles) are recorded as not \
         documents rather than left without a binding — a file with none reads as \
         'not scanned yet', which is a queue that never empties. Send them with an \
         empty body: the verdict for one is its path. Send a few dozen files per \
         call — the whole repository in one body exceeds the gateway's \
         request-size limit.";

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
        "Bindings written, and what the pass decided",
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
        "Bindings written, and what the pass decided",
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

    router
        .layer(Extension(Quality { hub }))
        .layer(Extension(service))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_analysis_request_may_carry_inline_texts_alone() {
        // The IDE's Analyze panel sends the text on screen and nothing else;
        // `binding_ids` being required would make it send an empty list to
        // say so.
        let body: AnalyzeBindingsRequest = serde_json::from_value(serde_json::json!({
            "documents": [{ "path": "docs/prd.md", "text": "# PRD" }]
        }))
        .expect("inline texts alone are a request");
        assert!(body.binding_ids.is_empty());
        assert!(body.document_ids.is_empty());
        assert_eq!(body.documents.len(), 1);
        assert_eq!(body.documents[0].path, "docs/prd.md");
        assert_eq!(body.documents[0].type_key, None);
    }

    #[test]
    fn an_analysis_request_mixes_ids_and_inline_texts() {
        let binding = Uuid::from_u128(1);
        let document = Uuid::from_u128(2);
        let body: AnalyzeBindingsRequest = serde_json::from_value(serde_json::json!({
            "binding_ids": [binding],
            "document_ids": [document],
            "documents": [{ "path": "docs/prd.md", "text": "# PRD", "type_key": "prd" }]
        }))
        .expect("all three together");
        assert_eq!(body.binding_ids, vec![binding]);
        assert_eq!(body.document_ids, vec![document]);
        assert_eq!(body.documents[0].type_key.as_deref(), Some("prd"));
    }

    #[test]
    fn the_portals_request_without_inline_texts_still_parses() {
        let body: AnalyzeBindingsRequest =
            serde_json::from_value(serde_json::json!({ "binding_ids": [] }))
                .expect("the portal's request");
        assert!(body.documents.is_empty());
    }
}
