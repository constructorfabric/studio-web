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
    /// What the Gearbox engine can report a gear as providing, any of which
    /// satisfies the capability: a contract id with or without its version, or a
    /// GTS extension-point segment. Matched before `terms`.
    pub contracts: Vec<String>,
    /// Answered by where and how the product runs, not by gears: the composer
    /// offers it none.
    pub nonfunctional: bool,
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
    pub contracts: Option<Vec<String>>,
    pub nonfunctional: Option<bool>,
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
    /// Required reviewers of the document's current review request who have
    /// not approved it. Empty when nobody was asked to review it.
    pub approvals_outstanding: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct StageStatusDto {
    pub key: String,
    pub label: String,
    pub required: bool,
    pub complete: bool,
    pub requirements: Vec<RequirementDto>,
    /// The stage's checks beyond documents, each answered (#782).
    pub checks: Vec<StageCheckDto>,
}

/// One check beyond documents, and where the project stands on it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct StageCheckDto {
    /// `code`, `tests` or `review`.
    pub kind: String,
    /// `null` when this deployment cannot read the evidence: no verdict.
    pub passed: Option<bool>,
    /// What passed it, or what is still missing.
    pub detail: String,
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
    /// Checks beyond documents: `code`, `tests`, `review`.
    pub checks: Vec<String>,
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
    /// Checks beyond documents, each of `code`, `tests`, `review`.
    pub checks: Option<Vec<String>>,
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

/// The current text of a bound repository file.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct BindingTextDto {
    /// The file as the checkout the detectors read holds it.
    pub text: String,
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
            contracts: c.contracts,
            nonfunctional: c.nonfunctional,
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
                    approvals_outstanding: r.approvals_outstanding,
                })
                .collect(),
            checks: st
                .checks
                .into_iter()
                .map(|c| StageCheckDto {
                    kind: c.kind,
                    passed: c.passed,
                    detail: c.detail,
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
            checks: st.checks,
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
    let checks = body.checks.unwrap_or_default();
    if let Some(bad) = checks
        .iter()
        .find(|c| !super::model::STAGE_CHECKS.contains(&c.as_str()))
    {
        return Err(invalid(anyhow::anyhow!(
            "`{bad}` is not a stage check: use code, tests or review"
        )));
    }
    let st = Stage {
        key: body.key,
        label: body.label,
        required: body.required.unwrap_or(false),
        position: body.position.unwrap_or(0),
        requires: body.requires.unwrap_or_default(),
        gates: body.gates.unwrap_or_default(),
        checks,
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

/// The evidence the stages' checks read, gathered only for the kinds some
/// stage declares.
async fn stage_evidence(
    service: &DocumentsService,
    quality: &Quality,
    ctx: &SecurityContext,
    workspace_id: Uuid,
    project_id: Uuid,
    kinds: &std::collections::BTreeSet<String>,
) -> super::model::StageEvidence {
    let mut ev = super::model::StageEvidence::default();
    let scope = project_id.to_string();
    let delivery = quality
        .hub
        .get::<dyn crate::artifact_ingest::port::DeliveryEvidence>()
        .ok();
    if kinds.contains("code") {
        ev.code = match (quality.work(), quality.reader().ok()) {
            (Some(source), Some(reader)) => {
                match (
                    source.project_work(ctx, &scope).await,
                    service
                        .spec_model_sources(ctx, workspace_id, project_id, reader.as_ref())
                        .await,
                ) {
                    (Ok(work), Ok(sources)) => Some(code_evidence(&sources.labelled_ids(), &work)),
                    _ => None,
                }
            }
            _ => None,
        };
    }
    if kinds.contains("tests") {
        ev.tests = match &delivery {
            Some(d) => d.ci_runs(ctx, &scope).await.ok().map(|runs| {
                match crate::artifact_ingest::port::latest_completed_run(&runs) {
                    None => Err("no completed CI run has been synced".to_string()),
                    Some(r) => {
                        let what = format!(
                            "{} on {} at {}",
                            r.workflow,
                            r.branch.as_deref().unwrap_or("?"),
                            r.sha.chars().take(7).collect::<String>()
                        );
                        if r.conclusion.as_deref() == Some("success") {
                            Ok(format!("{what} passed"))
                        } else {
                            Err(format!(
                                "{what} ended {}",
                                r.conclusion.as_deref().unwrap_or("without a conclusion")
                            ))
                        }
                    }
                }
            }),
            None => None,
        };
    }
    if kinds.contains("review") {
        let pulls = match &delivery {
            Some(d) => d.pulls_waiting_on_review(ctx, &scope).await.ok(),
            None => None,
        };
        let awaited: Vec<String> = service
            .reviews_with_verdicts(workspace_id, project_id, None)
            .await
            .unwrap_or_default()
            .iter()
            .filter(|r| r.request.state == "open")
            .filter(|r| {
                !super::approvals::holding(
                    &r.reviewers(),
                    &r.verdict_facts(),
                    r.maturity().as_deref(),
                    true,
                )
                .is_empty()
            })
            .map(|r| r.request.title.clone())
            .collect();
        ev.review = pulls.map(|waiting| {
            let mut missing = Vec::new();
            if waiting > 0 {
                missing.push(format!(
                    "{waiting} pull request{} wait on review",
                    if waiting == 1 { "" } else { "s" }
                ));
            }
            if !awaited.is_empty() {
                missing.push(format!(
                    "review requested and not approved: {}",
                    awaited.join(", ")
                ));
            }
            if missing.is_empty() {
                Ok("nothing waits on a reviewer".to_string())
            } else {
                Err(missing.join("; "))
            }
        });
    }
    ev
}

/// `code` passes when a commit or a merged pull request names one of the
/// requirements the project's documents define; with no labelled
/// requirements, when any commit was synced.
fn code_evidence(
    ids: &std::collections::BTreeMap<String, Vec<super::spec_model::finding::Side>>,
    work: &[crate::artifact_ingest::port::WorkItem],
) -> Result<String, String> {
    let landed: Vec<crate::artifact_ingest::port::WorkItem> = work
        .iter()
        .filter(|w| w.kind == "commit" || (w.kind == "pull_request" && w.merged))
        .cloned()
        .collect();
    if ids.is_empty() {
        return if landed.iter().any(|w| w.kind == "commit") {
            Ok("commits are synced (the documents label no requirements to match)".to_string())
        } else {
            Err("no commit has been synced".to_string())
        };
    }
    let (linked, _) = super::spec_model::work::link(ids, &landed);
    if linked.is_empty() {
        Err(format!(
            "no commit or merged pull request names one of the {} requirements",
            ids.len()
        ))
    } else {
        Ok(format!(
            "{} of {} requirements are named by commits or merged pull requests",
            linked.len(),
            ids.len()
        ))
    }
}

/// Where a project stands against its workspace's stages.
async fn project_stage_status(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Path((workspace_id, project_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<JsonBody<StageStatusListDto>> {
    service
        .authorize(&ctx, project_id)
        .await
        .map_err(no_tenant)?;
    let kinds: std::collections::BTreeSet<String> = service
        .list_stages(&ctx, workspace_id)
        .await
        .map_err(internal)?
        .into_iter()
        .flat_map(|s| s.checks)
        .collect();
    let evidence = if kinds.is_empty() {
        super::model::StageEvidence::default()
    } else {
        stage_evidence(&service, &quality, &ctx, workspace_id, project_id, &kinds).await
    };
    let items = service
        .stage_status(&ctx, workspace_id, project_id, &evidence)
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
        contracts: body.contracts.unwrap_or_default(),
        nonfunctional: body.nonfunctional.unwrap_or(false),
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
) -> ApiResult<(StatusCode, JsonBody<DocumentDto>)> {
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
    Ok((StatusCode::CREATED, Json(document_dto(doc, false))))
}

async fn create_project_document(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path((workspace_id, project_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<CreateDocumentDto>,
) -> ApiResult<(StatusCode, JsonBody<DocumentDto>)> {
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
    Ok((StatusCode::CREATED, Json(document_dto(doc, false))))
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
    Extension(quality): Extension<Quality>,
    Path((workspace_id, id)): Path<(Uuid, Uuid)>,
) -> ApiResult<StatusCode> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    // Its verdicts first, and a failure keeps the document: the other order
    // would leave verdicts nothing can find again, counted in the projects
    // table's `open_findings` for a document no list shows (studio-web#706).
    // Recorded under the parent workspace, which is the tenant here.
    if let Some(findings) = quality.findings() {
        findings
            .forget_spec_findings(
                &ctx,
                &workspace_id.to_string(),
                &[super::spec_rows::authored_subject(&id.to_string())],
            )
            .await
            .map_err(|e| {
                tracing::warn!(error = %e, %id, "studio-documents: verdicts not forgotten; document kept");
                CanonicalError::service_unavailable()
                    .with_detail(
                        "the document's recorded verdicts could not be removed, so it was                          kept; try again",
                    )
                    .create()
            })?;
    }
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
    /// The caller as a canonical person, with their name (ADR-0025).
    async fn caller(&self, ctx: &SecurityContext) -> ApiResult<(String, Option<String>)> {
        let people = self
            .hub
            .get_scoped::<dyn crate::user_profile::PersonResolver>(
                &toolkit::client_hub::ClientScope::gts_id(
                    crate::user_profile::IDENTITY_INSTANCE_ID,
                ),
            )
            .map_err(|_| {
                CanonicalError::service_unavailable()
                    .with_detail("studio-user is not available, so nobody can be told apart")
                    .create()
            })?;
        people.resolve_caller_named(ctx).await.map_err(internal)
    }

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

    /// The project's issues, pull requests and commits, from the artifact
    /// sync; `None` in a deployment without it.
    fn work(&self) -> Option<Arc<dyn crate::artifact_ingest::port::ProjectWork>> {
        self.hub
            .get::<dyn crate::artifact_ingest::port::ProjectWork>()
            .ok()
    }

    /// The model client, for reading documents into the spec model on the
    /// caller's key.
    fn models(&self) -> ApiResult<Arc<dyn crate::llm_proxy::port::ModelProviders>> {
        self.hub
            .get::<dyn crate::llm_proxy::port::ModelProviders>()
            .map_err(|_| {
                CanonicalError::service_unavailable()
                    .with_detail(
                        "the domain model cannot be built in this deployment: \
                         studio-llm-proxy is not part of it",
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

    /// The graph a document's verdicts are recorded in, to forget them with
    /// the document. Absent where no ingest gear runs, and then there are none.
    fn findings(&self) -> Option<Arc<dyn crate::artifact_ingest::port::SpecFindingWriter>> {
        self.hub
            .get::<dyn crate::artifact_ingest::port::SpecFindingWriter>()
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
    headers: axum::http::HeaderMap,
    Json(body): Json<AnalyzeBindingsRequest>,
) -> ApiResult<(StatusCode, JsonBody<AnalyzeEnqueuedDto>)> {
    let idempotency_key = crate::idempotency::key(&headers)?;
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
    // The run records each document's result itself, against these subjects,
    // so the result is kept whether or not the tab that asked stays open.
    let paths: Vec<String> = docs.iter().map(|d| d.path.clone()).collect();
    let record = service
        .record_subjects(
            workspace_id,
            Some(project_id),
            &body.binding_ids,
            &body.document_ids,
            &paths,
        )
        .await
        .map_err(internal)?;
    let payload = crate::documents::quality::batch_payload(
        detector,
        &docs,
        &project_id.to_string(),
        Some(&record),
    );

    let run_id = quality
        .queue()?
        .enqueue(
            &ctx,
            crate::tasks::sdk::NewRun {
                tenant: ctx.subject_tenant_id(),
                task_type: crate::spec_quality::sdk::BATCH_TASK_TYPE,
                payload,
                partition_key: None,
                idempotency_key: idempotency_key.as_deref(),
                coalesce_queued: false,
                // Nothing to tell an IDE session about: this run's result is
                // read on the Specs screen that asked for it.
                notify_workspace_id: None,
            },
        )
        .await
        .map_err(|e| CanonicalError::internal(format!("{e:#}")).create())?;

    Ok((
        StatusCode::ACCEPTED,
        Json(AnalyzeEnqueuedDto {
            poll: format!("/studio-tasks/v1/runs/{run_id}"),
            run_id: run_id.to_string(),
            documents,
        }),
    ))
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
    // Pairs, not a field of `PageQuery`: axum's `Query` cannot read a
    // repeated key into a `Vec` (see spec_quality's `VerdictQuery`).
    Query(pairs): Query<Vec<(String, String)>>,
) -> ApiResult<JsonBody<DocumentBindingListDto>> {
    service
        .authorize(&ctx, workspace_id)
        .await
        .map_err(no_tenant)?;
    service
        .authorize(&ctx, project_id)
        .await
        .map_err(no_tenant)?;
    let paths: Vec<String> = pairs
        .into_iter()
        .filter(|(key, value)| key == "path" && !value.is_empty())
        .map(|(_, value)| value)
        .collect();
    let (items, total) = if paths.is_empty() {
        service
            .list_bindings(workspace_id, Some(project_id), page)
            .await
            .map_err(internal)?
    } else {
        let items = service
            .list_bindings_at(workspace_id, Some(project_id), &paths)
            .await
            .map_err(internal)?;
        let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
        (items, total)
    };
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

/// The text of a bound repository file, read from the same checkout the
/// detectors analyse — the session's, else the sync's clone. An authored
/// document's content is a column and travels with the document; a repository
/// file's lives in the checkout, and a reader of the Specs list had no way to
/// open it.
async fn get_binding_text(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Path(id): Path<Uuid>,
    Query(query): Query<SpecScopeQuery>,
) -> ApiResult<JsonBody<BindingTextDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let reader = quality.reader()?;
    let text = service
        .project_binding_text(&ctx, workspace_id, project_id, id, reader.as_ref())
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            DocumentsError::not_found("no such binding, or no checkout holds its file")
                .with_resource("document_binding")
                .create()
        })?;
    Ok(Json(BindingTextDto { text }))
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

// ── the domain model read from a project's documents ─────────────────────────

/// One passage a finding rests on.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecModelSideDto {
    pub path: String,
    /// First line, from 1; absent when the side is a whole document.
    pub line_start: Option<u32>,
    pub line_end: Option<u32>,
    /// The passage verbatim, or the document's title for a whole document.
    pub quote: Option<String>,
    /// The document binding the path is, when the project binds it.
    #[serde(default)]
    pub binding_id: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecModelFindingDto {
    /// Stable across re-runs and line shifts.
    pub fingerprint: String,
    pub rule: String,
    /// `high`, `medium` or `low`.
    pub severity: String,
    pub message: String,
    pub sides: Vec<SpecModelSideDto>,
    /// The decision a person has to take when the documents cannot tell
    /// which side is right: one choice per entry.
    pub decide: Vec<String>,
    /// The smallest edit that fixes it, when the documents show which side
    /// is right; `replace` is checked to be in `path`.
    pub edit: Option<SpecModelEditDto>,
    /// A member's word on it: `confirmed` (a real problem) or `dismissed`.
    pub decision: Option<String>,
    /// For a reference to something missing: what it refers to.
    pub target: Option<String>,
}

/// Replace `replace` with `with` in `path`.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecModelEditDto {
    pub path: String,
    pub replace: String,
    pub with: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecModelFindingListDto {
    pub items: Vec<SpecModelFindingDto>,
    pub total: u32,
}

impl From<super::spec_model::finding::Finding> for SpecModelFindingDto {
    fn from(f: super::spec_model::finding::Finding) -> Self {
        Self {
            fingerprint: f.fingerprint,
            rule: f.rule,
            severity: f.severity,
            message: f.message,
            sides: f
                .sides
                .into_iter()
                .map(|s| SpecModelSideDto {
                    path: s.path,
                    line_start: s.line_start.and_then(|n| u32::try_from(n).ok()),
                    line_end: s.line_end.and_then(|n| u32::try_from(n).ok()),
                    quote: s.quote,
                    binding_id: None,
                })
                .collect(),
            decide: f.decide,
            edit: f.edit.map(|e| SpecModelEditDto {
                path: e.path,
                replace: e.replace,
                with: e.with,
            }),
            decision: None,
            target: f.target,
        }
    }
}

/// One field of an entity, as a person wrote it on the Domain model tab.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecModelFieldInput {
    pub name: String,
    /// What it holds, in a few words.
    #[serde(default)]
    pub meaning: String,
}

/// One relation of an entity: "belongs to" Workspace.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecModelRelationInput {
    pub verb: String,
    /// The entity it relates to, by name.
    pub target: String,
}

/// An entity of the domain model as a person edited it: what it is, what it
/// holds, how it relates. It replaces the entity's section of
/// `docs/domain-model.md`.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecModelEntityRequest {
    pub name: String,
    #[serde(default)]
    pub definition: Option<String>,
    #[serde(default)]
    pub fields: Vec<SpecModelFieldInput>,
    #[serde(default)]
    pub relations: Vec<SpecModelRelationInput>,
}

/// A sentence the Domain model tab proposes for a document, after the passage
/// the model read a fact from: the relation an entity has no document stating.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecModelSentenceRequest {
    /// The document, from the repository's root: one of the project's
    /// documentation, never another file.
    pub path: String,
    /// The revision the model read, so the line still means the same passage.
    pub revision: String,
    /// The passage's last line, 1-based; the sentence goes after its block.
    pub line: u32,
    pub sentence: String,
    /// What the change makes better, for the pull request's title.
    #[serde(default)]
    pub why: Option<String>,
}

/// Where a change to the documents landed.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecModelWriteDto {
    /// The file written, from the repository's root.
    pub path: String,
    pub branch: String,
    pub commit_sha: String,
    /// Set when the change went as a pull request.
    pub pr_url: Option<String>,
}

/// A member's ✓ or ✗ on one finding.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecModelDecisionRequest {
    pub project_id: String,
    /// `confirmed` (a real problem) or `dismissed` (not one).
    pub decision: String,
    /// Why, in the member's words; at most 2000 characters.
    pub note: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecModelDecisionDto {
    pub fingerprint: String,
    pub decision: String,
    pub decided_by: String,
    pub decided_at: String,
    pub note: Option<String>,
    /// Whether the finding is still found: `false` once the documents no
    /// longer show it (resolved), `null` when it was not a domain-model
    /// finding the decision kept.
    pub present: Option<bool>,
    /// The finding as it stood when decided, when it was a domain-model one.
    pub rule: Option<String>,
    pub message: Option<String>,
    pub target: Option<String>,
    pub sides: Vec<SpecModelSideDto>,
}

/// Every ✓/✗ members gave on a project's findings.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecModelDecisionListDto {
    pub items: Vec<SpecModelDecisionDto>,
    pub total: u32,
}

/// One term of the project's glossary document.
#[derive(Debug)]
#[toolkit_macros::api_dto(request, response)]
pub struct GlossaryDocRowDto {
    pub term: String,
    pub definition: String,
    /// Other names that mean the same.
    #[serde(default)]
    pub aliases: Vec<String>,
    /// Terms that look alike and are something else.
    #[serde(default)]
    pub not_same_as: Vec<String>,
    /// Where the definition was read: `path:line`.
    #[serde(default)]
    pub source: Option<String>,
}

/// The glossary the project's documents keep.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GlossaryDocFoundDto {
    pub path: String,
    /// The section's heading, for a glossary kept inside another document.
    pub heading: Option<String>,
    pub line_start: u32,
    pub line_end: u32,
    /// The whole document is the glossary.
    pub whole: bool,
    pub rows: Vec<GlossaryDocRowDto>,
}

/// Where the project's glossary is, and where Studio keeps it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GlossaryDocDto {
    /// The glossary the documents keep, if any.
    pub found: Option<GlossaryDocFoundDto>,
    /// Where Studio writes it: `docs/glossary.md`.
    pub path: String,
}

/// The glossary to propose, row by row in its order.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct GlossaryDocRequest {
    pub project_id: String,
    pub rows: Vec<GlossaryDocRowDto>,
}

/// One name merged into a glossary entry.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GlossaryAliasDto {
    pub key: String,
    pub name: String,
}

/// One entry of a project's glossary.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GlossaryEntryDto {
    /// The entry's subject, folded: what a decision names it by.
    pub key: String,
    /// The chosen name, or the spelling the documents use most.
    pub name: String,
    /// Whether a member chose `name`.
    pub chosen: bool,
    /// Every spelling of the entry and its aliases, most frequent first.
    pub spellings: Vec<String>,
    pub aliases: Vec<GlossaryAliasDto>,
    pub facts: u32,
    pub documents: u32,
    /// The keys of the entries a member said are different things from this
    /// one: not to be offered as one thing again.
    pub distinct_from: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GlossaryListDto {
    pub items: Vec<GlossaryEntryDto>,
    pub total: u32,
}

/// A member's decision on one glossary entry. It replaces the entry's last
/// decision whole: send both fields, `null` for the one not decided.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct GlossaryDecisionRequest {
    pub project_id: String,
    /// The entry's `key`.
    pub key: String,
    /// The name the project uses for it; `null` goes back to the spelling the
    /// documents use most.
    pub name: Option<String>,
    /// The `key` of the entry this one is another name of; `null` keeps it an
    /// entry of its own.
    pub alias_of: Option<String>,
}

/// A member's accept or reject on one fact the model read.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecModelReviewDto {
    /// The fact as the tab keys it.
    pub fact_key: String,
    /// `accepted` or `rejected`.
    pub state: String,
    pub path: String,
    pub revision: String,
    pub note: Option<String>,
    pub decided_by: String,
    pub decided_at: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecModelReviewListDto {
    pub items: Vec<SpecModelReviewDto>,
    pub total: u32,
}

/// A hypothesis check method a kit adds, as its `check-methods.json` says.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct KitCheckMethodDto {
    /// The kit that adds it.
    pub kit: String,
    pub id: String,
    pub label: String,
    /// The uncertainty it addresses.
    pub uncertainty: String,
    /// What it needs from earlier steps or materials.
    pub inputs: String,
    /// What to do and what comes out.
    pub action: String,
    /// What a result of it cannot establish.
    pub limits: String,
    /// Words in a claim that make it apply.
    pub applies_to: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct KitCheckMethodListDto {
    pub items: Vec<KitCheckMethodDto>,
    pub total: u32,
    /// Kits named whose file was unreadable or out of shape, each with why.
    /// A map rather than a second list: a collection is `items`.
    pub unread: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, serde::Deserialize)]
pub struct CheckMethodsQuery {
    pub project_id: String,
    /// The kits to read, comma-separated slugs: the project's installed kits.
    #[serde(default)]
    pub kits: String,
}

/// One fact to accept, reject, or put back as proposed.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecModelReviewInput {
    pub fact_key: String,
    /// `accepted`, `rejected`, or `proposed` to withdraw a review; for a
    /// hypothesis (key `ev:…`), what checking found: `supports`,
    /// `contradicts` or `insufficient`.
    pub state: String,
    /// Where the fact was read, and at which revision.
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub revision: String,
    /// Why, when it needs saying: an excluded obligation's reason.
    #[serde(default)]
    pub note: Option<String>,
}

/// An issue to open in the project's repository from something to decide.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecModelIssueRequest {
    pub project_id: String,
    pub title: String,
    pub body: String,
    /// The host accounts to assign it to (GitHub logins).
    #[serde(default)]
    pub assignees: Vec<String>,
}

/// The issue opened.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecModelIssueDto {
    pub number: i64,
    pub url: Option<String>,
}

/// A whole document Studio proposes for the repository: an accepted need,
/// a confirmed prioritisation.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecModelFileProposalRequest {
    pub project_id: String,
    /// Where it goes: a Markdown file under `docs/`.
    pub path: String,
    pub content: String,
    /// The pull request's title.
    pub title: String,
}

/// A selection of facts reviewed in one action.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecModelReviewRequest {
    pub project_id: String,
    pub items: Vec<SpecModelReviewInput>,
}

/// Two glossary entries a member says are different things.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct GlossaryDistinctRequest {
    pub project_id: String,
    /// One entry's `key`.
    pub a: String,
    /// The other's.
    pub b: String,
}

/// A glossary rename to carry into the documents: the name they use and the
/// name the project chose.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct GlossaryRenameRequest {
    /// The old name, as the documents spell it (any case).
    pub from: String,
    /// The project's name for it.
    pub to: String,
}

/// The pull request that renames a word across the documents.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GlossaryRenameProposalDto {
    /// Every file changed, from the repository's root.
    pub files: Vec<String>,
    /// How many uses were renamed, across the files.
    pub renamed: u32,
    pub branch: String,
    pub commit_sha: String,
    /// Set when the change went as a pull request.
    pub pr_url: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct GlossaryDecisionDto {
    pub key: String,
    pub name: Option<String>,
    pub alias_of: Option<String>,
    pub decided_by: String,
    pub decided_at: String,
}

/// One issue, pull request or commit that names an identifier.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct WorkItemDto {
    /// `issue`, `pull_request` or `commit`.
    pub kind: String,
    pub number: Option<i64>,
    pub title: String,
    pub url: Option<String>,
    /// `open` or `closed`, for an issue or pull request.
    pub state: Option<String>,
    pub merged: bool,
    /// A commit's short sha.
    pub sha: Option<String>,
}

/// An identifier the documents define, and the work that names it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct WorkLinkDto {
    pub id: String,
    /// The first place a document defines it.
    pub defined_in: SpecModelSideDto,
    pub work: Vec<WorkItemDto>,
}

/// The work against the documents.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct WorkLinkListDto {
    /// Only the identifiers some work names, in the identifiers' order.
    pub items: Vec<WorkLinkDto>,
    pub total: u32,
    /// Identifiers the documents define with a label.
    pub identifiers: u32,
    /// Issues, pull requests and commits read.
    pub work: u32,
    /// Of those, the ones that name no identifier.
    pub unlinked: u32,
    /// False when this deployment has no artifact sync to read work from.
    pub synced: bool,
}

/// One requirement a project's documents define, and what it states it
/// rests on (docs/spec-domain-model.md, "Requirements and their basis").
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecRequirementDto {
    pub id: String,
    /// Where it is defined: the label's line.
    pub defined_in: SpecModelSideDto,
    /// The nearest heading above the label.
    pub title: Option<String>,
    /// The statement, without its labelled list items; clipped.
    pub text: String,
    /// The identifier's segment after its family (`fr` in `cpt-x-fr-y`).
    pub kind: Option<String>,
    /// `p1`…`p9`, when the label's line gives one.
    pub priority: Option<String>,
    /// The label line's checkbox, when it has one.
    pub done: Option<bool>,
    /// `open_question`, `assumption`, `cited`, `reasoned` or `stated`.
    pub basis: String,
    /// What it cites, as written.
    pub cites: Vec<String>,
    /// The words that made it an assumption or an open question.
    pub because: Option<String>,
    /// Synced issues, pull requests and commits that name it.
    pub work: u32,
}

/// A project's requirements, in document order.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecRequirementListDto {
    pub items: Vec<SpecRequirementDto>,
    pub total: u32,
    /// How many items have each basis, keyed by basis.
    pub by_basis: std::collections::BTreeMap<String, u32>,
    /// False when this deployment has no artifact sync, so `work` is 0.
    pub synced: bool,
}

/// Which project to build the model of.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct SpecModelBuildRequest {
    pub project_id: String,
    /// One document to read again, whatever its state: its facts replace
    /// that document's facts only, and the rest of the model stays as it is.
    /// Without it, every document not read at its revision is read.
    pub path: Option<String>,
}

/// What a build would read, and about how long it would take.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecModelBuildEstimateDto {
    /// Documents the build would read: changed or never read, or the one
    /// asked for.
    pub documents: u32,
    /// Documents of the project's model, read or not.
    pub total_documents: u32,
    pub characters: u64,
    /// Characters over four: a rule of thumb, not the provider's tokenizer.
    pub input_tokens: u64,
    /// Seconds reading them is expected to take; the judge's stage after it
    /// is not counted.
    pub seconds: u64,
    /// Wall-clock seconds per document at `parallel` reads at once.
    pub seconds_per_document: f64,
    /// True when the pace was measured on the project's earlier builds,
    /// false when it is a default.
    pub measured: bool,
    /// Documents read at once.
    pub parallel: u32,
}

#[derive(Debug, serde::Deserialize)]
pub struct SpecBuildEstimateQuery {
    pub project_id: String,
    /// One document to estimate reading again, as `POST /spec-model/builds`
    /// with a `path` would.
    #[serde(default)]
    pub path: Option<String>,
}

/// A project's build, as the process serving it knows it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecModelBuildDto {
    pub running: bool,
    /// Documents this build reads.
    pub documents: u32,
    pub done: u32,
    /// Candidates sent to the judge, and how many it has answered.
    pub candidates: u32,
    pub judged: u32,
    pub current: Option<String>,
    /// Why it stopped, when it did not finish (no model key, most often).
    pub error: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    /// Seconds reading the documents was estimated to take when it started:
    /// the ETA until the first document is done, after which `done`,
    /// `documents` and `started_at` give a better one.
    pub estimated_seconds: Option<u64>,
    /// The one document this build reads again, when it was asked for one.
    pub path: Option<String>,
}

impl From<super::spec_model::build::BuildState> for SpecModelBuildDto {
    fn from(s: super::spec_model::build::BuildState) -> Self {
        let at = |t: Option<time::OffsetDateTime>| {
            t.and_then(|t| {
                t.format(&time::format_description::well_known::Rfc3339)
                    .ok()
            })
        };
        Self {
            running: s.running,
            documents: u32::try_from(s.documents).unwrap_or(u32::MAX),
            done: u32::try_from(s.done).unwrap_or(u32::MAX),
            candidates: u32::try_from(s.candidates).unwrap_or(u32::MAX),
            judged: u32::try_from(s.judged).unwrap_or(u32::MAX),
            current: s.current,
            error: s.error,
            started_at: at(s.started_at),
            finished_at: at(s.finished_at),
            estimated_seconds: s.estimated_seconds,
            path: s.path,
        }
    }
}

/// Where one document stands in the model.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecModelDocumentDto {
    pub path: String,
    pub revision: String,
    /// `extracted`, `failed` (part-way; read again on the next build),
    /// `stale` (only an older revision was read) or `pending`.
    pub state: String,
    pub facts: u32,
    /// Facts the model gave that the text did not bear out.
    pub dropped: u32,
    pub error: Option<String>,
}

/// One fact, with the passage it rests on.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecModelFactDto {
    /// `entity`, `attribute`, `relation`, `requirement`, `constraint`,
    /// `lifecycle` or `decision`.
    pub kind: String,
    pub subject: String,
    pub aspect: String,
    pub value: String,
    pub text: String,
    /// `active`, `proposed`, `deferred`, `superseded`, `resolved` or
    /// `evidence`.
    pub status: String,
    pub status_because: String,
    /// `domain`, `system` or `deployment` when the extractor stated where an
    /// `entity` sits; absent otherwise.
    pub layer: Option<String>,
    pub source: SpecModelSideDto,
}

/// A project's domain model as read so far.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct SpecModelDto {
    pub build: SpecModelBuildDto,
    pub documents: Vec<SpecModelDocumentDto>,
    pub facts: Vec<SpecModelFactDto>,
}

/// The project's sources, the facts of their current revisions, and where
/// each document stands.
async fn spec_model_state(
    service: &Arc<DocumentsService>,
    ctx: &SecurityContext,
    workspace_id: Uuid,
    project_id: Uuid,
    reader: &dyn crate::artifact_ingest::port::RepoFileReader,
) -> ApiResult<(
    super::spec_model::Sources,
    Vec<super::spec_model::extract::Fact>,
    Vec<super::spec_model::Coverage>,
)> {
    let sources = service
        .spec_model_sources(ctx, workspace_id, project_id, reader)
        .await
        .map_err(internal)?;
    let rows = service
        .spec_extractions(workspace_id, project_id)
        .await
        .map_err(internal)?;
    let kept: Vec<super::spec_model::Kept<'_>> = rows
        .iter()
        .map(|r| super::spec_model::Kept {
            path: &r.path,
            revision: &r.revision,
            extractor_version: &r.extractor_version,
            facts: &r.facts,
            dropped: r.dropped,
            error: r.error.as_deref(),
        })
        .collect();
    let (facts, coverage) = super::spec_model::current(&sources.documents, &kept);
    Ok((sources, facts, coverage))
}

/// A project's domain model as read so far.
async fn get_spec_model(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<SpecScopeQuery>,
) -> ApiResult<JsonBody<SpecModelDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let reader = quality.reader()?;
    let (_, facts, coverage) =
        spec_model_state(&service, &ctx, workspace_id, project_id, reader.as_ref()).await?;
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    Ok(Json(SpecModelDto {
        build: super::spec_model::build::state(project_id).into(),
        documents: coverage
            .into_iter()
            .map(|c| SpecModelDocumentDto {
                path: c.path,
                revision: c.revision,
                state: c.state.to_string(),
                facts: count(c.facts),
                dropped: count(c.dropped),
                error: c.error,
            })
            .collect(),
        facts: facts
            .into_iter()
            .map(|f| SpecModelFactDto {
                kind: f.kind,
                subject: f.subject,
                aspect: f.aspect,
                value: f.value,
                text: f.text,
                status: f.status,
                status_because: f.status_because,
                layer: f.layer,
                source: SpecModelSideDto {
                    path: f.path,
                    line_start: u32::try_from(f.line_start).ok(),
                    line_end: u32::try_from(f.line_end).ok(),
                    quote: Some(f.quote),
                    binding_id: None,
                },
            })
            .collect(),
    }))
}

/// Read every document of the project not yet read at its revision, on the
/// caller's model key, in the background. A build already running for the
/// project is answered with its state rather than started twice.
async fn start_spec_model_build(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Json(body): Json<SpecModelBuildRequest>,
) -> ApiResult<(StatusCode, JsonBody<SpecModelBuildDto>)> {
    use super::spec_model::build;
    let project_id = parse_project_id(&body.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let reader = quality.reader()?;
    let models = quality.models()?;
    let (sources, _, coverage) =
        spec_model_state(&service, &ctx, workspace_id, project_id, reader.as_ref()).await?;
    let pending = spec_model_pending(&sources, &coverage, body.path.as_deref())?;
    let estimate = spec_model_estimate(&service, workspace_id, project_id, &pending).await?;
    if !build::begin(project_id, pending.len()) {
        return Ok((StatusCode::ACCEPTED, Json(build::state(project_id).into())));
    }
    build::update(project_id, |s| {
        s.estimated_seconds = Some(estimate.seconds);
        s.path.clone_from(&body.path);
    });
    let findings_writer = quality.findings();
    let sources_for_record = super::spec_model::Sources {
        documents: sources.documents.clone(),
        tree: sources.tree,
        // Recording findings needs no code files.
        files: Vec::new(),
    };
    let documents = sources.documents;
    tokio::spawn(async move {
        let service_ref = &service;
        let read = build::read_all(
            project_id,
            models.as_ref(),
            &ctx,
            pending,
            move |doc, read| async move {
                let revision = super::spec_model::extract::revision(&doc.text);
                if let Err(error) = service_ref
                    .put_spec_extraction(workspace_id, project_id, &doc.path, &revision, &read)
                    .await
                {
                    tracing::warn!(%error, path = %doc.path, "spec-model: an extraction could not be kept");
                }
            },
        )
        .await;
        if let Err(build::Stop(reason)) = read {
            build::finish(project_id, Some(reason));
            return;
        }
        let reason = judge_new_candidates(
            &service,
            &models,
            &ctx,
            workspace_id,
            project_id,
            &documents,
        )
        .await
        .err();
        if let Some(writer) = findings_writer {
            record_spec_model_findings(
                &service,
                writer.as_ref(),
                &ctx,
                workspace_id,
                project_id,
                &sources_for_record,
            )
            .await;
        }
        build::finish(project_id, reason);
    });
    Ok((StatusCode::ACCEPTED, Json(build::state(project_id).into())))
}

/// The documents a build reads: every one not read at its revision, or the
/// one named by `path` whatever its state (404 when it is not one of the
/// model's documents).
fn spec_model_pending(
    sources: &super::spec_model::Sources,
    coverage: &[super::spec_model::Coverage],
    path: Option<&str>,
) -> ApiResult<Vec<super::spec_model::SourceText>> {
    if let Some(path) = path {
        let doc = sources
            .documents
            .iter()
            .find(|d| d.path == path)
            .cloned()
            .ok_or_else(|| {
                DocumentsError::not_found("no such document in the project's model")
                    .with_resource("document")
                    .create()
            })?;
        return Ok(vec![doc]);
    }
    let wanted: std::collections::BTreeSet<&str> =
        super::spec_model::to_read(coverage).into_iter().collect();
    Ok(sources
        .documents
        .iter()
        .filter(|d| wanted.contains(d.path.as_str()))
        .cloned()
        .collect())
}

/// What reading `pending` is expected to take, at the pace of the project's
/// earlier builds when there were any.
async fn spec_model_estimate(
    service: &DocumentsService,
    workspace_id: Uuid,
    project_id: Uuid,
    pending: &[super::spec_model::SourceText],
) -> ApiResult<super::spec_model::build::Estimate> {
    use super::spec_model::build;
    let rows = service
        .spec_extractions(workspace_id, project_id)
        .await
        .map_err(internal)?;
    let kept_at: Vec<time::OffsetDateTime> = rows.iter().map(|r| r.created_at).collect();
    let texts: Vec<&str> = pending.iter().map(|d| d.text.as_str()).collect();
    Ok(build::estimate(&texts, build::pace_from(&kept_at)))
}

/// What a build of the project would read now, and about how long it would
/// take.
async fn get_spec_model_build_estimate(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<SpecBuildEstimateQuery>,
) -> ApiResult<JsonBody<SpecModelBuildEstimateDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let reader = quality.reader()?;
    let (sources, _, coverage) =
        spec_model_state(&service, &ctx, workspace_id, project_id, reader.as_ref()).await?;
    let pending = spec_model_pending(&sources, &coverage, query.path.as_deref())?;
    let e = spec_model_estimate(&service, workspace_id, project_id, &pending).await?;
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    Ok(Json(SpecModelBuildEstimateDto {
        documents: count(e.documents),
        total_documents: count(sources.documents.len()),
        characters: u64::try_from(e.characters).unwrap_or(u64::MAX),
        input_tokens: u64::try_from(e.input_tokens).unwrap_or(u64::MAX),
        seconds: e.seconds,
        seconds_per_document: e.seconds_per_document,
        measured: e.measured,
        parallel: count(super::spec_model::build::PARALLEL_READS),
    }))
}

/// Today's candidates of the project's model and the judgements kept for
/// them: the confirmed findings, and which candidates are not judged yet.
async fn judged_candidates(
    service: &DocumentsService,
    workspace_id: Uuid,
    project_id: Uuid,
    documents: &[super::spec_model::SourceText],
) -> anyhow::Result<(
    Vec<super::spec_model::rules::Candidate>,
    Vec<super::spec_model::finding::Finding>,
    Vec<usize>,
)> {
    use super::spec_model as sm;
    let rows = service.spec_extractions(workspace_id, project_id).await?;
    let kept: Vec<sm::Kept<'_>> = rows
        .iter()
        .map(|r| sm::Kept {
            path: &r.path,
            revision: &r.revision,
            extractor_version: &r.extractor_version,
            facts: &r.facts,
            dropped: r.dropped,
            error: r.error.as_deref(),
        })
        .collect();
    let (facts, _) = sm::current(documents, &kept);
    let choices = service.glossary_choices(workspace_id, project_id).await?;
    let facts = sm::glossary::apply(&facts, &choices);
    let candidates = sm::candidates(documents, &facts);
    let judgements = service.spec_judgements(workspace_id, project_id).await?;
    let judged: Vec<sm::Judged<'_>> = judgements
        .iter()
        .map(|j| sm::Judged {
            fingerprint: &j.fingerprint,
            revisions: &j.revisions,
            judge_version: &j.judge_version,
            finding: j.finding.as_deref(),
        })
        .collect();
    let (findings, unjudged) = sm::judged(&candidates, &sm::revisions(documents), &judged);
    Ok((candidates, findings, unjudged))
}

/// The judge's stage of a build: every candidate not judged at its sides'
/// revisions is asked about once. `Err` is why the build stopped.
async fn judge_new_candidates(
    service: &DocumentsService,
    models: &Arc<dyn crate::llm_proxy::port::ModelProviders>,
    ctx: &SecurityContext,
    workspace_id: Uuid,
    project_id: Uuid,
    documents: &[super::spec_model::SourceText],
) -> Result<(), String> {
    use super::spec_model::build;
    let (candidates, _, unjudged) = judged_candidates(service, workspace_id, project_id, documents)
        .await
        .map_err(|e| format!("the model could not be read back: {e:#}"))?;
    build::update(project_id, |s| {
        s.candidates = unjudged.len();
        s.current = None;
    });
    let texts: std::collections::BTreeMap<String, String> = documents
        .iter()
        .map(|d| (d.path.clone(), d.text.clone()))
        .collect();
    let revision_of = super::spec_model::revisions(documents);
    for i in unjudged {
        let candidate = &candidates[i];
        match build::judge_candidate(models.as_ref(), ctx, candidate, &texts).await {
            Err(build::Stop(reason)) => return Err(reason),
            Ok(Err(error)) => {
                tracing::warn!(%error, "spec-model: a candidate could not be judged");
            }
            Ok(Ok(found)) => {
                let (fingerprint, revisions) =
                    super::spec_model::judgement_key(candidate, &revision_of);
                if let Err(error) = service
                    .put_spec_judgement(
                        workspace_id,
                        project_id,
                        &fingerprint,
                        &revisions,
                        found.as_ref(),
                    )
                    .await
                {
                    tracing::warn!(%error, "spec-model: a judgement could not be kept");
                }
            }
        }
        build::update(project_id, |s| s.judged += 1);
    }
    Ok(())
}

/// Every finding of the project, references and judged alike, each with a
/// member's decision on it when there is one.
async fn spec_model_findings(
    service: &DocumentsService,
    workspace_id: Uuid,
    project_id: Uuid,
    sources: &super::spec_model::Sources,
) -> anyhow::Result<(
    Vec<super::spec_model::finding::Finding>,
    std::collections::BTreeMap<String, String>,
)> {
    let mut findings = sources.reference_findings();
    let (_, judged, _) =
        judged_candidates(service, workspace_id, project_id, &sources.documents).await?;
    findings.extend(judged);
    let decisions = service
        .spec_decisions(workspace_id, project_id)
        .await?
        .into_iter()
        .map(|d| (d.fingerprint, d.decision))
        .collect();
    Ok((findings, decisions))
}

/// The last stage of a build: every document's findings as its
/// `spec_finding` verdict, so the Specs list counts them and the IDE places
/// them in the text. Nothing to stop a build over: a failure is logged and
/// the next build writes again.
async fn record_spec_model_findings(
    service: &DocumentsService,
    writer: &dyn crate::artifact_ingest::port::SpecFindingWriter,
    ctx: &SecurityContext,
    workspace_id: Uuid,
    project_id: Uuid,
    sources: &super::spec_model::Sources,
) {
    use super::spec_model::record;
    let (findings, decisions) =
        match spec_model_findings(service, workspace_id, project_id, sources).await {
            Ok(read) => read,
            Err(error) => {
                tracing::warn!(%error, "spec-model: the findings could not be read to record");
                return;
            }
        };
    let dismissed: std::collections::BTreeSet<String> = decisions
        .into_iter()
        .filter(|(_, d)| d == "dismissed")
        .map(|(f, _)| f)
        .collect();
    let paths: Vec<&str> = sources.documents.iter().map(|d| d.path.as_str()).collect();
    let node_of: std::collections::BTreeMap<&str, &str> = sources
        .documents
        .iter()
        .map(|d| (d.path.as_str(), d.node.as_str()))
        .collect();
    let verdicts: Vec<crate::artifact_ingest::port::QualityFinding> =
        record::verdicts(&paths, &findings, &dismissed)
            .into_iter()
            .filter_map(|v| {
                let node = node_of.get(v.path.as_str()).filter(|n| !n.is_empty())?;
                Some(crate::artifact_ingest::port::QualityFinding {
                    detector: record::DETECTOR.to_string(),
                    subject: (*node).to_string(),
                    path: Some(v.path),
                    severity: Some(v.severity.to_string()),
                    summary: Some(v.summary),
                    score: None,
                    details: v.details,
                })
            })
            .collect();
    if let Err(error) = writer
        .write_spec_findings(
            ctx,
            &verdicts,
            &[],
            Some(&workspace_id.to_string()),
            Some(&project_id.to_string()),
        )
        .await
    {
        tracing::warn!(%error, "spec-model: the findings could not be recorded");
    }
}

/// Where a project's documents disagree, or refer to what is not there.
async fn list_spec_model_findings(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<SpecScopeQuery>,
) -> ApiResult<JsonBody<SpecModelFindingListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let reader = quality.reader()?;
    let sources = service
        .spec_model_sources(&ctx, workspace_id, project_id, reader.as_ref())
        .await
        .map_err(internal)?;
    let (findings, decisions) = spec_model_findings(&service, workspace_id, project_id, &sources)
        .await
        .map_err(internal)?;
    let binding_of = binding_ids(&sources);
    let items: Vec<SpecModelFindingDto> = findings
        .into_iter()
        .map(|f| {
            let decision = decisions.get(&f.fingerprint).cloned();
            let mut dto = SpecModelFindingDto {
                decision,
                ..f.into()
            };
            for side in &mut dto.sides {
                side.binding_id = binding_of.get(&side.path).cloned();
            }
            dto
        })
        .collect();
    let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
    Ok(Json(SpecModelFindingListDto { items, total }))
}

/// Path → binding id, for every document the model read.
fn binding_ids(sources: &super::spec_model::Sources) -> std::collections::BTreeMap<String, String> {
    sources
        .documents
        .iter()
        .filter_map(|d| d.binding.map(|b| (d.path.clone(), b.to_string())))
        .collect()
}

/// A finding as a decision keeps it.
fn finding_snapshot(f: &super::spec_model::finding::Finding) -> serde_json::Value {
    serde_json::json!({
        "rule": f.rule,
        "message": f.message,
        "target": f.target,
        "sides": f.sides,
    })
}

/// A decision with the finding it was taken on, and whether that is still found.
fn spec_decision_dto(
    d: super::entity::spec_decision::Model,
    present: Option<bool>,
    binding_of: &std::collections::BTreeMap<String, String>,
) -> SpecModelDecisionDto {
    let snap = d.snapshot.clone().unwrap_or(serde_json::Value::Null);
    let text = |k: &str| {
        snap.get(k)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let sides: Vec<super::spec_model::finding::Side> = snap
        .get("sides")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    SpecModelDecisionDto {
        fingerprint: d.fingerprint,
        decision: d.decision,
        decided_by: d.decided_by.to_string(),
        decided_at: rfc3339(d.decided_at),
        note: d.note,
        present: if d.snapshot.is_some() { present } else { None },
        rule: text("rule"),
        message: text("message"),
        target: text("target"),
        sides: sides
            .into_iter()
            .map(|s| SpecModelSideDto {
                binding_id: binding_of.get(&s.path).cloned(),
                path: s.path,
                line_start: s.line_start.and_then(|n| u32::try_from(n).ok()),
                line_end: s.line_end.and_then(|n| u32::try_from(n).ok()),
                quote: s.quote,
            })
            .collect(),
    }
}

/// Record a member's ✓ or ✗ on one finding. It holds for as long as the
/// finding keeps its fingerprint, which a change to either passage ends.
/// The project's glossary: the things its documents name, under the names
/// members chose and with the aliases they merged.
async fn get_glossary(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<SpecScopeQuery>,
) -> ApiResult<JsonBody<GlossaryListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let reader = quality.reader()?;
    let (_, facts, _) =
        spec_model_state(&service, &ctx, workspace_id, project_id, reader.as_ref()).await?;
    let choices = service
        .glossary_choices(workspace_id, project_id)
        .await
        .map_err(internal)?;
    let apart: std::collections::HashMap<String, Vec<String>> = service
        .spec_terms(workspace_id, project_id)
        .await
        .map_err(internal)?
        .into_iter()
        .map(|t| (t.term_key, super::service::distinct_keys(&t.distinct_from)))
        .collect();
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let items: Vec<GlossaryEntryDto> = super::spec_model::glossary::entries(&facts, &choices)
        .into_iter()
        .map(|e| GlossaryEntryDto {
            distinct_from: apart.get(&e.key).cloned().unwrap_or_default(),
            key: e.key,
            name: e.name,
            chosen: e.chosen,
            spellings: e.spellings,
            aliases: e
                .aliases
                .into_iter()
                .map(|a| GlossaryAliasDto {
                    key: a.key,
                    name: a.name,
                })
                .collect(),
            facts: count(e.facts),
            documents: count(e.documents),
        })
        .collect();
    Ok(Json(GlossaryListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

/// Which issues, pull requests and commits name an identifier the project's
/// documents define. Read whole on every call: no model, nothing stored.
async fn list_work_links(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<SpecScopeQuery>,
) -> ApiResult<JsonBody<WorkLinkListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let reader = quality.reader()?;
    let sources = service
        .spec_model_sources(&ctx, workspace_id, project_id, reader.as_ref())
        .await
        .map_err(internal)?;
    let ids = sources.labelled_ids();
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let Some(source) = quality.work() else {
        return Ok(Json(WorkLinkListDto {
            items: Vec::new(),
            total: 0,
            identifiers: count(ids.len()),
            work: 0,
            unlinked: 0,
            synced: false,
        }));
    };
    let work = source
        .project_work(&ctx, &project_id.to_string())
        .await
        .map_err(internal)?;
    let (linked, unlinked) = super::spec_model::work::link(&ids, &work);
    let items: Vec<WorkLinkDto> = linked
        .into_iter()
        .map(|l| {
            let first = l
                .defined
                .into_iter()
                .next()
                .unwrap_or_else(|| super::spec_model::finding::Side::file("", None));
            WorkLinkDto {
                id: l.id,
                defined_in: SpecModelSideDto {
                    path: first.path,
                    line_start: first.line_start.and_then(|n| u32::try_from(n).ok()),
                    line_end: first.line_end.and_then(|n| u32::try_from(n).ok()),
                    quote: first.quote,
                    binding_id: None,
                },
                work: l
                    .work
                    .into_iter()
                    .map(|i| {
                        let w = &work[i];
                        WorkItemDto {
                            kind: w.kind.clone(),
                            number: w.number,
                            title: w.title.clone(),
                            url: w.url.clone(),
                            state: w.state.clone(),
                            merged: w.merged,
                            sha: w.sha.clone(),
                        }
                    })
                    .collect(),
            }
        })
        .collect();
    Ok(Json(WorkLinkListDto {
        total: count(items.len()),
        items,
        identifiers: count(ids.len()),
        work: count(work.len()),
        unlinked: count(unlinked),
        synced: true,
    }))
}

/// Every requirement the project's documents define, with the basis it
/// states and how much work names it.
async fn list_spec_requirements(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<SpecScopeQuery>,
) -> ApiResult<JsonBody<SpecRequirementListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let reader = quality.reader()?;
    let sources = service
        .spec_model_sources(&ctx, workspace_id, project_id, reader.as_ref())
        .await
        .map_err(internal)?;
    let requirements = sources.requirements();
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let mut work_per_id: std::collections::BTreeMap<String, usize> =
        std::collections::BTreeMap::new();
    let synced = match quality.work() {
        Some(source) => {
            let work = source
                .project_work(&ctx, &project_id.to_string())
                .await
                .map_err(internal)?;
            let (linked, _) = super::spec_model::work::link(&sources.labelled_ids(), &work);
            for l in linked {
                work_per_id.insert(l.id, l.work.len());
            }
            true
        }
        None => false,
    };
    let mut by_basis: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
    let items: Vec<SpecRequirementDto> = requirements
        .into_iter()
        .map(|r| {
            *by_basis.entry(r.basis.as_str().to_string()).or_default() += 1;
            let line = u32::try_from(r.line).ok();
            SpecRequirementDto {
                work: count(work_per_id.get(&r.id).copied().unwrap_or(0)),
                defined_in: SpecModelSideDto {
                    path: r.path,
                    line_start: line,
                    line_end: line,
                    quote: None,
                    binding_id: None,
                },
                id: r.id,
                title: r.title,
                text: r.text,
                kind: r.kind,
                priority: r.priority,
                done: r.done,
                basis: r.basis.as_str().to_string(),
                cites: r.cites,
                because: r.because,
            }
        })
        .collect();
    Ok(Json(SpecRequirementListDto {
        total: count(items.len()),
        items,
        by_basis,
        synced,
    }))
}

/// One question for a document's author: an entity the project's other
/// documents relate to what this one speaks of, and this one never names.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DomainQuestionDto {
    pub entity: String,
    /// The entities the document does mention that it is related to.
    pub because_of: Vec<String>,
    pub facts: u32,
    pub documents: Vec<String>,
    /// One passage that relates them.
    pub example: Option<SpecModelSideDto>,
}

/// A word the document uses for a thing the project named otherwise.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct TermDriftDto {
    pub used: String,
    pub project_name: String,
    pub line: u32,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DomainQuestionListDto {
    pub items: Vec<DomainQuestionDto>,
    pub total: u32,
    /// False when the model has not been built: no facts, no questions.
    pub built: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct TermDriftListDto {
    pub items: Vec<TermDriftDto>,
    pub total: u32,
}

#[derive(Debug, serde::Deserialize)]
pub struct DocumentScopeQuery {
    pub project_id: String,
    pub path: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct SubjectScopeQuery {
    pub project_id: String,
    pub subject: String,
}

/// One person who changed the documents that describe an entity.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DomainExpertDto {
    /// The account's login, or the commit author's name when it has none.
    pub person: String,
    pub commits: u32,
    /// The documents they changed, of those describing the entity.
    pub documents: Vec<String>,
    /// RFC 3339, their latest change to one of them.
    pub last_change: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DomainExpertListDto {
    pub items: Vec<DomainExpertDto>,
    pub total: u32,
    /// How many documents about the entity were read.
    pub documents_read: u32,
}

/// Questions for one document: what it leaves out of the domain the project
/// describes, and the words it uses where the project named things otherwise.
async fn list_domain_questions(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<DocumentScopeQuery>,
) -> ApiResult<JsonBody<DomainQuestionListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let reader = quality.reader()?;
    let (sources, facts, _) =
        spec_model_state(&service, &ctx, workspace_id, project_id, reader.as_ref()).await?;
    let Some(doc) = sources.documents.iter().find(|d| d.path == query.path) else {
        return Err(
            DocumentsError::not_found("no such document in this project")
                .with_resource("document")
                .create(),
        );
    };
    let choices = service
        .glossary_choices(workspace_id, project_id)
        .await
        .map_err(internal)?;
    let entries = super::spec_model::glossary::entries(&facts, &choices);
    let (questions, _) =
        super::spec_model::questions::questions(&doc.path, &doc.text, &entries, &facts);
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let items: Vec<DomainQuestionDto> = questions
        .into_iter()
        .map(|q| DomainQuestionDto {
            entity: q.entity,
            because_of: q.because_of,
            facts: count(q.facts),
            documents: q.documents,
            example: q.example.map(|(path, line, quote)| SpecModelSideDto {
                quote: Some(quote),
                ..side_at(&path, line)
            }),
        })
        .collect();
    Ok(Json(DomainQuestionListDto {
        total: count(items.len()),
        items,
        built: !facts.is_empty(),
    }))
}

/// The words one document uses for things the project named otherwise.
async fn list_term_drift(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<DocumentScopeQuery>,
) -> ApiResult<JsonBody<TermDriftListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let reader = quality.reader()?;
    let (sources, facts, _) =
        spec_model_state(&service, &ctx, workspace_id, project_id, reader.as_ref()).await?;
    let Some(doc) = sources.documents.iter().find(|d| d.path == query.path) else {
        return Err(
            DocumentsError::not_found("no such document in this project")
                .with_resource("document")
                .create(),
        );
    };
    let choices = service
        .glossary_choices(workspace_id, project_id)
        .await
        .map_err(internal)?;
    let entries = super::spec_model::glossary::entries(&facts, &choices);
    let (_, drifts) =
        super::spec_model::questions::questions(&doc.path, &doc.text, &entries, &facts);
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let items: Vec<TermDriftDto> = drifts
        .into_iter()
        .map(|d| TermDriftDto {
            used: d.used,
            project_name: d.project_name,
            line: count(d.line),
        })
        .collect();
    Ok(Json(TermDriftListDto {
        total: count(items.len()),
        items,
    }))
}

/// How many documents about an entity are asked about who changed them, and
/// how many commits of each are read.
const EXPERT_DOCUMENTS: usize = 3;
const EXPERT_COMMITS: u32 = 30;

fn is_bot_author(a: &str) -> bool {
    let a = a.to_ascii_lowercase();
    a.ends_with("[bot]") || a.ends_with("-bot") || a == "github-actions" || a.contains("dependabot")
}

/// Whom to ask about an entity: the people who changed the documents that
/// describe it most, from the repository's history.
async fn list_domain_experts(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<SubjectScopeQuery>,
) -> ApiResult<JsonBody<DomainExpertListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let reader = quality.reader()?;
    let (_, facts, _) =
        spec_model_state(&service, &ctx, workspace_id, project_id, reader.as_ref()).await?;
    let key = super::spec_model::rules::subject_key(&query.subject);
    let mut per_doc: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for f in facts
        .iter()
        .filter(|f| super::spec_model::rules::subject_key(&f.subject) == key)
    {
        *per_doc.entry(f.path.clone()).or_default() += 1;
    }
    let mut documents: Vec<(String, usize)> = per_doc.into_iter().collect();
    documents.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    documents.truncate(EXPERT_DOCUMENTS);
    let documents: Vec<String> = documents.into_iter().map(|(p, _)| p).collect();

    // person -> (commits, documents, latest)
    let mut people: std::collections::BTreeMap<
        String,
        (u32, std::collections::BTreeSet<String>, Option<String>),
    > = std::collections::BTreeMap::new();
    if let Some(connectors) = crate::connectors::sdk::Connectors::new(quality.hub.clone()).get() {
        for source in service.project_repositories(&ctx, project_id).await {
            let Some(connection_id) = source.connection_id else {
                continue;
            };
            let Some(tenant) = connectors.locate(&ctx, project_id, connection_id).await else {
                continue;
            };
            let Ok(repo) = crate::connectors::sdk::Repository::open(
                &connectors,
                &ctx,
                tenant,
                Some(connection_id),
                "github",
                &source.full_path,
                source.branch.as_deref(),
            )
            .await
            else {
                continue;
            };
            for path in &documents {
                let Ok(commits) = repo.history(path, EXPERT_COMMITS).await else {
                    continue;
                };
                for c in commits {
                    let Some(who) = c.author.clone().or(c.author_name.clone()) else {
                        continue;
                    };
                    if is_bot_author(&who) {
                        continue;
                    }
                    let entry = people.entry(who).or_default();
                    entry.0 += 1;
                    entry.1.insert(path.clone());
                    let at = c.committed_at.or(c.created_at);
                    if at > entry.2 {
                        entry.2 = at;
                    }
                }
            }
        }
    }
    let mut items: Vec<DomainExpertDto> = people
        .into_iter()
        .map(|(person, (commits, docs, last))| DomainExpertDto {
            person,
            commits,
            documents: docs.into_iter().collect(),
            last_change: last,
        })
        .collect();
    items.sort_by(|a, b| {
        b.commits
            .cmp(&a.commits)
            .then(b.last_change.cmp(&a.last_change))
    });
    items.truncate(5);
    Ok(Json(DomainExpertListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        documents_read: u32::try_from(documents.len()).unwrap_or(u32::MAX),
    }))
}

/// One comment of a review thread.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RemarkCommentDto {
    pub author: Option<String>,
    pub body: String,
    pub url: Option<String>,
    pub created_at: Option<String>,
}

/// One review thread on a document, from the repository host.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RemarkDto {
    /// The host's thread id, for a reply.
    pub thread_id: String,
    /// `owner/repo`.
    pub repo: String,
    pub pull_number: i64,
    pub pull_title: String,
    pub pull_url: Option<String>,
    /// `OPEN`, `CLOSED` or `MERGED`.
    pub pull_state: String,
    pub resolved: bool,
    pub outdated: bool,
    /// Unresolved in a pull request no longer open.
    pub left_open: bool,
    pub line: Option<i64>,
    pub comments: Vec<RemarkCommentDto>,
    /// Labelled identifiers its comments name.
    pub requirements: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RemarkListDto {
    pub items: Vec<RemarkDto>,
    pub total: u32,
    /// Threads left open after their pull request closed.
    pub left_open: u32,
    /// False when no repository connection could be asked.
    pub reached: bool,
}

/// A reply to a review thread, sent to the host.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct RemarkReplyRequest {
    pub project_id: String,
    /// `owner/repo`, as the remark names it.
    pub repo: String,
    pub thread_id: String,
    pub body: String,
}

/// Record a decision.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct DecisionInput {
    pub project_id: String,
    pub statement: String,
    /// Requirement identifiers it closes.
    pub requirements: Option<Vec<String>>,
    pub source_url: Option<String>,
    /// `review_thread`, `meeting`, `chat` or `other`.
    pub source_kind: String,
    pub path: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DecisionDto {
    pub id: String,
    pub statement: String,
    pub requirements: Vec<String>,
    pub source_url: Option<String>,
    pub source_kind: String,
    pub path: Option<String>,
    pub decided_by: String,
    pub decided_by_name: Option<String>,
    pub decided_at: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DecisionListDto {
    pub items: Vec<DecisionDto>,
    pub total: u32,
}

#[derive(Debug, serde::Deserialize)]
pub struct DecisionListQuery {
    pub project_id: String,
    /// Only the decisions that close this requirement.
    pub requirement: Option<String>,
    /// Only the decisions about this document.
    pub path: Option<String>,
}

fn decision_dto(d: super::entity::decision::Model) -> DecisionDto {
    DecisionDto {
        id: d.id.to_string(),
        statement: d.statement,
        requirements: serde_json::from_value(d.requirements).unwrap_or_default(),
        source_url: d.source_url,
        source_kind: d.source_kind,
        path: d.path,
        decided_by: d.decided_by,
        decided_by_name: d.decided_by_name,
        decided_at: rfc3339(d.decided_at),
    }
}

/// The project's repositories the caller's connections reach, with their
/// driver and credentials.
async fn reachable_repositories(
    service: &DocumentsService,
    quality: &Quality,
    ctx: &SecurityContext,
    project_id: Uuid,
) -> Vec<(
    std::sync::Arc<dyn crate::connectors::sdk::ConnectorDriver>,
    crate::connectors::sdk::ConnectionAuth,
    String,
    String,
)> {
    let Some(connectors) = crate::connectors::sdk::Connectors::new(quality.hub.clone()).get()
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for source in service.project_repositories(ctx, project_id).await {
        let Some(connection_id) = source.connection_id else {
            continue;
        };
        let Some(tenant) = connectors.locate(ctx, project_id, connection_id).await else {
            continue;
        };
        if let Ok((driver, auth, _)) = connectors.driver_and_auth(ctx, tenant, connection_id).await
        {
            let branch = source
                .branch
                .clone()
                .filter(|b| !b.trim().is_empty())
                .unwrap_or_else(|| "main".to_string());
            out.push((driver, auth, source.full_path.clone(), branch));
        }
    }
    out
}

/// Every review thread on one document, from the pull requests that changed
/// it and the open ones that change it.
async fn list_remarks(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<DocumentScopeQuery>,
) -> ApiResult<JsonBody<RemarkListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let _ = parent_workspace(&service, &ctx, project_id).await?;
    let repos = reachable_repositories(&service, &quality, &ctx, project_id).await;
    let reached = !repos.is_empty();
    let mut items = Vec::new();
    for (driver, auth, repo, branch) in repos {
        let Some((owner, name)) = repo.split_once('/') else {
            continue;
        };
        let answer = match driver
            .graphql(
                &auth,
                &super::remarks::remarks_request(owner, name, &query.path, &branch),
            )
            .await
        {
            Ok(a) => a,
            Err(e) => {
                tracing::warn!(error = %e, repo = %repo, "remarks: the host could not be asked");
                continue;
            }
        };
        let threads = match super::remarks::read_remarks(&answer, &query.path) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(error = %e, repo = %repo, "remarks: the host answered with an error");
                continue;
            }
        };
        for t in threads {
            let text: String = t
                .comments
                .iter()
                .map(|c| c.body.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            items.push(RemarkDto {
                requirements: super::remarks::identifiers_in(&text),
                left_open: t.left_open(),
                thread_id: t.id,
                repo: repo.clone(),
                pull_number: t.pull_number,
                pull_title: t.pull_title,
                pull_url: t.pull_url,
                pull_state: t.pull_state,
                resolved: t.resolved,
                outdated: t.outdated,
                line: t.line,
                comments: t
                    .comments
                    .into_iter()
                    .map(|c| RemarkCommentDto {
                        author: c.author,
                        body: c.body,
                        url: c.url,
                        created_at: c.created_at,
                    })
                    .collect(),
            });
        }
    }
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let left_open = items.iter().filter(|r| r.left_open).count();
    Ok(Json(RemarkListDto {
        total: count(items.len()),
        left_open: count(left_open),
        items,
        reached,
    }))
}

/// Answer a review thread; the reply is posted to the host under the
/// caller's connection.
async fn create_remark_reply(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Json(body): Json<RemarkReplyRequest>,
) -> ApiResult<(StatusCode, JsonBody<RemarkCommentDto>)> {
    let project_id = parse_project_id(&body.project_id)?;
    let _ = parent_workspace(&service, &ctx, project_id).await?;
    let text = body.body.trim();
    if text.is_empty() || text.chars().count() > 10_000 {
        return Err(DocumentsError::invalid_argument()
            .with_field_violation("body", "1 to 10000 characters".to_owned(), "INVALID")
            .create());
    }
    let repos = reachable_repositories(&service, &quality, &ctx, project_id).await;
    let Some((driver, auth, _, _)) = repos.into_iter().find(|(_, _, r, _)| *r == body.repo) else {
        return Err(DocumentsError::not_found(
            "no connection of this project reaches that repository",
        )
        .with_resource("repository")
        .create());
    };
    let answer = driver
        .graphql(&auth, &super::remarks::reply_request(&body.thread_id, text))
        .await
        .map_err(|e| {
            CanonicalError::service_unavailable()
                .with_detail(format!("the host could not be asked: {e:#}"))
                .create()
        })?;
    let c = super::remarks::read_reply(&answer).map_err(|why| {
        DocumentsError::invalid_argument()
            .with_constraint(format!("the host refused the reply: {why}"))
            .create()
    })?;
    Ok((
        StatusCode::CREATED,
        Json(RemarkCommentDto {
            author: c.author,
            body: c.body,
            url: c.url,
            created_at: c.created_at,
        }),
    ))
}

async fn create_decision(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Json(body): Json<DecisionInput>,
) -> ApiResult<(StatusCode, JsonBody<DecisionDto>)> {
    let project_id = parse_project_id(&body.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let me = quality.caller(&ctx).await?;
    let saved = service
        .record_decision(
            workspace_id,
            project_id,
            &body.statement,
            body.requirements.unwrap_or_default(),
            body.source_url,
            &body.source_kind,
            body.path,
            me,
        )
        .await
        .map_err(invalid)?;
    Ok((StatusCode::CREATED, Json(decision_dto(saved))))
}

async fn list_decisions(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Query(query): Query<DecisionListQuery>,
) -> ApiResult<JsonBody<DecisionListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let items: Vec<DecisionDto> = service
        .decisions(workspace_id, project_id)
        .await
        .map_err(internal)?
        .into_iter()
        .map(decision_dto)
        .filter(|d| {
            query
                .requirement
                .as_deref()
                .is_none_or(|r| d.requirements.iter().any(|x| x == r))
        })
        .filter(|d| {
            query
                .path
                .as_deref()
                .is_none_or(|p| d.path.as_deref() == Some(p))
        })
        .collect();
    Ok(Json(DecisionListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

/// One part of the application beyond its gears.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ApplicationPartDto {
    /// `configuration`, `storage` or `deployment`.
    pub kind: String,
    /// `owner/repo`.
    pub repo: String,
    /// A directory or a file in it.
    pub reference: String,
    pub name: String,
    /// What it was recognised by; empty for a part only recorded.
    pub evidence: String,
    /// Still found in the repository.
    pub present: bool,
    pub owner: Option<String>,
    pub owner_name: Option<String>,
    pub description_path: Option<String>,
    pub boundary: Option<String>,
    pub related: Vec<String>,
    pub updated_by: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ApplicationPartListDto {
    pub items: Vec<ApplicationPartDto>,
    pub total: u32,
    /// Repositories read.
    pub repos: u32,
}

/// Record what is known about one part.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ApplicationPartInput {
    pub project_id: String,
    pub repo: String,
    pub kind: String,
    pub reference: String,
    pub owner: Option<String>,
    pub owner_name: Option<String>,
    pub description_path: Option<String>,
    pub boundary: Option<String>,
    pub related: Option<Vec<String>>,
}

fn part_dto(
    kind: String,
    repo: String,
    reference: String,
    name: String,
    evidence: String,
    present: bool,
    record: Option<&super::entity::application_part::Model>,
) -> ApplicationPartDto {
    ApplicationPartDto {
        kind,
        repo,
        reference,
        name,
        evidence,
        present,
        owner: record.and_then(|r| r.owner.clone()),
        owner_name: record.and_then(|r| r.owner_name.clone()),
        description_path: record.and_then(|r| r.description_path.clone()),
        boundary: record.and_then(|r| r.boundary.clone()),
        related: record
            .map(|r| serde_json::from_value(r.related.clone()).unwrap_or_default())
            .unwrap_or_default(),
        updated_by: record.map(|r| r.updated_by.clone()),
        updated_at: record.map(|r| rfc3339(r.updated_at)),
    }
}

/// The application's configuration, storage and deployment parts, found in
/// the project's repositories, with what people recorded about each.
async fn list_application_parts(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<ProjectQuery>,
) -> ApiResult<JsonBody<ApplicationPartListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let records = service
        .part_records(workspace_id, project_id)
        .await
        .map_err(internal)?;
    let mut items = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let mut repos = 0u32;
    for (driver, auth, repo, branch) in
        reachable_repositories(&service, &quality, &ctx, project_id).await
    {
        let Ok(list) = driver.list_files(&auth, &repo, Some(&branch)).await else {
            continue;
        };
        repos += 1;
        let paths: Vec<String> = list
            .files
            .into_iter()
            .filter(|f| !f.is_dir)
            .map(|f| f.path)
            .collect();
        for part in super::parts::detect(&repo, &paths) {
            let record = records
                .iter()
                .find(|r| r.repo == repo && r.kind == part.kind && r.reference == part.reference);
            seen.insert((repo.clone(), part.kind.to_string(), part.reference.clone()));
            items.push(part_dto(
                part.kind.to_string(),
                repo.clone(),
                part.reference,
                part.name,
                part.evidence,
                true,
                record,
            ));
        }
    }
    // A part someone recorded that the repositories no longer show.
    for r in &records {
        if !seen.contains(&(r.repo.clone(), r.kind.clone(), r.reference.clone())) {
            let name = r
                .reference
                .rsplit('/')
                .next()
                .unwrap_or(&r.reference)
                .to_string();
            items.push(part_dto(
                r.kind.clone(),
                r.repo.clone(),
                r.reference.clone(),
                name,
                String::new(),
                false,
                Some(r),
            ));
        }
    }
    Ok(Json(ApplicationPartListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        repos,
    }))
}

async fn upsert_application_part(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Json(body): Json<ApplicationPartInput>,
) -> ApiResult<JsonBody<ApplicationPartDto>> {
    let project_id = parse_project_id(&body.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let (me, _) = quality.caller(&ctx).await?;
    let saved = service
        .record_part(
            workspace_id,
            project_id,
            body.repo.trim(),
            body.kind.trim(),
            body.reference.trim(),
            super::service::PartRecord {
                owner: body.owner,
                owner_name: body.owner_name,
                description_path: body.description_path,
                boundary: body.boundary,
                related: body.related.unwrap_or_default(),
            },
            &me,
        )
        .await
        .map_err(invalid)?;
    let name = saved
        .reference
        .rsplit('/')
        .next()
        .unwrap_or(&saved.reference)
        .to_string();
    Ok(Json(part_dto(
        saved.kind.clone(),
        saved.repo.clone(),
        saved.reference.clone(),
        name,
        String::new(),
        true,
        Some(&saved),
    )))
}

/// A new delivery scope.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct DeliveryScopeInput {
    pub project_id: String,
    pub title: String,
    pub outcome: Option<String>,
    /// Canonical person id.
    pub owner: Option<String>,
    pub owner_name: Option<String>,
    /// `YYYY-MM-DD`.
    pub target_date: Option<String>,
    /// Requirement identifiers it delivers.
    pub requirements: Option<Vec<String>>,
    /// Gears it pins, by crate name.
    pub gears: Option<Vec<String>>,
    pub acceptance: Option<String>,
    /// `planned` (default), `in_progress`, `delivered`, `dropped`.
    pub state: Option<String>,
}

/// A change to a delivery scope: only the fields given change.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct DeliveryScopePatch {
    pub project_id: String,
    pub title: Option<String>,
    pub outcome: Option<String>,
    /// An empty string clears it.
    pub owner: Option<String>,
    pub owner_name: Option<String>,
    /// An empty string clears it.
    pub target_date: Option<String>,
    pub requirements: Option<Vec<String>>,
    pub gears: Option<Vec<String>>,
    pub acceptance: Option<String>,
    pub state: Option<String>,
}

/// A new limit on a scope.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct DeliveryLimitInput {
    pub project_id: String,
    /// `limitation`, `open_question` or `dependency`.
    pub kind: String,
    pub text: String,
    pub blocking: Option<bool>,
    /// For a dependency: another scope's id, or a decision record.
    pub depends_on: Option<String>,
}

/// Resolve a limit, or change whether it blocks.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct DeliveryLimitPatch {
    pub project_id: String,
    /// The resolution; an empty string reopens the limit.
    pub resolution: Option<String>,
    pub blocking: Option<bool>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeliveryLimitDto {
    pub id: String,
    pub scope_id: String,
    pub kind: String,
    pub text: String,
    pub blocking: bool,
    pub depends_on: Option<String>,
    pub resolution: Option<String>,
    pub resolved_by: Option<String>,
    pub resolved_at: Option<String>,
    pub created_by: String,
    pub created_at: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeliveryScopeDto {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub outcome: String,
    pub owner: Option<String>,
    pub owner_name: Option<String>,
    pub target_date: Option<String>,
    pub requirements: Vec<String>,
    pub gears: Vec<String>,
    pub acceptance: String,
    pub state: String,
    /// A blocking limit still holds.
    pub blocked: bool,
    pub limits: Vec<DeliveryLimitDto>,
    pub created_by: String,
    pub created_at: String,
    pub updated_by: String,
    pub updated_at: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeliveryScopeListDto {
    pub items: Vec<DeliveryScopeDto>,
    pub total: u32,
}

/// One earlier version of a scope.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeliveryScopeVersionDto {
    /// The scope's fields as they were before the change.
    pub snapshot: serde_json::Value,
    pub changed_by: String,
    pub changed_at: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeliveryScopeHistoryDto {
    pub items: Vec<DeliveryScopeVersionDto>,
    pub total: u32,
}

#[derive(Debug, serde::Deserialize)]
pub struct ProjectQuery {
    pub project_id: String,
}

fn limit_dto(l: super::entity::delivery_limit::Model) -> DeliveryLimitDto {
    DeliveryLimitDto {
        id: l.id.to_string(),
        scope_id: l.scope_id.to_string(),
        kind: l.kind,
        text: l.text,
        blocking: l.blocking,
        depends_on: l.depends_on,
        resolution: l.resolution,
        resolved_by: l.resolved_by,
        resolved_at: l.resolved_at.map(rfc3339),
        created_by: l.created_by,
        created_at: rfc3339(l.created_at),
    }
}

fn scope_dto(
    s: super::entity::delivery_scope::Model,
    limits: Vec<super::entity::delivery_limit::Model>,
    blocked: bool,
) -> DeliveryScopeDto {
    DeliveryScopeDto {
        id: s.id.to_string(),
        project_id: s.project_id.to_string(),
        title: s.title,
        outcome: s.outcome,
        owner: s.owner,
        owner_name: s.owner_name,
        target_date: s.target_date,
        requirements: serde_json::from_value(s.requirements).unwrap_or_default(),
        gears: serde_json::from_value(s.gears).unwrap_or_default(),
        acceptance: s.acceptance,
        state: s.state,
        blocked,
        limits: limits.into_iter().map(limit_dto).collect(),
        created_by: s.created_by,
        created_at: rfc3339(s.created_at),
        updated_by: s.updated_by,
        updated_at: rfc3339(s.updated_at),
    }
}

fn no_scope() -> CanonicalError {
    DocumentsError::not_found("no such delivery scope in this project")
        .with_resource("delivery_scope")
        .create()
}

/// The scope as it now stands, with its limits and whether it is blocked.
async fn scope_view_dto(
    service: &DocumentsService,
    workspace_id: Uuid,
    project_id: Uuid,
    id: Uuid,
) -> ApiResult<DeliveryScopeDto> {
    let view = service
        .delivery_scopes(workspace_id, project_id)
        .await
        .map_err(internal)?
        .into_iter()
        .find(|v| v.scope.id == id)
        .ok_or_else(no_scope)?;
    Ok(scope_dto(view.scope, view.limits, view.blocked))
}

async fn list_delivery_scopes(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Query(query): Query<ProjectQuery>,
) -> ApiResult<JsonBody<DeliveryScopeListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let items: Vec<DeliveryScopeDto> = service
        .delivery_scopes(workspace_id, project_id)
        .await
        .map_err(internal)?
        .into_iter()
        .map(|v| scope_dto(v.scope, v.limits, v.blocked))
        .collect();
    Ok(Json(DeliveryScopeListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

async fn create_delivery_scope(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Json(body): Json<DeliveryScopeInput>,
) -> ApiResult<(StatusCode, JsonBody<DeliveryScopeDto>)> {
    let project_id = parse_project_id(&body.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let (me, _) = quality.caller(&ctx).await?;
    let saved = service
        .create_scope(
            workspace_id,
            project_id,
            super::delivery::ScopeFields {
                title: body.title,
                outcome: body.outcome.unwrap_or_default(),
                owner: body.owner,
                owner_name: body.owner_name,
                target_date: body.target_date,
                requirements: body.requirements.unwrap_or_default(),
                gears: body.gears.unwrap_or_default(),
                acceptance: body.acceptance.unwrap_or_default(),
                state: body.state.unwrap_or_default(),
            },
            &me,
        )
        .await
        .map_err(invalid)?;
    Ok((
        StatusCode::CREATED,
        Json(scope_dto(saved, Vec::new(), false)),
    ))
}

async fn update_delivery_scope(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Path(scope_id): Path<String>,
    Json(body): Json<DeliveryScopePatch>,
) -> ApiResult<JsonBody<DeliveryScopeDto>> {
    let project_id = parse_project_id(&body.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let id = parse_uuid_field("scope_id", &scope_id)?;
    let (me, _) = quality.caller(&ctx).await?;
    let clearable = |v: Option<String>| v.map(|s| Some(s).filter(|s| !s.trim().is_empty()));
    let patch = super::service::ScopePatch {
        title: body.title,
        outcome: body.outcome,
        owner: clearable(body.owner),
        owner_name: clearable(body.owner_name),
        target_date: clearable(body.target_date),
        requirements: body.requirements,
        gears: body.gears,
        acceptance: body.acceptance,
        state: body.state,
    };
    service
        .update_scope(workspace_id, project_id, id, patch, &me)
        .await
        .map_err(invalid)?
        .ok_or_else(no_scope)?;
    Ok(Json(
        scope_view_dto(&service, workspace_id, project_id, id).await?,
    ))
}

async fn delete_delivery_scope(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(scope_id): Path<String>,
    Query(query): Query<ProjectQuery>,
) -> ApiResult<StatusCode> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let id = parse_uuid_field("scope_id", &scope_id)?;
    if service
        .delete_scope(workspace_id, project_id, id)
        .await
        .map_err(internal)?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(no_scope())
    }
}

async fn list_delivery_scope_history(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Path(scope_id): Path<String>,
    Query(query): Query<ProjectQuery>,
) -> ApiResult<JsonBody<DeliveryScopeHistoryDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let id = parse_uuid_field("scope_id", &scope_id)?;
    let items: Vec<DeliveryScopeVersionDto> = service
        .scope_history(workspace_id, project_id, id)
        .await
        .map_err(internal)?
        .ok_or_else(no_scope)?
        .into_iter()
        .map(|h| DeliveryScopeVersionDto {
            snapshot: h.snapshot,
            changed_by: h.changed_by,
            changed_at: rfc3339(h.changed_at),
        })
        .collect();
    Ok(Json(DeliveryScopeHistoryDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

async fn create_delivery_limit(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Path(scope_id): Path<String>,
    Json(body): Json<DeliveryLimitInput>,
) -> ApiResult<(StatusCode, JsonBody<DeliveryLimitDto>)> {
    let project_id = parse_project_id(&body.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let id = parse_uuid_field("scope_id", &scope_id)?;
    let (me, _) = quality.caller(&ctx).await?;
    let saved = service
        .add_limit(
            workspace_id,
            project_id,
            id,
            super::delivery::LimitFields {
                kind: body.kind,
                text: body.text,
                blocking: body.blocking.unwrap_or(false),
                depends_on: body.depends_on,
            },
            &me,
        )
        .await
        .map_err(invalid)?
        .ok_or_else(no_scope)?;
    Ok((StatusCode::CREATED, Json(limit_dto(saved))))
}

async fn update_delivery_limit(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Path((scope_id, limit_id)): Path<(String, String)>,
    Json(body): Json<DeliveryLimitPatch>,
) -> ApiResult<JsonBody<DeliveryLimitDto>> {
    let project_id = parse_project_id(&body.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let scope = parse_uuid_field("scope_id", &scope_id)?;
    let limit = parse_uuid_field("limit_id", &limit_id)?;
    let (me, _) = quality.caller(&ctx).await?;
    let saved = service
        .update_limit(
            workspace_id,
            project_id,
            scope,
            limit,
            body.resolution,
            body.blocking,
            &me,
        )
        .await
        .map_err(invalid)?
        .ok_or_else(|| {
            DocumentsError::not_found("no such limit on this scope")
                .with_resource("delivery_limit")
                .create()
        })?;
    Ok(Json(limit_dto(saved)))
}

/// Check the project's open pull requests.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PullRequestChecksRequest {
    pub project_id: String,
    /// Set a commit status on each checked pull request's head. False: only
    /// answer what the statuses would say.
    pub publish: Option<bool>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PullRequestFileCheckDto {
    pub path: String,
    pub type_key: String,
    pub conforms: bool,
    pub issues: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PullRequestCheckDto {
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub url: Option<String>,
    pub head: String,
    /// `success` or `failure`.
    pub state: String,
    pub description: String,
    pub files: Vec<PullRequestFileCheckDto>,
    /// The status was set on the host.
    pub published: bool,
    /// Why it could not be, when it could not.
    pub publish_error: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PullRequestCheckListDto {
    pub items: Vec<PullRequestCheckDto>,
    pub total: u32,
    /// Open pull requests read, documents or not.
    pub pulls: u32,
    pub reached: bool,
}

/// Run the project's document checks on its open pull requests that change a
/// document of a known type, and say the result on each as a commit status.
async fn run_pull_request_checks(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Json(body): Json<PullRequestChecksRequest>,
) -> ApiResult<JsonBody<PullRequestCheckListDto>> {
    use super::pr_checks::{STATUS_CONTEXT, check, open_pulls_request, read_open_pulls};
    let project_id = parse_project_id(&body.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let publish = body.publish.unwrap_or(true);
    let types = service
        .list_types(&ctx, workspace_id)
        .await
        .map_err(internal)?;
    // Which path is which type: the project's settled bindings.
    let typed: std::collections::BTreeMap<String, String> = service
        .project_bindings(workspace_id, project_id)
        .await
        .map_err(internal)?;
    let repos = reachable_repositories(&service, &quality, &ctx, project_id).await;
    let reached = !repos.is_empty();
    let mut items = Vec::new();
    let mut pulls_read = 0usize;
    for (driver, auth, repo, _) in repos {
        let Some((owner, name)) = repo.split_once('/') else {
            continue;
        };
        let pulls = match driver
            .graphql(&auth, &open_pulls_request(owner, name))
            .await
            .map_err(|e| e.to_string())
            .and_then(|a| read_open_pulls(&a))
        {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(error = %e, repo = %repo, "pr checks: open pull requests unreadable");
                continue;
            }
        };
        pulls_read += pulls.len();
        for pull in pulls {
            let mut changed = Vec::new();
            for path in &pull.files {
                let Some(ty) = typed
                    .get(path)
                    .and_then(|key| types.iter().find(|t| &t.key == key))
                else {
                    continue;
                };
                // The version in the pull request, not the one on the branch.
                if let Ok(Some(file)) = driver.read_file(&auth, &repo, path, Some(&pull.head)).await
                {
                    changed.push((path.clone(), ty, file.text));
                }
            }
            if changed.is_empty() {
                continue;
            }
            let outcome = check(&changed);
            let (published, publish_error) = if publish {
                let status = crate::connectors::sdk::CommitStatus {
                    state: outcome.state.to_string(),
                    context: STATUS_CONTEXT.to_string(),
                    description: outcome.description.clone(),
                    target_url: None,
                };
                match driver
                    .set_commit_status(&auth, &repo, &pull.head, &status)
                    .await
                {
                    Ok(()) => (true, None),
                    Err(e) => (false, Some(format!("{e:#}"))),
                }
            } else {
                (false, None)
            };
            items.push(PullRequestCheckDto {
                repo: repo.clone(),
                number: pull.number,
                title: pull.title,
                url: pull.url,
                head: pull.head,
                state: outcome.state.to_string(),
                description: outcome.description,
                files: outcome
                    .files
                    .into_iter()
                    .map(|f| PullRequestFileCheckDto {
                        path: f.path,
                        type_key: f.type_key,
                        conforms: f.conforms,
                        issues: f.issues,
                    })
                    .collect(),
                published,
                publish_error,
            });
        }
    }
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    Ok(Json(PullRequestCheckListDto {
        total: count(items.len()),
        items,
        pulls: count(pulls_read),
        reached,
    }))
}

/// Ask for a review brief of one document.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ReviewBriefRequest {
    pub project_id: String,
    /// The document, by its path in the checkout.
    pub path: String,
    /// The version to compare with: a commit sha or a branch. Absent: the
    /// document as it was before its latest commit.
    pub base_ref: Option<String>,
}

/// One requirement that differs from the base version.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct BriefChangeDto {
    pub id: String,
    /// `added`, `removed` or `changed`.
    pub kind: String,
    pub before: Option<String>,
    pub after: Option<String>,
    /// True when what is required changed; false for rewording.
    pub meaning: bool,
    pub why: String,
}

/// A brief for the people reviewing a document.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReviewBriefDto {
    pub path: String,
    pub problem: String,
    pub roles: Vec<String>,
    pub scope: String,
    pub out_of_scope: Vec<String>,
    pub assumptions: Vec<String>,
    pub open_decisions: Vec<String>,
    /// The commit compared with, when one was found.
    pub base_ref: Option<String>,
    pub changes: Vec<BriefChangeDto>,
    /// The provider and model that wrote the summary.
    pub provider: String,
    pub model: String,
}

/// The document's text at `base_ref`, or before its latest commit, through
/// the project's repository connection. `None` when nothing reaches it.
async fn base_text(
    service: &DocumentsService,
    quality: &Quality,
    ctx: &SecurityContext,
    project_id: Uuid,
    path: &str,
    base_ref: Option<&str>,
) -> Option<(String, String)> {
    let connectors = crate::connectors::sdk::Connectors::new(quality.hub.clone()).get()?;
    for source in service.project_repositories(ctx, project_id).await {
        let Some(connection_id) = source.connection_id else {
            continue;
        };
        let Some(tenant) = connectors.locate(ctx, project_id, connection_id).await else {
            continue;
        };
        let open = |git_ref: Option<String>| {
            let connectors = connectors.clone();
            let repo = source.full_path.clone();
            async move {
                crate::connectors::sdk::Repository::open(
                    &connectors,
                    ctx,
                    tenant,
                    Some(connection_id),
                    "github",
                    &repo,
                    git_ref.as_deref(),
                )
                .await
                .ok()
            }
        };
        let base = match base_ref {
            Some(r) => r.to_string(),
            None => {
                let Some(head) = open(source.branch.clone()).await else {
                    continue;
                };
                let Ok(history) = head.history(path, 2).await else {
                    continue;
                };
                let Some(previous) = history.get(1) else {
                    continue;
                };
                previous.sha.clone()
            }
        };
        let Some(at_base) = open(Some(base.clone())).await else {
            continue;
        };
        if let Ok(Some(file)) = at_base.read_file(path).await {
            return Some((base, file.text));
        }
    }
    None
}

/// A brief of one document for its reviewers, with what changed since a base
/// version told apart as meaning or wording.
async fn analyze_review_brief(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Json(body): Json<ReviewBriefRequest>,
) -> ApiResult<JsonBody<ReviewBriefDto>> {
    let project_id = parse_project_id(&body.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let reader = quality.reader()?;
    let models = quality.models()?;
    let sources = service
        .spec_model_sources(&ctx, workspace_id, project_id, reader.as_ref())
        .await
        .map_err(internal)?;
    let Some(doc) = sources.documents.iter().find(|d| d.path == body.path) else {
        return Err(
            DocumentsError::not_found("no such document in this project")
                .with_resource("document")
                .create(),
        );
    };
    let base = base_text(
        &service,
        &quality,
        &ctx,
        project_id,
        &doc.path,
        body.base_ref
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty()),
    )
    .await;
    let changes = match &base {
        Some((_, old)) => super::brief::changes(&doc.path, old, &doc.text),
        None => Vec::new(),
    };
    let request = super::brief::request(&doc.path, doc.doc_type.as_deref(), &doc.text, &changes);
    let answer = match models.complete(&ctx, &request).await {
        Ok(a) => a,
        Err(crate::llm_proxy::port::CompletionError::NoKey(message)) => {
            return Err(DocumentsError::failed_precondition()
                .with_precondition_violation("provider_key", message, "PROVIDER_KEY_REQUIRED")
                .create());
        }
        Err(crate::llm_proxy::port::CompletionError::Failed(e)) => {
            return Err(CanonicalError::service_unavailable()
                .with_detail(format!("the model could not be asked: {e:#}"))
                .create());
        }
    };
    let brief = super::brief::read_answer(&answer.text, &changes).map_err(|why| {
        CanonicalError::service_unavailable()
            .with_detail(format!("the model's answer could not be read: {why}"))
            .create()
    })?;
    let changes = changes
        .into_iter()
        .map(|c| {
            let m = brief.changes.iter().find(|m| m.id == c.id);
            BriefChangeDto {
                meaning: m.is_none_or(|m| m.meaning),
                why: m.map(|m| m.why.clone()).unwrap_or_default(),
                id: c.id,
                kind: c.kind,
                before: c.before,
                after: c.after,
            }
        })
        .collect();
    Ok(Json(ReviewBriefDto {
        path: doc.path.clone(),
        problem: brief.problem,
        roles: brief.roles,
        scope: brief.scope,
        out_of_scope: brief.out_of_scope,
        assumptions: brief.assumptions,
        open_decisions: brief.open_decisions,
        base_ref: base.map(|(r, _)| r),
        changes,
        provider: answer.provider,
        model: answer.model,
    }))
}

/// One requirement and every place that names it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RequirementTraceDto {
    pub id: String,
    pub defined_in: SpecModelSideDto,
    pub title: Option<String>,
    pub text: String,
    /// Other documents, and other places in its own, that refer to it.
    pub documents: Vec<SpecModelSideDto>,
    /// Code that names it, tests left out.
    pub code: Vec<SpecModelSideDto>,
    /// Tests that name it, told from code by their path.
    pub tests: Vec<SpecModelSideDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RequirementTraceListDto {
    pub items: Vec<RequirementTraceDto>,
    pub total: u32,
    /// Requirements some code names.
    pub implemented: u32,
    /// Requirements some test names.
    pub tested: u32,
    /// Code and test files read.
    pub files: u32,
}

/// Every requirement of the project with the documents, code and tests that
/// name it.
async fn list_requirement_trace(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<SpecScopeQuery>,
) -> ApiResult<JsonBody<RequirementTraceListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let reader = quality.reader()?;
    let sources = service
        .spec_model_sources(&ctx, workspace_id, project_id, reader.as_ref())
        .await
        .map_err(internal)?;
    // Reading every checkout file is CPU work, not waiting: off the async
    // workers, so a large project does not stall every other request and the
    // health check with them.
    let (traced, files) =
        tokio::task::spawn_blocking(move || (sources.trace(), sources.files.len()))
            .await
            .map_err(|e| internal(anyhow::anyhow!("tracing requirements: {e}")))?;
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let sides = |c: Vec<super::spec_model::trace::Cited>| -> Vec<SpecModelSideDto> {
        c.into_iter().map(|x| side_at(&x.path, x.line)).collect()
    };
    let implemented = traced.iter().filter(|t| !t.code.is_empty()).count();
    let tested = traced.iter().filter(|t| !t.tests.is_empty()).count();
    let items: Vec<RequirementTraceDto> = traced
        .into_iter()
        .map(|t| RequirementTraceDto {
            defined_in: side_at(&t.requirement.path, t.requirement.line),
            id: t.requirement.id,
            title: t.requirement.title,
            text: t.requirement.text,
            documents: sides(t.documents),
            code: sides(t.code),
            tests: sides(t.tests),
        })
        .collect();
    Ok(Json(RequirementTraceListDto {
        total: count(items.len()),
        items,
        implemented: count(implemented),
        tested: count(tested),
        files: count(files),
    }))
}

/// How many other projects one `related` read compares against: each is a
/// read of its documents from the checkout.
const RELATED_PROJECTS_MAX: usize = 40;

/// One requirement elsewhere in the organization that reads like one here.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RelatedRequirementDto {
    /// The requirement in this project.
    pub id: String,
    pub defined_in: SpecModelSideDto,
    pub text: String,
    /// The other project.
    pub other_project_id: String,
    pub other_project_name: String,
    pub other_workspace_name: String,
    pub other_id: String,
    pub other_defined_in: SpecModelSideDto,
    pub other_text: String,
    /// The share of meaningful words the two have in common, 0–1.
    pub score: f64,
    /// `same`, `overlap`, or `opposite` (one negates what the other requires).
    pub relation: String,
    pub shared: Vec<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct RelatedRequirementListDto {
    pub items: Vec<RelatedRequirementDto>,
    pub total: u32,
    /// Other projects compared.
    pub projects: u32,
    /// True when the organization had more projects than one read compares.
    pub truncated: bool,
}

fn side_at(path: &str, line: usize) -> SpecModelSideDto {
    let line = u32::try_from(line).ok();
    SpecModelSideDto {
        path: path.to_string(),
        line_start: line,
        line_end: line,
        quote: None,
        binding_id: None,
    }
}

/// The requirements of the organization's other projects that read like
/// this project's, or like their opposite.
async fn list_related_requirements(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<SpecScopeQuery>,
) -> ApiResult<JsonBody<RelatedRequirementListDto>> {
    use super::spec_model::related::{Elsewhere, related};
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let reader = quality.reader()?;
    let here = service
        .spec_model_sources(&ctx, workspace_id, project_id, reader.as_ref())
        .await
        .map_err(internal)?
        .requirements();
    let organization = service
        .parent_of(&ctx, workspace_id)
        .await
        .map_err(internal)?;
    let projects = match (
        organization,
        quality
            .hub
            .get::<dyn crate::organizations::port::ProjectsOf>()
            .ok(),
    ) {
        (Some(org), Some(tree)) => tree.projects_of(&ctx, org).await.map_err(internal)?,
        _ => Vec::new(),
    };
    let others: Vec<_> = projects
        .into_iter()
        .filter(|p| p.id != project_id)
        .collect();
    let truncated = others.len() > RELATED_PROJECTS_MAX;
    let mut elsewhere = Vec::new();
    let mut names = std::collections::BTreeMap::new();
    let mut compared = 0usize;
    for other in others.into_iter().take(RELATED_PROJECTS_MAX) {
        // A project the caller cannot read is not compared, and not an error.
        if service.authorize(&ctx, other.id).await.is_err() {
            continue;
        }
        let Ok(sources) = service
            .spec_model_sources(&ctx, other.workspace_id, other.id, reader.as_ref())
            .await
        else {
            continue;
        };
        compared += 1;
        names.insert(
            other.id.to_string(),
            (other.name.clone(), other.workspace_name.clone()),
        );
        elsewhere.extend(sources.requirements().into_iter().map(|r| Elsewhere {
            project_id: other.id.to_string(),
            requirement: r,
        }));
    }
    let items: Vec<RelatedRequirementDto> = related(&here, &elsewhere)
        .into_iter()
        .map(|m| {
            let (name, ws) = names.get(&m.there.project_id).cloned().unwrap_or_default();
            RelatedRequirementDto {
                defined_in: side_at(&m.here.path, m.here.line),
                id: m.here.id,
                text: m.here.text,
                other_defined_in: side_at(&m.there.requirement.path, m.there.requirement.line),
                other_project_id: m.there.project_id,
                other_project_name: name,
                other_workspace_name: ws,
                other_id: m.there.requirement.id,
                other_text: m.there.requirement.text,
                score: (m.score * 100.0).round() / 100.0,
                relation: m.relation.as_str().to_string(),
                shared: m.shared,
            }
        })
        .collect();
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    Ok(Json(RelatedRequirementListDto {
        total: count(items.len()),
        items,
        projects: count(compared),
        truncated,
    }))
}

/// The longest key or name a glossary decision takes: a subject is a few
/// words, never a passage.
const GLOSSARY_TEXT_MAX: usize = 200;

/// Record a member's decision on one glossary entry.
fn spec_review_dto(r: super::entity::spec_review::Model) -> SpecModelReviewDto {
    SpecModelReviewDto {
        fact_key: r.fact_key,
        state: r.state,
        path: r.path,
        revision: r.revision,
        note: r.note,
        decided_by: r.decided_by.to_string(),
        decided_at: rfc3339(r.decided_at),
    }
}

/// Every accept or reject members gave on the facts the model read.
async fn list_spec_model_reviews(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Query(query): Query<SpecScopeQuery>,
) -> ApiResult<JsonBody<SpecModelReviewListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let items: Vec<SpecModelReviewDto> = service
        .spec_reviews(workspace_id, project_id)
        .await
        .map_err(internal)?
        .into_iter()
        .map(spec_review_dto)
        .collect();
    Ok(Json(SpecModelReviewListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

/// Open an issue in the project's repository for something to decide — a
/// problem in the documents, a gap in the model — assigned to people by
/// their host accounts.
async fn create_spec_model_issue(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Json(req): Json<SpecModelIssueRequest>,
) -> ApiResult<(StatusCode, JsonBody<SpecModelIssueDto>)> {
    let project_id = parse_project_id(&req.project_id)?;
    let _ = parent_workspace(&service, &ctx, project_id).await?;
    let refuse = |why: &str| {
        DocumentsError::invalid_argument()
            .with_constraint(why)
            .create()
    };
    let title = req.title.trim();
    if title.is_empty() || title.len() > 256 {
        return Err(refuse("an issue needs a title of at most 256 bytes"));
    }
    if req.body.len() > 64 * 1024 {
        return Err(refuse("the description must be at most 64 KiB"));
    }
    let valid_login = |l: &String| {
        !l.is_empty() && l.len() <= 39 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    };
    if req.assignees.len() > 10 || !req.assignees.iter().all(valid_login) {
        return Err(refuse("assignees are at most ten GitHub logins"));
    }
    let files = project_files(&quality)?;
    let (number, url) = files
        .create_issue(
            &ctx,
            &project_id.to_string(),
            title,
            &req.body,
            &req.assignees,
        )
        .await
        .map_err(invalid_or_internal)?;
    Ok((StatusCode::CREATED, Json(SpecModelIssueDto { number, url })))
}

/// Whether a review state belongs to what its key names: a fact, a
/// hypothesis's evidence (`ev:`) or its check (`hyp:`), a behaviour
/// obligation (`ob:`), a match across projects (`rel:`), an item being
/// prioritised (`pri:`) or a confirmed order (`prc:`). `proposed` withdraws
/// any of them.
fn review_state_fits(key: &str, state: &str) -> bool {
    if state == "proposed" {
        return true;
    }
    if key.starts_with("ev:") {
        matches!(state, "supports" | "contradicts" | "insufficient")
    } else if key.starts_with("hyp:") {
        state == "check"
    } else if key.starts_with("pri:") {
        state == "scored"
    } else if key.starts_with("prc:") {
        state == "confirmed"
    } else if key.starts_with("ob:") {
        state == "excluded"
    } else if key.starts_with("rel:") {
        matches!(state, "reuse" | "coordinate" | "separate" | "unrelated")
    } else if key.starts_with("iss:") {
        state == "opened"
    } else {
        matches!(state, "accepted" | "rejected")
    }
}

/// How long a review's note may be: a hypothesis's check keeps its brief and
/// what checking found, so it gets more room than a reason in a sentence.
fn review_note_max(key: &str) -> usize {
    if key.starts_with("hyp:") { 8000 } else { 2000 }
}

/// Propose a whole document for the project's repository, as a pull request:
/// what a member accepted in Studio — the need, a prioritisation — kept as a
/// document beside the others, versioned by the repository.
async fn create_spec_model_file_proposal(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Json(req): Json<SpecModelFileProposalRequest>,
) -> ApiResult<(StatusCode, JsonBody<SpecModelWriteDto>)> {
    let project_id = parse_project_id(&req.project_id)?;
    let _ = parent_workspace(&service, &ctx, project_id).await?;
    let refuse = |why: &str| {
        DocumentsError::invalid_argument()
            .with_constraint(why)
            .create()
    };
    let path = req.path.trim();
    let safe = path.starts_with("docs/")
        && path.ends_with(".md")
        && path.len() <= 200
        && !path.contains("..")
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/-_.".contains(c));
    if !safe {
        return Err(refuse(
            "the path must be a Markdown file under docs/, in plain letters, digits, - _ . and /",
        ));
    }
    if req.content.trim().is_empty() || req.content.len() > 512 * 1024 {
        return Err(refuse("the content must be a document of at most 512 KiB"));
    }
    let title: String = req.title.trim().chars().take(70).collect();
    if title.is_empty() {
        return Err(refuse("a title says what the pull request proposes"));
    }
    let files = project_files(&quality)?;
    let project = project_id.to_string();
    let branch = format!(
        "docs/{}",
        &super::spec_model::extract::revision(&req.content)[..12]
    );
    let written = files
        .write(
            &ctx,
            &project,
            &branch,
            &[crate::product::port::DeclarationFile { path: path.to_owned(), content: req.content.clone() }],
            &crate::product::port::PullRequestText {
                message: format!("docs: {title}"),
                title: format!("Docs: {title}"),
                body: format!("{title}\n\nWritten to `{path}` from the Domain model tab, as a proposal to review."),
            },
            true,
        )
        .await
        .map_err(invalid_or_internal)?;
    Ok((
        StatusCode::CREATED,
        Json(SpecModelWriteDto {
            path: path.to_owned(),
            branch: written.branch,
            commit_sha: written.commit_sha,
            pr_url: written.pr_url,
        }),
    ))
}

fn glossary_row_dto(r: super::spec_model::glossary_doc::Row) -> GlossaryDocRowDto {
    GlossaryDocRowDto {
        term: r.term,
        definition: r.definition,
        aliases: r.aliases,
        not_same_as: r.not_same_as,
        source: r.source,
    }
}

/// The glossary the project's documents keep — `docs/glossary.md`, or a
/// glossary section inside another document — read as written.
/// The hypothesis check methods the named kits add, each read from the
/// kit's `check-methods.json` in the project's repository. A kit with no
/// file, or one out of shape, is listed with the reason; nothing is guessed.
async fn list_kit_check_methods(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<CheckMethodsQuery>,
) -> ApiResult<JsonBody<KitCheckMethodListDto>> {
    use super::spec_model::check_methods::{KITS_MAX, is_kit_slug, parse, path_of};
    let project_id = parse_project_id(&query.project_id)?;
    let _ = parent_workspace(&service, &ctx, project_id).await?;
    let mut kits: Vec<&str> = query
        .kits
        .split(',')
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .collect();
    kits.dedup();
    if kits.len() > KITS_MAX || !kits.iter().all(|k| is_kit_slug(k)) {
        return Err(DocumentsError::invalid_argument()
            .with_field_violation(
                "kits",
                format!("at most {KITS_MAX} kit slugs: lowercase letters, digits and dashes"),
                "INVALID",
            )
            .create());
    }
    let mut items = Vec::new();
    let mut unread = std::collections::BTreeMap::new();
    if !kits.is_empty() {
        let files = project_files(&quality)?;
        let project = project_id.to_string();
        for kit in kits {
            let why = match files.read(&ctx, &project, &path_of(kit)).await {
                Ok(Some(text)) => match parse(&text) {
                    Ok(methods) => {
                        items.extend(methods.into_iter().map(|m| KitCheckMethodDto {
                            kit: kit.to_owned(),
                            id: m.id,
                            label: m.label,
                            uncertainty: m.uncertainty,
                            inputs: m.inputs,
                            action: m.action,
                            limits: m.limits,
                            applies_to: m.applies_to,
                        }));
                        continue;
                    }
                    Err(why) => why,
                },
                // Most kits add no methods: that is no failure to report.
                Ok(None) => continue,
                Err(e) => format!("the repository could not be read: {e}"),
            };
            unread.insert(kit.to_owned(), why);
        }
    }
    Ok(Json(KitCheckMethodListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        unread,
    }))
}

async fn get_glossary_document(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<SpecScopeQuery>,
) -> ApiResult<JsonBody<GlossaryDocDto>> {
    use super::spec_model::glossary_doc::{GLOSSARY_DOC_PATH, find};
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let reader = quality.reader()?;
    let sources = service
        .spec_model_sources(&ctx, workspace_id, project_id, reader.as_ref())
        .await
        .map_err(internal)?;
    let line = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let found = find(
        sources
            .documents
            .iter()
            .map(|d| (d.path.as_str(), d.text.as_str())),
    )
    .map(|f| GlossaryDocFoundDto {
        path: f.path,
        heading: f.heading,
        line_start: line(f.line_start),
        line_end: line(f.line_end),
        whole: f.whole,
        rows: f.rows.into_iter().map(glossary_row_dto).collect(),
    });
    Ok(Json(GlossaryDocDto {
        found,
        path: GLOSSARY_DOC_PATH.to_owned(),
    }))
}

/// Most rows one glossary holds.
const GLOSSARY_DOC_ROWS_MAX: usize = 1000;

/// Propose the project's glossary as `docs/glossary.md` in one pull request.
/// A glossary kept as a section of another document moves: the same pull
/// request leaves a link where the section's table was.
async fn create_glossary_document_proposal(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Json(req): Json<GlossaryDocRequest>,
) -> ApiResult<(StatusCode, JsonBody<SpecModelWriteDto>)> {
    use super::spec_model::glossary_doc::{GLOSSARY_DOC_PATH, Row, find, render, replace_section};
    let project_id = parse_project_id(&req.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let refuse = |why: &str| {
        DocumentsError::invalid_argument()
            .with_constraint(why)
            .create()
    };
    if req.rows.is_empty() || req.rows.len() > GLOSSARY_DOC_ROWS_MAX {
        return Err(refuse("a glossary holds between one and a thousand terms"));
    }
    let short = |s: &str| s.len() <= GLOSSARY_TEXT_MAX;
    if !req.rows.iter().all(|r| {
        !r.term.trim().is_empty()
            && short(&r.term)
            && r.definition.len() <= 4096
            && r.aliases.iter().chain(&r.not_same_as).all(|a| short(a))
            && r.source.as_deref().is_none_or(short)
    }) {
        return Err(refuse(
            "every row needs a term; terms, names and sources are at most 200 bytes, a definition 4 KiB",
        ));
    }
    let rows: Vec<Row> = req
        .rows
        .iter()
        .map(|r| Row {
            term: r.term.trim().to_owned(),
            definition: r.definition.trim().to_owned(),
            aliases: r.aliases.clone(),
            not_same_as: r.not_same_as.clone(),
            source: r.source.clone(),
        })
        .collect();
    let reader = quality.reader()?;
    let sources = service
        .spec_model_sources(&ctx, workspace_id, project_id, reader.as_ref())
        .await
        .map_err(internal)?;
    let found = find(
        sources
            .documents
            .iter()
            .map(|d| (d.path.as_str(), d.text.as_str())),
    );
    let content = render(&rows);
    let mut files_out = vec![crate::product::port::DeclarationFile {
        path: GLOSSARY_DOC_PATH.to_owned(),
        content: content.clone(),
    }];
    let moved = found.as_ref().filter(|f| !f.whole).and_then(|f| {
        let text = sources.documents.iter().find(|d| d.path == f.path)?;
        Some((f.path.clone(), replace_section(&text.text, f)))
    });
    if let Some((path, content)) = &moved {
        files_out.push(crate::product::port::DeclarationFile {
            path: path.clone(),
            content: content.clone(),
        });
    }
    let what = match (&found, &moved) {
        (Some(f), Some(_)) => format!(
            "The glossary moves out of `{}` ({}) into `{GLOSSARY_DOC_PATH}`, where every document can link a term;              the section keeps its heading and links there.",
            f.path,
            f.heading.as_deref().unwrap_or("its glossary section"),
        ),
        (Some(_), None) => {
            format!("`{GLOSSARY_DOC_PATH}` put in order and filled from what the documents name.")
        }
        _ => format!(
            "The project had no glossary: `{GLOSSARY_DOC_PATH}`, from what its documents name."
        ),
    };
    let files = project_files(&quality)?;
    let branch = format!(
        "docs/glossary-{}",
        &super::spec_model::extract::revision(&content)[..12]
    );
    let written = files
        .write(
            &ctx,
            &project_id.to_string(),
            &branch,
            &files_out,
            &crate::product::port::PullRequestText {
                message: "docs: the project's glossary".to_owned(),
                title: "Docs: the project's glossary".to_owned(),
                body: format!(
                    "{what}\n\n{} terms, each with what it means, the other names it goes by and the terms it is not. \
                     Proposed from the Glossary tab of Constructor Studio, to review.",
                    rows.len()
                ),
            },
            true,
        )
        .await
        .map_err(invalid_or_internal)?;
    Ok((
        StatusCode::CREATED,
        Json(SpecModelWriteDto {
            path: GLOSSARY_DOC_PATH.to_owned(),
            branch: written.branch,
            commit_sha: written.commit_sha,
            pr_url: written.pr_url,
        }),
    ))
}

/// The most facts one review action takes: a selection, not the model.
const SPEC_REVIEW_BATCH_MAX: usize = 500;

/// Accept, reject or put back a selection of facts in one action.
async fn review_spec_model_facts(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Json(body): Json<SpecModelReviewRequest>,
) -> ApiResult<JsonBody<SpecModelReviewListDto>> {
    let project_id = parse_project_id(&body.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let invalid = |field: &str, why: &str| {
        DocumentsError::invalid_argument()
            .with_field_violation(field, why.to_owned(), "INVALID")
            .create()
    };
    if body.items.is_empty() || body.items.len() > SPEC_REVIEW_BATCH_MAX {
        return Err(invalid("items", "must hold between 1 and 500 facts"));
    }
    let mut items = Vec::with_capacity(body.items.len());
    for i in body.items {
        let key = i.fact_key.trim();
        if key.is_empty() || key.len() > 128 {
            return Err(invalid(
                "fact_key",
                "must be a fact's key of at most 128 bytes",
            ));
        }
        if !review_state_fits(key, &i.state) {
            return Err(invalid(
                "state",
                "must be accepted, rejected or proposed; for a hypothesis's evidence (ev:) supports, \
                 contradicts or insufficient; for its check (hyp:) check; for an obligation (ob:) \
                 excluded; for a match across projects (rel:) reuse, coordinate, separate or \
                 unrelated; for a prioritised item (pri:) scored; for a confirmed order (prc:) \
                 confirmed",
            ));
        }
        if i.note
            .as_ref()
            .is_some_and(|n| n.len() > review_note_max(key))
        {
            return Err(invalid(
                "note",
                "must be at most 2000 bytes, or 8000 for a hypothesis's check (hyp:)",
            ));
        }
        if i.path.len() > 1024 || i.revision.len() > 128 {
            return Err(invalid("path", "must be a document path and its revision"));
        }
        items.push((key.to_owned(), i.state, i.path, i.revision, i.note));
    }
    let saved: Vec<SpecModelReviewDto> = service
        .put_spec_reviews(&ctx, workspace_id, project_id, items)
        .await
        .map_err(internal)?
        .into_iter()
        .map(spec_review_dto)
        .collect();
    Ok(Json(SpecModelReviewListDto {
        total: u32::try_from(saved.len()).unwrap_or(u32::MAX),
        items: saved,
    }))
}

/// Record that two glossary entries are different things, so the pair is not
/// offered as one thing again.
async fn decide_glossary_distinct(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Json(body): Json<GlossaryDistinctRequest>,
) -> ApiResult<StatusCode> {
    let project_id = parse_project_id(&body.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let (a, b) = (body.a.trim(), body.b.trim());
    for (field, key) in [("a", a), ("b", b)] {
        if key.is_empty() || key.len() > GLOSSARY_TEXT_MAX {
            return Err(DocumentsError::invalid_argument()
                .with_field_violation(
                    field,
                    "must be a glossary entry's key".to_owned(),
                    "INVALID",
                )
                .create());
        }
    }
    if a == b {
        return Err(DocumentsError::invalid_argument()
            .with_field_violation("b", "must name another entry".to_owned(), "INVALID")
            .create());
    }
    service
        .put_spec_terms_distinct(&ctx, workspace_id, project_id, a, b)
        .await
        .map_err(internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn decide_glossary_entry(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Json(body): Json<GlossaryDecisionRequest>,
) -> ApiResult<(StatusCode, JsonBody<GlossaryDecisionDto>)> {
    let project_id = parse_project_id(&body.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let invalid = |field: &str, why: &str| {
        DocumentsError::invalid_argument()
            .with_field_violation(field, why.to_owned(), "INVALID")
            .create()
    };
    let key = body.key.trim();
    if key.is_empty() || key.len() > GLOSSARY_TEXT_MAX {
        return Err(invalid("key", "must be a glossary entry's key"));
    }
    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_owned);
    if name.as_ref().is_some_and(|n| n.len() > GLOSSARY_TEXT_MAX) {
        return Err(invalid("name", "must be a name of at most 200 bytes"));
    }
    let alias_of = body
        .alias_of
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .map(str::to_owned);
    match &alias_of {
        Some(a) if a == key => return Err(invalid("alias_of", "must name another entry")),
        Some(a) if a.len() > GLOSSARY_TEXT_MAX => {
            return Err(invalid("alias_of", "must be a glossary entry's key"));
        }
        _ => {}
    }
    let saved = service
        .put_spec_term(&ctx, workspace_id, project_id, key, name, alias_of)
        .await
        .map_err(internal)?;
    Ok((
        StatusCode::CREATED,
        Json(GlossaryDecisionDto {
            key: saved.term_key,
            name: saved.name,
            alias_of: saved.alias_of,
            decided_by: saved.decided_by.to_string(),
            decided_at: saved
                .decided_at
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default(),
        }),
    ))
}

async fn decide_spec_model_finding(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Path(fingerprint): Path<String>,
    Json(body): Json<SpecModelDecisionRequest>,
) -> ApiResult<(StatusCode, JsonBody<SpecModelDecisionDto>)> {
    let project_id = parse_project_id(&body.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    if !matches!(body.decision.as_str(), "confirmed" | "dismissed") {
        return Err(DocumentsError::invalid_argument()
            .with_field_violation(
                "decision",
                "must be confirmed or dismissed".to_owned(),
                "INVALID",
            )
            .create());
    }
    if fingerprint.is_empty()
        || fingerprint.len() > 64
        || !fingerprint.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err(DocumentsError::invalid_argument()
            .with_field_violation(
                "fingerprint",
                "must be a finding's fingerprint".to_owned(),
                "INVALID",
            )
            .create());
    }
    // Keep the finding as it stands, so a fixed one stays readable as
    // resolved. A Spec Quality finding is not the model's: no snapshot.
    let (snapshot, binding_of) = match quality.reader() {
        Ok(reader) => match service
            .spec_model_sources(&ctx, workspace_id, project_id, reader.as_ref())
            .await
        {
            Ok(sources) => {
                let found = spec_model_findings(&service, workspace_id, project_id, &sources)
                    .await
                    .ok()
                    .and_then(|(fs, _)| fs.into_iter().find(|f| f.fingerprint == fingerprint));
                (found.as_ref().map(finding_snapshot), binding_ids(&sources))
            }
            Err(_) => (None, Default::default()),
        },
        Err(_) => (None, Default::default()),
    };
    let present = snapshot.as_ref().map(|_| true);
    let saved = service
        .put_spec_decision(
            &ctx,
            workspace_id,
            project_id,
            &fingerprint,
            &body.decision,
            body.note,
            snapshot,
        )
        .await
        .map_err(invalid)?;
    Ok((
        StatusCode::CREATED,
        Json(spec_decision_dto(saved, present, &binding_of)),
    ))
}

/// studio-product's writer into the project's repository.
fn project_files(quality: &Quality) -> ApiResult<Arc<dyn crate::product::port::ProjectFiles>> {
    quality
        .hub
        .get::<dyn crate::product::port::ProjectFiles>()
        .map_err(|_| {
            CanonicalError::service_unavailable()
                .with_detail(
                    "studio-product is not running, so nothing can be written to a repository",
                )
                .create()
        })
}

/// A branch name's part made of `name`: lowercase letters, digits, dashes.
fn branch_part(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = slug
        .split('-')
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    slug.chars().take(40).collect()
}

/// The first hex digits of `text`'s SHA-256: a branch for each new content,
/// so saving the same thing twice lands on the same branch.
fn content_tag(text: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(text.as_bytes()))[..6].to_owned()
}

/// Save one entity of the domain model as a person edited it: its section of
/// `docs/domain-model.md` in the project's repository, the way the repository
/// takes changes. The model reads it like any other document once its type is
/// settled, on the next build.
async fn upsert_spec_model_entity(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<SpecScopeQuery>,
    Json(body): Json<SpecModelEntityRequest>,
) -> ApiResult<JsonBody<SpecModelWriteDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    parent_workspace(&service, &ctx, project_id).await?;
    let invalid = |field: &str, why: &str| {
        DocumentsError::invalid_argument()
            .with_field_violation(field, why.to_owned(), "INVALID")
            .create()
    };
    let name = body.name.trim();
    if name.is_empty() || name.len() > GLOSSARY_TEXT_MAX {
        return Err(invalid("name", "must be a name of at most 200 bytes"));
    }
    let definition = body
        .definition
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty());
    if definition.is_some_and(|d| d.len() > 4000) {
        return Err(invalid("definition", "must be at most 4000 bytes"));
    }
    if body.fields.len() > 60 || body.relations.len() > 60 {
        return Err(invalid("fields", "at most 60 fields and 60 relations"));
    }
    let short = |s: &str| !s.trim().is_empty() && s.len() <= GLOSSARY_TEXT_MAX;
    if !body
        .fields
        .iter()
        .all(|f| short(&f.name) && f.meaning.len() <= 1000)
    {
        return Err(invalid(
            "fields",
            "each field needs a name of at most 200 bytes",
        ));
    }
    if !body
        .relations
        .iter()
        .all(|r| short(&r.verb) && short(&r.target))
    {
        return Err(invalid(
            "relations",
            "each relation needs a verb and a target",
        ));
    }
    let edit = super::spec_model::domain_doc::EntityEdit {
        name: name.to_owned(),
        definition: definition.map(str::to_owned),
        fields: body
            .fields
            .iter()
            .map(|f| (f.name.trim().to_owned(), f.meaning.trim().to_owned()))
            .collect(),
        relations: body
            .relations
            .iter()
            .map(|r| (r.verb.trim().to_owned(), r.target.trim().to_owned()))
            .collect(),
    };
    let files = project_files(&quality)?;
    let path = super::spec_model::domain_doc::DOMAIN_DOC_PATH;
    let project = project_id.to_string();
    let current = files
        .read(&ctx, &project, path)
        .await
        .map_err(invalid_or_internal)?;
    let content = super::spec_model::domain_doc::upsert(current.as_deref(), &edit);
    let branch = format!(
        "domain-model/{}-{}",
        branch_part(name),
        content_tag(&content)
    );
    let written = files
        .write(
            &ctx,
            &project,
            &branch,
            &[crate::product::port::DeclarationFile { path: path.to_owned(), content }],
            &crate::product::port::PullRequestText {
                message: format!("docs(domain-model): {name}"),
                title: format!("Domain model: {name}"),
                body: format!(
                    "What `{name}` is, what it holds and how it relates, as edited on the Domain model tab. \
                     Studio keeps `{path}` one section per entity; the model reads it on its next build."
                ),
            },
            false,
        )
        .await
        .map_err(invalid_or_internal)?;
    Ok(Json(SpecModelWriteDto {
        path: path.to_owned(),
        branch: written.branch,
        commit_sha: written.commit_sha,
        pr_url: written.pr_url,
    }))
}

/// Most files one rename proposes changes to: a word used in more is a
/// review nobody finishes.
const GLOSSARY_RENAME_FILES_MAX: usize = 100;

/// Propose a glossary rename in the documents: every whole-word use of the
/// old name in their prose replaced by the project's name, in one pull
/// request over every file that uses it.
async fn create_glossary_rename_proposal(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<SpecScopeQuery>,
    Json(body): Json<GlossaryRenameRequest>,
) -> ApiResult<(StatusCode, JsonBody<GlossaryRenameProposalDto>)> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let invalid = |field: &str, why: &str| {
        DocumentsError::invalid_argument()
            .with_field_violation(field, why.to_owned(), "INVALID")
            .create()
    };
    let from = body.from.trim();
    let to = body.to.trim();
    if from.is_empty() || from.len() > GLOSSARY_TEXT_MAX {
        return Err(invalid("from", "must be a name of at most 200 bytes"));
    }
    if to.is_empty() || to.len() > GLOSSARY_TEXT_MAX {
        return Err(invalid("to", "must be a name of at most 200 bytes"));
    }
    if from.to_lowercase() == to.to_lowercase() {
        return Err(invalid("to", "must differ from `from` by more than case"));
    }
    let reader = quality.reader()?;
    let sources = service
        .spec_model_sources(&ctx, workspace_id, project_id, reader.as_ref())
        .await
        .map_err(internal)?;
    let using: Vec<&str> = sources
        .documents
        .iter()
        .filter(|d| super::spec_model::rename::rename(&d.text, from, to).is_some())
        .map(|d| d.path.as_str())
        .collect();
    let unused = || {
        DocumentsError::invalid_argument()
            .with_constraint(format!(
                "no document of the project uses \"{from}\" as a word outside code and links"
            ))
            .create()
    };
    if using.is_empty() {
        return Err(unused());
    }
    if using.len() > GLOSSARY_RENAME_FILES_MAX {
        return Err(DocumentsError::invalid_argument()
            .with_constraint(format!(
                "\"{from}\" is used in {} documents; one proposal changes at most {GLOSSARY_RENAME_FILES_MAX}",
                using.len()
            ))
            .create());
    }
    // The repository's text, not the checkout's: the change is made to what
    // the branch holds now.
    let files = project_files(&quality)?;
    let project = project_id.to_string();
    let mut changed: Vec<crate::product::port::DeclarationFile> = Vec::new();
    let mut renamed = 0usize;
    for path in using {
        let Some(text) = files
            .read(&ctx, &project, path)
            .await
            .map_err(invalid_or_internal)?
        else {
            continue;
        };
        if let Some((content, n)) = super::spec_model::rename::rename(&text, from, to) {
            renamed += n;
            changed.push(crate::product::port::DeclarationFile {
                path: path.to_owned(),
                content,
            });
        }
    }
    if changed.is_empty() {
        return Err(unused());
    }
    let tag = content_tag(
        &changed
            .iter()
            .map(|f| format!("{}\n{}", f.path, f.content))
            .collect::<String>(),
    );
    let branch = format!(
        "glossary/{}-to-{}-{tag}",
        branch_part(from),
        branch_part(to)
    );
    let paths: Vec<String> = changed.iter().map(|f| f.path.clone()).collect();
    let listed = paths
        .iter()
        .map(|p| format!("- `{p}`"))
        .collect::<Vec<_>>()
        .join("\n");
    let written = files
        .write(
            &ctx,
            &project,
            &branch,
            &changed,
            &crate::product::port::PullRequestText {
                message: format!("docs: call \"{from}\" \"{to}\""),
                title: format!("Glossary: \"{from}\" is \"{to}\""),
                body: format!(
                    "The project's glossary calls \"{from}\" \"{to}\". {renamed} uses renamed in prose \
                     (code, links and front matter left as they are):\n\n{listed}\n\n\
                     Proposed from the Glossary."
                ),
            },
            true,
        )
        .await
        .map_err(invalid_or_internal)?;
    Ok((
        StatusCode::CREATED,
        Json(GlossaryRenameProposalDto {
            files: paths,
            renamed: u32::try_from(renamed).unwrap_or(u32::MAX),
            branch: written.branch,
            commit_sha: written.commit_sha,
            pr_url: written.pr_url,
        }),
    ))
}

/// A write refused for a reason the caller can act on (no repository, a
/// connection the organization does not own) as such; anything else is ours.
fn invalid_or_internal(error: anyhow::Error) -> CanonicalError {
    let text = format!("{error:#}");
    if text.contains("repository") || text.contains("connection") || text.contains("not owned") {
        DocumentsError::invalid_argument()
            .with_constraint(text)
            .create()
    } else {
        internal(error)
    }
}

/// Propose a finding's smallest fix as a pull request on the document it
/// names: its passage replaced, matched the way the finding was checked.
async fn create_spec_model_finding_proposal(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Path(fingerprint): Path<String>,
    Query(query): Query<SpecScopeQuery>,
) -> ApiResult<(StatusCode, JsonBody<SpecModelWriteDto>)> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let reader = quality.reader()?;
    let sources = service
        .spec_model_sources(&ctx, workspace_id, project_id, reader.as_ref())
        .await
        .map_err(internal)?;
    let (findings, _) = spec_model_findings(&service, workspace_id, project_id, &sources)
        .await
        .map_err(internal)?;
    let gone = || {
        DocumentsError::not_found("no such finding now: the documents changed since it was shown")
            .with_resource(fingerprint.clone())
            .create()
    };
    let finding = findings
        .into_iter()
        .find(|f| f.fingerprint == fingerprint)
        .ok_or_else(gone)?;
    let edit = finding.edit.clone().ok_or_else(|| {
        DocumentsError::invalid_argument()
            .with_constraint("this finding names no edit: it needs a person's decision, not a fix")
            .create()
    })?;
    let files = project_files(&quality)?;
    let project = project_id.to_string();
    let text = files
        .read(&ctx, &project, &edit.path)
        .await
        .map_err(invalid_or_internal)?
        .ok_or_else(gone)?;
    let changed = super::spec_model::domain_doc::apply_edit(&text, &edit.replace, &edit.with).ok_or_else(|| {
        DocumentsError::invalid_argument()
            .with_constraint("the passage is no longer in the document as the finding saw it, or is there twice")
            .create()
    })?;
    let branch = format!("fix/{}", &fingerprint[..fingerprint.len().min(12)]);
    let title: String = finding.message.chars().take(70).collect();
    let written = files
        .write(
            &ctx,
            &project,
            &branch,
            &[crate::product::port::DeclarationFile { path: edit.path.clone(), content: changed }],
            &crate::product::port::PullRequestText {
                message: format!("docs: {title}"),
                title: format!("Fix: {title}"),
                body: format!(
                    "{}\n\nIn `{}`:\n\n```diff\n- {}\n+ {}\n```\n\nProposed from the Domain model tab.",
                    finding.message, edit.path, edit.replace, edit.with
                ),
            },
            true,
        )
        .await
        .map_err(invalid_or_internal)?;
    Ok((
        StatusCode::CREATED,
        Json(SpecModelWriteDto {
            path: edit.path,
            branch: written.branch,
            commit_sha: written.commit_sha,
            pr_url: written.pr_url,
        }),
    ))
}

/// Propose a sentence for one of the project's documents as a pull request:
/// a paragraph of its own after the passage the model read, on the revision
/// it read. What the Domain model tab offers for an entity no document
/// relates to anything.
async fn create_spec_model_sentence_proposal(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<SpecScopeQuery>,
    Json(req): Json<SpecModelSentenceRequest>,
) -> ApiResult<(StatusCode, JsonBody<SpecModelWriteDto>)> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let refuse = |why: &str| {
        DocumentsError::invalid_argument()
            .with_constraint(why)
            .create()
    };
    let reader = quality.reader()?;
    let sources = service
        .spec_model_sources(&ctx, workspace_id, project_id, reader.as_ref())
        .await
        .map_err(internal)?;
    if !sources.documents.iter().any(|d| d.path == req.path) {
        return Err(refuse(
            "not one of the project's documents: only its documentation is proposed to",
        ));
    }
    let files = project_files(&quality)?;
    let project = project_id.to_string();
    let text = files
        .read(&ctx, &project, &req.path)
        .await
        .map_err(invalid_or_internal)?
        .ok_or_else(|| {
            DocumentsError::not_found("the document is not in the repository")
                .with_resource(req.path.clone())
                .create()
        })?;
    if super::spec_model::extract::revision(&text) != req.revision {
        return Err(refuse(
            "the document changed since the model read it: build the model again",
        ));
    }
    let line = usize::try_from(req.line).unwrap_or(usize::MAX);
    let changed = super::spec_model::domain_doc::insert_after(&text, line, &req.sentence)
        .ok_or_else(|| refuse("no passage at that line to add a sentence after, or it is code"))?;
    let sentence = req
        .sentence
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let title: String = req
        .why
        .as_deref()
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .unwrap_or(&sentence)
        .chars()
        .take(70)
        .collect();
    let branch = format!(
        "docs/{}",
        &super::spec_model::extract::revision(&changed)[..12]
    );
    let written = files
        .write(
            &ctx,
            &project,
            &branch,
            &[crate::product::port::DeclarationFile { path: req.path.clone(), content: changed }],
            &crate::product::port::PullRequestText {
                message: format!("docs: {title}"),
                title: format!("Docs: {title}"),
                body: format!(
                    "{title}\n\nAdded to `{}` after line {line}:\n\n> {sentence}\n\nProposed from the Domain model tab.",
                    req.path
                ),
            },
            true,
        )
        .await
        .map_err(invalid_or_internal)?;
    Ok((
        StatusCode::CREATED,
        Json(SpecModelWriteDto {
            path: req.path,
            branch: written.branch,
            commit_sha: written.commit_sha,
            pr_url: written.pr_url,
        }),
    ))
}

/// Every decision members recorded on the project's findings, of the model
/// and of the Spec Quality detectors alike: both are keyed by fingerprint.
async fn list_spec_model_decisions(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<SpecScopeQuery>,
) -> ApiResult<JsonBody<SpecModelDecisionListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    // Which fingerprints the documents still show: a decided finding no
    // longer among them was resolved.
    let (current, binding_of): (Option<std::collections::BTreeSet<String>>, _) =
        match quality.reader() {
            Ok(reader) => match service
                .spec_model_sources(&ctx, workspace_id, project_id, reader.as_ref())
                .await
            {
                Ok(sources) => (
                    spec_model_findings(&service, workspace_id, project_id, &sources)
                        .await
                        .ok()
                        .map(|(fs, _)| fs.into_iter().map(|f| f.fingerprint).collect()),
                    binding_ids(&sources),
                ),
                Err(_) => (None, Default::default()),
            },
            Err(_) => (None, Default::default()),
        };
    let items: Vec<SpecModelDecisionDto> = service
        .spec_decisions(workspace_id, project_id)
        .await
        .map_err(internal)?
        .into_iter()
        .map(|d| {
            let present = current.as_ref().map(|c| c.contains(&d.fingerprint));
            spec_decision_dto(d, present, &binding_of)
        })
        .collect();
    Ok(Json(SpecModelDecisionListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

// ── review requests and approvals ────────────────────────────────────────────

/// One person to ask, as a request names them.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ReviewerInput {
    /// Canonical person id.
    pub person: String,
    pub name: Option<String>,
    /// Defaults to true: the request is not approved until they approve.
    pub required: Option<bool>,
    /// The stakeholder (an organization) they speak for. One approval from
    /// a stakeholder answers for every reviewer of it.
    pub stakeholder: Option<String>,
}

/// Ask for a review of one version of one document.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ReviewRequestInput {
    pub project_id: String,
    /// `document` (written in Studio) or `binding` (a repository file).
    pub subject_kind: String,
    pub subject_id: String,
    /// Ignored: the review takes its type from the stored document or
    /// binding, never from the caller (#744). Still accepted, so a client
    /// that sends it is not refused.
    #[allow(dead_code)]
    pub type_key: Option<String>,
    pub title: String,
    /// The version asked about: a commit sha or a revision.
    pub version: String,
    pub reviewers: Vec<ReviewerInput>,
    /// RFC 3339.
    pub due_at: Option<String>,
    /// The stakeholders (organizations) that must approve: one nobody of
    /// theirs approved for holds the request.
    pub stakeholders: Option<Vec<String>>,
}

/// A reviewer's verdict on a request.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ReviewVerdictInput {
    pub project_id: String,
    /// `approved` or `changes_requested`.
    pub verdict: String,
    /// The changes asked for are a security concern, which holds the stage at
    /// any maturity. Ignored on an approval.
    pub security: Option<bool>,
    pub note: Option<String>,
}

/// Which request to cancel.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ReviewCancelInput {
    pub project_id: String,
}

/// One reviewer of a request, and where they stand.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReviewerDto {
    pub person: String,
    pub name: Option<String>,
    pub required: bool,
    /// Their latest verdict, when they gave one.
    pub verdict: Option<String>,
    /// That verdict asks for changes over a security concern.
    pub security: bool,
    /// The stakeholder they speak for, when the requester named one.
    pub stakeholder: Option<String>,
}

/// Where one stakeholder stands on a request.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct StakeholderDto {
    pub name: String,
    /// The request names it as one that must approve.
    pub required: bool,
    /// Somebody speaking for it approved.
    pub approved: bool,
    /// Its reviewers who approved, by name.
    pub approved_by: Vec<String>,
    /// Every reviewer asked on its behalf, by name. Empty for a required
    /// stakeholder nobody was asked for yet.
    pub asked: Vec<String>,
}

/// One verdict, as it was recorded. Never edited.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ApprovalDto {
    pub id: String,
    pub request_id: String,
    pub version: String,
    pub approver: String,
    pub approver_name: Option<String>,
    pub verdict: String,
    /// The changes asked for are a security concern.
    pub security: bool,
    pub note: Option<String>,
    /// The detectors that had passed on the document when it was given.
    pub checks: Vec<String>,
    pub decided_at: String,
}

/// A review request with everyone it asks and every verdict given.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReviewRequestDto {
    pub id: String,
    pub project_id: String,
    pub subject_kind: String,
    pub subject_id: String,
    pub type_key: Option<String>,
    pub title: String,
    pub version: String,
    pub requested_by: String,
    pub requested_by_name: Option<String>,
    pub reviewers: Vec<ReviewerDto>,
    pub due_at: Option<String>,
    /// `open`, `approved`, `superseded` or `withdrawn`.
    pub state: String,
    /// Past its due date with a required reviewer still awaited.
    pub overdue: bool,
    /// The required reviewers who have not approved, by name.
    pub outstanding: Vec<String>,
    /// The maturity the version asked about declares in its front matter.
    pub maturity: Option<String>,
    /// That maturity is below `stable`: the review is advice, and only a
    /// security concern holds the stage on it.
    pub advisory: bool,
    pub created_at: String,
    pub verdicts: Vec<ApprovalDto>,
    /// The version the document is at now: a binding's content digest, a
    /// Studio document's content digest. `null` when the document is gone.
    pub current_version: Option<String>,
    /// The document changed since the version asked about.
    pub stale: bool,
    /// The detectors that pass on the document now.
    pub recorded_checks: Vec<String>,
    /// The stakeholders it requires, then any other a reviewer speaks for.
    pub stakeholders: Vec<StakeholderDto>,
    /// The digest of the type's template and review guide when the review
    /// was asked for: what it is judged by. `null` for an older request.
    pub rules_digest: Option<String>,
    /// The type's rules changed since the review was asked for. The review
    /// is still judged by the ones it started with
    /// (`GET /review-criteria?review_request_id=`).
    pub rules_changed: bool,
}

/// What a review was asked about, against what the document is now and the
/// last version approved before it: the review card's diff.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReviewDiffDto {
    pub request_id: String,
    pub version: String,
    pub current_version: Option<String>,
    pub stale: bool,
    /// The text kept when the review was asked for; `null` for a request from
    /// before texts were kept.
    pub reviewed_text: Option<String>,
    /// The text now; `null` when no checkout holds it.
    pub current_text: Option<String>,
    /// The newest earlier request on the same document that was approved.
    pub base: Option<ReviewBaseDto>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReviewBaseDto {
    pub request_id: String,
    pub version: String,
    pub reviewed_text: Option<String>,
    pub created_at: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReviewRequestListDto {
    pub items: Vec<ReviewRequestDto>,
    pub total: u32,
    /// Open requests in the list.
    pub open: u32,
    /// Open requests past their due date.
    pub overdue: u32,
    /// Open requests whose document changed since the version asked about.
    pub stale: u32,
}

/// A reviewer worth asking, from who was asked before.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReviewerSuggestionDto {
    pub person: String,
    pub name: Option<String>,
    /// Whether they were required the last time they were asked.
    pub required: bool,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ReviewerSuggestionListDto {
    pub items: Vec<ReviewerSuggestionDto>,
    pub total: u32,
}

#[derive(Debug, serde::Deserialize)]
pub struct ReviewListQuery {
    /// One project's requests; or
    pub project_id: Option<String>,
    /// every project's in this workspace.
    pub workspace_id: Option<String>,
    /// One document's requests.
    pub subject_id: Option<String>,
    /// `me`: only open requests that still wait for the caller's verdict.
    pub waiting_on: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub struct ReviewerSuggestionQuery {
    pub project_id: String,
    pub subject_id: String,
    pub type_key: Option<String>,
}

fn rfc3339(t: time::OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn parse_uuid_field(field: &str, raw: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(raw.trim()).map_err(|_| {
        DocumentsError::invalid_argument()
            .with_field_violation(field, "must be a UUID".to_owned(), "INVALID")
            .create()
    })
}

/// What happened to a review request, as the `review_request.*` kind it is
/// announced under. An enum so the kinds are a closed set the tests can hold
/// against `docs/events-catalog.md`.
#[derive(Debug, Clone, Copy)]
enum ReviewEvent {
    Created,
    Decided,
    Cancelled,
}

impl ReviewEvent {
    #[cfg(test)]
    const ALL: [Self; 3] = [Self::Created, Self::Decided, Self::Cancelled];

    fn kind(self) -> &'static str {
        match self {
            Self::Created => "review_request.created",
            Self::Decided => "review_request.decided",
            Self::Cancelled => "review_request.cancelled",
        }
    }
}

/// Tell the caller's organization a review request changed, so an inbox or a
/// stage on screen reads it again (`docs/events-catalog.md`, rule E5: the
/// event is a prompt, `GET /review-requests` is the truth).
fn announce_review(
    quality: &Quality,
    ctx: &SecurityContext,
    event: ReviewEvent,
    dto: &ReviewRequestDto,
) {
    let Ok(events) = quality
        .hub
        .get::<dyn crate::studio_events::StudioEventPublisher>()
    else {
        return;
    };
    events.publish(
        crate::studio_events::StudioEvent::new(
            ctx.subject_tenant_id(),
            event.kind(),
            "review_request",
            dto.id.clone(),
            "studio-documents",
        )
        .with_payload(serde_json::json!({
            "id": dto.id,
            "project_id": dto.project_id,
            "subject_id": dto.subject_id,
            "title": dto.title,
            "state": dto.state,
            "requested_by": dto.requested_by,
            "reviewers": dto.reviewers.iter().map(|r| r.person.clone()).collect::<Vec<_>>(),
            "outstanding": dto.outstanding,
            "due_at": dto.due_at,
        })),
    );
}

fn approval_dto(a: &super::entity::approval::Model) -> ApprovalDto {
    ApprovalDto {
        id: a.id.to_string(),
        request_id: a.request_id.to_string(),
        version: a.version.clone(),
        approver: a.approver.clone(),
        approver_name: a.approver_name.clone(),
        verdict: a.verdict.clone(),
        security: a.security,
        note: a.note.clone(),
        checks: serde_json::from_value(a.checks.clone()).unwrap_or_default(),
        decided_at: rfc3339(a.decided_at),
    }
}

fn review_dto(review: &super::service::Review, now: time::OffsetDateTime) -> ReviewRequestDto {
    let r = &review.request;
    let reviewers = review.reviewers();
    let facts = review.verdict_facts();
    let latest = |person: &str| {
        review
            .verdicts
            .iter()
            .filter(|v| v.approver == person)
            .max_by_key(|v| v.decided_at)
    };
    let open = r.state == "open";
    let maturity = review.maturity();
    let stakeholders = super::approvals::stakeholders(&review.stakeholders(), &reviewers, &facts)
        .into_iter()
        .map(|s| StakeholderDto {
            approved: !s.approved_by.is_empty(),
            name: s.name,
            required: s.required,
            approved_by: s.approved_by,
            asked: s.asked,
        })
        .collect();
    ReviewRequestDto {
        id: r.id.to_string(),
        project_id: r.project_id.to_string(),
        subject_kind: r.subject_kind.clone(),
        subject_id: r.subject_id.to_string(),
        type_key: r.type_key.clone(),
        title: r.title.clone(),
        version: r.version.clone(),
        requested_by: r.requested_by.clone(),
        requested_by_name: r.requested_by_name.clone(),
        overdue: open && super::approvals::overdue(r.due_at, &reviewers, &facts, now),
        outstanding: if open {
            super::approvals::outstanding(&reviewers, &facts)
                .into_iter()
                .map(|x| x.name.clone().unwrap_or_else(|| x.person.clone()))
                .collect()
        } else {
            Vec::new()
        },
        advisory: super::approvals::advisory(maturity.as_deref()),
        maturity,
        reviewers: reviewers
            .iter()
            .map(|x| ReviewerDto {
                verdict: latest(&x.person).map(|v| v.verdict.clone()),
                security: latest(&x.person).is_some_and(|v| v.security),
                person: x.person.clone(),
                name: x.name.clone(),
                required: x.required,
                stakeholder: x.stakeholder.clone(),
            })
            .collect(),
        stakeholders,
        rules_digest: review.rules().map(|s| s.digest),
        rules_changed: false,
        due_at: r.due_at.map(rfc3339),
        state: r.state.clone(),
        created_at: rfc3339(r.created_at),
        verdicts: review.verdicts.iter().map(approval_dto).collect(),
        current_version: None,
        stale: false,
        recorded_checks: Vec::new(),
    }
}

/// Say whether the type's rules moved since the review was asked for, from
/// each type's digest now (`type_key` -> digest).
fn with_rules(
    mut dto: ReviewRequestDto,
    now: &std::collections::HashMap<String, String>,
) -> ReviewRequestDto {
    dto.rules_changed = match (
        &dto.rules_digest,
        dto.type_key.as_ref().and_then(|k| now.get(k)),
    ) {
        (Some(then), Some(now)) => then != now,
        _ => false,
    };
    dto
}

/// Each type's rules digest as `workspace_id` sees them now.
async fn rules_now(
    service: &DocumentsService,
    ctx: &SecurityContext,
    workspace_id: Uuid,
) -> std::collections::HashMap<String, String> {
    service
        .list_types(ctx, workspace_id)
        .await
        .unwrap_or_default()
        .iter()
        .map(|t| (t.key.clone(), super::review_guide::rules_snapshot(t).digest))
        .collect()
}

/// Fold the document's current version and passing checks into a request.
fn with_version(
    mut dto: ReviewRequestDto,
    versions: &std::collections::HashMap<Uuid, (String, Vec<String>)>,
) -> ReviewRequestDto {
    let current = Uuid::parse_str(&dto.subject_id)
        .ok()
        .and_then(|id| versions.get(&id));
    dto.current_version = current.map(|(v, _)| v.clone());
    dto.stale = current.is_some_and(|(v, _)| *v != dto.version);
    dto.recorded_checks = current.map(|(_, c)| c.clone()).unwrap_or_default();
    dto
}

/// Ask people to review one version of a document.
async fn create_review_request(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Json(body): Json<ReviewRequestInput>,
) -> ApiResult<(StatusCode, JsonBody<ReviewRequestDto>)> {
    let project_id = parse_project_id(&body.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let subject_id = parse_uuid_field("subject_id", &body.subject_id)?;
    let due_at = match body
        .due_at
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        Some(d) => Some(
            time::OffsetDateTime::parse(d, &time::format_description::well_known::Rfc3339)
                .map_err(|_| {
                    DocumentsError::invalid_argument()
                        .with_field_violation("due_at", "must be RFC 3339".to_owned(), "INVALID")
                        .create()
                })?,
        ),
        None => None,
    };
    let requester = quality.caller(&ctx).await?;
    let reader = quality.reader().ok();
    let (current, text) = service
        .subject_state(
            &ctx,
            workspace_id,
            project_id,
            &body.subject_kind,
            subject_id,
            reader.as_deref(),
        )
        .await
        .map_err(internal)?;
    // A request with no version is about the document as it is now.
    let version = match body.version.trim() {
        "" => current.clone().unwrap_or_default(),
        v => v.to_string(),
    };
    let ask = super::service::ReviewAsk {
        subject_kind: body.subject_kind,
        subject_id,
        title: body.title,
        version,
        reviewers: body
            .reviewers
            .into_iter()
            .map(|r| super::approvals::Reviewer {
                person: r.person.trim().to_string(),
                name: r.name,
                required: r.required.unwrap_or(true),
                stakeholder: r.stakeholder,
            })
            .collect(),
        due_at,
        stakeholders: body.stakeholders.unwrap_or_default(),
    };
    let types = service
        .list_types(&ctx, workspace_id)
        .await
        .map_err(internal)?;
    let review = service
        .request_review(workspace_id, project_id, ask, requester, text, &types)
        .await
        .map_err(invalid)?;
    let versions = service
        .subject_versions(workspace_id, project_id)
        .await
        .unwrap_or_default();
    let dto = with_version(
        review_dto(&review, time::OffsetDateTime::now_utc()),
        &versions,
    );
    announce_review(&quality, &ctx, ReviewEvent::Created, &dto);
    Ok((StatusCode::CREATED, Json(dto)))
}

/// A project's (or a workspace's) review requests, newest first.
async fn list_review_requests(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<ReviewListQuery>,
) -> ApiResult<JsonBody<ReviewRequestListDto>> {
    let reviews = match (query.project_id.as_deref(), query.workspace_id.as_deref()) {
        (Some(p), _) => {
            let project_id = parse_project_id(p)?;
            let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
            let subject = match query.subject_id.as_deref() {
                Some(s) => Some(parse_uuid_field("subject_id", s)?),
                None => None,
            };
            service
                .reviews_with_verdicts(workspace_id, project_id, subject)
                .await
                .map_err(internal)?
        }
        (None, Some(w)) => {
            let workspace_id = parse_uuid_field("workspace_id", w)?;
            service
                .authorize(&ctx, workspace_id)
                .await
                .map_err(no_tenant)?;
            service
                .workspace_reviews(workspace_id)
                .await
                .map_err(internal)?
        }
        (None, None) => {
            return Err(DocumentsError::invalid_argument()
                .with_field_violation(
                    "project_id",
                    "name a project_id or a workspace_id".to_owned(),
                    "REQUIRED",
                )
                .create());
        }
    };
    let reviews = match query.waiting_on.as_deref() {
        None => reviews,
        Some("me") => {
            let (me, _) = quality.caller(&ctx).await?;
            reviews
                .into_iter()
                .filter(|r| r.request.state == "open")
                .filter(|r| {
                    let reviewers = r.reviewers();
                    super::approvals::awaiting(&reviewers, &r.verdict_facts())
                        .iter()
                        .any(|x| x.person == me)
                })
                .collect()
        }
        Some(_) => {
            return Err(DocumentsError::invalid_argument()
                .with_field_violation("waiting_on", "only `me` is supported".to_owned(), "INVALID")
                .create());
        }
    };
    let now = time::OffsetDateTime::now_utc();
    let mut versions: std::collections::HashMap<Uuid, (String, Vec<String>)> =
        std::collections::HashMap::new();
    let projects: std::collections::BTreeSet<Uuid> =
        reviews.iter().map(|r| r.request.project_id).collect();
    for p in projects {
        let ws = reviews
            .iter()
            .find(|r| r.request.project_id == p)
            .map(|r| r.request.tenant_id)
            .unwrap_or_default();
        if let Ok(v) = service.subject_versions(ws, p).await {
            versions.extend(v);
        }
    }
    let mut rules: std::collections::HashMap<Uuid, std::collections::HashMap<String, String>> =
        std::collections::HashMap::new();
    for ws in reviews
        .iter()
        .map(|r| r.request.tenant_id)
        .collect::<std::collections::BTreeSet<_>>()
    {
        rules.insert(ws, rules_now(&service, &ctx, ws).await);
    }
    let no_rules = std::collections::HashMap::new();
    let items: Vec<ReviewRequestDto> = reviews
        .iter()
        .map(|r| {
            with_rules(
                with_version(review_dto(r, now), &versions),
                rules.get(&r.request.tenant_id).unwrap_or(&no_rules),
            )
        })
        .collect();
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    let open: Vec<&ReviewRequestDto> = items.iter().filter(|r| r.state == "open").collect();
    Ok(Json(ReviewRequestListDto {
        total: count(items.len()),
        open: count(open.len()),
        overdue: count(open.iter().filter(|r| r.overdue).count()),
        stale: count(open.iter().filter(|r| r.stale).count()),
        items,
    }))
}

/// Record the caller's verdict on a request they were asked to review.
async fn create_review_approval(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Path(request_id): Path<String>,
    Json(body): Json<ReviewVerdictInput>,
) -> ApiResult<(StatusCode, JsonBody<ApprovalDto>)> {
    let project_id = parse_project_id(&body.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let request_id = parse_uuid_field("request_id", &request_id)?;
    let approver = quality.caller(&ctx).await?;
    let (review, approval) = service
        .give_verdict(
            workspace_id,
            project_id,
            request_id,
            approver,
            &body.verdict,
            body.security.unwrap_or(false),
            body.note,
        )
        .await
        .map_err(invalid)?
        .ok_or_else(|| {
            DocumentsError::not_found("no such review request in this project")
                .with_resource("review_request")
                .create()
        })?;
    let dto = review_dto(&review, time::OffsetDateTime::now_utc());
    announce_review(&quality, &ctx, ReviewEvent::Decided, &dto);
    Ok((StatusCode::CREATED, Json(approval_dto(&approval))))
}

/// Withdraw an open request the caller asked for.
async fn cancel_review_request(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Path(request_id): Path<String>,
    Json(body): Json<ReviewCancelInput>,
) -> ApiResult<JsonBody<ReviewRequestDto>> {
    let project_id = parse_project_id(&body.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let request_id = parse_uuid_field("request_id", &request_id)?;
    let (me, _) = quality.caller(&ctx).await?;
    let review = service
        .withdraw_review(workspace_id, project_id, request_id, &me)
        .await
        .map_err(invalid)?
        .ok_or_else(|| {
            DocumentsError::not_found("no such review request in this project")
                .with_resource("review_request")
                .create()
        })?;
    let dto = review_dto(&review, time::OffsetDateTime::now_utc());
    announce_review(&quality, &ctx, ReviewEvent::Cancelled, &dto);
    Ok(Json(dto))
}

/// A request's reviewed text, the document now, and the last approved
/// version before it.
async fn get_review_request_diff(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Path(request_id): Path<String>,
    Query(query): Query<ProjectQuery>,
) -> ApiResult<JsonBody<ReviewDiffDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let request_id = parse_uuid_field("request_id", &request_id)?;
    let all = service
        .reviews_with_verdicts(workspace_id, project_id, None)
        .await
        .map_err(internal)?;
    let Some(this) = all.iter().find(|r| r.request.id == request_id) else {
        return Err(
            DocumentsError::not_found("no such review request in this project")
                .with_resource("review_request")
                .create(),
        );
    };
    let r = &this.request;
    let reader = quality.reader().ok();
    let (current, text) = service
        .subject_state(
            &ctx,
            workspace_id,
            project_id,
            &r.subject_kind,
            r.subject_id,
            reader.as_deref(),
        )
        .await
        .map_err(internal)?;
    // Newest first, as the repository lists them.
    let base = all
        .iter()
        .filter(|o| {
            o.request.subject_id == r.subject_id
                && o.request.id != r.id
                && o.request.state == "approved"
                && o.request.created_at < r.created_at
        })
        .max_by_key(|o| o.request.created_at)
        .map(|o| ReviewBaseDto {
            request_id: o.request.id.to_string(),
            version: o.request.version.clone(),
            reviewed_text: o.request.reviewed_text.clone(),
            created_at: rfc3339(o.request.created_at),
        });
    Ok(Json(ReviewDiffDto {
        request_id: r.id.to_string(),
        version: r.version.clone(),
        stale: current.as_ref().is_some_and(|c| *c != r.version),
        current_version: current,
        reviewed_text: r.reviewed_text.clone(),
        current_text: text,
        base,
    }))
}

/// Whom to ask about a document, from who was asked before in the project.
async fn list_reviewer_suggestions(
    Extension(ctx): Extension<SecurityContext>,
    Extension(service): Extension<Arc<DocumentsService>>,
    Extension(quality): Extension<Quality>,
    Query(query): Query<ReviewerSuggestionQuery>,
) -> ApiResult<JsonBody<ReviewerSuggestionListDto>> {
    let project_id = parse_project_id(&query.project_id)?;
    let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
    let subject_id = parse_uuid_field("subject_id", &query.subject_id)?;
    let (me, _) = quality.caller(&ctx).await?;
    let items: Vec<ReviewerSuggestionDto> = service
        .suggest_reviewers(
            workspace_id,
            project_id,
            subject_id,
            query.type_key.as_deref(),
            &me,
        )
        .await
        .map_err(internal)?
        .into_iter()
        .map(|r| ReviewerSuggestionDto {
            person: r.person,
            name: r.name,
            required: r.required,
        })
        .collect();
    Ok(Json(ReviewerSuggestionListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
    }))
}

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
    /// Unique across all three kinds a row can be, and what a caller acts on:
    ///
    /// - a bound repository file: the binding id — `PUT
    ///   …/document-bindings/{id}`, and `binding_ids` in a quality run;
    /// - an authored document: the document id — `document_ids` in a quality
    ///   run, and what opens it;
    /// - a file nothing has classified: `candidate:<node_id>`, which names no
    ///   record yet and is not accepted by either.
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
    /// That repository's `full_path`. Empty for an authored row, and for a
    /// repository row whose repository is unknown: the files could not be read
    /// (`sources.files_known` false — the file-to-repository map comes from
    /// that read), the repository paths could not be read
    /// (`sources.repos_known` false), or the graph no longer holds the
    /// repository (both true).
    pub repo_full_path: String,
    /// The binding's confidence in its type. Meaningful while `state` is
    /// `detected`; `1.0` for a type a person chose (`manual`); a confirmed
    /// binding keeps the classifier's number. Null for an authored row, a file
    /// nothing has classified, and a classifier that gave none.
    pub confidence: Option<f64>,
    /// RFC 3339 time of the newest verdict recorded for this document, from
    /// ANY detector — `bloat` and `traceability`, which a sync runs over every
    /// typed document as a set, included. So it says that something looked,
    /// not that `purpose` or `leak` did, and not whether Spec Quality takes
    /// the document's type (a refusal records nothing, but a set detector may
    /// still have dated the document).
    ///
    /// Null when no verdict carries a date: never checked, or — with
    /// `findings > 0` — checked before verdicts were dated. Read `findings`
    /// first.
    pub checked_at: Option<String>,
    /// Findings placed in the text, across all the document's verdicts: the
    /// items of each verdict's `details.findings`, and one for a failed
    /// verdict (`high`, `gate-failed`) recorded without items. Traceability's
    /// `some` ("cites no other document") passed its gate and counts nothing.
    pub findings: u32,
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
    /// Whether the recorded verdicts could be read. False means every row's
    /// `checked_at` and `findings` are unknown rather than "never checked".
    pub reviews_known: bool,
    /// Whether the repositories' paths could be read. False means an empty
    /// `repo_full_path` is unknown rather than a repository that is gone.
    pub repos_known: bool,
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

    // The never-classified files, their provenance and the recorded verdicts.
    // Absent when no ingest gear is here, which costs one queue and the review
    // columns rather than the screen.
    let scope = project_id.to_string();
    let mut known = super::spec_rows::Known::default();
    // A finding a member dismissed (✗) is not counted against its document.
    let dismissed: std::collections::BTreeSet<String> = service
        .spec_decisions(workspace_id, project_id)
        .await
        .map_err(internal)?
        .into_iter()
        .filter(|d| d.decision == "dismissed")
        .map(|d| d.fingerprint)
        .collect();
    let (candidates, files_known, reviews_known, repos_known) = match quality.files() {
        Some(files) => {
            let (found, reviews, repo_paths) = tokio::join!(
                files.list_files(&ctx, &scope),
                files.reviews(&ctx, &scope, &dismissed),
                files.repo_paths(&ctx, &scope),
            );
            // Each read degrades one part of the answer, and the response says
            // which through its `*_known` flag; the cause is only in the log.
            let repos_known = match repo_paths {
                Ok(paths) => {
                    known.repo_paths = paths;
                    true
                }
                Err(e) => {
                    tracing::warn!(error = %e, project = %scope, "spec-rows: repository paths unreadable");
                    false
                }
            };
            let reviews_known = match reviews {
                Ok(r) => {
                    known.reviews = r;
                    true
                }
                Err(e) => {
                    tracing::warn!(error = %e, project = %scope, "spec-rows: recorded verdicts unreadable");
                    false
                }
            };
            match found {
                Ok(found) => {
                    known.repos = found
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
                    (candidates, true, reviews_known, repos_known)
                }
                Err(e) => {
                    tracing::warn!(error = %e, project = %scope, "spec-rows: ingested files unreadable");
                    (Vec::new(), false, reviews_known, repos_known)
                }
            }
        }
        None => (Vec::new(), false, false, false),
    };

    let rows = super::spec_rows::rows(&bindings, &authored, &candidates, &known);
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
            repo_full_path: r.repo_full_path,
            confidence: r.confidence.map(f64::from),
            checked_at: r.review.checked_at,
            findings: r.review.findings,
        })
        .collect();

    Ok(Json(SpecRowListDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        sources: SpecRowsSourcesDto {
            files_known,
            reviews_known,
            repos_known,
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
            confidence: b.confidence,
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
    /// Read the criteria a review is judged by: the ones kept when it was
    /// asked for, however the type changed since. Needs `project_id`.
    #[serde(default)]
    pub review_request_id: Option<String>,
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
    let (mut guide, owner) =
        effective_guide(&ty).unwrap_or_else(|| (ReviewGuide::default(), ty.owner.clone()));
    // A review is judged by the rules it started with.
    if let (Some(raw), Some(project)) = (
        query.review_request_id.as_deref(),
        query.project_id.as_deref(),
    ) {
        let request_id = parse_uuid_field("review_request_id", raw)?;
        let project_id = parse_project_id(project)?;
        let workspace_id = parent_workspace(&service, &ctx, project_id).await?;
        let kept = service
            .reviews_with_verdicts(workspace_id, project_id, None)
            .await
            .map_err(internal)?
            .into_iter()
            .find(|r| r.request.id == request_id)
            .ok_or_else(|| {
                DocumentsError::not_found("no such review request in this project")
                    .with_resource("review_request")
                    .create()
            })?
            .rules();
        if let Some(kept) = kept {
            guide = ReviewGuide {
                checklist: kept.checklist,
                rules: kept.rules,
            };
        }
    }
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

    router = OperationBuilder::get("/studio-documents/v1/spec-model")
        .operation_id("studio_documents.get_spec_model")
        .summary("A project's domain model, as read from its documents so far")
        .description(
            "The facts every document gave at its current revision — entities, attributes, \
             relations, requirements, constraints, lifecycles and decisions — each with the \
             passage it rests on and whether that passage is in force \
             (docs/spec-domain-model.md). `documents` says where each document stands: \
             extracted, failed part-way, stale (only an older revision was read) or pending. \
             `build` is the project's build as the process answering knows it.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project whose model to read")
        .handler(get_spec_model)
        .json_response_with_schema::<SpecModelDto>(openapi, StatusCode::OK, "The model")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/spec-model/builds")
        .operation_id("studio_documents.start_spec_model_build")
        .summary("Read a project's documents into its domain model, on your model key")
        .description(
            "Every document not yet read at its current revision is read by a model on the \
             caller's own key (ADR-0039: Studio holds none), in the background; follow it on \
             `GET /spec-model`. Not a studio-tasks run, because the queue worker cannot act as \
             the caller. A build already running for the project is answered with its state. \
             A document already read at its revision is never read again, so a build stopped \
             part-way resumes where it stopped. Up to four documents are read at once. With \
             `path`, only that document is read again, whatever its state: its facts replace \
             its own and the rest of the model stays (404 when it is not one of the model's \
             documents).",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<SpecModelBuildRequest>(
            openapi,
            "The project, and one document to read again",
        )
        .handler(start_spec_model_build)
        .json_response_with_schema::<SpecModelBuildDto>(openapi, StatusCode::ACCEPTED, "The build")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/spec-model/build-estimate")
        .operation_id("studio_documents.get_spec_model_build_estimate")
        .summary("What a build of a project's model would read, and about how long it would take")
        .description(
            "The documents `POST /spec-model/builds` would read now (changed or never read, or \
             the one `path` names), their size in characters and approximate input tokens \
             (characters over four), and the seconds reading them should take: at the pace of \
             the project's earlier builds when there were any (`measured`), else a default. \
             The judge's stage after the reading is not counted. No model is called.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project whose build to estimate")
        .query_param("path", false, "One document to estimate reading again")
        .handler(get_spec_model_build_estimate)
        .json_response_with_schema::<SpecModelBuildEstimateDto>(
            openapi,
            StatusCode::OK,
            "The estimate",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/spec-model/decisions")
        .operation_id("studio_documents.list_spec_model_decisions")
        .summary("Every ✓ and ✗ members gave on a project's findings")
        .description(
            "The decisions recorded with `POST /spec-model/findings/{fingerprint}/decision`, for \
             the model's findings and the Spec Quality detectors' alike, since both are keyed by \
             their fingerprint. A `dismissed` finding is not counted on the Specs list. The list \
             is read whole.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project whose decisions to read")
        .handler(list_spec_model_decisions)
        .json_response_with_schema::<SpecModelDecisionListDto>(
            openapi,
            StatusCode::OK,
            "The decisions",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router =
        OperationBuilder::post("/studio-documents/v1/spec-model/findings/{fingerprint}/decision")
            .operation_id("studio_documents.decide_spec_model_finding")
            .summary("Mark a finding a real problem, or not one")
            .description(
                "`confirmed` says the finding is a real problem, `dismissed` that it is not. The \
             latest decision on a finding wins, and it holds while the finding keeps its \
             fingerprint: a change to either passage is a new finding, decided afresh.",
            )
            .tag("StudioDocuments")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("fingerprint", "The finding's fingerprint")
            .json_request::<SpecModelDecisionRequest>(openapi, "The project and the decision")
            .handler(decide_spec_model_finding)
            .json_response_with_schema::<SpecModelDecisionDto>(
                openapi,
                StatusCode::CREATED,
                "The decision",
            )
            .error_400(openapi)
            .error_401(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/spec-model/entities")
        .operation_id("studio_documents.upsert_spec_model_entity")
        .summary("Save an entity of the domain model to the project's documentation")
        .description(
            "What the entity is, what it holds and how it relates, as a person edited it. It \
             replaces the entity's section of `docs/domain-model.md` in the project's repository, \
             which Studio keeps one section per entity and which the model reads like any other \
             document once its type is settled. Written the way the repository takes changes: \
             onto its branch, or on a `domain-model/…` branch with a pull request.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project whose model it is")
        .json_request::<SpecModelEntityRequest>(openapi, "The entity as edited")
        .handler(upsert_spec_model_entity)
        .json_response_with_schema::<SpecModelWriteDto>(openapi, StatusCode::OK, "Where it landed")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router =
        OperationBuilder::post("/studio-documents/v1/spec-model/findings/{fingerprint}/proposals")
            .operation_id("studio_documents.create_spec_model_finding_proposal")
            .summary("Propose a finding's fix as a pull request on its document")
            .description(
                "The finding's smallest edit applied to the passage it names, matched across line \
         breaks the way it was checked, on a `fix/…` branch with a pull request: a proposal, \
         never a commit onto the document's branch. 404 when the finding is gone; 400 when it \
         names no edit or its passage is no longer in the document.",
            )
            .tag("StudioDocuments")
            .authenticated()
            .require_license_features::<License>([])
            .path_param("fingerprint", "The finding's fingerprint")
            .query_param("project_id", true, "The project the finding is in")
            .handler(create_spec_model_finding_proposal)
            .json_response_with_schema::<SpecModelWriteDto>(
                openapi,
                StatusCode::CREATED,
                "The pull request",
            )
            .error_400(openapi)
            .error_401(openapi)
            .error_404(openapi)
            .error_500(openapi)
            .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/spec-model/sentences/proposals")
        .operation_id("studio_documents.create_spec_model_sentence_proposal")
        .summary("Propose a sentence for one of the project's documents as a pull request")
        .description(
            "A paragraph of its own after the block the given line sits in, on a `docs/…` branch \
             with a pull request — a proposal, never a commit onto the document's branch. The Domain \
             model tab uses it to state a relation no document states. 400 when the file is not one \
             of the project's documents, it changed since the model read it, or the line is blank \
             or code; 404 when it is not in the repository.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project the document is in")
        .json_request::<SpecModelSentenceRequest>(openapi, "The sentence and where it goes")
        .handler(create_spec_model_sentence_proposal)
        .json_response_with_schema::<SpecModelWriteDto>(openapi, StatusCode::CREATED, "The pull request")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/spec-model/glossary")
        .operation_id("studio_documents.get_spec_model_glossary")
        .summary("The project's glossary: what its documents name, and by which names")
        .description(
            "One entry per thing the documents name, proposed without a model from the facts' \
             subjects: spellings that differ only in case, articles and plurals are one entry. \
             Members decide the name an entry goes by and which entry is another name of which \
             (`POST /spec-model/glossary/decisions`); facts about an alias count as facts about \
             its entry when the rules look for disagreements. An alias whose entry the documents \
             no longer name, or that is an alias itself, holds nothing \
             (docs/project-and-product.md, \"The project's words\").",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project whose glossary to read")
        .handler(get_glossary)
        .json_response_with_schema::<GlossaryListDto>(openapi, StatusCode::OK, "The glossary")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/spec-model/issues")
        .operation_id("studio_documents.create_spec_model_issue")
        .summary("Open an issue in the project's repository for something to decide")
        .description(
            "A problem in the documents or a gap in the model, opened as an issue in the project's \
             repository and assigned to people by their GitHub logins; the repository's sync then \
             brings it back as work like any other issue.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<SpecModelIssueRequest>(openapi, "The project, the issue and who it is for")
        .handler(create_spec_model_issue)
        .json_response_with_schema::<SpecModelIssueDto>(openapi, StatusCode::CREATED, "The issue")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/spec-model/check-methods")
        .operation_id("studio_documents.list_spec_model_check_methods")
        .summary("The hypothesis check methods the project's kits add")
        .description(
            "Each named kit's `.cf-studio/config/kits/<kit>/check-methods.json` in the project's \
             repository, read as written: a JSON array of methods, each with the uncertainty it \
             addresses, what it needs, what it does, what a result of it cannot establish and \
             the words in a claim it applies to. A kit with no such file adds nothing; one whose \
             file is out of shape or unreadable is named in `unread`, mapped to the reason. The five \
             built-in methods are the portal's and are not listed.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project whose kits to read")
        .query_param(
            "kits",
            false,
            "The kits to read: comma-separated slugs, at most 20",
        )
        .handler(list_kit_check_methods)
        .json_response_with_schema::<KitCheckMethodListDto>(
            openapi,
            StatusCode::OK,
            "The methods the kits add",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/spec-model/glossary/document")
        .operation_id("studio_documents.get_spec_model_glossary_document")
        .summary("The glossary the project's documents keep, read as written")
        .description(
            "`docs/glossary.md` when the repository has it, else the glossary section with a term \
             table inside another document (a PRD's glossary), with its rows; `found` is null when \
             the documents keep none.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project whose glossary to find")
        .handler(get_glossary_document)
        .json_response_with_schema::<GlossaryDocDto>(
            openapi,
            StatusCode::OK,
            "Where the glossary is",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/spec-model/glossary/document/proposals")
        .operation_id("studio_documents.create_spec_model_glossary_document_proposal")
        .summary("Propose the project's glossary as docs/glossary.md")
        .description(
            "The rows written as `docs/glossary.md`, one table row per term with an anchor other \
             documents link to, in a pull request. A glossary kept as a section of another document \
             moves in the same pull request: the section keeps its heading and links to the file.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<GlossaryDocRequest>(openapi, "The project and the glossary's rows")
        .handler(create_glossary_document_proposal)
        .json_response_with_schema::<SpecModelWriteDto>(openapi, StatusCode::CREATED, "The pull request")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/spec-model/files/proposals")
        .operation_id("studio_documents.create_spec_model_file_proposal")
        .summary("Propose a whole document for the project's repository as a pull request")
        .description(
            "What a member accepted in Studio — the need, a prioritisation — written to a Markdown \
             file under `docs/` on a `docs/…` branch with a pull request: a proposal, never a commit \
             onto the repository's branch. 400 for any other path or an empty document.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<SpecModelFileProposalRequest>(openapi, "The document and where it goes")
        .handler(create_spec_model_file_proposal)
        .json_response_with_schema::<SpecModelWriteDto>(openapi, StatusCode::CREATED, "The pull request")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/spec-model/reviews")
        .operation_id("studio_documents.list_spec_model_reviews")
        .summary("Every accept or reject members gave on the facts the model read")
        .description(
            "What the model proposes is the project's reading only once a member accepts it; a \
             rejected reading is not proposed again while its passage says the same.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .handler(list_spec_model_reviews)
        .json_response_with_schema::<SpecModelReviewListDto>(openapi, StatusCode::OK, "The reviews")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/spec-model/reviews")
        .operation_id("studio_documents.decide_spec_model_fact_reviews")
        .summary("Accept, reject or put back a selection of facts in one action")
        .description(
            "Each item is a fact's key with `accepted`, `rejected`, or `proposed` to withdraw an \
             earlier review, and where it was read. Prefixed keys carry the project's other \
             decisions under the same rule: a hypothesis's evidence (`ev:`) and its check \
             (`hyp:`, a note of up to 8000 bytes), an excluded obligation (`ob:`), a match \
             across projects (`rel:`), an opened issue (`iss:`), an item being prioritised \
             (`pri:`, state `scored`) and a confirmed order (`prc:`, state `confirmed`). At most \
             500 in one call.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<SpecModelReviewRequest>(openapi, "The project and the facts")
        .handler(review_spec_model_facts)
        .json_response_with_schema::<SpecModelReviewListDto>(
            openapi,
            StatusCode::OK,
            "What was recorded",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/spec-model/glossary/distinct")
        .operation_id("studio_documents.decide_spec_model_glossary_distinct")
        .summary("Say two glossary entries are different things")
        .description(
            "Kept on both entries as `distinct_from`, so the glossary does not offer them as one \
             thing again. Each entry's name and alias decision stay as they are.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<GlossaryDistinctRequest>(openapi, "The project and the two entries")
        .handler(decide_glossary_distinct)
        .no_content_response(StatusCode::NO_CONTENT, "Recorded")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/spec-model/glossary/decisions")
        .operation_id("studio_documents.decide_spec_model_glossary_entry")
        .summary("Name a glossary entry, or make it another name of one")
        .description(
            "Replaces the entry's last decision whole. `name` is the name the project uses for \
             it; `alias_of` is the key of the entry it is another name of. `null` in both puts \
             the entry back as the documents propose it.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<GlossaryDecisionRequest>(openapi, "The project, the entry and the decision")
        .handler(decide_glossary_entry)
        .json_response_with_schema::<GlossaryDecisionDto>(
            openapi,
            StatusCode::CREATED,
            "The decision",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/spec-model/glossary/proposals")
        .operation_id("studio_documents.create_spec_model_glossary_proposal")
        .summary("Propose a glossary rename in the documents as one pull request")
        .description(
            "Every whole-word use of `from` (any case) in the prose of the project's documents \
             replaced by `to`, the first letter keeping its case; code, links' destinations and \
             front matter are left as they are. One pull request on a `glossary/…` branch over \
             every file that uses it: a proposal, never a commit onto the documents' branch. 400 \
             when no document uses the name.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project whose documents to change")
        .json_request::<GlossaryRenameRequest>(openapi, "The old name and the project's name")
        .handler(create_glossary_rename_proposal)
        .json_response_with_schema::<GlossaryRenameProposalDto>(
            openapi,
            StatusCode::CREATED,
            "The pull request",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/review-requests")
        .operation_id("studio_documents.create_review_request")
        .summary("Ask people to review one version of a document")
        .description(
            "Names the document (`document` written in Studio, or `binding` for a repository \
             file), the version asked about, the reviewers (required unless `required: false`) \
             and an optional due date. An earlier open request on the same document becomes \
             `superseded`. While a required reviewer has not approved, the document's stage is \
             not complete (`stage-status`, `approvals_outstanding`).",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<ReviewRequestInput>(
            openapi,
            "The document, version, reviewers and due date",
        )
        .handler(create_review_request)
        .json_response_with_schema::<ReviewRequestDto>(openapi, StatusCode::CREATED, "The request")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/review-requests")
        .operation_id("studio_documents.list_review_requests")
        .summary("A project's or a workspace's review requests, with every verdict given")
        .description(
            "Newest first, each with its reviewers and where each stands, the verdicts as \
             recorded, the required reviewers still awaited (`outstanding`) and whether it is \
             past its due date (`overdue`). `project_id` (optionally narrowed by `subject_id`) \
             or `workspace_id`; `waiting_on=me` keeps the open requests that still wait for the \
             caller's verdict. The list is read whole.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", false, "One project's requests")
        .query_param("workspace_id", false, "Every project's in the workspace")
        .query_param("subject_id", false, "One document's requests")
        .query_param(
            "waiting_on",
            false,
            "`me`: only the requests awaiting the caller",
        )
        .handler(list_review_requests)
        .json_response_with_schema::<ReviewRequestListDto>(openapi, StatusCode::OK, "The requests")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/review-requests/{request_id}/approvals")
        .operation_id("studio_documents.create_review_approval")
        .summary("Give a verdict on a review request you were asked to review")
        .description(
            "Records `approved` or `changes_requested` from the caller, who must be one of the \
             request's reviewers, against the version the request names, with the detectors \
             that had passed on the document at that moment. A verdict is never edited: a \
             later one is another record, and the latest counts. `security: true` marks the \
             changes asked for as a security concern, which holds the stage at any maturity. \
             When every required reviewer has approved and no latest verdict is a security \
             concern, the request becomes `approved`.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("request_id", "The review request")
        .json_request::<ReviewVerdictInput>(openapi, "The project, verdict and note")
        .handler(create_review_approval)
        .json_response_with_schema::<ApprovalDto>(openapi, StatusCode::CREATED, "The verdict")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/review-requests/{request_id}/cancel")
        .operation_id("studio_documents.cancel_review_request")
        .summary("Withdraw a review request you asked for")
        .description(
            "Only the person who asked can withdraw it. An open request becomes `withdrawn` and \
             stops holding the document's stage; one already approved or superseded is \
             answered as it is. The verdicts given stay on record.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("request_id", "The review request")
        .json_request::<ReviewCancelInput>(openapi, "The project")
        .handler(cancel_review_request)
        .json_response_with_schema::<ReviewRequestDto>(openapi, StatusCode::OK, "The request")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/review-requests/{request_id}/diff")
        .operation_id("studio_documents.get_review_request_diff")
        .summary("What a review was asked about, the document now, and the last approved version")
        .description(
            "The text kept when the review was asked for, the document's text now, whether it \
             changed since (`stale`), and `base`: the newest earlier request on the same \
             document that was approved, with its text, for a Before / Proposed diff. Texts \
             are kept from this version on; an older request answers `reviewed_text: null`.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("request_id", "The review request")
        .query_param("project_id", true, "The project")
        .handler(get_review_request_diff)
        .json_response_with_schema::<ReviewDiffDto>(openapi, StatusCode::OK, "The texts")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/review-requests/reviewer-suggestions")
        .operation_id("studio_documents.list_reviewer_suggestions")
        .summary("Whom to ask to review a document, from who was asked before")
        .description(
            "The reviewers of earlier requests on this document first, then of documents of \
             its type in the project, each ranked by how often they were asked, never the \
             caller; `required` as it was the last time. Empty for a project nobody reviewed \
             in yet.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .query_param("subject_id", true, "The document")
        .query_param("type_key", false, "The document's type")
        .handler(list_reviewer_suggestions)
        .json_response_with_schema::<ReviewerSuggestionListDto>(
            openapi,
            StatusCode::OK,
            "The suggestions",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/application-parts")
        .operation_id("studio_documents.list_application_parts")
        .summary("The application's configuration, storage and deployment parts beyond its gears")
        .description(
            "Found in the project's repositories by what the files are: Helm charts and their \
             values, Dockerfiles, compose files, Kubernetes and Terraform directories, \
             deployment workflows, configuration files and directories, migrations and \
             schemas; each with the owner, describing document, boundary and related parts \
             people recorded. A recorded part the repositories no longer show is listed with \
             `present: false` (issue #786).",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .handler(list_application_parts)
        .json_response_with_schema::<ApplicationPartListDto>(openapi, StatusCode::OK, "The parts")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::put("/studio-documents/v1/application-parts")
        .operation_id("studio_documents.upsert_application_part")
        .summary("Record the owner, describing document, boundary and related parts of one part")
        .description(
            "Keyed by the repository, the kind and the reference; replaces what was recorded \
             for it. A part need not have been found to be recorded.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<ApplicationPartInput>(openapi, "The part and what is known about it")
        .handler(upsert_application_part)
        .json_response_with_schema::<ApplicationPartDto>(openapi, StatusCode::OK, "The part")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/delivery-scopes")
        .operation_id("studio_documents.list_delivery_scopes")
        .summary("A project's delivery scopes, with their limits and whether each is blocked")
        .description(
            "Every delivery scope of the project, oldest first: its outcome, owner, target \
             date, the requirement identifiers it delivers, the gears it pins, its acceptance \
             and state, and its limits (limitations, open questions, dependencies). `blocked` \
             is true while a blocking limit holds: unresolved, and for a dependency on another \
             scope, that scope not delivered (issue #784).",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .handler(list_delivery_scopes)
        .json_response_with_schema::<DeliveryScopeListDto>(openapi, StatusCode::OK, "The scopes")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/delivery-scopes")
        .operation_id("studio_documents.create_delivery_scope")
        .summary("Add a delivery scope to a project")
        .description(
            "A scope is one outcome the project promises: title, outcome, owner, target date \
             (YYYY-MM-DD), the requirement identifiers it delivers (as decisions name them), \
             the gears it pins, how it is accepted, and its state (`planned` by default).",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<DeliveryScopeInput>(openapi, "The scope")
        .handler(create_delivery_scope)
        .json_response_with_schema::<DeliveryScopeDto>(openapi, StatusCode::CREATED, "The scope")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::patch("/studio-documents/v1/delivery-scopes/{scope_id}")
        .operation_id("studio_documents.patch_delivery_scope")
        .summary("Change a delivery scope; the version it replaces is kept")
        .description(
            "Only the fields given change; an empty owner or target date clears it. The \
             version the change replaces is kept in the scope's history, with who changed it \
             and when.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("scope_id", "The scope")
        .json_request::<DeliveryScopePatch>(openapi, "The project and the fields to change")
        .handler(update_delivery_scope)
        .json_response_with_schema::<DeliveryScopeDto>(openapi, StatusCode::OK, "The scope")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::delete("/studio-documents/v1/delivery-scopes/{scope_id}")
        .operation_id("studio_documents.delete_delivery_scope")
        .summary("Remove a delivery scope with its limits and history")
        .description(
            "Removes the scope, its limits and its history. To keep a scope on record without \
             it counting, set its state to `dropped` instead.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("scope_id", "The scope")
        .query_param("project_id", true, "The project")
        .handler(delete_delivery_scope)
        .no_content_response(StatusCode::NO_CONTENT, "Removed")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/delivery-scopes/{scope_id}/history")
        .operation_id("studio_documents.list_delivery_scope_history")
        .summary("Earlier versions of a delivery scope, newest first")
        .description(
            "Each version a change replaced, with who changed it and when. The scope as it \
             stands is the scope itself, not a version here.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("scope_id", "The scope")
        .query_param("project_id", true, "The project")
        .handler(list_delivery_scope_history)
        .json_response_with_schema::<DeliveryScopeHistoryDto>(
            openapi,
            StatusCode::OK,
            "The versions",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/delivery-scopes/{scope_id}/limits")
        .operation_id("studio_documents.create_delivery_limit")
        .summary("Add a limit to a delivery scope: a limitation, an open question or a dependency")
        .description(
            "A limit may block the scope (`blocking`). A dependency names what it depends on: \
             another scope's id (it stops holding once that scope is delivered) or a decision \
             record.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("scope_id", "The scope")
        .json_request::<DeliveryLimitInput>(openapi, "The limit")
        .handler(create_delivery_limit)
        .json_response_with_schema::<DeliveryLimitDto>(openapi, StatusCode::CREATED, "The limit")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::patch(
        "/studio-documents/v1/delivery-scopes/{scope_id}/limits/{limit_id}",
    )
    .operation_id("studio_documents.patch_delivery_limit")
    .summary("Resolve a limit, reopen it, or change whether it blocks")
    .description(
        "A resolution records who resolved it and when; an empty resolution reopens it. A \
         resolved limit no longer blocks its scope.",
    )
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("scope_id", "The scope")
    .path_param("limit_id", "The limit")
    .json_request::<DeliveryLimitPatch>(openapi, "The project and the change")
    .handler(update_delivery_limit)
    .json_response_with_schema::<DeliveryLimitDto>(openapi, StatusCode::OK, "The limit")
    .error_400(openapi)
    .error_401(openapi)
    .error_404(openapi)
    .error_500(openapi)
    .error_503(openapi)
    .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/pull-request-checks")
        .operation_id("studio_documents.run_pull_request_checks")
        .summary(
            "Check the documents each open pull request changes, and say it on the pull request",
        )
        .description(
            "For every open pull request of the project's repositories that changes a document \
             of a known type (a settled binding), checks the version in the pull request \
             against its type's template (required sections, their length, front matter) and \
             sets a `studio/documents` commit status on the head commit, unless `publish` is \
             false. One shared check for every repository instead of one per team. Answers \
             what each status says, and why one could not be set.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<PullRequestChecksRequest>(openapi, "The project, and whether to publish")
        .handler(run_pull_request_checks)
        .json_response_with_schema::<PullRequestCheckListDto>(openapi, StatusCode::OK, "The checks")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/remarks")
        .operation_id("studio_documents.list_remarks")
        .summary("Every review thread on a document, from the pull requests that changed it")
        .description(
            "Asks the repository host, through the project's connections, for the review \
             threads on one document: in the pull requests its last twenty commits came from \
             and in the open pull requests that change it. Unresolved threads of pull requests \
             that are no longer open come first, marked `left_open`: the remarks a merge left \
             behind. Each names the requirement identifiers its comments mention. Read live, \
             stored nowhere; `reached: false` when no connection reaches a repository.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .query_param("path", true, "The document, by its path in the repository")
        .handler(list_remarks)
        .json_response_with_schema::<RemarkListDto>(openapi, StatusCode::OK, "The threads")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/remarks/replies")
        .operation_id("studio_documents.create_remark_reply")
        .summary("Answer a review thread; the reply is posted where the remark was made")
        .description(
            "Posts the reply to the thread on the repository host through the project's \
             connection to that repository, so it appears in the pull request under that \
             connection's account. Answers the comment as the host recorded it.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<RemarkReplyRequest>(openapi, "The thread and the reply")
        .handler(create_remark_reply)
        .json_response_with_schema::<RemarkCommentDto>(openapi, StatusCode::CREATED, "The reply")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/decisions")
        .operation_id("studio_documents.create_decision")
        .summary("Record a decision on a project's requirements, with where it was taken")
        .description(
            "What was decided, the requirement identifiers it closes, where it was taken (a \
             review thread, a meeting, a chat) with a link, and the document it is about. \
             Recorded as the caller and never edited: a changed decision is a new one, so the \
             history stays readable.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<DecisionInput>(openapi, "The decision")
        .handler(create_decision)
        .json_response_with_schema::<DecisionDto>(openapi, StatusCode::CREATED, "The decision")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/decisions")
        .operation_id("studio_documents.list_decisions")
        .summary("A project's decisions, newest first")
        .description(
            "Every decision recorded on the project, newest first; `requirement` keeps those \
             that close one requirement, `path` those about one document. The list is read \
             whole.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .query_param("requirement", false, "A requirement identifier")
        .query_param("path", false, "A document path")
        .handler(list_decisions)
        .json_response_with_schema::<DecisionListDto>(openapi, StatusCode::OK, "The decisions")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router = OperationBuilder::post("/studio-documents/v1/review-brief")
        .operation_id("studio_documents.analyze_review_brief")
        .summary("A brief of one document for its reviewers, with changes of meaning told from rewording")
        .description(
            "Compares the document's labelled requirements with a base version (`base_ref`, or \
             the document before its latest commit, read through the project's repository \
             connection) to find which were added, removed or changed, then asks a model on \
             the caller's own key (ADR-0039) for the problem, roles, scope, assumptions and \
             open decisions, and whether each changed requirement changes what is required. \
             Claims about changes the comparison did not find are dropped; an added or removed \
             requirement always counts as meaning. Stores nothing; 400 \
             `PROVIDER_KEY_REQUIRED` when the caller has no key.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<ReviewBriefRequest>(openapi, "The document and the base to compare with")
        .handler(analyze_review_brief)
        .json_response_with_schema::<ReviewBriefDto>(openapi, StatusCode::OK, "The brief")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/spec-model/questions")
        .operation_id("studio_documents.list_domain_questions")
        .summary("What a document leaves out of the project's domain, and words it uses otherwise")
        .description(
            "For one document of the project: the entities the project's other documents relate \
             to an entity this one names, which this one never mentions (the ledger a billing \
             PRD forgot), strongest first, at most 15. Computed from the facts already \
             extracted: before the model is built (`built: false`) there are none \
             (docs/spec-domain-model.md, \"Questions while writing\").",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .query_param("path", true, "The document, by its path in the checkout")
        .handler(list_domain_questions)
        .json_response_with_schema::<DomainQuestionListDto>(
            openapi,
            StatusCode::OK,
            "The questions",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/spec-model/term-drift")
        .operation_id("studio_documents.list_term_drift")
        .summary("The words a document uses for things the project named otherwise")
        .description(
            "Every glossary alias members merged into an entry that one document still uses, \
             with the name the project chose and the line. From the glossary decisions and \
             the facts already extracted.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .query_param("path", true, "The document, by its path in the checkout")
        .handler(list_term_drift)
        .json_response_with_schema::<TermDriftListDto>(openapi, StatusCode::OK, "The words")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/spec-model/experts")
        .operation_id("studio_documents.list_domain_experts")
        .summary("Whom to ask about an entity: who changed the documents that describe it")
        .description(
            "Finds the three documents of the project with the most facts about the entity and \
             reads their history through the project's repository connection: the people who \
             changed them, most commits first, at most five, bots left out. Empty when the \
             model has not been built or no connection reaches the repository.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .query_param("subject", true, "The entity, as the glossary names it")
        .handler(list_domain_experts)
        .json_response_with_schema::<DomainExpertListDto>(openapi, StatusCode::OK, "The people")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/spec-model/trace")
        .operation_id("studio_documents.list_requirement_trace")
        .summary("Where each requirement is named: other documents, code, tests")
        .description(
            "Every requirement the project's documents define, with the documents that refer \
             to it and the code and test files of its checkouts that name its identifier as a \
             whole token (a test is told from code by its path). Mechanical, computed on every \
             call: what is not named is not traced. `implemented` and `tested` count the \
             requirements some code or some test names (docs/spec-domain-model.md, \"From \
             requirement to code and test\").",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(
            "project_id",
            true,
            "The project whose requirements to trace",
        )
        .handler(list_requirement_trace)
        .json_response_with_schema::<RequirementTraceListDto>(openapi, StatusCode::OK, "The traces")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/spec-model/related")
        .operation_id("studio_documents.list_related_requirements")
        .summary(
            "Requirements of other projects that say the same as this project's, or the opposite",
        )
        .description(
            "Compares every requirement this project's documents define with those of the \
             organization's other projects the caller can read (at most 40 a call): pairs that \
             share most of their meaningful words, as `same` or `overlap`, and `opposite` where \
             one negates what the other requires. Candidates for a person to read, never a \
             verdict: nothing is stored or raised (docs/spec-domain-model.md, \"Across \
             projects\").",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param(
            "project_id",
            true,
            "The project whose requirements to compare",
        )
        .handler(list_related_requirements)
        .json_response_with_schema::<RelatedRequirementListDto>(
            openapi,
            StatusCode::OK,
            "The pairs",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/spec-model/requirements")
        .operation_id("studio_documents.list_spec_model_requirements")
        .summary("The requirements a project's documents define, and what each rests on")
        .description(
            "Every identifier a project's documents define with a label (`**ID**: `x``), with \
             its statement, heading, priority and checkbox, and the basis its own block states: \
             `cited` (a link, an ADR, an issue or pull request, another document's identifier, \
             a labelled source), `reasoned` (a rationale and no citation), `assumption` or \
             `open_question` (the words that make it so are in `because`), or `stated` (nothing \
             about where it comes from). Read as written, computed on every call and never \
             stored; no finding is raised. `work` counts the synced issues, pull requests and \
             commits that name the identifier (docs/spec-domain-model.md).",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project whose requirements to read")
        .handler(list_spec_requirements)
        .json_response_with_schema::<SpecRequirementListDto>(
            openapi,
            StatusCode::OK,
            "The requirements",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/spec-model/work")
        .operation_id("studio_documents.list_spec_model_work")
        .summary("Which issues, pull requests and commits name what the documents define")
        .description(
            "Every identifier a project's documents define with a label (`**ID**: `x``: a \
             requirement, a component, a decision), with the synced issues, pull requests and \
             commits whose title or text names it as a whole token. Mechanical: no model \
             proposes a link (docs/project-and-product.md, \"The links\"). `unlinked` counts the \
             work that names none; `synced` is false where nothing syncs work.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project whose work to link")
        .handler(list_work_links)
        .json_response_with_schema::<WorkLinkListDto>(openapi, StatusCode::OK, "The links")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
        .register(router, openapi);

    router = OperationBuilder::get("/studio-documents/v1/spec-model/findings")
        .operation_id("studio_documents.list_spec_model_findings")
        .summary("Where a project's documents disagree, or refer to what is not there")
        .description(
            "Read from the documents as they are written (docs/spec-domain-model.md). Today the              rules that need no model: a reference to an identifier, ADR, file or section the              project does not have (`reference.dangling`), and an ADR number two of the              project's ADR sets share, cited without a link from outside both              (`reference.ambiguous`). Every finding quotes each side, and its `fingerprint`              survives the lines moving. The list is read whole.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project whose documents to check")
        .handler(list_spec_model_findings)
        .json_response_with_schema::<SpecModelFindingListDto>(openapi, StatusCode::OK, "The findings")
        .error_400(openapi)
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
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
        "Hands the named bindings to Spec Quality as one background run. The          request carries binding ids, NOT text: the server reads the documents          from the checkout a sync left on disk, which is where they already are.          The one exception is `documents`: texts the server cannot have, such as          an editor's unsaved buffer, each analysed under its own `path` and          replacing the named binding at the same path. At most 20 of them, 256 KiB          each and 1 MiB together; more is a 400.          `bloat` and `traceability` judge a set and become one analysis over all          of them; `purpose` and `leak` judge a document and become one each.          Which bindings deserve a detector is the caller's decision and is not          made here. Answers 202 with the `run_id`; follow the run at the returned          `poll`. Send an `Idempotency-Key` header to make a retry of this request          safe: a repeat with the same key answers the same run.          The run RECORDS each document's result itself as it finishes: a          `spec_finding` node per detector per document, whose `details.findings`          are the findings placed in the text, and the gate verdict a stage reads.          A caller does not write them back, and should not: a second write          without `details.findings` would replace the one the run made.",
    )
    .tag("StudioDocuments")
    .authenticated()
    .require_license_features::<License>([])
    .path_param("workspace_id", "Workspace tenant id")
    .path_param("project_id", "Project tenant id")
    .path_param("detector", "purpose | leak | bloat | traceability")
    .param(crate::idempotency::param())
    .json_request::<AnalyzeBindingsRequest>(openapi, "Bindings to analyse")
    .handler(analyze_project_documents)
    .json_response_with_schema::<AnalyzeEnqueuedDto>(
        openapi,
        StatusCode::ACCEPTED,
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
        .json_response_with_schema::<DocumentDto>(openapi, StatusCode::CREATED, "Created document")
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
    .json_response_with_schema::<DocumentDto>(openapi, StatusCode::CREATED, "Created document")
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
             with it — its gate verdicts and its `spec_finding` nodes in the \
             artifact graph. The verdicts go first: when they cannot be removed \
             the document is kept and the answer is 503, so a retry finishes the \
             job rather than leaving verdicts nothing lists.",
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
            .error_503(openapi)
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

    router = OperationBuilder::get("/studio-documents/v1/document-bindings/{id}/text")
        .operation_id("studio_documents.get_binding_text")
        .summary("Read a bound repository file's text")
        .description(
            "The current text of the file a binding names, from the checkout the Spec \
         Quality detectors read: the session's when there is one, else the sync's clone. \
         A spec-rows repository row's `id` is its binding id, and `project_id` is the \
         project the Specs list was read for. Not found when there is no such binding in \
         that project or no checkout holds the file yet; unavailable when this deployment \
         keeps no checkout to read from.",
        )
        .tag("StudioDocuments")
        .authenticated()
        .require_license_features::<License>([])
        .path_param("id", "Binding id")
        .query_param(
            "project_id",
            true,
            "The project whose Specs list the binding is on",
        )
        .handler(get_binding_text)
        .json_response_with_schema::<BindingTextDto>(openapi, StatusCode::OK, "File text")
        .error_401(openapi)
        .error_403(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .error_503(openapi)
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
    .query_param(
        "path",
        false,
        "Only the bindings at this repository path; repeat for several. With \
         it the answer is every match, unpaged — a path names one file per \
         repository — and `offset`/`limit` are ignored.",
    )
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

    /// The review kinds this gear publishes are the ones the events catalogue
    /// lists, no more and no fewer.
    #[test]
    fn the_review_kinds_are_the_ones_the_catalogue_lists() {
        for event in ReviewEvent::ALL {
            // A new variant stops compiling here until it is in `ALL`.
            match event {
                ReviewEvent::Created | ReviewEvent::Decided | ReviewEvent::Cancelled => {}
            }
        }
        let published: std::collections::BTreeSet<String> = ReviewEvent::ALL
            .into_iter()
            .map(|event| event.kind().to_string())
            .collect();
        assert_eq!(
            published,
            crate::api_contract::events::documented_kinds("review_request."),
            "docs/events-catalog.md and studio-documents disagree on the `review_request.*` kinds"
        );
    }

    #[test]
    fn a_review_state_fits_only_what_its_key_names() {
        assert!(review_state_fits("0123456789abcdef", "accepted"));
        assert!(review_state_fits("hyp:0123456789abcdef", "check"));
        assert!(review_state_fits("pri:cpt-a-fr-search", "scored"));
        assert!(review_state_fits("prc:2026-10-19T08:00:00Z", "confirmed"));
        assert!(review_state_fits("pri:cpt-a-fr-search", "proposed"));
        assert!(!review_state_fits("pri:cpt-a-fr-search", "accepted"));
        assert!(!review_state_fits("hyp:0123456789abcdef", "supports"));
        assert!(!review_state_fits("0123456789abcdef", "scored"));
        assert_eq!(review_note_max("hyp:0123456789abcdef"), 8000);
        assert_eq!(review_note_max("pri:cpt-a"), 2000);
    }

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
