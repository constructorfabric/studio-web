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
///
/// `contracts` comes before `terms` in matching (`cpt-studio-fr-spec-gear-mapping`).
/// A gear that the engine reports as providing one of them is a contract match.
/// The terms only find evidence in a gear's prose, which is ranked below every
/// contract match.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capability {
    /// Slug, as written in a question's `capability` field (`auth`, `storage`).
    pub key: String,
    pub label: String,
    /// Words that make a component a candidate. Empty means "match the key
    /// itself", which is what the prototype fell back to.
    #[serde(default)]
    pub terms: Vec<String>,
    /// What the Gearbox engine can report a gear as providing, any of which
    /// satisfies this capability. Each entry is one of:
    /// - a contract id without its version (`authz-resolver/AuthZResolverApi`);
    /// - a contract id with its version (`authz-resolver/AuthZResolverApi@v1`);
    /// - a GTS extension-point segment (`cf.core.authn_resolver.plugin.v1~`).
    #[serde(default)]
    pub contracts: Vec<String>,
    /// Answered by where and how the product runs, not by what it is made
    /// of: the composer offers it no gears (`cpt-studio-fr-nfr-to-profile`).
    #[serde(default)]
    pub nonfunctional: bool,
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
/// `domain`. The PRD questionnaire's first question seeds it (`prd_type`), so
/// every intake document produced a capability the matcher had never heard of
/// and silently scored against its own name.
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
        contracts: builtin_contracts(key)
            .iter()
            .map(|c| (*c).to_string())
            .collect(),
        nonfunctional: key == "deploy",
        owner: Owner::Builtin,
        hidden: false,
    })
    .collect()
}

/// The contracts the platform's own extension points give a built-in key.
///
/// These are the `cf.core` and `cf.bss` plugin points of the platform's
/// toolkit, not the gears of any one product. A key with no engine-checked
/// contract gets none here, so its matches come from search. An organization
/// or workspace overrides these like any other field of the entry.
fn builtin_contracts(key: &str) -> &'static [&'static str] {
    match key {
        "tenancy" => &["cf.core.tenant_resolver.plugin.v1~"],
        "auth" => &[
            "cf.core.authn_resolver.plugin.v1~",
            "cf.core.idp.plugin.v1~",
        ],
        "authz" => &[
            "cf.core.authz_resolver.plugin.v1~",
            "authz-resolver/AuthZResolverApi",
        ],
        "billing" => &["cf.core.uc.plugin.v1~", "cf.bss.rate_provider.plugin.v1~"],
        "compliance" => &["cf.core.credstore.plugin.v1~"],
        _ => &[],
    }
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
    /// Other headings that count as this section. A document written against an
    /// older revision of the template (`## Context` where the template now says
    /// `## Context and Problem Statement`) is still the same kind of document,
    /// and a repository full of them should not stop being recognized because
    /// the template was improved.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
}

impl Section {
    /// The title followed by every alias — each heading this section answers to.
    pub fn titles(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.title.as_str()).chain(self.aliases.iter().map(String::as_str))
    }
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
    /// Semantic review criteria this entry states for itself. `None` means the
    /// built-in guide for the key, if there is one
    /// ([`super::review_guide::effective_guide`]); the built-ins leave it
    /// `None` and are served from the vendored kit files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<super::review_guide::ReviewGuide>,
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
    /// The Studio document this verdict is about, when it is about one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_id: Option<Uuid>,
    /// The bound repository file it is about, when it is about one of those.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_id: Option<Uuid>,
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
///
/// `ToSchema` for [`DetectionSource`]'s reason.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
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
    /// The non-functional statements its NFR, operational and deployment
    /// sections make ([`super::intake::declared_requirements`]).
    #[serde(default)]
    pub requirements: Vec<String>,
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
///
/// `ToSchema` so the API contract carries the values instead of describing
/// them in a sentence. It was `"front_matter" | "heuristic" | ..." on a
/// `String` field, which no client can generate from and nothing checks: a
/// frontend transcribed the sentence by hand, and adding a variant here left
/// that copy silently wrong.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
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
///
/// `ToSchema` for [`DetectionSource`]'s reason: the contract states the five
/// values rather than spelling them in prose beside a `String`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
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
    /// The capability keys the file's front matter declares. Read by the
    /// Composer for a bound file the same way it reads an authored document's.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// The file's non-functional statements, as for a document.
    #[serde(default)]
    pub requirements: Vec<String>,
    /// Digest of the content last classified/validated, so the caller can tell
    /// a stale verdict from a current one after a re-sync.
    pub content_sha: String,
    pub created_at: String,
    pub updated_at: String,
}

// ── Built-in catalogue ──────────────────────────────────────────────────────
// Seeded from the Constructor Studio KIT artifact chain
// (PRD → ADR + DESIGN → DECOMPOSITION → FEATURE, the five types Spec Quality
// analyses). The bodies in `templates/` are vendored verbatim from gears-rust
// `docs/spec-templates/gears-sdlc/<KIND>/template.md` — refresh them from there
// rather than editing them here. A workspace may override any of these by
// defining a type with the same key.

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
            review: None,
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
        aliases: Vec::new(),
    }
}

/// `sec` with the older headings that still count as this section.
fn sec_aka(
    key: &str,
    title: &str,
    required: bool,
    min_words: Option<usize>,
    aliases: &[&str],
) -> Section {
    Section {
        aliases: aliases.iter().map(|a| a.to_string()).collect(),
        ..sec(key, title, required, min_words)
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

/// The PRD: requirements intake for a new application, and the one type in this
/// catalogue that asks rather than only templating. Each answer both seeds a
/// capability for the Composer and lands in a section of the generated
/// document.
///
/// This was `app_spec`, a seventh type beside a PRD of its own, and two things
/// made that untenable. Spec Quality analyses five document types and
/// `app_spec` was not one of them, so the intake document — the first
/// thing a new project has — was the one document no detector would
/// look at. And the two types asked the same question in different words: what
/// are we building, for whom, on what. So there is one, it is called what the
/// rest of the industry calls it, and its sections are the App Spec's, because
/// those are the ones the questionnaire fills and the Composer reads.
fn prd_type() -> DocumentType {
    DocumentType {
        key: "prd".to_string(),
        name: "Product Requirements (PRD)".to_string(),
        description:
            "What we are building and for whom — answered as a questionnaire, then composed from gears."
                .to_string(),
        gts_type_id: TYPE_GTS_ID.to_string(),
        owner: Owner::Builtin,
        hidden: false,
        template: TemplateSpec {
            // The SDLC template, whichever way the document is started. Written
            // by hand, it is the skeleton; composed from the questionnaire, the
            // answers are written INTO it, each under the template section its
            // question names -- the questionnaire fills the PRD, it does not
            // replace it with a form of its own.
            //
            // The required five are how a PRD sitting in somebody's repository
            // is recognised at all -- `classify` scores a document against the
            // REQUIRED sections -- so each also answers to the heading of the
            // older Problem / Users / Non-Goals / Requirements / Success Metrics
            // shape, and a PRD written that way is still a PRD.
            //
            // So a document composed from the questionnaire starts out NOT
            // conforming: the intake settles what is being built and for whom,
            // and the rest of the template is still somebody's to write.
            body: concat!(
                "---\ntype: prd\nstatus: draft\nowner: \n---\n\n",
                include_str!("templates/prd.md")
            )
            .to_string(),
            sections: vec![
                sec_aka(
                    "overview",
                    "Overview",
                    true,
                    Some(30),
                    &["Problem", "Background / Problem Statement"],
                ),
                sec_aka("actors", "Actors", true, Some(10), &["Users & Use Cases"]),
                sec(
                    "operational_concept",
                    "Operational Concept & Environment",
                    false,
                    None,
                ),
                sec_aka("scope", "Scope", true, None, &["Non-Goals", "Out of Scope"]),
                sec_aka(
                    "functional_requirements",
                    "Functional Requirements",
                    true,
                    Some(30),
                    &["Requirements"],
                ),
                sec(
                    "non_functional_requirements",
                    "Non-Functional Requirements",
                    false,
                    None,
                ),
                sec(
                    "public_interfaces",
                    "Public Library Interfaces",
                    false,
                    None,
                ),
                sec("use_cases", "Use Cases", false, None),
                sec_aka(
                    "acceptance_criteria",
                    "Acceptance Criteria",
                    true,
                    Some(10),
                    &["Success Metrics"],
                ),
                sec("dependencies", "Dependencies", false, None),
                sec("assumptions", "Assumptions", false, None),
                sec("risks", "Risks", false, None),
                sec("open_questions", "Open Questions", false, None),
                sec("traceability", "Traceability", false, None),
            ],
            rules: Rules {
                // `status` only. An owner is a workflow fact nothing in the
                // questionnaire asks for, and a required field no route fills
                // is a permanent complaint rather than a check.
                front_matter: vec!["status".into()],
                min_title_words: 1,
                ..Rules::default()
            },
            questionnaire: vec![
                q("product", "What are we building? Describe the product and its core domain.", QuestionKind::LongText, &[], true, Some("domain"), "overview", None),
                q("primary_users", "Who are the primary users?", QuestionKind::Text, &[], true, None, "actors", None),
                q("tenancy", "What is the tenancy model?", QuestionKind::Single, &["Single-tenant", "Multi-tenant", "Hierarchical tenants"], true, Some("tenancy"), "actors", None),
                q("auth", "How do users authenticate?", QuestionKind::Single, &["None", "Username & password", "SSO / OIDC (Keycloak)", "External IdP"], true, Some("auth"), "functional_requirements", None),
                q("rbac", "Do you need roles and access control (RBAC)?", QuestionKind::Bool, &[], false, Some("authz"), "functional_requirements", None),
                q("storage", "What data does the app store?", QuestionKind::Multi, &["Relational (Postgres)", "Documents / graph", "Files / blobs", "Full-text search"], true, Some("storage"), "operational_concept", None),
                q("integrations", "Which external systems do you integrate with or wrap?", QuestionKind::LongText, &[], false, Some("connectors"), "dependencies", Some("e.g. GitHub, GitLab, Salesforce, Stripe")),
                q("facade", "Is part of the product a facade over an existing system?", QuestionKind::Bool, &[], false, Some("facade"), "dependencies", None),
                q("billing", "Do you need billing or metering?", QuestionKind::Bool, &[], false, Some("billing"), "functional_requirements", None),
                q("compliance", "Any compliance requirements?", QuestionKind::Multi, &["GDPR", "SOC 2", "HIPAA", "None"], false, Some("compliance"), "non_functional_requirements", None),
                q("deploy", "Target deployment?", QuestionKind::Single, &["Docker Compose", "Kubernetes", "Managed cloud"], true, Some("deploy"), "operational_concept", None),
            ],
            review: None,
        },
    }
}

/// The platform document-type catalogue.
pub fn builtin_types() -> Vec<DocumentType> {
    // Headings are matched with their numbering stripped (`## 5. Functional
    // Requirements` is `Functional Requirements`), and a section's words include
    // its subsections — the templates put the prose under `###`.
    vec![
        prd_type(),
        builtin(
            "adr",
            "Architecture Decision Record",
            "One decision, its context, and its consequences.",
            include_str!("templates/adr.md"),
            vec![
                sec_aka(
                    "context",
                    "Context and Problem Statement",
                    true,
                    Some(30),
                    &["Context"],
                ),
                sec("decision_drivers", "Decision Drivers", false, None),
                sec_aka(
                    "considered_options",
                    "Considered Options",
                    false,
                    None,
                    &["Alternatives Considered"],
                ),
                sec_aka(
                    "decision",
                    "Decision Outcome",
                    true,
                    Some(20),
                    &["Decision"],
                ),
                sec("consequences", "Consequences", true, Some(20)),
                sec("confirmation", "Confirmation", false, None),
                sec("pros_and_cons", "Pros and Cons of the Options", false, None),
                sec("more_information", "More Information", false, None),
                sec("traceability", "Traceability", false, None),
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
            include_str!("templates/design.md"),
            vec![
                sec_aka(
                    "overview",
                    "Architecture Overview",
                    true,
                    Some(30),
                    &["Overview"],
                ),
                sec("principles", "Principles & Constraints", true, None),
                sec_aka(
                    "architecture",
                    "Technical Architecture",
                    true,
                    Some(40),
                    &["Architecture"],
                ),
                sec("additional_context", "Additional context", false, None),
                sec("traceability", "Traceability", false, None),
            ],
            Rules::default(),
        ),
        builtin(
            "decomposition",
            "Decomposition",
            "Breaking the design into features and work items.",
            include_str!("templates/decomposition.md"),
            vec![
                sec_aka("overview", "Overview", true, Some(20), &["Approach"]),
                sec_aka("entries", "Entries", true, Some(20), &["Features"]),
                sec_aka(
                    "dependencies",
                    "Feature Dependencies",
                    true,
                    None,
                    &["Sequencing"],
                ),
            ],
            Rules::default(),
        ),
        builtin(
            "feature",
            "Feature Spec",
            "One shippable feature: behaviour, acceptance, and edges.",
            include_str!("templates/feature.md"),
            vec![
                sec_aka("context", "Feature Context", true, Some(15), &["Summary"]),
                sec_aka(
                    "actor_flows",
                    "Actor Flows (CDSL)",
                    true,
                    Some(25),
                    &["Actor Flows", "Behaviour"],
                ),
                sec_aka(
                    "processes",
                    "Processes / Business Logic (CDSL)",
                    false,
                    None,
                    &["Processes / Business Logic"],
                ),
                sec_aka("states", "States (CDSL)", false, None, &["States"]),
                sec("definitions_of_done", "Definitions of Done", true, None),
                sec("acceptance_criteria", "Acceptance Criteria", true, Some(15)),
            ],
            Rules::default(),
        ),
    ]
}
