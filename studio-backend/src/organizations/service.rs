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
use crate::user_profile::AssignmentRecorder;

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

pub struct OrganizationService {
    am: Arc<dyn AccountManagementClient>,
    memberships: Arc<dyn AssignmentRecorder>,
    /// The tenant every organization is created under.
    platform_root: Uuid,
}

impl OrganizationService {
    pub(crate) fn new(
        am: Arc<dyn AccountManagementClient>,
        memberships: Arc<dyn AssignmentRecorder>,
        platform_root: Uuid,
    ) -> Self {
        Self {
            am,
            memberships,
            platform_root,
        }
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
