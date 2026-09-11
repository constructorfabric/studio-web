//! Studio AuthZ plugin — the Studio PDP (ADR-0006).
//!
//! Reads the org access config from AM tenant metadata
//! (`cf.studio.access.config.v1`) and switches on `model`:
//!   - `tenant` (or no config / unreadable) → tenant clamp (behaviour == static);
//!   - `roles` → for a Studio resource it maps (resource_type, action) to a
//!     privilege, matches the subject's MEMBER grants, expands roles → privileges,
//!     and allows iff an in-scope grant carries the privilege; else denies.
//!
//! Roles sit ON TOP OF the tenant model, they do not replace it (ADR-0009). The
//! tenant clamp is the invariant outer boundary: every allow the role path emits
//! is AND-ed with tenant isolation, so a grant can only ever NARROW access within
//! the caller's tenant subtree — never widen it or reach across tenants. An
//! org-scoped grant resolves to the full tenant clamp; a project-scoped grant
//! intersects the clamp with the granted scope ids (owner-tenant), which the
//! subtree bound keeps inside the tenant. A mapped Studio resource with no
//! matching grant is denied — membership alone does not confer Work access.
//!
//! Safety: only Studio resources we explicitly map are role-gated. Every other
//! resource (AM tenants/metadata, RG, …) takes the tenant clamp, so selecting
//! this PDP — even with `model = "roles"` — never breaks platform operations.
//! The metadata read is itself PEP-gated, so a recursion guard short-circuits
//! authorizing reads of AM tenant-metadata to the tenant clamp.
//!
//! Patterns (client fetch, `GtsTypeId::new(<&str>)`, `resolve_metadata`) mirror
//! the in-crate `connectors` gear, which already reads tenant metadata.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use authz_resolver_sdk::{
    AuthZResolverError, AuthZResolverPluginClient, AuthZResolverPluginSpecV1, Capability,
    Constraint, EvaluationRequest, EvaluationResponse, EvaluationResponseContext, InPredicate,
    InTenantSubtreePredicate, Predicate,
};
use gts::GtsTypeId;
use serde::Deserialize;
use toolkit::Gear;
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit::context::GearCtx;
use toolkit::gts::PluginV1;
use toolkit_security::SecurityContext;
use toolkit_security::pep_properties;
use tracing::{info, warn};
use types_registry_sdk::{RegisterResult, TypesRegistryClient};
use uuid::Uuid;

pub(crate) const INSTANCE_ID: &str = "cf.studio.authz_resolver.plugin.v1";
/// AM tenant-metadata type holding the org access config (portal writes it).
pub(crate) const ACCESS_METADATA_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.access.config.v1~";

/* ── Config ── */

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct StudioAuthZPluginConfig {
    pub vendor: String,
    pub priority: i16,
}
impl Default for StudioAuthZPluginConfig {
    fn default() -> Self {
        Self {
            vendor: "constructorfabric".to_owned(),
            priority: 40,
        }
    }
}

/* ── Gear ── */

#[toolkit::gear(
    name = "studio-authz-plugin",
    deps = [types_registry, account_management]
)]
pub struct StudioAuthZPlugin {
    service: OnceLock<Arc<Service>>,
}
impl Default for StudioAuthZPlugin {
    fn default() -> Self {
        Self {
            service: OnceLock::new(),
        }
    }
}

#[async_trait]
impl Gear for StudioAuthZPlugin {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: StudioAuthZPluginConfig = ctx.config_or_default()?;
        info!(vendor = %cfg.vendor, priority = cfg.priority, "Loaded Studio AuthZ plugin config");

        let (instance_id, instance_json) =
            PluginV1::<AuthZResolverPluginSpecV1>::build_registration(
                INSTANCE_ID,
                cfg.vendor.clone(),
                cfg.priority,
            )?;
        let registry = ctx.client_hub().get::<dyn TypesRegistryClient>()?;
        let results = registry.register(vec![instance_json]).await?;
        RegisterResult::ensure_all_ok(&results)?;

        let am = ctx.client_hub().get::<dyn AccountManagementClient>()?;
        let service = Arc::new(Service::new(am, ctx.client_hub()));
        self.service
            .set(service.clone())
            .map_err(|_| anyhow::anyhow!("{} gear already initialized", Self::MODULE_NAME))?;

        let api: Arc<dyn AuthZResolverPluginClient> = service;
        ctx.client_hub()
            .register_scoped::<dyn AuthZResolverPluginClient>(
                ClientScope::gts_id(&instance_id),
                api,
            );
        info!(instance_id = %instance_id, "Studio AuthZ plugin registered");
        Ok(())
    }
}

/* ── Access config (mirrors the portal's access.ts) ── */

#[derive(Debug, Clone, Deserialize, Default)]
struct AccessConfig {
    #[serde(default)]
    model: String,
    #[serde(default)]
    roles: Vec<RoleDef>,
    #[serde(default)]
    grants: Vec<GrantDef>,
}
#[derive(Debug, Clone, Deserialize)]
struct RoleDef {
    key: String,
    #[serde(default)]
    privileges: Vec<String>,
}
#[derive(Debug, Clone, Deserialize)]
struct GrantDef {
    #[serde(rename = "subjectType")]
    subject_type: String,
    #[serde(rename = "subjectId")]
    subject_id: String,
    #[serde(rename = "roleKey")]
    role_key: String,
    #[serde(rename = "scopeType")]
    scope_type: String,
    #[serde(rename = "scopeId")]
    scope_id: String,
}

/* ── Service ── */

/// How long a person's organization list is reused before it is read again.
///
/// This runs on every authorization decision, so reading memberships per
/// request would put an indexed `SELECT` in front of every call through the
/// gateway. Memberships change rarely and the window is short, so the cost of
/// the staleness is bounded and stated: a membership granted takes effect
/// within this long, and one revoked stops working within this long — which
/// still satisfies ADR-0011 §7's "without waiting for a new external login".
const MEMBERSHIP_TTL: Duration = Duration::from_secs(10);

/// A subject's organizations, with when and against which generation they were
/// read.
type MembershipCache = HashMap<Uuid, CachedMemberships>;

struct CachedMemberships {
    read_at: Instant,
    generation: u64,
    organizations: Arc<Vec<Uuid>>,
}

pub struct Service {
    am: Arc<dyn AccountManagementClient>,
    /// Held rather than resolved at construction: `studio-user` publishes the
    /// reader in its own `init`, and this plugin does not depend on that gear,
    /// so init order guarantees nothing. Looked up once, on first use.
    hub: Arc<ClientHub>,
    organizations: OnceLock<Option<Arc<dyn crate::user_profile::OrganizationReader>>>,
    cache: Mutex<MembershipCache>,
}

impl Service {
    #[must_use]
    pub fn new(am: Arc<dyn AccountManagementClient>, hub: Arc<ClientHub>) -> Self {
        Self {
            am,
            hub,
            organizations: OnceLock::new(),
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// The reader, looked up once.
    ///
    /// `None` when `studio-user` is not in this assembly or has no database. The
    /// clamp then behaves exactly as it did before memberships existed, which
    /// is the safe direction: it reaches less, never more.
    fn organization_reader(&self) -> Option<&Arc<dyn crate::user_profile::OrganizationReader>> {
        self.organizations
            .get_or_init(|| {
                let reader = self
                    .hub
                    .get_scoped::<dyn crate::user_profile::OrganizationReader>(
                        &ClientScope::gts_id(crate::user_profile::IDENTITY_INSTANCE_ID),
                    )
                    .ok();
                if reader.is_none() {
                    warn!(
                        "studio-authz: studio-user is not available — the tenant clamp stays on \
                         the token's tenant, so a person cannot reach an organization they are \
                         only a member of"
                    );
                }
                reader
            })
            .as_ref()
    }

    /// Every tenant this request may reach.
    ///
    /// The tenant the request arrived with, plus the organizations the caller is
    /// a member of. The first is kept deliberately: it is what the clamp has
    /// always been, so this change can only widen, and nothing that works today
    /// stops working — including service accounts, which have a tenant and no
    /// memberships. Dropping it is a separate step, after the things that still
    /// depend on it are gone (ADR-0018 §3).
    async fn reachable_tenants(&self, request: &EvaluationRequest, tid: Uuid) -> Vec<Uuid> {
        let mut tids = vec![tid];
        let Some(reader) = self.organization_reader() else {
            return tids;
        };
        let subject = request.subject.id;
        let generation = reader.membership_generation();
        if let Some(cached) = self.cached(subject, generation) {
            extend_unique(&mut tids, &cached);
            return tids;
        }
        match reader.organizations_of(&subject.to_string()).await {
            Ok(orgs) => {
                let orgs = Arc::new(orgs);
                if let Ok(mut cache) = self.cache.lock() {
                    cache.insert(
                        subject,
                        CachedMemberships {
                            read_at: Instant::now(),
                            generation,
                            organizations: orgs.clone(),
                        },
                    );
                }
                extend_unique(&mut tids, &orgs);
            }
            Err(error) => {
                // Not fatal, and not a denial: the caller keeps the reach they
                // had before memberships were consulted. Failing closed here
                // would make a database hiccup look like a revoked membership.
                warn!(%subject, "studio-authz: cannot read memberships: {error:#}");
            }
        }
        tids
    }

    /// A cached answer is good while it is young *and* nothing has changed
    /// membership since it was taken. The generation is what makes a write
    /// visible immediately; the age is only a backstop.
    fn cached(&self, subject: Uuid, generation: u64) -> Option<Arc<Vec<Uuid>>> {
        let mut cache = self.cache.lock().ok()?;
        match cache.get(&subject) {
            Some(entry)
                if entry.generation == generation && entry.read_at.elapsed() < MEMBERSHIP_TTL =>
            {
                Some(entry.organizations.clone())
            }
            Some(_) => {
                cache.remove(&subject);
                None
            }
            None => None,
        }
    }

    fn tenant_of(request: &EvaluationRequest) -> Option<Uuid> {
        request
            .context
            .tenant_context
            .as_ref()
            .and_then(|t| t.root_id)
            .or_else(|| {
                request
                    .subject
                    .properties
                    .get("tenant_id")
                    .and_then(|v| v.as_str())
                    .and_then(|s| Uuid::parse_str(s).ok())
            })
    }

    /// SecurityContext for the metadata read. Forwards the caller's identity +
    /// bearer token; the read is authorized by this same plugin's tenant clamp
    /// (see the recursion guard), so a caller-scoped context is sufficient.
    fn read_ctx(request: &EvaluationRequest, tid: Uuid) -> SecurityContext {
        let mut b = SecurityContext::builder()
            .subject_id(request.subject.id)
            .subject_tenant_id(tid)
            .token_scopes(request.context.token_scopes.clone());
        if let Some(tok) = request.context.bearer_token.as_ref() {
            b = b.bearer_token(tok.clone());
        }
        b.build().unwrap_or_else(|_| SecurityContext::anonymous())
    }

    async fn read_access_config(&self, sec: &SecurityContext, tid: Uuid) -> Option<AccessConfig> {
        match self
            .am
            .resolve_metadata(sec, tid, GtsTypeId::new(ACCESS_METADATA_TYPE))
            .await
        {
            Ok(Some(e)) => serde_json::from_value::<AccessConfig>(e.value).ok(),
            _ => None,
        }
    }
}

/// The account-management type families whose authorization must never depend
/// on reading the access config, because that read is one of them.
///
/// All three, not just the metadata one: the previous spelling of this guard
/// matched `am.tenant` as a substring, which caught tenants, tenant metadata
/// and tenant types alike, and the breadth is deliberate — an AM resource is
/// never a Studio Work resource, so clamping it costs nothing.
const RECURSION_GUARDED_FAMILIES: [&str; 3] = [
    "gts.cf.core.am.tenant.v1",
    "gts.cf.core.am.tenant_metadata.v1",
    "gts.cf.core.am.tenant_type.v1",
];

/// The family a GTS type id belongs to: everything before the first `~`.
///
/// A GTS id is a `~`-terminated chain in which the first segment names the base
/// type and each later one narrows it, so
/// `gts.cf.core.am.tenant_metadata.v1~cf.studio.access.config.v1~` *is* a
/// tenant-metadata type and comparing families is how you say so.
fn family_of(type_id: &str) -> &str {
    type_id.split_once('~').map_or(type_id, |(base, _)| base)
}

/// Is this the read that would recurse?
///
/// It compares the family rather than looking for a substring. The two are the
/// same for every id in use today and diverge on the ones that matter: a
/// substring search exempts anything whose id merely *contains* the words —
/// another vendor's `gts.acme.am.tenant.v1~`, or a Studio type that grows a
/// `tenant_metadata` segment of its own — from a role gate it was never meant
/// to escape. Nothing is role-gated yet, so that is latent rather than live,
/// which is exactly the kind of thing to fix while it still costs nothing.
fn is_recursion_guarded(type_id: &str) -> bool {
    RECURSION_GUARDED_FAMILIES.contains(&family_of(type_id))
}

/// What a request can be answered with before anything is read.
///
/// Reading the org access config is a call into account-management, and the
/// only thing that consumes it is the role path. Deciding the shape of the
/// answer first means a request that cannot reach that path never pays for it
/// — which is every request until [`privilege_for`] maps a resource type.
///
/// It is a type rather than an early return so the property is structural: a
/// future edit that wants the config a little sooner has to move it into a
/// branch that says it needs one.
#[derive(Debug, PartialEq, Eq)]
enum Plan {
    /// Nothing identifies the caller's tenant, so nothing can be allowed.
    Deny,
    /// Answerable from the request alone: scope the caller to their tenant.
    Clamp(Uuid),
    /// A resource this deployment role-gates. Only this needs the config.
    Roles { tid: Uuid, privilege: &'static str },
}

impl Plan {
    fn for_request(request: &EvaluationRequest) -> Self {
        let Some(tid) = Service::tenant_of(request) else {
            return Self::Deny;
        };
        if tid == Uuid::default() {
            return Self::Deny;
        }

        // First-party / unrestricted token (`token_scopes` contains "*"): a
        // platform / service caller is never role-gated — anti-lockout backstop.
        if request.context.token_scopes.iter().any(|s| s == "*") {
            return Self::Clamp(tid);
        }

        // RECURSION GUARD: authorizing a read of AM tenant-metadata must not
        // read the config to decide (that read is itself PEP-gated → would
        // recurse).
        let rt = request.resource.resource_type.as_str();
        if is_recursion_guarded(rt) {
            return Self::Clamp(tid);
        }

        // Only Studio resources we map are role-gated; everything else keeps
        // tenant scoping, so the platform is never denied.
        match privilege_for(rt, &request.action.name) {
            Some(privilege) => Self::Roles { tid, privilege },
            None => Self::Clamp(tid),
        }
    }
}

#[async_trait]
impl AuthZResolverPluginClient for Service {
    async fn evaluate(
        &self,
        request: EvaluationRequest,
    ) -> Result<EvaluationResponse, AuthZResolverError> {
        let (tid, privilege) = match Plan::for_request(&request) {
            Plan::Deny => return Ok(deny()),
            Plan::Clamp(tid) => {
                let tids = self.reachable_tenants(&request, tid).await;
                return Ok(tenant_clamp(&request, &tids));
            }
            Plan::Roles { tid, privilege } => (tid, privilege),
        };

        // Read the org access config. Missing/unreadable OR non-roles model →
        // tenant clamp (behaviour == today, fail-safe).
        let sec = Service::read_ctx(&request, tid);
        let Some(cfg) = self.read_access_config(&sec, tid).await else {
            let tids = self.reachable_tenants(&request, tid).await;
            return Ok(tenant_clamp(&request, &tids));
        };
        if cfg.model != "roles" {
            let tids = self.reachable_tenants(&request, tid).await;
            return Ok(tenant_clamp(&request, &tids));
        }

        let subject_id = request.subject.id.to_string();
        // TODO(step 4): resolve the subject's Teams (RG groups) for team grants.
        let subject_teams: Vec<String> = Vec::new();

        // Walk the subject's grants that carry this privilege. An org-scoped
        // grant means "the whole tenant" (== the tenant clamp); project-scoped
        // grants collect the specific scope ids to narrow to.
        let mut org_grant = false;
        let mut project_scopes: Vec<Uuid> = Vec::new();
        for g in &cfg.grants {
            let subject_matches = match g.subject_type.as_str() {
                "member" => g.subject_id == subject_id,
                "team" => subject_teams.iter().any(|t| t == &g.subject_id),
                _ => false,
            };
            if !subject_matches {
                continue;
            }
            let role_has = cfg
                .roles
                .iter()
                .find(|r| r.key == g.role_key)
                .is_some_and(|r| r.privileges.iter().any(|p| p == privilege));
            if !role_has {
                continue;
            }
            match g.scope_type.as_str() {
                "org" => org_grant = true,
                "project" => {
                    if let Ok(pid) = Uuid::parse_str(&g.scope_id) {
                        project_scopes.push(pid);
                    }
                }
                _ => {}
            }
        }

        // An org-scoped grant carries the privilege across the whole tenant:
        // that is exactly the tenant clamp (incl. the hierarchy subtree).
        if org_grant {
            let tids = self.reachable_tenants(&request, tid).await;
            return Ok(tenant_clamp(&request, &tids));
        }

        // No grant at all → deny. Roles NARROW: tenant membership by itself does
        // not confer access to a mapped Work resource.
        if project_scopes.is_empty() {
            return Ok(deny());
        }

        // Project-scoped grants: start from the tenant clamp (the invariant
        // outer boundary) and AND the granted scope ids into every branch of it.
        // Because the clamp already bounds owner-tenant to `tid` + its subtree,
        // intersecting with the scope ids can only keep those that live inside
        // the tenant — a scope id outside the subtree drops out at evaluation,
        // so a grant can never reach across tenants.
        // The grant's own tenant, not the caller's whole reach: this branch
        // narrows to the scopes one grant names, and starting from a wider set
        // would let a project-scoped grant pull in an organization the grant
        // says nothing about.
        let mut constraints = tenant_constraints(&request, &[tid]);
        for c in &mut constraints {
            c.predicates.push(Predicate::In(InPredicate::new(
                pep_properties::OWNER_TENANT_ID,
                project_scopes.clone(),
            )));
        }
        Ok(EvaluationResponse {
            decision: true,
            context: EvaluationResponseContext {
                constraints,
                ..Default::default()
            },
        })
    }
}

/* ── Helpers ── */

/// The tenant-isolation constraint set: owner-tenant is `tid`, plus the
/// hierarchy subtree branches when the caller supports them. Returned as a bare
/// `Vec<Constraint>` so the role path can AND further narrowing into each branch
/// (constraints are OR-combined; predicates within one are AND-combined).
/// The clamp, over every tenant the caller may reach.
///
/// Constraints in a response are OR-ed and predicates inside one are AND-ed
/// (`authz_resolver_sdk::constraints`), so "any of these tenants" is a list of
/// constraints and nothing more exotic. `InTenantSubtree` carries a single
/// root, which is why the subtree arms are one per tenant rather than one with
/// a list.
///
/// `tids` is never empty: it always contains the tenant the request arrived
/// with, so this can only ever widen what a caller could already reach.
fn tenant_constraints(request: &EvaluationRequest, tids: &[Uuid]) -> Vec<Constraint> {
    let mut constraints = vec![Constraint {
        predicates: vec![Predicate::In(InPredicate::new(
            pep_properties::OWNER_TENANT_ID,
            tids.to_vec(),
        ))],
    }];
    let hierarchy = request
        .context
        .capabilities
        .iter()
        .any(|c| matches!(c, Capability::TenantHierarchy));
    if hierarchy {
        for prop in [pep_properties::OWNER_TENANT_ID, pep_properties::RESOURCE_ID] {
            if request
                .context
                .supported_properties
                .iter()
                .any(|p| p == prop)
            {
                for tid in tids {
                    constraints.push(Constraint {
                        predicates: vec![Predicate::InTenantSubtree(
                            InTenantSubtreePredicate::new(prop, *tid),
                        )],
                    });
                }
            }
        }
    }
    constraints
}

/// static-authz behaviour: allow, clamped to the context tenant (+ subtree).
/// Append the ones that are not already there, preserving order.
fn extend_unique(into: &mut Vec<Uuid>, more: &[Uuid]) {
    for id in more {
        if !into.contains(id) {
            into.push(*id);
        }
    }
}

fn tenant_clamp(request: &EvaluationRequest, tids: &[Uuid]) -> EvaluationResponse {
    EvaluationResponse {
        decision: true,
        context: EvaluationResponseContext {
            constraints: tenant_constraints(request, tids),
            ..Default::default()
        },
    }
}

fn deny() -> EvaluationResponse {
    EvaluationResponse {
        decision: false,
        context: EvaluationResponseContext::default(),
    }
}

/// Map a platform request `(resource_type, action)` to a Studio privilege id
/// (the portal's `access.ts` catalogue). TODO(step 4): complete the table and
/// key off the real Studio GTS resource-type ids.
/// The privilege a resource type and action need, when this deployment
/// role-gates them.
///
/// **Returns `None` for everything today**, which is worth knowing before
/// reading further: `studio-project` (the portal's "Work") has been retired —
/// projects are AM tenants now, and their access is governed by tenant
/// membership rather than by a Studio privilege grant. Nothing is role-mapped,
/// so every request is answered by the tenant clamp and the grant evaluation in
/// [`AuthZResolverPluginClient::evaluate`] is unreachable.
///
/// That is a stage, not a leftover: the roles, grants and scopes it walks are
/// the model the access config already carries. Mapping the first resource type
/// here is what turns it on — and, through [`Plan`], what makes the config
/// worth reading.
fn privilege_for(_resource_type: &str, _action: &str) -> Option<&'static str> {
    None
}

#[cfg(test)]
mod tests {
    //! What the PDP can answer before it reads anything.
    //!
    //! Every request through the gateway reaches this plugin, and the org
    //! access config it may need is a call into account-management. So the
    //! question worth pinning is not only what the answer is, but whether
    //! arriving at it costs a round trip.

    use std::collections::HashMap;

    use authz_resolver_sdk::{Action, EvaluationRequestContext, Resource, Subject, TenantContext};

    use super::*;

    const TENANT: Uuid = Uuid::from_u128(0x7e1a);
    const SUBJECT: Uuid = Uuid::from_u128(0x5ab1);

    fn request(resource_type: &str) -> EvaluationRequest {
        EvaluationRequest {
            subject: Subject {
                id: SUBJECT,
                subject_type: Some("user".to_string()),
                properties: HashMap::new(),
            },
            action: Action {
                name: "list".to_string(),
            },
            resource: Resource {
                resource_type: resource_type.to_string(),
                id: None,
                properties: HashMap::new(),
            },
            context: EvaluationRequestContext {
                tenant_context: Some(TenantContext {
                    root_id: Some(TENANT),
                    ..TenantContext::default()
                }),
                token_scopes: Vec::new(),
                require_constraints: true,
                capabilities: Vec::new(),
                supported_properties: Vec::new(),
                bearer_token: None,
            },
        }
    }

    /// Every resource type this deployment actually serves, near enough: one
    /// per gear that has a REST surface worth authorizing.
    const STUDIO_RESOURCES: [&str; 6] = [
        "gts.cf.studio.doc.document.v1~",
        "gts.cf.studio.session.session.v1~",
        "gts.cf.studio.connector.connection.v1~",
        "gts.cf.studio.artifact.issue.v1~",
        "gts.cf.core.rg.group.v1~",
        "gts.cf.core.users.user.v1~",
    ];

    const ORG_A: Uuid = Uuid::from_u128(0xa1);
    const ORG_B: Uuid = Uuid::from_u128(0xb2);

    /// A request that can express the subtree predicates, so the clamp's
    /// hierarchy arms are actually built.
    fn hierarchical(resource_type: &str) -> EvaluationRequest {
        let mut r = request(resource_type);
        r.context.capabilities = vec![Capability::TenantHierarchy];
        r.context.supported_properties = vec![
            pep_properties::OWNER_TENANT_ID.to_string(),
            pep_properties::RESOURCE_ID.to_string(),
        ];
        r
    }

    fn owner_tenant_values(constraints: &[Constraint]) -> Vec<Uuid> {
        constraints
            .iter()
            .flat_map(|c| &c.predicates)
            .filter_map(|p| match p {
                Predicate::In(inp) => Some(inp),
                _ => None,
            })
            .flat_map(|inp| inp.values.iter())
            .filter_map(|v| v.as_str().and_then(|s| Uuid::parse_str(s).ok()))
            .collect()
    }

    fn subtree_roots(constraints: &[Constraint]) -> Vec<Uuid> {
        constraints
            .iter()
            .flat_map(|c| &c.predicates)
            .filter_map(|p| match p {
                // The root is carried as a JSON value, so the test reads it the
                // same way the PEP compiler does.
                Predicate::InTenantSubtree(t) => t
                    .root_tenant_id
                    .as_str()
                    .and_then(|s| Uuid::parse_str(s).ok()),
                _ => None,
            })
            .collect()
    }

    /// The point of reading memberships: a person reaches the organizations
    /// they belong to, not only the one their token names.
    #[test]
    fn the_clamp_covers_every_tenant_the_caller_may_reach() {
        let c = tenant_constraints(&hierarchical(STUDIO_RESOURCES[0]), &[TENANT, ORG_A, ORG_B]);
        let mut owners = owner_tenant_values(&c);
        owners.sort();
        let mut expected = vec![TENANT, ORG_A, ORG_B];
        expected.sort();
        assert_eq!(owners, expected, "every reachable tenant is in the IN arm");

        // One subtree arm per tenant per supported property: `InTenantSubtree`
        // carries a single root, so a set is a list of arms.
        let roots = subtree_roots(&c);
        for tid in [TENANT, ORG_A, ORG_B] {
            assert_eq!(
                roots.iter().filter(|r| **r == tid).count(),
                2,
                "{tid} needs a subtree arm for the owner tenant and one for the resource"
            );
        }
    }

    /// With one tenant the clamp is what it always was — this change widens and
    /// never narrows, which is what makes it safe to land before the things
    /// that still read the token's tenant are gone.
    #[test]
    fn one_tenant_produces_the_clamp_it_always_did() {
        let c = tenant_constraints(&hierarchical(STUDIO_RESOURCES[0]), &[TENANT]);
        assert_eq!(owner_tenant_values(&c), vec![TENANT]);
        assert_eq!(subtree_roots(&c), vec![TENANT, TENANT]);
    }

    /// A gear that cannot express subtrees still gets the flat arm, and it
    /// still lists every reachable tenant.
    #[test]
    fn without_the_hierarchy_capability_the_flat_arm_still_covers_the_set() {
        let c = tenant_constraints(&request(STUDIO_RESOURCES[0]), &[TENANT, ORG_A]);
        assert!(
            subtree_roots(&c).is_empty(),
            "no capability, no subtree arms"
        );
        let mut owners = owner_tenant_values(&c);
        owners.sort();
        let mut expected = vec![TENANT, ORG_A];
        expected.sort();
        assert_eq!(owners, expected);
    }

    /// Duplicates never reach the clamp: a person whose token already names one
    /// of their organizations gets it once.
    #[test]
    fn a_tenant_already_present_is_not_added_twice() {
        let mut tids = vec![TENANT];
        extend_unique(&mut tids, &[ORG_A, TENANT, ORG_A]);
        assert_eq!(tids, vec![TENANT, ORG_A]);
    }

    /// The read that would recurse must be guarded, or the PDP asks itself
    /// whether it may ask itself.
    #[test]
    fn the_access_config_read_is_guarded() {
        assert!(
            is_recursion_guarded(ACCESS_METADATA_TYPE),
            "authorizing the config read must not require the config"
        );
        for family in RECURSION_GUARDED_FAMILIES {
            assert!(is_recursion_guarded(&format!("{family}~")));
        }
    }

    /// The point of comparing families rather than searching for a substring.
    /// Each of these contains the words the old guard looked for, and none of
    /// them is an account-management type — so each would have been exempted
    /// from a role gate it was never meant to escape.
    #[test]
    fn a_type_that_merely_contains_the_words_is_not_guarded() {
        for impostor in [
            // Another vendor's tenant type.
            "gts.acme.am.tenant.v1~",
            // A Studio type that grows a metadata segment of its own.
            "gts.cf.studio.doc.tenant_metadata.v1~",
            // A near-miss on the family name itself.
            "gts.cf.core.am.tenanted.v1~",
        ] {
            assert!(
                !is_recursion_guarded(impostor),
                "{impostor} is not an account-management type and must stay gateable"
            );
        }
    }

    #[test]
    fn a_derived_type_belongs_to_its_base_family() {
        assert_eq!(
            family_of("gts.cf.core.am.tenant_metadata.v1~cf.studio.access.config.v1~"),
            "gts.cf.core.am.tenant_metadata.v1"
        );
        // An id with no chain at all is its own family.
        assert_eq!(
            family_of("gts.cf.studio.doc.document.v1"),
            "gts.cf.studio.doc.document.v1"
        );
    }

    #[test]
    fn a_request_with_no_tenant_is_denied() {
        let mut req = request(STUDIO_RESOURCES[0]);
        req.context.tenant_context = None;
        assert_eq!(Plan::for_request(&req), Plan::Deny);
    }

    /// The nil uuid is what an unset tenant deserialises to, and it addresses
    /// nothing — treating it as a tenant would clamp to a scope that matches
    /// every row whose tenant was never set.
    #[test]
    fn the_nil_tenant_is_denied() {
        let mut req = request(STUDIO_RESOURCES[0]);
        req.context.tenant_context = Some(TenantContext {
            root_id: Some(Uuid::nil()),
            ..TenantContext::default()
        });
        assert_eq!(Plan::for_request(&req), Plan::Deny);
    }

    /// The anti-lockout backstop: a first-party caller is never role-gated, so
    /// a broken access config can never lock the platform out of itself.
    #[test]
    fn an_unrestricted_token_is_clamped_without_a_config_read() {
        let mut req = request(STUDIO_RESOURCES[0]);
        req.context.token_scopes = vec!["*".to_string()];
        assert_eq!(Plan::for_request(&req), Plan::Clamp(TENANT));
    }

    /// The recursion guard. Reading the access config is itself an
    /// account-management metadata read, which this plugin authorizes — so
    /// deciding that read by reading the config would not terminate.
    #[test]
    fn a_tenant_metadata_read_is_answered_without_reading_the_config() {
        for resource_type in [
            "gts.cf.core.am.tenant_metadata.v1~cf.studio.access.config.v1~",
            "gts.cf.core.am.tenant.v1~",
        ] {
            assert_eq!(
                Plan::for_request(&request(resource_type)),
                Plan::Clamp(TENANT),
                "{resource_type} must not need the config to be authorized"
            );
        }
    }

    /// The property this restructure exists for. `privilege_for` maps nothing
    /// today, so no request can reach the role path — and therefore none pays
    /// for the config read that only the role path consumes.
    ///
    /// When the first resource type is mapped this test fails, which is the
    /// point: it is the reminder that the config read has just become live,
    /// and that a cache in front of it is then worth having.
    #[test]
    fn nothing_is_role_gated_yet_so_no_request_reaches_the_config() {
        for resource_type in STUDIO_RESOURCES {
            for action in ["list", "get", "create", "update", "delete"] {
                let mut req = request(resource_type);
                req.action.name = action.to_string();
                assert_eq!(
                    Plan::for_request(&req),
                    Plan::Clamp(TENANT),
                    "{action} on {resource_type} reached the role path — `privilege_for` now \
                     maps something, so revisit the config read in `evaluate` (it happens on \
                     every one of these requests) before deleting this test"
                );
            }
        }
    }
}
