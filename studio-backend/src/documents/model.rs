//! Domain model for studio-documents.
//!
//! A **document type** couples a stable key to a template: a markdown skeleton,
//! an ordered checklist of sections, and the structural rules that decide
//! whether a document conforms. Types are either platform **built-ins** (the
//! KIT artifact chain, seeded here) or **workspace-defined** (owned by a
//! workspace tenant and inherited by its projects). A **document** is an
//! instance of a type, owned by a workspace or project tenant.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Who owns a document type. Built-ins are visible in every tenant; a
/// workspace-defined type is visible in that workspace and inherited by its
/// projects (see the tenant closure in the service).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Owner {
    /// Platform catalogue — available everywhere, not editable per tenant
    /// (a workspace may *override* by defining a type with the same key).
    Builtin,
    /// Owned by one workspace tenant; inherited by that workspace's projects.
    Workspace { tenant_id: Uuid },
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
    /// Subject id of the creator (as a string principal).
    pub created_by: String,
    /// RFC 3339 UTC timestamps.
    pub created_at: String,
    pub updated_at: String,
}

// ── Built-in catalogue ──────────────────────────────────────────────────────
// Seeded from the Constructor Studio KIT artifact chain
// (UPSTREAM_REQS → PRD → ADR + DESIGN → DECOMPOSITION → FEATURE). A workspace
// may override any of these by defining a type with the same key.

/// GTS id for a document type key.
pub fn type_gts_id(key: &str) -> String {
    format!("gts.cf.studio.doc.{key}.v1~")
}

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
        gts_type_id: type_gts_id(key),
        owner: Owner::Builtin,
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
        gts_type_id: type_gts_id("app_spec"),
        owner: Owner::Builtin,
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
