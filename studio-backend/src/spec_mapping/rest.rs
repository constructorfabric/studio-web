//! REST surface of studio-spec-mapping, under `/studio-spec-mapping/v1`.
//!
//! The gear reads what it matches through ports, and owns none of the data:
//! the documents' index (`documents::port::SpecNeeds`), the catalogue's
//! components and the project's code (`components_catalog::port::ComponentCatalog`),
//! and the decisions in the artifact graph
//! (`artifact_ingest::port::MappingDecisionStore`). Each is resolved per request,
//! so this gear does not care which initialised first, and a deployment without
//! one answers 503 for the routes that need it and serves the rest.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::Query;
use axum::{Extension, Router};
use serde_json::Value;
use toolkit::api::canonical_prelude::*;
use toolkit::api::operation_builder::{CORE_GLOBAL_BASE_LICENSE_FEATURE, LicenseFeature};
use toolkit::api::{OpenApiRegistry, OperationBuilder};
use toolkit::client_hub::ClientHub;
use toolkit_canonical_errors::resource_error;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::local;
use super::plan::{self, PastDecision, Vocabulary};
use crate::artifact_ingest::port::{MappingDecision, MappingDecisionStore};
use crate::components_catalog::port::ComponentCatalog;
use crate::documents::port::{Capability, CapabilitySource, DeclaredCapability, SpecNeeds};
use crate::org_scope::OrgCtx;

#[resource_error(gts_id!("cf.studio._.spec_mapping.v1~"))]
pub struct SpecMappingError;

struct License;
impl AsRef<str> for License {
    fn as_ref(&self) -> &'static str {
        CORE_GLOBAL_BASE_LICENSE_FEATURE
    }
}
impl LicenseFeature for License {}

/// The ports this gear reads through, resolved per request.
#[derive(Clone)]
pub struct Ports {
    hub: Arc<ClientHub>,
}

impl Ports {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }

    fn unavailable(what: &str) -> CanonicalError {
        CanonicalError::service_unavailable()
            .with_detail(format!("{what} is not part of this deployment"))
            .create()
    }

    fn catalog(&self) -> ApiResult<Arc<dyn ComponentCatalog>> {
        self.hub
            .get::<dyn ComponentCatalog>()
            .map_err(|_| Self::unavailable("the components catalogue"))
    }

    /// The organization's registry, when the catalogue publishes one. Its
    /// absence only means the project's gears are read on demand.
    fn registry(&self) -> Option<Arc<dyn crate::components_catalog::port::Registry>> {
        self.hub
            .get::<dyn crate::components_catalog::port::Registry>()
            .ok()
    }

    fn documents(&self) -> ApiResult<Arc<dyn SpecNeeds>> {
        self.hub
            .get::<dyn SpecNeeds>()
            .map_err(|_| Self::unavailable("the documents gear"))
    }

    fn decisions(&self) -> ApiResult<Arc<dyn MappingDecisionStore>> {
        self.hub
            .get::<dyn MappingDecisionStore>()
            .map_err(|_| Self::unavailable("the artifact graph"))
    }
}

fn internal(e: anyhow::Error) -> CanonicalError {
    CanonicalError::internal(format!("{e:#}")).create()
}

fn invalid(field: &str, why: String) -> CanonicalError {
    SpecMappingError::invalid_argument()
        .with_field_violation(field, why, "INVALID")
        .create()
}

// ── The plan ──────────────────────────────────────────────────────────────

/// One capability, and what could fill it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct PlanRowDto {
    pub capability: String,
    pub candidates: Vec<CandidateDto>,
    /// No candidate at all — nothing here to build this from.
    pub gap: bool,
    /// Candidates exist and none of them is built. Not a gap, and not an
    /// answer either.
    pub unbuilt: bool,
    /// Answered by the deployment profile, not by gears: no candidates, and
    /// not a gap.
    pub nonfunctional: bool,
    /// The documents that need it, when the plan was read from a project
    /// (`GET /plan?project_id=`). Empty for a plan asked by value.
    pub sources: Vec<CapabilitySourceDto>,
    /// The capability's name in the vocabulary, when the plan was read from a
    /// project. Null for a plan asked by value.
    pub label: Option<String>,
    /// The words a gear is looked for with. Empty means the key itself.
    pub terms: Vec<String>,
    /// The contracts that satisfy it, as the vocabulary names them.
    pub contracts: Vec<String>,
    /// Every component that fills it, past the shortlist in `candidates`:
    /// what a product's picks are checked against. Rejected gears are left out.
    pub providers: Vec<CapabilityProviderDto>,
}

/// A component that fills a capability.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CapabilityProviderDto {
    pub name: String,
    /// It provides one of the capability's contracts, declares the capability,
    /// or a member confirmed it. `false`: only its words were found, which
    /// says it talks about the subject, not that it does the job.
    pub strong: bool,
}

/// One component offered for one capability.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CandidateDto {
    pub name: String,
    pub kind: String,
    /// Which step proposed it: `contract` (the engine reports the gear provides
    /// one of the capability's contracts) or `evidence` (its words were found in
    /// what the gear says about itself). Every `contract` ranks first.
    pub step: String,
    /// The provided contracts that satisfy the capability. Empty for `evidence`.
    pub contracts: Vec<String>,
    /// For `evidence`, the text around the first term found. Null otherwise.
    pub passage: Option<String>,
    /// The document the passage is quoted from, when the match came from the
    /// gear's own documentation. Such a match ranks after every evidence match
    /// from the catalogue's text. Null otherwise.
    pub cites: Option<String>,
    /// The version the catalogue knows the component at. Send it back with a
    /// decision, so a later version reopens it.
    pub version: Option<String>,
    /// A member's earlier decision on this gear for this capability. Null when
    /// nobody has decided.
    pub decision: Option<DecisionMarkDto>,
    /// The gear declares this capability itself, rather than being found by
    /// the words in its name and description.
    pub declared: bool,
    /// How many of the capability's terms it mentions.
    pub score: u32,
    /// Which terms they were, so a suggestion can be argued with rather than
    /// only accepted.
    pub why: Vec<String>,
    /// `built`, `docs-only`, or `unknown` — and `unknown` is not a maybe: it
    /// means the question does not apply or was never asked.
    pub built: String,
    /// What the Gearbox engine said: `runs`, `blocked`, or `undescribed`.
    /// A different question from `built` — that one says somebody wrote code,
    /// this one says the engine can put it into a product.
    pub composable: String,
    /// The engine's reason, when `blocked`. Null otherwise.
    pub composable_why: Option<String>,
    /// `catalogue`, or `project` for a gear the project's own repository
    /// declares -- whether or not the catalogue lists it too.
    pub origin: String,
    /// For a `project` gear, where it lives in the repository. Null otherwise.
    pub path: Option<String>,
    /// For a gear the organization's registry backs, its lifecycle state
    /// there (`declared`, `registered`, `published`, `deprecated`, …). Null
    /// for every other candidate. A `deprecated` one is still offered.
    pub registry_state: Option<String>,
    /// For a `deprecated` registry gear, the entry to use instead, when the
    /// decision named one.
    pub replaced_by: Option<String>,
    /// Whose component it is (ADR-0042): `project` (declared in this
    /// project's own repositories), `organization` (the organization's
    /// catalogue or registry) or `platform` (the shared set). On otherwise
    /// equal ranking, the project's and the organization's come first.
    pub tier: String,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MappingPlanDto {
    pub items: Vec<PlanRowDto>,
    pub total: u32,
    /// The deployment profile the project's non-functional statements point
    /// to. Null when none of them names where the product runs.
    pub profile: Option<ProfileAdviceDto>,
}

/// Which profile of `product.gdl` to make the default, and why.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ProfileAdviceDto {
    /// `dev`, `local` or `prod`, as Studio's `product.gdl` names them.
    pub profile: String,
    /// The engine's kind of that profile: `embedded`, `self_hosted` or
    /// `kubernetes`.
    pub kind: String,
    /// The statements that point to it.
    pub because: Vec<String>,
}

/// A member's earlier decision on a mapping, as the composer is given it.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PastDecisionDto {
    pub capability: String,
    pub gear: String,
    /// `confirmed` or `rejected`.
    pub decision: String,
    /// The gear's version when it was decided.
    #[serde(default)]
    pub gear_version: Option<String>,
    /// The declaring document's revision is no longer the one decided
    /// against. The caller compares, because it holds the current revision.
    #[serde(default)]
    pub document_changed: bool,
}

/// What an earlier decision says about a candidate now.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DecisionMarkDto {
    /// `confirmed` or `rejected`.
    pub decision: String,
    /// The document or the gear changed since: decide again. It ranks as if
    /// nobody had decided.
    pub needs_review: bool,
}

fn past_decision(d: PastDecisionDto) -> PastDecision {
    PastDecision {
        capability: d.capability,
        gear: d.gear,
        decision: d.decision,
        gear_version: d.gear_version,
        document_changed: d.document_changed,
    }
}

/// What a product needs, and the vocabulary to look for it with.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct PlanRequest {
    /// The capabilities to fill, in the order they should be answered.
    pub capabilities: Vec<String>,
    /// The workspace's effective capability vocabulary: capability key to the
    /// terms to search for. A capability absent from it is matched against its
    /// own name, which is what it meant before vocabularies existed
    /// (ADR-0014 §5).
    #[serde(default)]
    pub terms: std::collections::BTreeMap<String, Vec<String>>,
    /// Capability key to the contracts that satisfy it, from the same
    /// vocabulary. Matched before `terms`; a capability absent from it is
    /// found by its terms alone.
    #[serde(default)]
    pub contracts: std::collections::BTreeMap<String, Vec<String>>,
    /// What members already decided in this scope, newest first, as
    /// `GET /studio-spec-mapping/v1/decisions` lists them. A
    /// confirmed gear ranks first within its step and a rejected one last.
    #[serde(default)]
    pub decisions: Vec<PastDecisionDto>,
    /// Capabilities answered by the deployment profile rather than by gears
    /// (the vocabulary's `nonfunctional` entries). They are offered no gear.
    #[serde(default)]
    pub nonfunctional: Vec<String>,
    /// The project's non-functional statements, as `GET /requirements` returns them. They choose the deployment profile (`profile`).
    #[serde(default)]
    pub requirements: Vec<String>,
}

// ── Spec against code ─────────────────────────────────────────────────────

/// Compare what a project's specs ask for with what its code is made of.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct ConformanceRequest {
    /// The project whose gear repository is read.
    pub project_id: String,
    /// The capabilities the project's documents declare
    /// (`GET /studio-spec-mapping/v1/capabilities`).
    pub capabilities: Vec<String>,
    /// The workspace's capability vocabulary, as for `/plan`.
    #[serde(default)]
    pub terms: std::collections::BTreeMap<String, Vec<String>>,
    /// The contracts of the same vocabulary, as for `/plan`.
    #[serde(default)]
    pub contracts: std::collections::BTreeMap<String, Vec<String>>,
    /// Earlier mapping decisions, as for `/plan`.
    #[serde(default)]
    pub decisions: Vec<PastDecisionDto>,
    /// Capabilities answered by the deployment profile, as for `/plan`.
    #[serde(default)]
    pub nonfunctional: Vec<String>,
}

/// A component the code depends on.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ImplementerDto {
    pub name: String,
    /// It declares the capability itself, rather than matching by words.
    pub declared: bool,
}

/// One capability the specs declare, and whether the code has it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ConformanceRowDto {
    pub capability: String,
    /// `implemented` -- the code depends on a component that fills it --
    /// or `missing`, or `nonfunctional` -- answered by the deployment profile,
    /// so no component is expected to fill it.
    pub status: String,
    /// The components in the code that fill it.
    pub implemented_by: Vec<ImplementerDto>,
    /// When missing: the best catalogue candidates, as `/compose` ranks them.
    pub candidates: Vec<String>,
}

/// A component the code uses that no declared capability accounts for.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct UnexplainedDto {
    pub name: String,
    /// The capabilities it declares itself, if any: what the specs may be
    /// missing.
    pub declares: Vec<String>,
}

/// Spec against code, for one project.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct ConformanceDto {
    /// The repository read (`owner/name`).
    pub repo: String,
    /// Catalogue components the code depends on.
    pub components_in_code: Vec<String>,
    /// One row per declared capability.
    pub items: Vec<ConformanceRowDto>,
    pub total: u32,
    /// Components the code uses that the specs do not account for.
    pub unexplained: Vec<UnexplainedDto>,
    /// What the Gearbox engine says about the code's own set of gears: what
    /// it would have to add for them to resolve, and what cannot run. Empty
    /// when the engine is not configured or has nothing to say.
    pub gearbox: Vec<EngineChangeDto>,
}

// ── What the specifications need ──────────────────────────────────────────

/// A document that declares a capability.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct CapabilitySourceDto {
    /// `document` (held by Studio) or `file` (a bound repository file).
    pub kind: String,
    pub id: Uuid,
    /// The document's title, or the file's repository path.
    pub label: String,
    /// What the document was when this was read: a Studio document's
    /// `updated_at`, a file's `content_sha`. A mapping decided against one
    /// revision needs review once the document has another.
    pub revision: String,
    /// The artifact-graph node of a bound file. Null for a Studio document.
    pub node_id: Option<String>,
    /// Implied by the document's functional requirements rather than declared
    /// in its front matter.
    pub inferred: bool,
    /// For an inferred capability, the headings of the requirements that imply it.
    pub because: Vec<String>,
    /// For an inferred capability, the capability's words those requirements
    /// use. Empty until a document indexed before this was kept is read again.
    pub terms: Vec<String>,
    /// For an inferred capability, how many requirements mention it; `because`
    /// lists the first few.
    pub requirements: u32,
    /// `false` for a repository file the classifier proposed and nobody has
    /// confirmed yet. It still counts, and the screens say it is unconfirmed.
    pub confirmed: bool,
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

/// One non-functional statement, and the document that makes it.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeclaredRequirementDto {
    pub text: String,
    pub source: CapabilitySourceDto,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct DeclaredRequirementListDto {
    pub items: Vec<DeclaredRequirementDto>,
    /// Every statement is in `items`: at most thirty per document.
    pub total: u32,
}

// ── Decisions ─────────────────────────────────────────────────────────────

/// A member's decision on one proposed mapping of a capability to a gear.
#[derive(Debug)]
#[toolkit_macros::api_dto(request)]
pub struct MappingDecisionRequest {
    /// The project the deciding document belongs to. Its workspace is found
    /// on the server.
    pub project_id: String,
    /// The declaring document as `GET /capabilities` names it: a bound
    /// file's binding id or a Studio document's id.
    pub document: String,
    /// The artifact node of a bound file. Linked by a `decision_on` edge.
    #[serde(default)]
    pub document_node: Option<String>,
    /// The document's `revision` when this was decided.
    pub document_revision: String,
    /// Where in the document the capability is declared. Defaults to
    /// `front matter`, where every declared capability comes from today.
    #[serde(default)]
    pub section: Option<String>,
    pub capability: String,
    /// The gear by catalogue name. Empty when deciding a gap.
    #[serde(default)]
    pub gear: String,
    #[serde(default)]
    pub gear_version: Option<String>,
    /// `contract`, `evidence` or `gap`: the step that proposed it.
    pub step: String,
    /// `confirmed` or `rejected`.
    pub decision: String,
}

/// A recorded mapping decision.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MappingDecisionDto {
    pub id: String,
    pub document: String,
    pub document_revision: String,
    pub section: String,
    pub capability: String,
    pub gear: String,
    pub gear_version: Option<String>,
    pub step: String,
    pub decision: String,
    pub decided_by: String,
    /// RFC 3339 UTC.
    pub decided_at: String,
    pub workspace_id: Option<String>,
    pub project_id: Option<String>,
}

#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct MappingDecisionListDto {
    pub items: Vec<MappingDecisionDto>,
    /// Every decision in the scope is in `items`.
    pub total: u32,
}

#[derive(Debug, serde::Deserialize)]
pub struct ProjectQuery {
    /// The project, as `?project_id=` (`docs/api-conventions.md` C2).
    pub project_id: String,
}

fn parse_project(raw: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(raw.trim())
        .map_err(|_| invalid("project_id", format!("`{}` is not a uuid", raw.trim())))
}

fn mapping_decision_dto(id: String, v: &Value) -> MappingDecisionDto {
    let s = |key: &str| {
        v.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let o = |key: &str| v.get(key).and_then(Value::as_str).map(str::to_owned);
    MappingDecisionDto {
        id,
        document: s("document"),
        document_revision: s("document_revision"),
        section: s("section"),
        capability: s("capability"),
        gear: s("gear"),
        gear_version: o("gear_version"),
        step: s("step"),
        decision: s("decision"),
        decided_by: s("decided_by"),
        decided_at: s("decided_at"),
        workspace_id: o("workspace_id"),
        project_id: o("project_id"),
    }
}

/// A change the Gearbox engine would make to the code's own set of gears.
#[derive(Debug)]
#[toolkit_macros::api_dto(response)]
pub struct EngineChangeDto {
    /// Crate name.
    pub gear: String,
    /// The engine would add it; otherwise it says this one cannot run.
    pub added: bool,
    pub reason: String,
}

fn capability_source_dto(s: CapabilitySource) -> CapabilitySourceDto {
    CapabilitySourceDto {
        kind: s.kind,
        id: s.id,
        label: s.label,
        revision: s.revision,
        node_id: s.node_id,
        inferred: s.inferred,
        because: s.because,
        terms: s.terms,
        requirements: u32::try_from(s.requirements).unwrap_or(u32::MAX),
        confirmed: s.confirmed,
    }
}

fn declared_dto(c: DeclaredCapability) -> DeclaredCapabilityDto {
    DeclaredCapabilityDto {
        key: c.key,
        sources: c.sources.into_iter().map(capability_source_dto).collect(),
    }
}

fn plan_dto(
    rows: Vec<plan::PlanRow>,
    vocabulary: &Vocabulary,
    profile: Option<plan::ProfileAdvice>,
) -> MappingPlanDto {
    let items: Vec<PlanRowDto> = rows
        .into_iter()
        .map(|row| PlanRowDto {
            terms: vocabulary
                .terms
                .get(&row.capability)
                .cloned()
                .unwrap_or_default(),
            contracts: vocabulary
                .contracts
                .get(&row.capability)
                .cloned()
                .unwrap_or_default(),
            capability: row.capability,
            gap: row.gap,
            unbuilt: row.unbuilt,
            nonfunctional: row.nonfunctional,
            sources: Vec::new(),
            label: None,
            providers: row
                .providers
                .into_iter()
                .map(|p| CapabilityProviderDto {
                    name: p.name,
                    strong: p.strong,
                })
                .collect(),
            candidates: row
                .candidates
                .into_iter()
                .map(|c| CandidateDto {
                    name: c.name,
                    kind: c.kind,
                    step: c.step.as_str().to_owned(),
                    contracts: c.contracts,
                    passage: c.passage,
                    cites: c.cites,
                    version: c.version,
                    decision: c.decision.map(|d| DecisionMarkDto {
                        decision: d.decision,
                        needs_review: d.needs_review,
                    }),
                    declared: c.declared,
                    score: u32::try_from(c.score).unwrap_or(u32::MAX),
                    why: c.why,
                    built: c.built.as_str().to_owned(),
                    composable: c.composable.as_str().to_owned(),
                    composable_why: c.composable_why,
                    origin: "catalogue".to_owned(),
                    path: None,
                    registry_state: None,
                    replaced_by: None,
                    tier: c.tier,
                })
                .collect(),
        })
        .collect();
    MappingPlanDto {
        total: u32::try_from(items.len()).unwrap_or(u32::MAX),
        items,
        profile: profile.map(|a| ProfileAdviceDto {
            profile: a.profile.to_owned(),
            kind: a.kind.to_owned(),
            because: a.because,
        }),
    }
}

// ── Handlers ──────────────────────────────────────────────────────────────

/// `POST /plan`: the plan for capabilities and a vocabulary sent by value.
async fn create_plan(
    OrgCtx(org): OrgCtx,
    Extension(ports): Extension<Ports>,
    Json(req): Json<PlanRequest>,
) -> ApiResult<JsonBody<MappingPlanDto>> {
    let (components, profiles) = ports.catalog()?.components(&org).await.map_err(internal)?;
    let vocabulary = Vocabulary {
        terms: req.terms,
        contracts: req.contracts,
        decisions: req.decisions.into_iter().map(past_decision).collect(),
        nonfunctional: req.nonfunctional.into_iter().collect(),
    };
    let rows = plan::plan(&req.capabilities, &components, &profiles, &vocabulary);
    Ok(Json(plan_dto(
        rows,
        &vocabulary,
        plan::deployment_profile(&req.requirements),
    )))
}

/// The project's parent workspace, or 404 for a project the caller cannot
/// reach: one answer for "not yours" and "not there".
async fn project_workspace(
    docs: &Arc<dyn SpecNeeds>,
    ctx: &SecurityContext,
    project_id: Uuid,
) -> ApiResult<Uuid> {
    docs.project_workspace(ctx, project_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| {
            SpecMappingError::not_found("no such project, or not one the caller reaches")
                .with_resource("project")
                .create()
        })
}

/// The vocabulary in the shape the rules read it.
fn vocabulary_of(caps: &[Capability], decisions: Vec<PastDecision>) -> Vocabulary {
    Vocabulary {
        terms: caps
            .iter()
            .filter(|c| !c.terms.is_empty())
            .map(|c| (c.key.clone(), c.terms.clone()))
            .collect(),
        contracts: caps
            .iter()
            .filter(|c| !c.contracts.is_empty())
            .map(|c| (c.key.clone(), c.contracts.clone()))
            .collect(),
        decisions,
        nonfunctional: caps
            .iter()
            .filter(|c| c.nonfunctional)
            .map(|c| c.key.clone())
            .collect(),
    }
}

/// Recorded decisions as the rules take them: each marked changed when the
/// document it was decided against has another revision now.
fn past_decisions(recorded: &[(String, Value)], needs: &[DeclaredCapability]) -> Vec<PastDecision> {
    let revision_of: BTreeMap<String, &str> = needs
        .iter()
        .flat_map(|c| c.sources.iter())
        .map(|s| (s.id.to_string(), s.revision.as_str()))
        .collect();
    let s = |v: &Value, k: &str| {
        v.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let mut decisions: Vec<(String, PastDecision)> = recorded
        .iter()
        .map(|(_, v)| {
            let document = s(v, "document");
            let changed = revision_of
                .get(&document)
                .is_some_and(|now| *now != s(v, "document_revision"));
            (
                s(v, "decided_at"),
                PastDecision {
                    capability: s(v, "capability"),
                    gear: s(v, "gear"),
                    decision: s(v, "decision"),
                    gear_version: v
                        .get("gear_version")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    document_changed: changed,
                },
            )
        })
        .collect();
    // Newest first: the rules read the first decision on a (capability, gear).
    decisions.sort_by(|a, b| b.0.cmp(&a.0));
    decisions.into_iter().map(|(_, d)| d).collect()
}

/// `GET /plan?project_id=`: everything read on the server.
async fn get_project_plan(
    Extension(ctx): Extension<SecurityContext>,
    OrgCtx(org): OrgCtx,
    Extension(ports): Extension<Ports>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<MappingPlanDto>> {
    let project_id = parse_project(&q.project_id)?;
    let docs = ports.documents()?;
    let workspace_id = project_workspace(&docs, &ctx, project_id).await?;
    let (vocabulary, (needs, requirements)) = tokio::try_join!(
        docs.vocabulary(&ctx, workspace_id),
        docs.needs(workspace_id, project_id),
    )
    .map_err(internal)?;
    // Past decisions only rank the proposals; without the store the plan
    // still stands.
    let recorded = match ports.decisions() {
        Ok(store) => store
            .list_decisions(&ctx, &project_id.to_string())
            .await
            .unwrap_or_else(|e| {
                tracing::warn!(error = %format!("{e:#}"), "spec-mapping: decisions unreadable");
                Vec::new()
            }),
        Err(_) => Vec::new(),
    };
    let catalog = ports.catalog()?;
    let (mut components, mut profiles) = catalog.components(&org).await.map_err(internal)?;
    let registry = ports.registry();
    let (own, registry_states) =
        local::project_gears(catalog.as_ref(), registry.as_deref(), &org, project_id).await;
    let in_repo = local::with_project_gears(&mut components, &mut profiles, own);
    let keys: Vec<String> = needs.iter().map(|c| c.key.clone()).collect();
    let rules = vocabulary_of(&vocabulary, past_decisions(&recorded, &needs));
    let rows = plan::plan(&keys, &components, &profiles, &rules);
    let statements: Vec<String> = requirements.into_iter().map(|r| r.text).collect();
    let mut dto = plan_dto(rows, &rules, plan::deployment_profile(&statements));
    local::mark_in_repo(
        dto.items.iter_mut().flat_map(|r| r.candidates.iter_mut()),
        &in_repo,
    );
    local::mark_registry_state(
        dto.items.iter_mut().flat_map(|r| r.candidates.iter_mut()),
        &in_repo,
        &registry_states,
    );
    let mut sources: BTreeMap<String, Vec<CapabilitySource>> =
        needs.into_iter().map(|c| (c.key, c.sources)).collect();
    for row in &mut dto.items {
        row.label = vocabulary
            .iter()
            .find(|c| c.key == row.capability)
            .map(|c| c.label.clone());
        row.sources = sources
            .remove(&row.capability)
            .unwrap_or_default()
            .into_iter()
            .map(capability_source_dto)
            .collect();
    }
    Ok(Json(dto))
}

/// `GET /capabilities?project_id=`.
async fn list_project_capabilities(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ports): Extension<Ports>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<DeclaredCapabilityListDto>> {
    let project_id = parse_project(&q.project_id)?;
    let docs = ports.documents()?;
    let workspace_id = project_workspace(&docs, &ctx, project_id).await?;
    let (needs, _) = docs
        .needs(workspace_id, project_id)
        .await
        .map_err(internal)?;
    let items: Vec<DeclaredCapabilityDto> = needs.into_iter().map(declared_dto).collect();
    let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
    Ok(Json(DeclaredCapabilityListDto { items, total }))
}

/// `GET /requirements?project_id=`.
async fn list_project_requirements(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ports): Extension<Ports>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<DeclaredRequirementListDto>> {
    let project_id = parse_project(&q.project_id)?;
    let docs = ports.documents()?;
    let workspace_id = project_workspace(&docs, &ctx, project_id).await?;
    let (_, requirements) = docs
        .needs(workspace_id, project_id)
        .await
        .map_err(internal)?;
    let items: Vec<DeclaredRequirementDto> = requirements
        .into_iter()
        .map(|r| DeclaredRequirementDto {
            text: r.text,
            source: capability_source_dto(r.source),
        })
        .collect();
    let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
    Ok(Json(DeclaredRequirementListDto { items, total }))
}

/// `POST /conformance`: what the specs ask for, against what the code is made of.
async fn create_conformance_report(
    OrgCtx(org): OrgCtx,
    Extension(ports): Extension<Ports>,
    Json(req): Json<ConformanceRequest>,
) -> ApiResult<JsonBody<ConformanceDto>> {
    let project_id = req.project_id.trim();
    if Uuid::parse_str(project_id).is_err() {
        return Err(invalid(
            "project_id",
            format!("`{project_id}` is not a uuid"),
        ));
    }
    let catalog = ports.catalog()?;
    let Some((repo, deps)) = catalog
        .project_dependencies(&org, project_id)
        .await
        .map_err(internal)?
    else {
        return Err(SpecMappingError::invalid_argument()
            .with_constraint(
                "the project has no gear repository and no GitHub source whose Cargo manifests \
                 could be read, so there is no code to compare",
            )
            .create());
    };
    let (components, profiles) = catalog.components(&org).await.map_err(internal)?;

    // The catalogue components the code is made of: gears and plugins its
    // manifests depend on. SDK crates and libraries are how a gear is used,
    // not what the product is made of.
    let mut in_code: Vec<String> = components
        .iter()
        .filter(|c| {
            matches!(
                c.get("kind").and_then(Value::as_str),
                Some("gear" | "plugin")
            )
        })
        .filter_map(|c| c.get("name").and_then(Value::as_str))
        .filter(|name| deps.contains(*name))
        .map(str::to_owned)
        .collect();
    in_code.sort();
    in_code.dedup();

    let all = plan::plan_all(
        &req.capabilities,
        &components,
        &profiles,
        &Vocabulary {
            terms: req.terms,
            contracts: req.contracts,
            decisions: req.decisions.into_iter().map(past_decision).collect(),
            nonfunctional: req.nonfunctional.into_iter().collect(),
        },
    );
    let mut explained: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let items: Vec<ConformanceRowDto> = all
        .into_iter()
        .map(|row| {
            let implemented_by: Vec<ImplementerDto> = row
                .candidates
                .iter()
                .filter(|c| in_code.contains(&c.name))
                .map(|c| ImplementerDto {
                    name: c.name.clone(),
                    declared: c.declared,
                })
                .collect();
            explained.extend(implemented_by.iter().map(|i| i.name.clone()));
            let missing = implemented_by.is_empty();
            ConformanceRowDto {
                capability: row.capability,
                status: if row.nonfunctional {
                    "nonfunctional"
                } else if missing {
                    "missing"
                } else {
                    "implemented"
                }
                .to_string(),
                candidates: if missing {
                    row.candidates
                        .iter()
                        .take(3)
                        .map(|c| c.name.clone())
                        .collect()
                } else {
                    Vec::new()
                },
                implemented_by,
            }
        })
        .collect();

    let unexplained: Vec<UnexplainedDto> = in_code
        .iter()
        .filter(|name| !explained.contains(*name))
        .map(|name| UnexplainedDto {
            name: name.clone(),
            declares: components
                .iter()
                .find(|c| c.get("name").and_then(Value::as_str) == Some(name.as_str()))
                .map(|c| plan::declared_capabilities(c, profiles.get(name.as_str())))
                .unwrap_or_default(),
        })
        .collect();

    // The engine's view of the code's own set: what it would add, and what it
    // says cannot run. Best-effort -- the comparison stands without it.
    let gearbox: Vec<EngineChangeDto> = match catalog.engine_completion(&in_code).await {
        Some(Ok(changes)) => changes
            .into_iter()
            .map(|c| EngineChangeDto {
                gear: c.gear,
                added: c.added,
                reason: c.reason,
            })
            .collect(),
        Some(Err(e)) => {
            tracing::warn!(error = %format!("{e:#}"), "conformance: the Gearbox engine did not answer");
            Vec::new()
        }
        None => Vec::new(),
    };

    let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
    Ok(Json(ConformanceDto {
        repo,
        components_in_code: in_code,
        items,
        total,
        unexplained,
        gearbox,
    }))
}

/// `POST /decisions`: record a member's decision on one mapping.
async fn create_decision(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ports): Extension<Ports>,
    Json(req): Json<MappingDecisionRequest>,
) -> ApiResult<(StatusCode, JsonBody<MappingDecisionDto>)> {
    let trimmed = |s: &str| s.trim().to_owned();
    let project_id = parse_project(&req.project_id)?;
    let document = trimmed(&req.document);
    let capability = trimmed(&req.capability);
    if document.is_empty() {
        return Err(invalid(
            "document",
            "must name the declaring document".into(),
        ));
    }
    if capability.is_empty() {
        return Err(invalid("capability", "must name a capability".into()));
    }
    let step = trimmed(&req.step);
    if !matches!(step.as_str(), "contract" | "evidence" | "gap") {
        return Err(invalid(
            "step",
            format!("must be contract, evidence or gap, got `{step}`"),
        ));
    }
    let decision = trimmed(&req.decision);
    if !matches!(decision.as_str(), "confirmed" | "rejected") {
        return Err(invalid(
            "decision",
            format!("must be confirmed or rejected, got `{decision}`"),
        ));
    }
    let gear = trimmed(&req.gear);
    if gear.is_empty() && step != "gap" {
        return Err(invalid(
            "gear",
            "a contract or evidence mapping names its gear".into(),
        ));
    }
    let docs = ports.documents()?;
    let workspace_id = project_workspace(&docs, &ctx, project_id).await?;
    let non_empty = |s: Option<String>| s.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    let input = MappingDecision {
        workspace_id: workspace_id.to_string(),
        project_id: Some(project_id.to_string()),
        document,
        document_node: non_empty(req.document_node),
        document_revision: trimmed(&req.document_revision),
        section: non_empty(req.section).unwrap_or_else(|| "front matter".to_owned()),
        capability,
        gear,
        gear_version: non_empty(req.gear_version),
        step,
        decision,
    };
    let (id, value) = ports
        .decisions()?
        .record_decision(&ctx, &input)
        .await
        .map_err(internal)?;
    Ok((StatusCode::CREATED, Json(mapping_decision_dto(id, &value))))
}

/// `GET /decisions?project_id=`: the decisions recorded in a project.
async fn list_decisions(
    Extension(ctx): Extension<SecurityContext>,
    Extension(ports): Extension<Ports>,
    Query(q): Query<ProjectQuery>,
) -> ApiResult<JsonBody<MappingDecisionListDto>> {
    let project_id = parse_project(&q.project_id)?;
    let docs = ports.documents()?;
    project_workspace(&docs, &ctx, project_id).await?;
    let mut items: Vec<MappingDecisionDto> = ports
        .decisions()?
        .list_decisions(&ctx, &project_id.to_string())
        .await
        .map_err(internal)?
        .into_iter()
        .map(|(id, value)| mapping_decision_dto(id, &value))
        .collect();
    // Newest first, and the id breaks a tie, so the order is the same on
    // every read.
    items.sort_by(|a, b| b.decided_at.cmp(&a.decided_at).then(a.id.cmp(&b.id)));
    let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
    Ok(Json(MappingDecisionListDto { items, total }))
}

// ── Routes ────────────────────────────────────────────────────────────────

pub fn register_routes(router: Router, openapi: &dyn OpenApiRegistry, ports: Ports) -> Router {
    let router = OperationBuilder::get("/studio-spec-mapping/v1/plan")
        .operation_id("studio_spec_mapping.get_project_plan")
        .summary("What a project's specifications need, and the gears that cover it")
        .description(
            "Everything read on the server: the capabilities the project's documents need, \
             read as written (front matter when it says, the functional requirements \
             otherwise); the workspace's vocabulary; the decisions members recorded; and the \
             catalogue of the organization on screen. Each row is one capability with the \
             documents behind it (`sources`) and its candidates, CONTRACT MATCHES FIRST: a gear \
             the Gearbox engine reports as providing one of the capability's contracts, then \
             gears whose words mention its terms, each citing its passage. A confirmed gear \
             ranks first within its step and a rejected one last. `profile` is the deployment \
             profile the documents' non-functional statements point to.",
        )
        .tag("StudioSpecMapping")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(get_project_plan)
        .json_response_with_schema::<MappingPlanDto>(openapi, StatusCode::OK, "The plan")
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-spec-mapping/v1/plan")
        .operation_id("studio_spec_mapping.create_plan")
        .summary("Match capabilities sent by value against the components that exist")
        .description(
            "The same rules as a project's plan, for capabilities and a vocabulary the caller \
             sends: the App Spec's Compose button asks about one document before it is saved. \
             A POST because the vocabulary travels with the question, and a map does not \
             belong in a query string. CANDIDATES COME BACK BUILT FIRST within each step, and \
             the shortlist is cut after that sort; components never built are LABELLED rather \
             than dropped. `unbuilt` says candidates exist and none is built.",
        )
        .tag("StudioSpecMapping")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<PlanRequest>(openapi, "The capabilities to fill")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(create_plan)
        .json_response_with_schema::<MappingPlanDto>(openapi, StatusCode::OK, "The plan")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-spec-mapping/v1/capabilities")
        .operation_id("studio_spec_mapping.list_project_capabilities")
        .summary("The capabilities a project's documents need")
        .description(
            "Every capability the project's documents need -- the ones Studio holds and the \
             repository files bound to a type -- with the documents saying so. A capability \
             comes from a document's front matter when it declares one, and otherwise from \
             what its functional requirements imply (`inferred`, with the requirements \
             `because`); the documents are read as written. A repository file still awaiting \
             review counts, marked `confirmed: false`.",
        )
        .tag("StudioSpecMapping")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .handler(list_project_capabilities)
        .json_response_with_schema::<DeclaredCapabilityListDto>(
            openapi,
            StatusCode::OK,
            "The capabilities",
        )
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-spec-mapping/v1/requirements")
        .operation_id("studio_spec_mapping.list_project_requirements")
        .summary("The non-functional statements a project's documents make")
        .description(
            "Every line of the non-functional, operational and deployment sections of the \
             project's documents, with the document making each. They choose the product's \
             deployment profile and never its gears.",
        )
        .tag("StudioSpecMapping")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .handler(list_project_requirements)
        .json_response_with_schema::<DeclaredRequirementListDto>(
            openapi,
            StatusCode::OK,
            "The statements",
        )
        .error_401(openapi)
        .error_404(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-spec-mapping/v1/conformance")
        .operation_id("studio_spec_mapping.create_conformance_report")
        .summary("Compare what a project's specs ask for with what its code is made of")
        .description(
            "For each capability the project's documents need: whether the code depends on a \
             catalogue component that fills it, and which. Then the components the code uses \
             that no capability accounts for -- what the specs may be missing -- and what the \
             Gearbox engine says about the code's own set of gears. The code is the project's \
             gear repository, read as the run-time dependencies of every Cargo.toml in it.",
        )
        .tag("StudioSpecMapping")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<ConformanceRequest>(openapi, "The project and its capabilities")
        .query_param(crate::org_scope::PARAM, false, crate::org_scope::PARAM_DOC)
        .handler(create_conformance_report)
        .json_response_with_schema::<ConformanceDto>(openapi, StatusCode::OK, "The comparison")
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::post("/studio-spec-mapping/v1/decisions")
        .operation_id("studio_spec_mapping.create_decision")
        .summary("Record a member's decision on a capability-to-gear mapping")
        .description(
            "Confirms or rejects one proposed mapping of a capability a document needs to a \
             gear, or to nothing (a gap). The decision is a mapping_decision node in the \
             artifact graph, linked to a bound file by a decision_on edge, and it records who \
             decided, when, which step proposed it, the gear version and the document revision \
             decided against. Deciding the same document, section, capability and gear again \
             replaces the decision.",
        )
        .tag("StudioSpecMapping")
        .authenticated()
        .require_license_features::<License>([])
        .json_request::<MappingDecisionRequest>(openapi, "The decision")
        .handler(create_decision)
        .json_response_with_schema::<MappingDecisionDto>(
            openapi,
            StatusCode::CREATED,
            "The decision as recorded",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    let router = OperationBuilder::get("/studio-spec-mapping/v1/decisions")
        .operation_id("studio_spec_mapping.list_decisions")
        .summary("List the mapping decisions recorded in a project")
        .description(
            "Every mapping decision recorded in the project, newest first. A project's plan reads them \
             itself; a plan asked by value takes them in its request.",
        )
        .tag("StudioSpecMapping")
        .authenticated()
        .require_license_features::<License>([])
        .query_param("project_id", true, "The project")
        .handler(list_decisions)
        .json_response_with_schema::<MappingDecisionListDto>(
            openapi,
            StatusCode::OK,
            "The decisions",
        )
        .error_400(openapi)
        .error_401(openapi)
        .error_500(openapi)
        .register(router, openapi);

    router.layer(Extension(ports))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn source(id: Uuid, revision: &str) -> CapabilitySource {
        CapabilitySource {
            kind: "file".into(),
            id,
            label: "docs/PRD.md".into(),
            revision: revision.into(),
            node_id: None,
            inferred: true,
            because: vec!["5.1 Login".into()],
            terms: vec!["login".into()],
            requirements: 1,
            confirmed: false,
        }
    }

    fn recorded(document: Uuid, revision: &str, gear: &str, at: &str) -> (String, Value) {
        (
            format!("d-{gear}"),
            json!({
                "document": document.to_string(),
                "document_revision": revision,
                "capability": "auth",
                "gear": gear,
                "decision": "confirmed",
                "gear_version": "1.0.0",
                "decided_at": at,
            }),
        )
    }

    /// A decision taken against a document that has another revision now
    /// needs review; one about a document the project no longer has does not
    /// claim to know, and keeps standing.
    #[test]
    fn a_decision_is_changed_when_its_document_has_another_revision() {
        let (same, moved, gone) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let needs = vec![DeclaredCapability {
            key: "auth".into(),
            sources: vec![source(same, "sha1"), source(moved, "sha2")],
        }];
        let decisions = past_decisions(
            &[
                recorded(same, "sha1", "a", "2026-10-07T10:00:00Z"),
                recorded(moved, "sha1", "b", "2026-10-07T11:00:00Z"),
                recorded(gone, "sha1", "c", "2026-10-07T09:00:00Z"),
            ],
            &needs,
        );
        // Newest first, which is the order the rules read them in.
        let order: Vec<(&str, bool)> = decisions
            .iter()
            .map(|d| (d.gear.as_str(), d.document_changed))
            .collect();
        assert_eq!(order, [("b", true), ("a", false), ("c", false)]);
        assert_eq!(decisions[0].gear_version.as_deref(), Some("1.0.0"));
    }

    #[test]
    fn the_vocabulary_is_read_into_the_rules_shape() {
        let caps = crate::documents::sdk::builtin_capabilities();
        let v = vocabulary_of(&caps, Vec::new());
        assert!(v.nonfunctional.contains("deploy"));
        assert!(v.contracts["auth"].contains(&"cf.core.authn_resolver.plugin.v1~".to_owned()));
        assert!(!v.terms["auth"].is_empty());
        assert!(
            !v.contracts.contains_key("storage"),
            "a key with no contract is left out"
        );
    }
}
