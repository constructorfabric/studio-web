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
//! There is no transaction across Postgres and account-management, so the
//! operation is ordered and resumable instead: the writes go in the order above,
//! and a failure names the organization it got as far as creating so the same
//! call can be repeated with `organization_id` to finish the rest. Each write is
//! idempotent on its own, so resuming is safe however far the first attempt got.
//!
//! The order matters. The tenant first, because the other two need its id. The
//! membership before the grant, because membership is the authority: an
//! organization the creator can see but cannot yet administer is a worse state
//! than one they cannot see at all, and the first is what the other order would
//! produce.

use std::sync::Arc;

use account_management_sdk::{AccountManagementClient, CreateTenantRequest};
use anyhow::{Result, anyhow};
use gts::GtsTypeId;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use crate::access_config;
use crate::user_profile::{AssignmentRecorder, MembershipEvictor, OrganizationReader};

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
    Membership,
    Grant,
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
    people: Arc<dyn OrganizationReader>,
    /// The tenant every organization is created under.
    platform_root: Uuid,
}

impl OrganizationService {
    pub(crate) fn new(
        am: Arc<dyn AccountManagementClient>,
        memberships: Arc<dyn AssignmentRecorder>,
        evictions: Arc<dyn MembershipEvictor>,
        people: Arc<dyn OrganizationReader>,
        platform_root: Uuid,
    ) -> Self {
        Self {
            am,
            memberships,
            evictions,
            people,
            platform_root,
        }
    }

    /// May the caller delete this organization?
    ///
    /// Its owner may, and so may a platform administrator — the second for the
    /// case ADR-0018 §6 calls break-glass, where the owner is gone and somebody
    /// still has to dispose of what they left. Nobody else, whatever they can
    /// otherwise reach inside it.
    ///
    /// Ownership is read from the access config rather than from the membership
    /// row because that is the document the authorization policy evaluates, and
    /// a deletion gate that disagreed with the policy would be a gate in name.
    pub async fn may_delete(&self, ctx: &SecurityContext, org_id: Uuid) -> bool {
        let subject = ctx.subject_id().to_string();
        access_config::read(self.am.as_ref(), ctx, org_id)
            .await
            .grants_ownership_to(&subject)
            || self
                .people
                .is_platform_admin(&subject)
                .await
                .unwrap_or(false)
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

        // The authority for access, before the document the PDP happens to read.
        self.memberships
            .record_creation(&subject, org.id)
            .await
            .map_err(|e| (Step::Membership, e, Some(org.id)))?;

        access_config::set_owner_grant(self.am.as_ref(), ctx, org.id, &org.name, &subject, true)
            .await
            .map_err(|e| (Step::Grant, e, Some(org.id)))?;

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
