//! Creating an organization: one operation, three writes, resumable.
//!
//! A person who can sign in may create an organization and owns it (ADR-0018
//! §2). "Owns it" is not one fact in one place — it is three, in two systems:
//!
//! 1. the **tenant** in account-management, which is what an organization *is*;
//! 2. the **membership** `(person, org, owner)`, which is the authority for
//!    organization access (ADR-0011 §2) and what the portal reads;
//! 3. the **owner grant** in the tenant's access config, which is what the
//!    Studio PDP evaluates.
//!
//! This gear writes the first. The other two are facts about a person, and
//! studio-user writes them, in one call (`AssignmentRecorder::record_creation`)
//! — the grant is a projection of the membership, and it has one writer
//! (ADR-0040 §2).
//!
//! There is no transaction across Postgres and account-management, so the
//! operation is ordered and resumable instead: the writes go in the order above,
//! and a failure names the organization it got as far as creating so the same
//! call can be repeated with `organization_id` to finish the rest. Each write is
//! idempotent on its own, so resuming is safe however far the first attempt got.
//!
//! The order matters. The tenant first, because the other two need its id. The
//! membership before the grant, because membership is the authority.

use std::sync::Arc;

use account_management_sdk::{AccountManagementClient, CreateTenantRequest};
use anyhow::{Result, anyhow};
use gts::GtsTypeId;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::user_profile::{
    AssignmentRecorder, MembershipEvictor, OrgAuthority, OrganizationReader, OrganizationRequest,
    OrganizationRequests, RequestRefusal,
};

/// The tenant type an organization has.
///
/// The same id the portal filters the context switcher on; a tenant of any
/// other type is a workspace or a project and never appears as an organization.
pub const ORGANIZATION_TENANT_TYPE: &str =
    "gts.cf.core.am.tenant_type.v1~cf.studio.tenant.organization.v1~";

/// Longest organization name accepted.
///
/// Names are free text and are not unique (ADR-0018 §5); this only stops a name
/// the UI cannot render and the column should not hold.
pub const MAX_NAME_LEN: usize = 120;

/// What a caller gets back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Organization {
    pub id: Uuid,
    pub name: String,
}

/// How far a failed attempt got, so the error can say what to repeat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Tenant,
    /// The membership and the owner grant: one call into studio-user.
    Membership,
}

/// Trim a submitted name and refuse the ones that are not names.
///
/// Pure, so the rule is stated as a test. Uniqueness is deliberately *not*
/// checked: two organizations may share a name, and telling somebody they may
/// not call theirs what they want would be us pretending to know better
/// (ADR-0018 §5).
pub fn clean_name(raw: &str) -> Result<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(anyhow!("an organization needs a name"));
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(anyhow!(
            "an organization name must be at most {MAX_NAME_LEN} characters"
        ));
    }
    Ok(name.to_owned())
}

/// What deleting an organization took with it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Deletion {
    pub people: usize,
    pub connections: usize,
}

pub struct OrganizationService {
    am: Arc<dyn AccountManagementClient>,
    memberships: Arc<dyn AssignmentRecorder>,
    evictions: Arc<dyn MembershipEvictor>,
    authority: Arc<dyn OrgAuthority>,
    /// Organization requests (ADR-0051). Optional: without them the request
    /// routes answer 503 and everything else works.
    requests: Option<Arc<dyn OrganizationRequests>>,
    reader: Option<Arc<dyn OrganizationReader>>,
    /// The tenant every organization is created under.
    platform_root: Uuid,
    /// Where a new organization's domain model is prepared; `None` in tests
    /// and in a build without the domain model.
    hub: Option<Arc<toolkit::client_hub::ClientHub>>,
}

/// Why an approval did not finish.
#[derive(Debug)]
pub enum ApprovalError {
    /// The request is not there, or not pending.
    Refused(RequestRefusal),
    /// The name the administrator gave is not a name.
    BadName(anyhow::Error),
    /// Something failed past the first write. Approving again finishes it.
    Failed(anyhow::Error),
}

impl OrganizationService {
    pub(crate) fn new(
        am: Arc<dyn AccountManagementClient>,
        memberships: Arc<dyn AssignmentRecorder>,
        evictions: Arc<dyn MembershipEvictor>,
        authority: Arc<dyn OrgAuthority>,
        requests: Option<Arc<dyn OrganizationRequests>>,
        reader: Option<Arc<dyn OrganizationReader>>,
        platform_root: Uuid,
    ) -> Self {
        Self {
            am,
            memberships,
            evictions,
            authority,
            requests,
            reader,
            platform_root,
            hub: None,
        }
    }

    /// Prepare each new organization's domain model through the gear the hub
    /// resolves.
    pub(crate) fn with_hub(mut self, hub: Arc<toolkit::client_hub::ClientHub>) -> Self {
        self.hub = Some(hub);
        self
    }

    /// Studio's own model, stored for a new organization with its types
    /// registered, so the first screen and the first gear write find it. A
    /// failure is logged and left to the start-up sweep and the first write:
    /// the organization exists either way.
    async fn prepare_model(&self, ctx: &SecurityContext, org: Uuid) {
        let Some(port) = self
            .hub
            .as_ref()
            .and_then(|h| h.get::<dyn crate::domain_model::port::DomainObjects>().ok())
        else {
            return;
        };
        let prepared = match crate::org_scope::acting_in(ctx, org) {
            Ok(acting) => port.prepare_model(&acting).await,
            Err(e) => Err(anyhow!("{e}")),
        };
        if let Err(e) = prepared {
            tracing::warn!(%org, error = %e, "studio-organizations: the new organization's domain model is not prepared yet");
        }
    }

    /// The request store, when studio-user publishes it.
    pub fn requests(&self) -> Option<&Arc<dyn OrganizationRequests>> {
        self.requests.as_ref()
    }

    /// Is the caller a platform administrator? `false` when nobody can say.
    pub async fn is_platform_admin(&self, ctx: &SecurityContext) -> bool {
        match &self.reader {
            Some(reader) => reader
                .is_platform_admin(&ctx.subject_id().to_string())
                .await
                .unwrap_or(false),
            None => false,
        }
    }

    /// How many organizations the caller owns because they made them, for
    /// the installation's `max_owned`. `None` when studio-user cannot say.
    pub async fn self_made_ownerships(&self, ctx: &SecurityContext) -> Result<Option<usize>> {
        match &self.requests {
            Some(requests) => Ok(Some(requests.self_made_ownerships(ctx).await?)),
            None => Ok(None),
        }
    }

    /// Approve a request: create the organization with the request's id and
    /// make the requester its owner (ADR-0051 §4).
    ///
    /// The tenant first, under the request's id — so a repeated approval finds
    /// the tenant it created rather than making a second one — then
    /// studio-user's half: the owner membership, the owner grant, and the
    /// request marked approved, in that order. `name` overrides the requested
    /// name; the request keeps what was asked for.
    pub async fn approve(
        &self,
        ctx: &SecurityContext,
        id: Uuid,
        name: Option<&str>,
    ) -> Result<OrganizationRequest, ApprovalError> {
        let requests = self
            .requests
            .as_ref()
            .ok_or_else(|| ApprovalError::Failed(anyhow!("studio-user keeps no requests here")))?;
        let request = requests
            .find_request(id)
            .await
            .map_err(ApprovalError::Failed)?
            .ok_or(ApprovalError::Refused(RequestRefusal::NotFound))?;
        if request.status == crate::user_profile::REQUEST_APPROVED
            && request.organization_id == Some(id)
        {
            return Ok(request);
        }
        if request.status != crate::user_profile::REQUEST_PENDING {
            return Err(ApprovalError::Refused(RequestRefusal::NotPending(
                request.status,
            )));
        }
        let name = clean_name(name.unwrap_or(&request.name)).map_err(ApprovalError::BadName)?;

        match self.am.get_tenant(ctx, id).await {
            Ok(tenant) => {
                if tenant.tenant_type.as_deref() != Some(ORGANIZATION_TENANT_TYPE) {
                    return Err(ApprovalError::Failed(anyhow!(
                        "{id} exists and is not an organization"
                    )));
                }
            }
            Err(_) => {
                let create = CreateTenantRequest::new(
                    id,
                    self.platform_root,
                    name,
                    GtsTypeId::new(ORGANIZATION_TENANT_TYPE),
                );
                self.am.create_tenant(ctx, create).await.map_err(|e| {
                    ApprovalError::Failed(anyhow!("cannot create organization {id}: {e}"))
                })?;
            }
        }

        match requests.settle_approval(ctx, id, id).await {
            Ok(Ok(request)) => Ok(request),
            Ok(Err(refusal)) => Err(ApprovalError::Refused(refusal)),
            Err(error) => Err(ApprovalError::Failed(error)),
        }
    }

    /// May the caller delete this organization?
    ///
    /// Its owner may, and so may a platform administrator — the second for the
    /// case ADR-0018 §6 calls break-glass, where the owner is gone and somebody
    /// still has to dispose of what they left. Nobody else, whatever they can
    /// otherwise reach inside it.
    ///
    /// studio-user answers (`OrgAuthority::may_dispose`): who owns an
    /// organization is a fact about people, and this gear does not read the
    /// access config to re-derive it (ADR-0040 §2).
    pub async fn may_delete(&self, ctx: &SecurityContext, org_id: Uuid) -> bool {
        self.authority.may_dispose(ctx, org_id).await
    }

    /// May the caller change the organization's logo? Whoever administers
    /// its access, or a platform administrator.
    pub async fn may_change_logo(&self, ctx: &SecurityContext, org_id: Uuid) -> bool {
        self.authority
            .may_administer(ctx, org_id, super::logo::LOGO_PRIVILEGE)
            .await
    }

    /// The organization's logo, as the caller reads it.
    pub async fn logo(
        &self,
        ctx: &SecurityContext,
        org_id: Uuid,
    ) -> anyhow::Result<Option<super::logo::Logo>> {
        Ok(super::logo::read(&self.am, ctx, org_id)
            .await?
            .map(|(logo, _)| logo))
    }

    /// Keep a new logo for the organization, or remove it with `None`.
    pub async fn set_logo(
        &self,
        org_id: Uuid,
        logo: Option<&super::logo::Logo>,
    ) -> anyhow::Result<()> {
        super::logo::write(&self.am, org_id, logo).await
    }

    /// Create an organization owned by the caller, or finish creating one.
    ///
    /// `resume` carries the id from a previous attempt's error. With it, the
    /// tenant is looked up rather than created and the remaining writes are
    /// repeated; without it, a fresh organization is created.
    pub async fn create(
        &self,
        ctx: &SecurityContext,
        name: &str,
        resume: Option<Uuid>,
    ) -> Result<Organization, (Step, anyhow::Error, Option<Uuid>)> {
        let name = clean_name(name).map_err(|e| (Step::Tenant, e, None))?;
        let subject = ctx.subject_id().to_string();

        let org = match resume {
            Some(id) => self
                .am
                .get_tenant(ctx, id)
                .await
                .map(|t| Organization { id, name: t.name })
                .map_err(|e| {
                    (
                        Step::Tenant,
                        anyhow!("cannot resume organization {id}: {e}"),
                        Some(id),
                    )
                })?,
            None => {
                let id = Uuid::new_v4();
                let request = CreateTenantRequest::new(
                    id,
                    self.platform_root,
                    name.clone(),
                    GtsTypeId::new(ORGANIZATION_TENANT_TYPE),
                );
                self.am.create_tenant(ctx, request).await.map_err(|e| {
                    (
                        Step::Tenant,
                        anyhow!("cannot create organization: {e}"),
                        None,
                    )
                })?;
                Organization { id, name }
            }
        };

        // The membership, and the owner grant the PDP reads, in one call:
        // studio-user writes both, the membership first (ADR-0040 §2).
        self.memberships
            .record_creation(ctx, &subject, org.id)
            .await
            .map_err(|e| (Step::Membership, e, Some(org.id)))?;

        self.prepare_model(ctx, org.id).await;
        Ok(org)
    }

    /// Delete an organization: the memberships first, then the tenant.
    ///
    /// The order is creation's, reversed, and for the same reason creation has
    /// one. The memberships and the personal connections that hang off them live
    /// *inside* the tenant — its metadata holds the connection catalogue — so
    /// removing the tenant first would leave nothing to read them through, and
    /// the credentials of everybody who was in it would stay behind in
    /// credstore. Membership is also the authority for access (ADR-0011 §2):
    /// while it exists the organization is still somebody's, and it must be the
    /// first thing to stop being true.
    ///
    /// Deleting a tenant is a soft delete with a retention window in
    /// account-management, and it refuses a tenant that still has children — a
    /// workspace or a project. That refusal is the right one and is passed
    /// through: an organization with work in it is not something to remove by
    /// answering one prompt.
    ///
    /// Idempotent as far as it can be: emptying an organization with no members
    /// removes nothing, and account-management returns the existing tombstone
    /// for a tenant already deleted.
    pub async fn delete(&self, ctx: &SecurityContext, org_id: Uuid) -> Result<Deletion> {
        let tenant = self
            .am
            .get_tenant(ctx, org_id)
            .await
            .map_err(|e| anyhow!("cannot read organization {org_id}: {e}"))?;
        // A workspace and a project are tenants too, and this route must not be
        // a way to delete one of those by naming it an organization.
        if tenant.tenant_type.as_deref() != Some(ORGANIZATION_TENANT_TYPE) {
            return Err(anyhow!("{org_id} is not an organization"));
        }

        let evicted = self.evictions.evict_everybody(ctx, org_id).await?;
        self.am
            .delete_tenant(ctx, org_id)
            .await
            .map_err(|e| anyhow!("cannot delete organization {org_id}: {e}"))?;
        Ok(Deletion {
            people: evicted.people,
            connections: evicted.connections,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_trimmed_and_kept_as_written() {
        assert_eq!(clean_name("  Acme  ").expect("valid"), "Acme");
        assert_eq!(clean_name("Acme Ltd.").expect("valid"), "Acme Ltd.");
    }

    #[test]
    fn a_name_that_is_only_space_is_not_a_name() {
        assert!(clean_name("   ").is_err());
        assert!(clean_name("").is_err());
    }

    #[test]
    fn the_length_limit_counts_characters_not_bytes() {
        assert!(clean_name(&"я".repeat(MAX_NAME_LEN)).is_ok());
        assert!(clean_name(&"a".repeat(MAX_NAME_LEN + 1)).is_err());
    }

    #[test]
    fn two_organizations_may_share_a_name() {
        // Not a uniqueness check anywhere, on purpose: whether somebody wants a
        // second organization called the same thing is their business
        // (ADR-0018 §5). This test exists so removing that stays a decision.
        assert_eq!(
            clean_name("Acme").expect("valid"),
            clean_name("Acme").expect("valid")
        );
    }
}
