//! Domain model for studio-documents.
//!
//! A **document type** couples a stable key to a template: a markdown skeleton,
//! an ordered checklist of sections, and the structural rules that decide
//! whether a document conforms. Types are either platform **built-ins** (the
//! KIT artifact chain, seeded here) or **workspace-defined** (owned by a
//! workspace tenant and inherited by its projects). A **document** is an
//! instance of a type, owned by a workspace or project tenant.

use serde::{Deserialize, Serialize};

use super::validate::ValidationReport;
use uuid::Uuid;

/// Who owns a document type, in the order the levels overlay:
/// `Builtin -> Organization -> Workspace`, then inherited by every project
/// under the workspace. A lower level replacing a key replaces the whole
/// entry (ADR-0014 section 4).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Owner {
    /// Platform catalogue — available everywhere, not editable per tenant
    /// (a workspace may *override* by defining a type with the same key).
    Builtin,
    /// Owned by one organization tenant; inherited by every workspace under it.
    Organization { tenant_id: Uuid },
    /// Owned by one workspace tenant; inherited by that workspace's projects.
    Workspace { tenant_id: Uuid },
}

/// A catalogue entry: something a tenant may publish, override or hide.
///
/// Document types and stages are different shapes with identical resolution
/// rules (ADR-0014 section 4), so the rules live once, in `overlay`, and each
/// shape only has to say what its key is and whether it is a tombstone.
pub trait CatalogEntry: Clone {
    fn key(&self) -> &str;
    fn is_hidden(&self) -> bool;
}

/// One stage of the journey a project passes through.
///
/// This catalogue used to be a constant in two frontends (`JOURNEY_STAGES` in
/// `projects-mfe/src/model/project.ts` and in the prototype), left there when
/// the `studio-project` gear was retired and `GET /studio-project/v1/stages`
/// went with it -- see ADR-0010. It is the path a product takes through the
/// studio, so it is the last thing that should be unreachable from an API.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stage {
    /// Slug, unique within its owner scope (`intent`, `prd`, ...).
    pub key: String,
    /// What a screen renders. Not derived from the key: the retired gear served
    /// `PRD-Spec` for `prd_spec` and `BRD` for `brd`, and no casing rule gets
    /// there from the slug.
    pub label: String,
    /// A required stage cannot be dropped from a project's selection.
    #[serde(default)]
    pub required: bool,
    /// Position in the catalogue. Stages are a sequence, so the order is data
    /// rather than the order rows happen to come back in; ties fall back to the
    /// key so a listing is never arbitrary.
    #[serde(default)]
    pub position: i32,
    /// Detectors every required document must pass before the stage is complete.
    ///
    /// Empty means structure is enough. A stage that lists `bloat` will not be
    /// complete until a bloat verdict exists and says `passed` -- which is the
    /// gate between "we wrote the documents" and "the documents are good enough
    /// to build from".
    #[serde(default)]
    pub gates: Vec<Detector>,
    /// Keys of the document types this stage is not complete without.
    ///
    /// The `rel.requires` edge of ADR-0014 section 5, carried as data until the
    /// graph projection exists to hold it as an edge. A key that no longer
    /// resolves is kept rather than dropped -- a stage that references a type
    /// the workspace hid is a real condition worth reporting, not a
    /// typo to swallow.
    #[serde(default)]
    pub requires: Vec<String>,
    pub owner: Owner,
    /// A tombstone, exactly as on a document type.
    #[serde(default)]
    pub hidden: bool,
}

impl CatalogEntry for Stage {
    fn key(&self) -> &str {
        &self.key
    }
    fn is_hidden(&self) -> bool {
        self.hidden
    }
}

/// The platform's journey catalogue.
///
/// Positions are spaced by ten so an organization can insert between two
/// built-ins without renumbering anything it does not own.
pub fn builtin_stages() -> Vec<Stage> {
    [
        ("intent", "Intent", true),
        ("brd", "BRD", false),
        ("prd", "PRD", false),
        ("prd_spec", "PRD-Spec", false),
        ("architecture", "Architecture", false),
        ("ui_design", "UI Design", false),
        ("user_stories", "User Stories", false),
        ("testing", "Testing", false),
    ]
    .into_iter()
    .enumerate()
    .map(|(i, (key, label, required))| Stage {
        key: key.to_string(),
        label: label.to_string(),
        required,
        position: (i as i32 + 1) * 10,
        requires: Vec::new(),
        gates: Vec::new(),
        owner: Owner::Builtin,
        hidden: false,
    })
    .collect()
}

/// One capability a product may need, and the words that find components
/// providing it.
///
/// A questionnaire answer seeds a capability (`Question::capability`), and the
/// composer turns capabilities into candidate components. Until now the
/// vocabulary was prose on one side and a hardcoded keyword table in a UI file
/// on the other (`CAP_KEYWORDS` in the prototype), so a workspace that invented
/// a capability got zero candidates and no explanation. Making it a catalogue
/// entry puts both halves in the same place, under the same three-level
/// ownership as everything else (ADR-0014 sections 4 and 5).
///
/// `terms` is lexical on purpose for now. The component catalogue already
/// computes embeddings, and matching should end up there -- but a term list is
/// explainable ("matched because the component mentions `keycloak`"), which a
/// vector score is not, and the two can coexist.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capability {
    /// Slug, as written in a question's `capability` field (`auth`, `storage`).
    pub key: String,
    pub label: String,
    /// Words that make a component a candidate. Empty means "match the key
    /// itself", which is what the prototype fell back to.
    #[serde(default)]
    pub terms: Vec<String>,
    pub owner: Owner,
    #[serde(default)]
    pub hidden: bool,
}

impl CatalogEntry for Capability {
    fn key(&self) -> &str {
        &self.key
    }
    fn is_hidden(&self) -> bool {
        self.hidden
    }
}

/// The platform's capability vocabulary.
///
/// Seeded from the prototype's `CAP_KEYWORDS`, with one addition it was missing:
/// `domain`. The App Spec questionnaire's first question seeds it
/// (`app_spec_type`), so every App Spec produced a capability the matcher had
/// never heard of and silently scored against its own name.
pub fn builtin_capabilities() -> Vec<Capability> {
    [
        (
            "domain",
            "Domain",
            &["domain", "model", "entity", "ontology", "knowledge"][..],
        ),
        (
            "tenancy",
            "Tenancy",
            &[
                "tenant",
                "tenancy",
                "account",
                "organization",
                "org",
                "resource group",
            ][..],
        ),
        (
            "auth",
            "Authentication",
            &[
                "auth",
                "authn",
                "identity",
                "idp",
                "oidc",
                "keycloak",
                "login",
                "session",
                "credential",
            ][..],
        ),
        (
            "authz",
            "Authorization",
            &[
                "authz",
                "authorization",
                "permission",
                "rbac",
                "policy",
                "access",
                "role",
            ][..],
        ),
        (
            "storage",
            "Data & Storage",
            &[
                "storage", "graph", "postgres", "database", "file", "object", "search", "node",
            ][..],
        ),
        (
            "connectors",
            "Connectors",
            &[
                "connector",
                "github",
                "gitlab",
                "bitbucket",
                "integration",
                "source",
            ][..],
        ),
        (
            "facade",
            "Facade",
            &[
                "connector",
                "proxy",
                "gateway",
                "adapter",
                "facade",
                "wrapper",
                "oagw",
                "egress",
            ][..],
        ),
        (
            "billing",
            "Billing",
            &[
                "billing",
                "payment",
                "invoice",
                "metering",
                "subscription",
                "usage",
            ][..],
        ),
        (
            "compliance",
            "Compliance",
            &[
                "audit",
                "compliance",
                "gdpr",
                "secret",
                "credstore",
                "policy",
            ][..],
        ),
        (
            "deploy",
            "Deployment",
            &["deploy", "gitops", "helm", "k8s", "kubernetes", "bootstrap"][..],
        ),
    ]
    .into_iter()
    .map(|(key, label, terms)| Capability {
        key: key.to_string(),
        label: label.to_string(),
        terms: terms.iter().map(|t| (*t).to_string()).collect(),
        owner: Owner::Builtin,
        hidden: false,
    })
    .collect()
}

/// One expected section of a document, as a checklist item.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Section {
    /// Stable key, used by the UI checklist and validation report.
    pub key: String,
    /// The heading text expected in the document (matched case-insensitively).
    pub title: String,
    /// A missing required section fails conformance; an optional one only warns.
    #[serde(default = "default_true")]
    pub required: bool,
    /// Minimum word count for the section body, when set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_words: Option<usize>,
    /// Short guidance shown in the editor for this section.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

fn default_true() -> bool {
    true
}

/// Structural conformance rules (v1). Deliberately structural — presence,
/// front-matter, length, placeholders — not semantic. Everything here is cheap
/// and has no false positives on a genuinely-filled document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rules {
    /// Required required-section presence is always checked; this toggles
    /// whether *unexpected* top-level headings are reported as a warning.
    #[serde(default)]
    pub warn_unknown_sections: bool,
    /// Front-matter keys (YAML `--- ... ---` block) that must be present and
    /// non-empty, e.g. `status`, `owner`.
    #[serde(default)]
    pub front_matter: Vec<String>,
    /// Reject leftover template markers: `TODO`, `TBD`, `{{...}}`, `<...>`.
    #[serde(default = "default_true")]
    pub forbid_placeholders: bool,
    /// The document title (first `# ` heading or front-matter `title`) must
    /// have at least this many words.
    #[serde(default)]
    pub min_title_words: usize,
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            warn_unknown_sections: false,
            front_matter: Vec::new(),
            forbid_placeholders: true,
            min_title_words: 1,
        }
    }
}

/// How a questionnaire answer is captured in the UI.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionKind {
    /// One-line free text.
    Text,
    /// Multi-line free text.
    LongText,
    /// Yes / no.
    Bool,
    /// Pick exactly one option.
    Single,
    /// Pick any number of options.
    Multi,
}

fn default_question_kind() -> QuestionKind {
    QuestionKind::Text
}

/// One question of a type's intake questionnaire. Answering the questionnaire is
/// how a document of this type is produced: each answer both seeds a capability
/// (for the Composer) and is written into a section of the generated document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Question {
    /// Stable id, used to key the answer.
    pub id: String,
    /// The question shown to the person.
    pub prompt: String,
    #[serde(default = "default_question_kind")]
    pub kind: QuestionKind,
    /// Options for `single` / `multi`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(default)]
    pub required: bool,
    /// Capability tag this answer seeds for the Composer (free-form, e.g.
    /// `tenancy`, `auth`, `billing`). Answers with a tag feed gear matching.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability: Option<String>,
    /// Section key (in this type's checklist) the answer is written under when
    /// the document is generated from the questionnaire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    /// Short helper text shown under the question.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
}

/// A template: the starting body plus the checklist and rules it is judged by.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateSpec {
    /// Markdown skeleton a new document is seeded from.
    pub body: String,
    /// Ordered section checklist.
    pub sections: Vec<Section>,
    /// Conformance rules.
    #[serde(default)]
    pub rules: Rules,
    /// Optional intake questionnaire. When present, a document of this type is
    /// produced by answering it rather than editing the skeleton by hand.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub questionnaire: Vec<Question>,
}

/// The four detectors `studio-spec-quality` exposes.
///
/// Kept as an open string rather than an enum: the upstream owns the list, and a
/// gear that refuses to record a detector the service has just added would be
/// worse than one that records a name it does not recognise.
pub type Detector = String;

/// Where a submitted analysis got to.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisState {
    /// Submitted upstream, no verdict yet.
    Pending,
    Passed,
    Failed,
}

impl AnalysisState {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "passed" => Some(Self::Passed),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Passed => "passed",
            Self::Failed => "failed",
        }
    }
}

/// One detector's verdict on one document.
///
/// `studio-spec-quality` is a stateless passthrough -- the caller submits, the
/// caller polls, and nothing kept the answer. So "the documentation passed
/// analysis" could not be said in data, and no stage could depend on it. This is
/// the record that makes it sayable; the gear does not run the analysis, it
/// remembers what the analysis said.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Analysis {
    pub document_id: Uuid,
    pub detector: Detector,
    pub state: AnalysisState,
    /// The upstream task this verdict came from, so a disputed result can be
    /// traced back to the run that produced it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// What the detector said, in one line, for a screen.
    #[serde(default)]
    pub summary: String,
    pub updated_at: String,
}

/// Whether a stage's conditions are met, and which of them are not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageStatus {
    pub key: String,
    pub label: String,
    pub required: bool,
    /// Every required document type is present, conforming, and has no failing
    /// or missing analysis.
    pub complete: bool,
    /// One entry per document type the stage requires.
    pub requirements: Vec<Requirement>,
}

/// One document type a stage asks for, and how the project stands against it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requirement {
    pub type_key: String,
    /// A document of this type exists in the project.
    pub present: bool,
    /// It passes its type's structural check.
    pub conforms: bool,
    /// Detectors that have not passed: missing, pending or failed. Empty means
    /// every analysis that ran said yes -- and, when no analysis was ever asked
    /// for, that nothing is outstanding, because a stage that required one would
    /// have to say so.
    pub analyses_outstanding: Vec<Detector>,
}

/// A document type registered in the platform (its `gts_type_id` is registered
/// in the types-registry) with its template.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentType {
    /// Slug, unique within its owner scope (`prd`, `adr`, `design`, …).
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Stable GTS id registered in the types-registry.
    pub gts_type_id: String,
    pub owner: Owner,
    pub template: TemplateSpec,
    /// A tombstone: this entry removes the key it overrides from the effective
    /// catalogue instead of replacing it.
    ///
    /// Hiding is an override rather than a DELETE because the levels below are
    /// not ours to erase - a built-in lives in code and an organization's entry
    /// belongs to the organization. "We do not use this" has to be recorded at
    /// the level that decided it, and stay reversible (ADR-0014 section 4). One
    /// mechanism then covers both "change this" and "drop this", so resolution
    /// keeps a single rule.
    #[serde(default)]
    pub hidden: bool,
}

impl CatalogEntry for DocumentType {
    fn key(&self) -> &str {
        &self.key
    }
    fn is_hidden(&self) -> bool {
        self.hidden
    }
}

/// A document's position on the forward-only status ladder.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocStatus {
    Draft,
    Review,
    Approved,
}

impl DocStatus {
    /// Ladder rank; a document may only move to an equal-or-higher rank.
    pub fn rank(self) -> u8 {
        match self {
            DocStatus::Draft => 0,
            DocStatus::Review => 1,
            DocStatus::Approved => 2,
        }
    }

    /// Whether a transition to `next` is allowed (never moves backward).
    pub fn can_move_to(self, next: DocStatus) -> bool {
        next.rank() >= self.rank()
    }
}

/// A document instance.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Document {
    pub id: Uuid,
    /// Scope tenant — always the **workspace**. A project-level document keeps
    /// the same tenant and distinguishes itself with `project_id`, so the
    /// storage scope stays single-tenant and inheritance is a column filter.
    pub tenant_id: Uuid,
    /// `None` = workspace-level (inherited by every project under it); else the
    /// owning project tenant id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Uuid>,
    /// The document type key this instance was created from.
    pub type_key: String,
    pub title: String,
    /// Markdown content.
    pub content: String,
    pub status: DocStatus,
    /// Result of the last validation run (structural conformance).
    pub conforms: bool,
    /// Capability keys this document declares, read from its front matter. The
    /// questionnaire seeds them; a hand-edited document re-declares them.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Subject id of the creator (as a string principal).
    pub created_by: String,
    /// RFC 3339 UTC timestamps.
    pub created_at: String,
    pub updated_at: String,
}

// ── Ingested documents ──────────────────────────────────────────────────────
// A document written in Studio knows its type. A document that already existed
// in a repository does not, and its content stays where ingest put it — the
// artifact graph. A **binding** is the thin record that joins the two: which
// graph node, which type, how we decided, and whether it conforms. The content
// is never copied here, so a re-sync cannot leave two versions of one file.

/// How a binding's type was decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DetectionSource {
    /// The document declared it in its front matter.
    FrontMatter,
    /// Our offline scoring proposed it (sections, path, title, front matter).
    Heuristic,
    /// The external Spec Quality `purpose` detector proposed it.
    SpecQuality,
    /// A person chose it.
    Manual,
}

impl DetectionSource {
    pub fn as_str(self) -> &'static str {
        match self {
            DetectionSource::FrontMatter => "front_matter",
            DetectionSource::Heuristic => "heuristic",
            DetectionSource::SpecQuality => "spec_quality",
            DetectionSource::Manual => "manual",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "front_matter" => Some(DetectionSource::FrontMatter),
            "heuristic" => Some(DetectionSource::Heuristic),
            "spec_quality" => Some(DetectionSource::SpecQuality),
            "manual" => Some(DetectionSource::Manual),
            _ => None,
        }
    }
}

/// Where a binding stands on the question "do we know what this file is?".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingState {
    /// A type was proposed; nobody has looked at it yet.
    Detected,
    /// A person accepted the proposal.
    Confirmed,
    /// A person chose the type themselves, proposal or not.
    Manual,
    /// Nothing scored well enough — this one needs a person.
    Unknown,
    /// A person said this file is not a document at all; stop proposing types
    /// for it and leave it out of the queue.
    NotADocument,
}

impl BindingState {
    pub fn as_str(self) -> &'static str {
        match self {
            BindingState::Detected => "detected",
            BindingState::Confirmed => "confirmed",
            BindingState::Manual => "manual",
            BindingState::Unknown => "unknown",
            BindingState::NotADocument => "not_a_document",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "detected" => Some(BindingState::Detected),
            "confirmed" => Some(BindingState::Confirmed),
            "manual" => Some(BindingState::Manual),
            "unknown" => Some(BindingState::Unknown),
            "not_a_document" => Some(BindingState::NotADocument),
            _ => None,
        }
    }

    /// Whether a person has ruled on this binding. A settled binding is never
    /// overwritten by a re-run of the classifier.
    pub fn is_settled(self) -> bool {
        matches!(
            self,
            BindingState::Confirmed | BindingState::Manual | BindingState::NotADocument
        )
    }
}

/// One type the classifier considered, with its score and the reason for it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TypeCandidate {
    pub type_key: String,
    /// 0.0–1.0.
    pub confidence: f32,
    /// Why this type scored what it did, in words, for the person deciding.
    pub why: String,
}

/// An ingested file bound to a document type (or knowingly not bound yet).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DocumentBinding {
    pub id: Uuid,
    /// Workspace tenant — the same scope documents use.
    pub tenant_id: Uuid,
    /// Owning project, or `None` for a workspace-level binding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<Uuid>,
    /// Instance id of the `gts.cf.studio.artifact.file` node holding the bytes.
    pub node_id: String,
    /// Repository path, kept here so the queue can be read without the graph.
    pub path: String,
    /// The bound type, or `None` while undetermined.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_key: Option<String>,
    pub state: BindingState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<DetectionSource>,
    /// What else it might be — what a person picks from when correcting.
    #[serde(default)]
    pub candidates: Vec<TypeCandidate>,
    /// Conformance from the last validation, or `None` if never validated
    /// (an unbound document has no template to be judged against).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conforms: Option<bool>,
    /// The last validation in full — what is missing, not just whether
    /// anything is. `None` alongside `conforms`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation: Option<ValidationReport>,
    /// Digest of the content last classified/validated, so the caller can tell
    /// a stale verdict from a current one after a re-sync.
    pub content_sha: String,
    pub created_at: String,
    pub updated_at: String,
}

// ── Built-in catalogue ──────────────────────────────────────────────────────
// Seeded from the Constructor Studio KIT artifact chain
// (UPSTREAM_REQS → PRD → ADR + DESIGN → DECOMPOSITION → FEATURE). A workspace
// may override any of these by defining a type with the same key.

/// The GTS type every catalogue entry is an instance of.
///
/// Deliberately one id for all of them. A catalogue key used to mint its own
/// type (`gts.cf.studio.doc.{key}.v1~`), which was wrong three ways and is
/// retired by ADR-0014 §2: the types-registry is not tenant-scoped, so two
/// workspaces defining `vision` collided on one id; a registered schema is
/// immutable, so an organization editing its own template would be performing a
/// schema migration; and a registration refused at boot takes down a pod rather
/// than the request that caused it. A key is an instance, not a type.
pub use super::gts::DOCUMENT_TYPE as TYPE_GTS_ID;

fn builtin(
    key: &str,
    name: &str,
    description: &str,
    body: &str,
    sections: Vec<Section>,
    rules: Rules,
) -> DocumentType {
    DocumentType {
        key: key.to_string(),
        name: name.to_string(),
        description: description.to_string(),
        gts_type_id: TYPE_GTS_ID.to_string(),
        owner: Owner::Builtin,
        hidden: false,
        template: TemplateSpec {
            body: body.to_string(),
            sections,
            rules,
            questionnaire: Vec::new(),
        },
    }
}

fn sec(key: &str, title: &str, required: bool, min_words: Option<usize>) -> Section {
    Section {
        key: key.to_string(),
        title: title.to_string(),
        required,
        min_words,
        description: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn q(
    id: &str,
    prompt: &str,
    kind: QuestionKind,
    options: &[&str],
    required: bool,
    capability: Option<&str>,
    section: &str,
    help: Option<&str>,
) -> Question {
    Question {
        id: id.to_string(),
        prompt: prompt.to_string(),
        kind,
        options: options.iter().map(|s| s.to_string()).collect(),
        required,
        capability: capability.map(str::to_string),
        section: Some(section.to_string()),
        help: help.map(str::to_string),
    }
}

/// The App Spec type: requirements intake for a new application. Unlike the KIT
/// chain it is filled by answering a questionnaire, and each answer both seeds a
/// capability for the Composer and lands in a section of the generated document.
fn app_spec_type() -> DocumentType {
    DocumentType {
        key: "app_spec".to_string(),
        name: "App Spec".to_string(),
        description:
            "Requirements intake for a new app — answered as a questionnaire, then composed from gears."
                .to_string(),
        gts_type_id: TYPE_GTS_ID.to_string(),
        owner: Owner::Builtin,
        hidden: false,
        template: TemplateSpec {
            body: "---\nstatus: draft\nowner: \n---\n\n# App Spec — <title>\n\n## Overview\n\n## Users & Tenancy\n\n## Authentication & Authorization\n\n## Data & Storage\n\n## Integrations & External Systems\n\n## Billing\n\n## Compliance\n\n## Deployment\n".to_string(),
            sections: vec![
                sec("overview", "Overview", true, Some(15)),
                sec("users_tenancy", "Users & Tenancy", true, None),
                sec("auth", "Authentication & Authorization", true, None),
                sec("data", "Data & Storage", true, None),
                sec("integrations", "Integrations & External Systems", false, None),
                sec("billing", "Billing", false, None),
                sec("compliance", "Compliance", false, None),
                sec("deployment", "Deployment", true, None),
            ],
            rules: Rules {
                front_matter: vec!["status".into()],
                ..Rules::default()
            },
            questionnaire: vec![
                q("product", "What are we building? Describe the product and its core domain.", QuestionKind::LongText, &[], true, Some("domain"), "overview", None),
                q("primary_users", "Who are the primary users?", QuestionKind::Text, &[], true, None, "users_tenancy", None),
                q("tenancy", "What is the tenancy model?", QuestionKind::Single, &["Single-tenant", "Multi-tenant", "Hierarchical tenants"], true, Some("tenancy"), "users_tenancy", None),
                q("auth", "How do users authenticate?", QuestionKind::Single, &["None", "Username & password", "SSO / OIDC (Keycloak)", "External IdP"], true, Some("auth"), "auth", None),
                q("rbac", "Do you need roles and access control (RBAC)?", QuestionKind::Bool, &[], false, Some("authz"), "auth", None),
                q("storage", "What data does the app store?", QuestionKind::Multi, &["Relational (Postgres)", "Documents / graph", "Files / blobs", "Full-text search"], true, Some("storage"), "data", None),
                q("integrations", "Which external systems do you integrate with or wrap?", QuestionKind::LongText, &[], false, Some("connectors"), "integrations", Some("e.g. GitHub, GitLab, Salesforce, Stripe")),
                q("facade", "Is part of the product a facade over an existing system?", QuestionKind::Bool, &[], false, Some("facade"), "integrations", None),
                q("billing", "Do you need billing or metering?", QuestionKind::Bool, &[], false, Some("billing"), "billing", None),
                q("compliance", "Any compliance requirements?", QuestionKind::Multi, &["GDPR", "SOC 2", "HIPAA", "None"], false, Some("compliance"), "compliance", None),
                q("deploy", "Target deployment?", QuestionKind::Single, &["Docker Compose", "Kubernetes", "Managed cloud"], true, Some("deploy"), "deployment", None),
            ],
        },
    }
}

/// The platform document-type catalogue.
pub fn builtin_types() -> Vec<DocumentType> {
    vec![
        builtin(
            "upstream_reqs",
            "Upstream Requirements",
            "Raw stakeholder needs and constraints feeding the PRD.",
            "---\nstatus: draft\nowner: \n---\n\n# Upstream Requirements — <title>\n\n## Context\n\n## Stakeholders\n\n## Needs\n\n## Constraints\n\n## Out of Scope\n",
            vec![
                sec("context", "Context", true, Some(20)),
                sec("stakeholders", "Stakeholders", true, None),
                sec("needs", "Needs", true, Some(20)),
                sec("constraints", "Constraints", false, None),
                sec("out_of_scope", "Out of Scope", false, None),
            ],
            Rules {
                front_matter: vec!["status".into(), "owner".into()],
                ..Rules::default()
            },
        ),
        builtin(
            "prd",
            "Product Requirements (PRD)",
            "What we are building and why, and how we will know it works.",
            "---\nstatus: draft\nowner: \n---\n\n# PRD — <title>\n\n## Problem\n\n## Goals\n\n## Non-Goals\n\n## Users & Use Cases\n\n## Requirements\n\n## Success Metrics\n",
            vec![
                sec("problem", "Problem", true, Some(30)),
                sec("goals", "Goals", true, Some(15)),
                sec("non_goals", "Non-Goals", true, None),
                sec("users", "Users & Use Cases", true, Some(20)),
                sec("requirements", "Requirements", true, Some(30)),
                sec("success_metrics", "Success Metrics", true, Some(10)),
            ],
            Rules {
                front_matter: vec!["status".into(), "owner".into()],
                min_title_words: 1,
                ..Rules::default()
            },
        ),
        builtin(
            "adr",
            "Architecture Decision Record",
            "One decision, its context, and its consequences.",
            "---\nstatus: proposed\n---\n\n# ADR — <decision title>\n\n## Status\n\n## Context\n\n## Decision\n\n## Consequences\n\n## Alternatives Considered\n",
            vec![
                sec("status", "Status", true, None),
                sec("context", "Context", true, Some(30)),
                sec("decision", "Decision", true, Some(20)),
                sec("consequences", "Consequences", true, Some(20)),
                sec("alternatives", "Alternatives Considered", false, None),
            ],
            Rules {
                front_matter: vec!["status".into()],
                ..Rules::default()
            },
        ),
        builtin(
            "design",
            "Design Document",
            "How the thing is built: components, interactions, trade-offs.",
            "---\nstatus: draft\nowner: \n---\n\n# Design — <title>\n\n## Overview\n\n## Architecture\n\n## Data Model\n\n## Interfaces\n\n## Trade-offs\n\n## Risks\n",
            vec![
                sec("overview", "Overview", true, Some(30)),
                sec("architecture", "Architecture", true, Some(40)),
                sec("data_model", "Data Model", true, None),
                sec("interfaces", "Interfaces", true, None),
                sec("trade_offs", "Trade-offs", true, Some(20)),
                sec("risks", "Risks", false, None),
            ],
            Rules {
                front_matter: vec!["status".into()],
                ..Rules::default()
            },
        ),
        builtin(
            "decomposition",
            "Decomposition",
            "Breaking the design into features and work items.",
            "---\nstatus: draft\n---\n\n# Decomposition — <title>\n\n## Approach\n\n## Features\n\n## Sequencing\n\n## Open Questions\n",
            vec![
                sec("approach", "Approach", true, Some(20)),
                sec("features", "Features", true, Some(20)),
                sec("sequencing", "Sequencing", true, None),
                sec("open_questions", "Open Questions", false, None),
            ],
            Rules::default(),
        ),
        builtin(
            "feature",
            "Feature Spec",
            "One shippable feature: behaviour, acceptance, and edges.",
            "---\nstatus: draft\nowner: \n---\n\n# Feature — <title>\n\n## Summary\n\n## Behaviour\n\n## Acceptance Criteria\n\n## Edge Cases\n\n## Rollout\n",
            vec![
                sec("summary", "Summary", true, Some(15)),
                sec("behaviour", "Behaviour", true, Some(25)),
                sec("acceptance", "Acceptance Criteria", true, Some(15)),
                sec("edge_cases", "Edge Cases", false, None),
                sec("rollout", "Rollout", false, None),
            ],
            Rules {
                front_matter: vec!["status".into(), "owner".into()],
                ..Rules::default()
            },
        ),
        app_spec_type(),
    ]
}
