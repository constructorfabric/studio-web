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
//! three. Since ADR-0037 the owner grant has exactly one writer, studio-user,
//! and every grant it writes names the canonical person.

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
/// `scopeType` for a grant covering one project of the organization.
const SCOPE_PROJECT: &str = "project";
/// The role key that makes somebody an owner.
pub const ROLE_OWNER: &str = "owner";

/// The Studio privilege catalogue (ADR-0019 §2).
///
/// Each entry is one `(resource type, action)` question the PDP can be asked.
/// `project.*` and `work.*` from the prototype's older catalogue are absent on
/// purpose: projects are account-management tenants (ADR-0010), so reaching one
/// is membership rather than a privilege, and an entry that must be granted to
/// everybody in order not to break them is worse than no entry.
pub const PRIVILEGES: [&str; 14] = [
    "people.view",
    "people.invite",
    "people.manage",
    "access.manage",
    "connector.view",
    "connector.manage",
    "secret.view",
    "secret.manage",
    "document.view",
    "document.edit",
    "session.open",
    // The domain model (ADR-0035): reading and writing its objects are row
    // questions the PDP answers; changing the model is administration.
    "domain.view",
    "domain.edit",
    "domain.model",
];

/// The role ladder a fresh organization is seeded with (ADR-0019 §2).
///
/// This is written into the document rather than supplied by whoever reads it.
/// The prototype fills the ladder in on read, in the browser, which means the
/// stored document never gains it — and a grant naming a role the document does
/// not contain carries nothing. See [`set_owner_grant`] for what that cost.
///
/// `owner` is seeded for editing, not for deciding: an owner's authority does
/// not depend on this array (ADR-0019 §7).
pub(crate) fn default_roles() -> serde_json::Value {
    let except = |missing: &[&str]| -> Vec<&str> {
        PRIVILEGES
            .iter()
            .copied()
            .filter(|p| !missing.contains(p))
            .collect()
    };
    serde_json::json!([
        { "key": ROLE_OWNER, "name": "Owner", "system": true, "privileges": PRIVILEGES },
        { "key": "admin", "name": "Admin", "system": true, "privileges": except(&["access.manage"]) },
        { "key": "editor", "name": "Editor", "system": true, "privileges": [
            "people.view", "document.view", "document.edit",
            "connector.view", "secret.view", "session.open",
            "domain.view", "domain.edit",
        ] },
        { "key": "viewer", "name": "Viewer", "system": true, "privileges":
            PRIVILEGES.iter().filter(|p| p.ends_with(".view")).collect::<Vec<_>>() },
    ])
}

/// The `model` value that turns role evaluation on for an organization.
const MODEL_ROLES: &str = "roles";

/// The subset of the document this assembly writes and asks questions of.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AccessConfig {
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
    /// The project a `project`-scoped grant covers. Unread for `org` grants,
    /// whose scope is the document's own organization.
    #[serde(rename = "scopeId", default)]
    scope_id: Option<String>,
}

impl AccessConfig {
    /// Does the person behind `subjects` hold the organization-wide owner grant?
    ///
    /// `subjects` is every key of one person (`grant_keys_of`): the person id,
    /// which is what a grant names (ADR-0037 §5), and every sign-in subject of
    /// theirs, which is what a grant written before that names. Matching a
    /// single token subject would answer a question about a *login*: the same
    /// human, signed in the other way, would not be the owner.
    #[must_use]
    pub fn grants_ownership_to(&self, subjects: &[String]) -> bool {
        self.grants.iter().any(|g| {
            g.subject_type == SUBJECT_MEMBER
                && subjects.contains(&g.subject_id)
                && g.role_key == ROLE_OWNER
                && g.scope_type == SCOPE_ORG
        })
    }

    /// Has this organization opted into role-based access?
    ///
    /// Everything that exists today answers `false`, which is what keeps
    /// ADR-0019 releasable: a privilege can only ever *add* a way in, and only
    /// where somebody deliberately switched the model.
    #[must_use]
    pub fn is_roles_model(&self) -> bool {
        self.model == MODEL_ROLES
    }

    /// Does `subject` hold `privilege` across the whole organization?
    ///
    /// Only organization-scoped grants count. A project-scoped grant narrows
    /// which rows somebody may touch inside one project; it says nothing about
    /// administering the organization, and reading it as though it did would
    /// let a grant about one project decide who may change memberships.
    ///
    /// `subjects` is every grant key of one person — see
    /// [`Self::grants_ownership_to`] for why that is the unit of the question.
    #[must_use]
    pub fn grants_privilege_to(&self, subjects: &[String], privilege: &str) -> bool {
        self.grants.iter().any(|g| {
            g.subject_type == SUBJECT_MEMBER
                && subjects.contains(&g.subject_id)
                && g.scope_type == SCOPE_ORG
                && self.role_carries(&g.role_key, privilege)
        })
    }

    /// The subjects a member grant places on `project_id`: every
    /// organization-wide grant, and every grant scoped to that project.
    ///
    /// The same set the prototype's project Team screen lists
    /// (`grantsForProject` in `people.tsx`): under the roles model a project's
    /// team is exactly who holds a role there. Team grants are left out, as
    /// they are there — a team is not a person.
    pub fn subjects_granted_on_project<'a>(
        &'a self,
        project_id: &'a str,
    ) -> impl Iterator<Item = &'a str> + 'a {
        self.grants
            .iter()
            .filter(move |g| {
                g.subject_type == SUBJECT_MEMBER
                    && (g.scope_type == SCOPE_ORG
                        || (g.scope_type == SCOPE_PROJECT
                            && g.scope_id.as_deref() == Some(project_id)))
            })
            .map(|g| g.subject_id.as_str())
    }

    /// Does the named role carry `privilege`?
    ///
    /// An owner's authority is definitional rather than looked up (ADR-0019 §7):
    /// a document whose `roles` array does not define `owner` — every document
    /// written before the ladder was seeded — would otherwise strip its owner of
    /// every privilege, `access.manage` included, leaving nobody able to repair
    /// it. The same rule holds in the PDP, and the two must not disagree.
    fn role_carries(&self, role_key: &str, privilege: &str) -> bool {
        role_key == ROLE_OWNER
            || self
                .roles
                .iter()
                .find(|r| r.key == role_key)
                .is_some_and(|r| r.privileges.iter().any(|p| p == privilege))
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

/// Read an organization's access config, or `None` when it could not be read.
///
/// [`read`] folds a failed read into "no grants", which is right for a
/// decision: it denies. It is wrong for a count, where "nobody holds a grant"
/// and "nobody could tell me" must stay two answers. An organization with no
/// document at all is on the `tenant` model, which is a known answer, so it
/// reads as the default document rather than as `None`.
pub async fn try_read(
    am: &dyn AccountManagementClient,
    ctx: &SecurityContext,
    tenant_id: Uuid,
) -> Option<AccessConfig> {
    match am
        .resolve_metadata(ctx, tenant_id, GtsTypeId::new(ACCESS_METADATA_TYPE))
        .await
    {
        Ok(Some(entry)) => serde_json::from_value(entry.value).ok(),
        Ok(None) => Some(AccessConfig::default()),
        Err(_) => None,
    }
}

/// Who an owner grant is for.
pub struct GrantSubject<'a> {
    /// What the grant names: the canonical person id (ADR-0037 §5).
    pub key: &'a str,
    /// What a screen shows for it — `subjectName` in the document.
    pub name: &'a str,
    /// Keys older writers named the same person by — their sign-in subjects.
    /// An owner grant on any of them is removed, whatever `owner` says, so the
    /// person ends up holding at most one, on `key`.
    pub legacy_keys: &'a [String],
}

/// Give a person the organization-wide owner grant, or take it away.
///
/// Idempotent: every matching grant is removed and, for an owner, one is
/// added back, so calling twice leaves one grant and calling with
/// `owner = false` leaves none.
///
/// studio-user is the only caller (ADR-0037 §2): the grant is a projection of
/// an active `owner` membership, and a second writer is how the two drifted.
/// The PDP and `may_administer` match it against the caller's grant keys —
/// the person id and every login — so a grant on the person is the person's
/// however they signed in.
pub async fn set_owner_grant(
    am: &dyn AccountManagementClient,
    ctx: &SecurityContext,
    tenant_id: Uuid,
    tenant_name: &str,
    subject: &GrantSubject<'_>,
    owner: bool,
) -> Result<()> {
    let type_id = GtsTypeId::new(ACCESS_METADATA_TYPE);
    let mut config = match am.get_metadata(ctx, tenant_id, type_id.clone()).await {
        Ok(entry) => entry.value,
        // No document yet: a fresh organization has none until its first grant.
        Err(_) => serde_json::json!({ "model": "tenant", "roles": default_roles(), "grants": [] }),
    };
    let object = config
        .as_object_mut()
        .context("organization access config is not an object")?;

    // Backfill the ladder into a document written before it was seeded. A grant
    // naming a role the document does not define carries no privilege, so an
    // organization switching to the roles model with an empty `roles` array
    // would deny every role-gated request — `access.manage` among them, which
    // is the only way back. Writing the ladder here means the document is
    // repaired the next time anything touches its grants.
    let missing_roles = object
        .get("roles")
        .and_then(serde_json::Value::as_array)
        .is_none_or(Vec::is_empty);
    if missing_roles {
        object.insert("roles".to_owned(), default_roles());
    }
    let grants = object
        .entry("grants")
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .context("organization access grants are not an array")?;

    grants.retain(|grant| {
        let field = |name: &str| grant.get(name).and_then(serde_json::Value::as_str);
        let names_them = field("subjectId")
            .is_some_and(|id| id == subject.key || subject.legacy_keys.iter().any(|k| k == id));
        field("subjectType") != Some(SUBJECT_MEMBER)
            || !names_them
            || field("scopeType") != Some(SCOPE_ORG)
            || field("roleKey") != Some(ROLE_OWNER)
    });
    if owner {
        grants.push(serde_json::json!({
            "id": Uuid::new_v4().to_string(),
            "subjectType": SUBJECT_MEMBER,
            "subjectId": subject.key,
            "subjectName": subject.name,
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

/// Point every member grant of a document at the key `rekey` gives it.
///
/// `rekey` answers with the new key for a grant's `subjectId`, or `None` to
/// leave the grant alone — a subject nobody resolves, a team, a grant already
/// on its person. Returns how many grants changed, after dropping the
/// duplicates a rewrite produces (one person granted the same role on the same
/// scope through two logins is one grant once both name the person). Pure, so
/// the rule is a test.
pub fn rekey_member_grants(
    document: &mut serde_json::Value,
    rekey: &dyn Fn(&str) -> Option<String>,
) -> usize {
    let Some(grants) = document
        .get_mut("grants")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return 0;
    };
    let mut changed = 0;
    for grant in grants.iter_mut() {
        let field = |name: &str| grant.get(name).and_then(serde_json::Value::as_str);
        if field("subjectType") != Some(SUBJECT_MEMBER) {
            continue;
        }
        let Some(new_key) = field("subjectId").and_then(rekey) else {
            continue;
        };
        if field("subjectId") == Some(new_key.as_str()) {
            continue;
        }
        grant["subjectId"] = serde_json::Value::String(new_key);
        changed += 1;
    }
    let before = grants.len();
    let mut seen = std::collections::HashSet::new();
    grants.retain(|grant| {
        let field = |name: &str| {
            grant
                .get(name)
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        seen.insert((
            field("subjectType"),
            field("subjectId"),
            field("roleKey"),
            field("scopeType"),
            // An org grant's scope is the document's own organization, whatever
            // its `scopeId` happens to say.
            if field("scopeType") == SCOPE_ORG {
                String::new()
            } else {
                field("scopeId")
            },
        ))
    });
    changed + (before - grants.len())
}

/// Rewrite one organization's own access config with [`rekey_member_grants`],
/// and write it back only when something changed.
///
/// `resolve` is asked once per distinct member `subjectId` in the document and
/// answers with the key that grant should carry, or `None` to leave it.
///
/// The organization's own document, not the resolved one: rekeying a document
/// inherited from an ancestor would copy the ancestor's grants into this
/// organization. An organization with no document of its own has nothing to
/// rekey.
pub async fn rekey_grants_in<F, Fut>(
    am: &dyn AccountManagementClient,
    ctx: &SecurityContext,
    tenant_id: Uuid,
    resolve: F,
) -> Result<usize>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<Option<String>>>,
{
    let type_id = GtsTypeId::new(ACCESS_METADATA_TYPE);
    let mut document = match am.get_metadata(ctx, tenant_id, type_id.clone()).await {
        Ok(entry) => entry.value,
        Err(toolkit_canonical_errors::CanonicalError::NotFound { .. }) => return Ok(0),
        Err(error) => {
            return Err(anyhow::anyhow!(
                "cannot read the access config of {tenant_id}: {error}"
            ));
        }
    };
    let subjects: std::collections::BTreeSet<String> = document
        .get("grants")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|g| {
            g.get("subjectType").and_then(serde_json::Value::as_str) == Some(SUBJECT_MEMBER)
        })
        .filter_map(|g| g.get("subjectId").and_then(serde_json::Value::as_str))
        .map(str::to_owned)
        .collect();
    let mut keys = std::collections::HashMap::new();
    for subject in subjects {
        if let Some(key) = resolve(subject.clone()).await? {
            keys.insert(subject, key);
        }
    }
    let changed = rekey_member_grants(&mut document, &|s| keys.get(s).cloned());
    if changed > 0 {
        am.upsert_metadata(
            ctx,
            tenant_id,
            UpsertMetadataRequest::new(type_id, document),
        )
        .await
        .map_err(|error| {
            anyhow::anyhow!("cannot write the access config of {tenant_id}: {error}")
        })?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rekey_moves_member_grants_and_folds_what_becomes_the_same() {
        let mut doc = serde_json::json!({ "grants": [
            { "subjectType": "member", "subjectId": "login-a", "roleKey": "owner", "scopeType": "org", "scopeId": "x" },
            { "subjectType": "member", "subjectId": "login-b", "roleKey": "owner", "scopeType": "org", "scopeId": "y" },
            { "subjectType": "member", "subjectId": "person", "roleKey": "viewer", "scopeType": "org" },
            { "subjectType": "team", "subjectId": "login-a", "roleKey": "viewer", "scopeType": "org" },
        ]});
        let rekey = |s: &str| matches!(s, "login-a" | "login-b").then(|| "person".to_owned());
        // Two rewritten, and one of them is now the other's duplicate — an org
        // grant's scope is the document's organization, whatever `scopeId` says.
        assert_eq!(rekey_member_grants(&mut doc, &rekey), 3);
        let grants = doc["grants"].as_array().unwrap();
        assert_eq!(grants.len(), 3);
        assert_eq!(grants[0]["subjectId"], "person");
        assert_eq!(grants[1]["roleKey"], "viewer");
        assert_eq!(grants[2]["subjectType"], "team", "a team is not a person");
        assert_eq!(rekey_member_grants(&mut doc, &rekey), 0, "idempotent");
    }

    #[test]
    fn a_document_without_grants_rekeys_nothing() {
        let mut doc = serde_json::json!({ "model": "tenant" });
        assert_eq!(rekey_member_grants(&mut doc, &|_| Some("p".to_owned())), 0);
    }

    /// One login, the way every caller looked before a person could have two.
    fn one(subject: &str) -> Vec<String> {
        vec![subject.to_owned()]
    }

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
        assert!(cfg.grants_ownership_to(&one("ada")));
        assert!(!cfg.grants_ownership_to(&one("bob")));
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
            assert!(!cfg.grants_ownership_to(&one("ada")));
        }
    }

    #[test]
    fn a_document_with_no_grants_denies() {
        assert!(!AccessConfig::default().grants_ownership_to(&one("ada")));
        assert!(!config(serde_json::json!({})).grants_ownership_to(&one("ada")));
    }

    /* ── Holding a privilege (ADR-0019 §2, §3) ── */

    fn roles_doc(grants: serde_json::Value) -> AccessConfig {
        config(serde_json::json!({
            "model": "roles", "roles": default_roles(), "grants": grants
        }))
    }

    fn grant(subject: &str, role: &str, scope: &str) -> serde_json::Value {
        serde_json::json!({
            "subjectType": "member", "subjectId": subject,
            "roleKey": role, "scopeType": scope
        })
    }

    /// The property that makes this releasable: every organization that exists
    /// is on the `tenant` model, and there a privilege opens nothing. Ownership
    /// stays the only way in, exactly as before ADR-0019.
    #[test]
    fn the_tenant_model_grants_no_privilege_however_the_roles_read() {
        let cfg = config(serde_json::json!({
            "model": "tenant",
            "roles": default_roles(),
            "grants": [grant("ada", "admin", "org")],
        }));
        assert!(!cfg.is_roles_model());
        assert!(!cfg.grants_ownership_to(&one("ada")));
    }

    #[test]
    fn an_admin_on_the_roles_model_holds_people_manage_but_not_access_manage() {
        let cfg = roles_doc(serde_json::json!([grant("ada", "admin", "org")]));
        assert!(cfg.is_roles_model());
        assert!(cfg.grants_privilege_to(&one("ada"), "people.manage"));
        assert!(cfg.grants_privilege_to(&one("ada"), "people.invite"));
        assert!(
            !cfg.grants_privilege_to(&one("ada"), "access.manage"),
            "ADR-0011 §7: a role is denied operations outside its privilege set"
        );
    }

    #[test]
    fn a_viewer_holds_reads_and_nothing_that_writes() {
        let cfg = roles_doc(serde_json::json!([grant("ada", "viewer", "org")]));
        assert!(cfg.grants_privilege_to(&one("ada"), "people.view"));
        for privilege in ["people.manage", "people.invite", "access.manage"] {
            assert!(
                !cfg.grants_privilege_to(&one("ada"), privilege),
                "a viewer was allowed {privilege}"
            );
        }
    }

    /// ADR-0019 §7 again, from the other side of the assembly: the gear and the
    /// PDP must not disagree about what an owner holds.
    #[test]
    fn an_owner_holds_every_privilege_even_when_the_ladder_is_missing() {
        let cfg = config(serde_json::json!({
            "model": "roles",
            "roles": [],
            "grants": [grant("ada", "owner", "org")],
        }));
        for privilege in PRIVILEGES {
            assert!(
                cfg.grants_privilege_to(&one("ada"), privilege),
                "an owner was denied {privilege} because the document omits the role"
            );
        }
    }

    #[test]
    fn a_project_is_granted_to_org_wide_grants_and_its_own_only() {
        let cfg = roles_doc(serde_json::json!([
            grant("ada", "owner", "org"),
            { "subjectType": "member", "subjectId": "bob", "roleKey": "editor",
              "scopeType": "project", "scopeId": "p1" },
            { "subjectType": "member", "subjectId": "cy", "roleKey": "editor",
              "scopeType": "project", "scopeId": "p2" },
            { "subjectType": "team", "subjectId": "t", "roleKey": "editor",
              "scopeType": "project", "scopeId": "p1" },
        ]));
        let on = |p: &'static str| cfg.subjects_granted_on_project(p).collect::<Vec<_>>();
        assert_eq!(on("p1"), vec!["ada", "bob"]);
        assert_eq!(on("p2"), vec!["ada", "cy"]);
        assert_eq!(on("p3"), vec!["ada"]);
    }

    /// A project grant with no `scopeId` names no project, so it covers none.
    #[test]
    fn a_project_grant_without_a_scope_id_covers_no_project() {
        let cfg = roles_doc(serde_json::json!([grant("bob", "editor", "project")]));
        assert_eq!(cfg.subjects_granted_on_project("p1").count(), 0);
    }

    /// A grant about one project is not authority over the organization.
    #[test]
    fn a_project_scoped_grant_does_not_administer_the_organization() {
        let cfg = roles_doc(serde_json::json!([grant("ada", "admin", "project")]));
        assert!(!cfg.grants_privilege_to(&one("ada"), "people.manage"));
    }

    #[test]
    fn a_member_with_no_grant_holds_nothing() {
        let cfg = roles_doc(serde_json::json!([grant("bob", "admin", "org")]));
        assert!(!cfg.grants_privilege_to(&one("ada"), "people.manage"));
    }

    /// The defect this set exists to close (ADR-0023 follow-up 2). A grant
    /// records whichever login was in front of whoever wrote it. Ada owns the
    /// organization; she also signs in with GitHub. Asked about that login
    /// alone, she is not the owner of the place she owns.
    #[test]
    fn an_owner_is_the_owner_whichever_way_they_signed_in() {
        let cfg = config(serde_json::json!({
            "grants": [grant("ada-keycloak", "owner", "org")]
        }));
        let both = vec!["ada-github".to_owned(), "ada-keycloak".to_owned()];

        assert!(cfg.grants_ownership_to(&both));
        assert!(
            !cfg.grants_ownership_to(&one("ada-github")),
            "this is the old behaviour, kept here to say what changed"
        );
        assert!(cfg.grants_ownership_to(&one("ada-keycloak")));
    }

    /// The set is one person's logins, never a way to borrow somebody else's.
    #[test]
    fn another_persons_login_in_the_set_grants_nothing() {
        let cfg = config(serde_json::json!({
            "grants": [grant("bob", "owner", "org")]
        }));
        assert!(!cfg.grants_ownership_to(&["ada-github".to_owned(), "ada-keycloak".to_owned()]));
    }

    #[test]
    fn a_privilege_follows_the_person_too() {
        let cfg = roles_doc(serde_json::json!([grant("ada-keycloak", "admin", "org")]));
        let both = vec!["ada-github".to_owned(), "ada-keycloak".to_owned()];
        assert!(cfg.grants_privilege_to(&both, "people.manage"));
        assert!(!cfg.grants_privilege_to(&both, "access.manage"));
    }

    /// The ladder is what a grant's `roleKey` is resolved against, so every key
    /// the writer can produce has to exist in it.
    #[test]
    fn the_seeded_ladder_defines_the_role_the_owner_grant_names() {
        let roles = default_roles();
        let keys: Vec<&str> = roles
            .as_array()
            .expect("the ladder is an array")
            .iter()
            .map(|r| r["key"].as_str().expect("a role has a key"))
            .collect();
        assert!(
            keys.contains(&ROLE_OWNER),
            "set_owner_grant writes roleKey {ROLE_OWNER}, and the ladder must define it"
        );
        assert_eq!(keys, [ROLE_OWNER, "admin", "editor", "viewer"]);
    }

    /// ADR-0019 §2: an administrator runs the organization; redefining the
    /// roles themselves is the one thing that decides who may do any of it.
    #[test]
    fn admin_holds_everything_except_redefining_access() {
        let roles = default_roles();
        let privileges = |key: &str| -> Vec<String> {
            roles
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["key"] == key)
                .expect("role present")["privileges"]
                .as_array()
                .expect("privileges is an array")
                .iter()
                .map(|p| p.as_str().expect("a privilege is a string").to_owned())
                .collect()
        };

        let owner = privileges(ROLE_OWNER);
        assert_eq!(
            owner.len(),
            PRIVILEGES.len(),
            "the owner ladder is the whole catalogue"
        );

        let admin = privileges("admin");
        assert!(!admin.contains(&"access.manage".to_owned()));
        assert!(admin.contains(&"people.manage".to_owned()));
        assert_eq!(admin.len(), PRIVILEGES.len() - 1);

        let viewer = privileges("viewer");
        assert!(
            viewer.iter().all(|p| p.ends_with(".view")),
            "a viewer holds only reads, got {viewer:?}"
        );
        assert!(!viewer.is_empty());
    }
    /// Both guards below were a TypeScript test that PARSED THIS FILE with a
    /// regular expression, because the portal kept a second copy of the
    /// catalogue. The copy is gone — the portal reads
    /// `GET /studio-organizations/v1/access-catalogue` — so the rules come
    /// home to the side that owns them.
    #[test]
    fn no_role_in_the_ladder_names_a_privilege_that_does_not_exist() {
        // A role naming an unknown privilege is not a compile error and not a
        // runtime one: the PDP simply never matches it, and the role silently
        // carries less than it says.
        for role in default_roles().as_array().expect("the ladder is an array") {
            let key = role["key"].as_str().expect("a role has a key");
            for privilege in role["privileges"].as_array().expect("an array") {
                let id = privilege.as_str().expect("a privilege is a string");
                assert!(
                    PRIVILEGES.contains(&id),
                    "role {key} names unknown privilege {id}"
                );
            }
        }
    }

    #[test]
    fn the_catalogue_names_nothing_the_product_retired() {
        // Projects are account-management tenants (ADR-0010), so reaching one
        // is membership; `studio-project` — the gear "Works" belonged to — is
        // gone. A privilege for either would have to be granted to everybody
        // in order not to break them, which is worse than no privilege.
        for id in PRIVILEGES {
            assert!(
                !id.starts_with("project.") && !id.starts_with("work."),
                "{id} names a retired resource"
            );
        }
    }

    #[test]
    fn every_privilege_is_a_resource_and_an_action() {
        // The shape the PDP splits on. An id with no dot, or with two, is not
        // a question anybody can be asked.
        for id in PRIVILEGES {
            assert_eq!(
                id.split('.').count(),
                2,
                "{id} is not `<resource>.<action>`"
            );
        }
    }
}
