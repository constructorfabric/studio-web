//! An organization's Studio access config: who holds which role in it.
//!
//! The document lives in account-management's tenant metadata under
//! `cf.studio.access.config.v1~`, and it is what the Studio PDP reads to decide
//! whether a caller holds a privilege (`studio_authz_plugin`). Three places in
//! this assembly used to carry their own copy of its shape — the directory that
//! writes the owner grant, the identity gear that asks whether somebody owns an
//! organization, and the PDP that evaluates it — which is three chances for the
//! written shape and the read shape to disagree about a field name nobody
//! notices until a grant silently stops matching.
//!
//! This module is the shape, the read and the write. The PDP keeps its own
//! deserialization for now: it also carries `roles` and privilege expansion,
//! and it sits on the authorization path where a refactor is not free. Folding
//! it in is worth doing once something else needs roles.
//!
//! **Membership is the authority for organization access (ADR-0011 §2); this
//! document is what the PDP happens to evaluate.** They are written together
//! and must not drift — which is the other reason for one writer rather than
//! three.

use account_management_sdk::{AccountManagementClient, UpsertMetadataRequest};
use anyhow::{Context, Result};
use gts::GtsTypeId;
use serde::Deserialize;
use toolkit_security::SecurityContext;
use uuid::Uuid;

/// The tenant-metadata type the access config is stored under.
pub const ACCESS_METADATA_TYPE: &str =
    "gts.cf.core.am.tenant_metadata.v1~cf.studio.access.config.v1~";

/// `subjectType` for a grant naming one person rather than a team.
const SUBJECT_MEMBER: &str = "member";
/// `scopeType` for a grant covering a whole organization.
const SCOPE_ORG: &str = "org";
/// The role key that makes somebody an owner.
pub const ROLE_OWNER: &str = "owner";

/// The subset of the document this assembly writes and asks questions of.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AccessConfig {
    #[serde(default)]
    grants: Vec<GrantDef>,
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
}

impl AccessConfig {
    /// Does `subject` hold the organization-wide owner grant?
    ///
    /// `subject` is a token subject, because that is what the grants record —
    /// see the note on [`set_owner_grant`].
    #[must_use]
    pub fn grants_ownership_to(&self, subject: &str) -> bool {
        self.grants.iter().any(|g| {
            g.subject_type == SUBJECT_MEMBER
                && g.subject_id == subject
                && g.role_key == ROLE_OWNER
                && g.scope_type == SCOPE_ORG
        })
    }
}

/// Read an organization's effective access config.
///
/// Resolves through the ancestor chain, the same way the PDP sees it. A tenant
/// with no document of its own, or an unreadable one, reads as "no grants" —
/// which denies rather than permits.
pub async fn read(
    am: &dyn AccountManagementClient,
    ctx: &SecurityContext,
    tenant_id: Uuid,
) -> AccessConfig {
    match am
        .resolve_metadata(ctx, tenant_id, GtsTypeId::new(ACCESS_METADATA_TYPE))
        .await
    {
        Ok(Some(entry)) => serde_json::from_value(entry.value).unwrap_or_default(),
        _ => AccessConfig::default(),
    }
}

/// Give `subject` the organization-wide owner grant, or take it away.
///
/// Idempotent: the matching grant is removed and re-added, so calling twice
/// leaves one grant and calling with `owner = false` leaves none.
///
/// `subject` is a **token subject**, not a canonical person id. That is what
/// the PDP matches today (`grant.subjectId == request.subject.id`), so writing
/// anything else here would produce a grant that never matches. Moving the
/// grant model onto the person is ADR-0006 follow-up 2, and it has to move on
/// both sides at once.
pub async fn set_owner_grant(
    am: &dyn AccountManagementClient,
    ctx: &SecurityContext,
    tenant_id: Uuid,
    tenant_name: &str,
    subject: &str,
    owner: bool,
) -> Result<()> {
    let type_id = GtsTypeId::new(ACCESS_METADATA_TYPE);
    let mut config = match am.get_metadata(ctx, tenant_id, type_id.clone()).await {
        Ok(entry) => entry.value,
        // No document yet: a fresh organization has none until its first grant.
        Err(_) => serde_json::json!({ "model": "tenant", "roles": [], "grants": [] }),
    };
    let object = config
        .as_object_mut()
        .context("organization access config is not an object")?;
    let grants = object
        .entry("grants")
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .context("organization access grants are not an array")?;

    grants.retain(|grant| {
        let field = |name: &str| grant.get(name).and_then(serde_json::Value::as_str);
        field("subjectType") != Some(SUBJECT_MEMBER)
            || field("subjectId") != Some(subject)
            || field("scopeType") != Some(SCOPE_ORG)
            || field("roleKey") != Some(ROLE_OWNER)
    });
    if owner {
        grants.push(serde_json::json!({
            "id": Uuid::new_v4().to_string(),
            "subjectType": SUBJECT_MEMBER,
            "subjectId": subject,
            "subjectName": subject,
            "roleKey": ROLE_OWNER,
            "scopeType": SCOPE_ORG,
            "scopeId": tenant_id.to_string(),
            "scopeName": tenant_name,
        }));
    }

    am.upsert_metadata(ctx, tenant_id, UpsertMetadataRequest::new(type_id, config))
        .await
        .map(|_| ())
        .map_err(|error| anyhow::anyhow!("cannot update the organization's owner grant: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(json: serde_json::Value) -> AccessConfig {
        serde_json::from_value(json).expect("valid access config")
    }

    #[test]
    fn an_org_scoped_owner_grant_is_ownership() {
        let cfg = config(serde_json::json!({
            "grants": [{
                "subjectType": "member", "subjectId": "ada",
                "roleKey": "owner", "scopeType": "org"
            }]
        }));
        assert!(cfg.grants_ownership_to("ada"));
        assert!(!cfg.grants_ownership_to("bob"));
    }

    #[test]
    fn a_grant_that_differs_in_any_field_is_not_ownership() {
        // Each of these is one field away from the real thing, and each of them
        // is a way the write side and the read side could quietly disagree.
        for grant in [
            serde_json::json!({"subjectType": "team", "subjectId": "ada", "roleKey": "owner", "scopeType": "org"}),
            serde_json::json!({"subjectType": "member", "subjectId": "ada", "roleKey": "admin", "scopeType": "org"}),
            serde_json::json!({"subjectType": "member", "subjectId": "ada", "roleKey": "owner", "scopeType": "project"}),
        ] {
            let cfg = config(serde_json::json!({ "grants": [grant] }));
            assert!(!cfg.grants_ownership_to("ada"));
        }
    }

    #[test]
    fn a_document_with_no_grants_denies() {
        assert!(!AccessConfig::default().grants_ownership_to("ada"));
        assert!(!config(serde_json::json!({})).grants_ownership_to("ada"));
    }
}
