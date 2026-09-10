use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use account_management_sdk::{AccountManagementClient, UpsertMetadataRequest};
use anyhow::{Context, Result, bail};
use gts::GtsTypeId;
use reqwest::Client;
use serde::Deserialize;
use toolkit_security::SecurityContext;
use uuid::Uuid;

pub const PLATFORM_ROOT_TENANT_ID: Uuid = Uuid::from_u128(1);
const HOME_TENANT_ATTRIBUTE: &str = "tenant_id";
const ORGANIZATION_ROLE_ATTRIBUTE: &str = "studio_organization_role";
const TENANT_GROUP_ROOT: &str = "tenants";
const ACCESS_METADATA_TYPE: &str = "gts.cf.core.am.tenant_metadata.v1~cf.studio.access.config.v1~";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryIdentity {
    pub id: String,
    pub username: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub identity_provider: Option<String>,
    pub first_seen_at_epoch_ms: Option<i64>,
    pub status: &'static str,
    pub home_tenant_id: Option<Uuid>,
    pub home_tenant_name: Option<String>,
    pub organization_role: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FederatedIdentity {
    identity_provider: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeycloakUser {
    id: String,
    #[serde(default)]
    username: String,
    email: Option<String>,
    first_name: Option<String>,
    last_name: Option<String>,
    created_timestamp: Option<i64>,
    service_account_client_id: Option<String>,
    #[serde(default)]
    attributes: HashMap<String, Vec<String>>,
    #[serde(default)]
    federated_identities: Vec<FederatedIdentity>,
}

/// Does this Keycloak user belong in the directory at all?
///
/// Service accounts do not: they are clients, they never sign in, and an
/// onboarding screen that lists them is asking an administrator to place a
/// robot in an organization.
fn is_directory_identity(user: &KeycloakUser) -> bool {
    user.service_account_client_id.is_none()
}

/// The tenant an identity's `tenant_id` attribute asks for, when it parses.
///
/// Asking is not being: the attribute is written by whoever provisioned the
/// user and is not evidence the tenant exists or is visible here. Only
/// [`DirectoryIdentity::project`] decides what it means.
fn requested_tenant(user: &KeycloakUser) -> Option<Uuid> {
    user.attributes
        .get(HOME_TENANT_ATTRIBUTE)
        .and_then(|values| values.first())
        .and_then(|value| Uuid::parse_str(value).ok())
}

impl DirectoryIdentity {
    /// One Keycloak identity as the directory reports it.
    ///
    /// `home_tenant_name` is the identity's requested tenant *as resolved
    /// through account-management* — `None` when it requested none, and also
    /// `None` when it requested one that could not be read. Those collapse on
    /// purpose: an attribute naming a tenant that does not resolve is not an
    /// assignment, so the identity reads as `unassigned` and its
    /// `home_tenant_id` is dropped rather than shown. A stale or forged
    /// attribute must not make somebody look placed.
    fn project(user: KeycloakUser, home_tenant_name: Option<String>) -> Self {
        let home_tenant_id = requested_tenant(&user).filter(|_| home_tenant_name.is_some());
        let status = if home_tenant_id == Some(PLATFORM_ROOT_TENANT_ID) {
            "platform_admin"
        } else if home_tenant_id.is_some() {
            "assigned"
        } else {
            "unassigned"
        };
        let display_name = [user.first_name.as_deref(), user.last_name.as_deref()]
            .into_iter()
            .flatten()
            .filter(|part| !part.trim().is_empty())
            .collect::<Vec<_>>()
            .join(" ");

        Self {
            id: user.id,
            username: user.username,
            email: user.email,
            display_name: (!display_name.is_empty()).then_some(display_name),
            identity_provider: user
                .federated_identities
                .first()
                .map(|identity| identity.identity_provider.clone()),
            first_seen_at_epoch_ms: user.created_timestamp,
            status,
            home_tenant_id,
            home_tenant_name,
            organization_role: user
                .attributes
                .get(ORGANIZATION_ROLE_ATTRIBUTE)
                .and_then(|values| values.first())
                .cloned(),
        }
    }
}

/// Newest first, ties broken by username.
///
/// The screen this feeds is an onboarding queue, so the people who just
/// arrived and are waiting to be placed belong at the top. Username breaks the
/// tie because Keycloak's creation timestamp is optional, and identities that
/// have none must still come out in a stable order.
fn sort_identities(identities: &mut [DirectoryIdentity]) {
    identities.sort_by(|left, right| {
        right
            .first_seen_at_epoch_ms
            .cmp(&left.first_seen_at_epoch_ms)
            .then_with(|| left.username.cmp(&right.username))
    });
}

#[derive(Debug, Deserialize)]
struct KeycloakGroup {
    id: String,
    name: String,
    path: String,
}

pub struct IdentityDirectoryService {
    http: Client,
    admin_base_url: String,
    realm: String,
    client_id: String,
    client_secret: String,
    account_management: Arc<dyn AccountManagementClient>,
}

impl IdentityDirectoryService {
    pub fn new(
        admin_base_url: String,
        realm: String,
        client_id: String,
        client_secret: String,
        account_management: Arc<dyn AccountManagementClient>,
    ) -> Result<Self> {
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(Self {
            http,
            admin_base_url: admin_base_url.trim_end_matches('/').to_owned(),
            realm,
            client_id,
            client_secret,
            account_management,
        })
    }

    async fn admin_token(&self) -> Result<String> {
        let url = format!(
            "{}/realms/{}/protocol/openid-connect/token",
            self.admin_base_url, self.realm
        );
        let response = self
            .http
            .post(url)
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
            ])
            .send()
            .await
            .context("request Keycloak admin access token")?
            .error_for_status()
            .context("Keycloak rejected identity-directory client credentials")?
            .json::<TokenResponse>()
            .await
            .context("decode Keycloak admin access token response")?;
        if response.access_token.is_empty() {
            bail!("Keycloak returned an empty admin access token");
        }
        Ok(response.access_token)
    }

    async fn keycloak_users(&self, token: &str) -> Result<Vec<KeycloakUser>> {
        let url = format!("{}/admin/realms/{}/users", self.admin_base_url, self.realm);
        self.http
            .get(url)
            .bearer_auth(token)
            .query(&[
                ("first", "0"),
                ("max", "200"),
                ("briefRepresentation", "false"),
            ])
            .send()
            .await
            .context("list Keycloak users")?
            .error_for_status()
            .context("Keycloak rejected the identity-directory request")?
            .json::<Vec<KeycloakUser>>()
            .await
            .context("decode Keycloak users response")
    }

    async fn tenant_group(&self, token: &str, tenant_id: Uuid) -> Result<KeycloakGroup> {
        let groups_url = format!("{}/admin/realms/{}/groups", self.admin_base_url, self.realm);
        let parent = self
            .http
            .get(groups_url)
            .bearer_auth(token)
            .query(&[
                ("search", TENANT_GROUP_ROOT),
                ("exact", "true"),
                ("briefRepresentation", "false"),
            ])
            .send()
            .await
            .context("find Keycloak tenant group root")?
            .error_for_status()
            .context("Keycloak rejected the tenant group root lookup")?
            .json::<Vec<KeycloakGroup>>()
            .await
            .context("decode Keycloak tenant group root")?
            .into_iter()
            .find(|group| {
                group.name == TENANT_GROUP_ROOT && group.path == format!("/{TENANT_GROUP_ROOT}")
            })
            .context("Keycloak tenant group root does not exist")?;

        let children_url = format!(
            "{}/admin/realms/{}/groups/{}/children",
            self.admin_base_url, self.realm, parent.id
        );
        let tenant_name = tenant_id.to_string();
        self.http
            .get(children_url)
            .bearer_auth(token)
            .query(&[
                ("search", tenant_name.as_str()),
                ("exact", "true"),
                ("briefRepresentation", "false"),
            ])
            .send()
            .await
            .context("find Keycloak organization group")?
            .error_for_status()
            .context("Keycloak rejected the organization group lookup")?
            .json::<Vec<KeycloakGroup>>()
            .await
            .context("decode Keycloak organization group")?
            .into_iter()
            .find(|group| {
                group.name == tenant_name
                    && group.path == format!("/{TENANT_GROUP_ROOT}/{tenant_name}")
            })
            .context("Keycloak organization group does not exist")
    }

    async fn sync_tenant_group_membership(
        &self,
        token: &str,
        identity_id: Uuid,
        tenant_id: Uuid,
    ) -> Result<()> {
        let target = self.tenant_group(token, tenant_id).await?;
        let groups_url = format!(
            "{}/admin/realms/{}/users/{}/groups",
            self.admin_base_url, self.realm, identity_id
        );
        let current = self
            .http
            .get(&groups_url)
            .bearer_auth(token)
            .query(&[
                ("first", "0"),
                ("max", "200"),
                ("briefRepresentation", "false"),
            ])
            .send()
            .await
            .context("list Keycloak user groups")?
            .error_for_status()
            .context("Keycloak rejected the user group lookup")?
            .json::<Vec<KeycloakGroup>>()
            .await
            .context("decode Keycloak user groups")?;

        let tenant_path_prefix = format!("/{TENANT_GROUP_ROOT}/");
        for group in current
            .into_iter()
            .filter(|group| group.path.starts_with(&tenant_path_prefix) && group.id != target.id)
        {
            let membership_url = format!("{groups_url}/{}", group.id);
            self.http
                .delete(membership_url)
                .bearer_auth(token)
                .send()
                .await
                .context("remove stale Keycloak organization membership")?
                .error_for_status()
                .context("Keycloak rejected stale organization membership removal")?;
        }

        let membership_url = format!("{groups_url}/{}", target.id);
        self.http
            .put(membership_url)
            .bearer_auth(token)
            .send()
            .await
            .context("add Keycloak organization membership")?
            .error_for_status()
            .context("Keycloak rejected the organization membership")?;
        Ok(())
    }

    pub async fn list(&self, ctx: &SecurityContext) -> Result<Vec<DirectoryIdentity>> {
        let token = self.admin_token().await?;
        let users = self.keycloak_users(&token).await?;
        let mut tenants = HashMap::<Uuid, Option<String>>::new();
        let mut identities = Vec::with_capacity(users.len());

        for user in users {
            if !is_directory_identity(&user) {
                continue;
            }

            let requested_tenant = requested_tenant(&user);

            let home_tenant_name = if let Some(tenant_id) = requested_tenant {
                if let Some(cached) = tenants.get(&tenant_id) {
                    cached.clone()
                } else {
                    let resolved = self
                        .account_management
                        .get_tenant(ctx, tenant_id)
                        .await
                        .ok()
                        .map(|tenant| tenant.name);
                    tenants.insert(tenant_id, resolved.clone());
                    resolved
                }
            } else {
                None
            };

            identities.push(DirectoryIdentity::project(user, home_tenant_name));
        }

        sort_identities(&mut identities);
        Ok(identities)
    }

    /// Assign an existing Keycloak identity to an Account Management tenant.
    ///
    /// Account Management's user surface is an IdP-backed projection. Tokens
    /// use the `tenant_id` attribute while tenant-scoped user listing uses the
    /// matching Keycloak group, so assignment must update both representations.
    pub async fn assign(
        &self,
        ctx: &SecurityContext,
        identity_id: &str,
        tenant_id: Uuid,
        organization_role: &str,
    ) -> Result<()> {
        let identity_id = Uuid::parse_str(identity_id).context("identity id is not a UUID")?;
        let identity_id_string = identity_id.to_string();
        let tenant = self
            .account_management
            .get_tenant(ctx, tenant_id)
            .await
            .map_err(|error| anyhow::anyhow!("cannot resolve target organization: {error}"))?;

        let token = self.admin_token().await?;
        let url = format!(
            "{}/admin/realms/{}/users/{}",
            self.admin_base_url, self.realm, identity_id
        );
        let mut user = self
            .http
            .get(&url)
            .bearer_auth(&token)
            .send()
            .await
            .context("get Keycloak user for organization assignment")?
            .error_for_status()
            .context("Keycloak rejected the user lookup")?
            .json::<serde_json::Value>()
            .await
            .context("decode Keycloak user representation")?;

        let attributes = user
            .as_object_mut()
            .context("Keycloak user representation is not an object")?
            .entry("attributes")
            .or_insert_with(|| serde_json::json!({}));
        let attributes = attributes
            .as_object_mut()
            .context("Keycloak user attributes are not an object")?;
        attributes.insert(
            HOME_TENANT_ATTRIBUTE.to_owned(),
            serde_json::json!([tenant_id.to_string()]),
        );
        attributes.insert(
            ORGANIZATION_ROLE_ATTRIBUTE.to_owned(),
            serde_json::json!([organization_role]),
        );

        // Owner is also a real organization-wide access grant understood by
        // Studio's PDP. Member is tenant membership without that elevated
        // grant; project roles can still be assigned independently.
        self.set_owner_grant(
            ctx,
            tenant_id,
            &tenant.name,
            &identity_id_string,
            organization_role == "owner",
        )
        .await?;

        self.http
            .put(url)
            .bearer_auth(&token)
            .json(&user)
            .send()
            .await
            .context("update Keycloak organization assignment")?
            .error_for_status()
            .context("Keycloak rejected the organization assignment")?;

        // Account Management's Keycloak IdP projection lists members from
        // the per-tenant group, not from the `tenant_id` attribute. Keep both
        // representations synchronized so assigned identities immediately
        // appear in the organization's People screen.
        self.sync_tenant_group_membership(&token, identity_id, tenant_id)
            .await?;
        Ok(())
    }

    async fn set_owner_grant(
        &self,
        ctx: &SecurityContext,
        tenant_id: Uuid,
        tenant_name: &str,
        identity_id: &str,
        owner: bool,
    ) -> Result<()> {
        let type_id = GtsTypeId::new(ACCESS_METADATA_TYPE);
        let mut config = match self
            .account_management
            .get_metadata(ctx, tenant_id, type_id.clone())
            .await
        {
            Ok(entry) => entry.value,
            Err(_) => serde_json::json!({ "model": "tenant", "roles": [], "grants": [] }),
        };
        let config_object = config
            .as_object_mut()
            .context("organization access config is not an object")?;
        let grants = config_object
            .entry("grants")
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .context("organization access grants are not an array")?;
        grants.retain(|grant| {
            grant.get("subjectType").and_then(|value| value.as_str()) != Some("member")
                || grant.get("subjectId").and_then(|value| value.as_str()) != Some(identity_id)
                || grant.get("scopeType").and_then(|value| value.as_str()) != Some("org")
                || grant.get("roleKey").and_then(|value| value.as_str()) != Some("owner")
        });
        if owner {
            grants.push(serde_json::json!({
                "id": Uuid::new_v4().to_string(),
                "subjectType": "member",
                "subjectId": identity_id,
                "subjectName": identity_id,
                "roleKey": "owner",
                "scopeType": "org",
                "scopeId": tenant_id.to_string(),
                "scopeName": tenant_name,
            }));
        }
        self.account_management
            .upsert_metadata(ctx, tenant_id, UpsertMetadataRequest::new(type_id, config))
            .await
            .map_err(|error| anyhow::anyhow!("cannot update organization owner grant: {error}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    //! The directory's judgement, without Keycloak.
    //!
    //! `list` is a Keycloak call, a tenant lookup per distinct attribute, and
    //! the decisions below. Only the decisions are worth pinning, and they are
    //! the part an administrator acts on: this screen is where somebody is
    //! placed into an organization.
    //!
    //! Fixtures are built from JSON rather than by constructing `KeycloakUser`,
    //! so the field names Keycloak actually sends are under test too. A realm
    //! that renamed `serviceAccountClientId` would otherwise start listing
    //! robots and nothing here would notice.

    use serde_json::json;

    use super::{
        DirectoryIdentity, KeycloakUser, PLATFORM_ROOT_TENANT_ID, is_directory_identity,
        sort_identities,
    };

    fn user(value: serde_json::Value) -> KeycloakUser {
        serde_json::from_value(value).expect("a Keycloak user shape")
    }

    fn person() -> serde_json::Value {
        json!({
            "id": "3f1b0c58-0000-0000-0000-000000000001",
            "username": "ada",
            "email": "ada@example.org",
            "firstName": "Ada",
            "lastName": "Lovelace",
            "createdTimestamp": 1_700_000_000_000_i64,
        })
    }

    fn with_tenant(mut value: serde_json::Value, tenant: &str) -> serde_json::Value {
        value["attributes"] = json!({ "tenant_id": [tenant] });
        value
    }

    #[test]
    fn a_service_account_is_not_an_identity_to_place() {
        let mut robot = person();
        robot["serviceAccountClientId"] = json!("studio-backend");
        assert!(!is_directory_identity(&user(robot)));
        assert!(is_directory_identity(&user(person())));
    }

    #[test]
    fn an_identity_with_no_tenant_attribute_is_unassigned() {
        let identity = DirectoryIdentity::project(user(person()), None);
        assert_eq!(identity.status, "unassigned");
        assert_eq!(identity.home_tenant_id, None);
    }

    #[test]
    fn a_resolved_tenant_makes_it_assigned() {
        let tenant = "6f9619ff-8b86-d011-b42d-00cf4fc964ff";
        let identity = DirectoryIdentity::project(
            user(with_tenant(person(), tenant)),
            Some("Constructor".to_string()),
        );
        assert_eq!(identity.status, "assigned");
        assert_eq!(
            identity.home_tenant_id.map(|id| id.to_string()).as_deref(),
            Some(tenant)
        );
        assert_eq!(identity.home_tenant_name.as_deref(), Some("Constructor"));
    }

    /// The one worth having. An attribute is a claim, not an assignment: if the
    /// tenant it names cannot be read, the identity is still waiting to be
    /// placed, and the directory must not show it as belonging anywhere.
    #[test]
    fn a_tenant_that_does_not_resolve_is_not_an_assignment() {
        let identity = DirectoryIdentity::project(
            user(with_tenant(
                person(),
                "6f9619ff-8b86-d011-b42d-00cf4fc964ff",
            )),
            None,
        );
        assert_eq!(identity.status, "unassigned");
        assert_eq!(
            identity.home_tenant_id, None,
            "an unresolved tenant must not be reported as this identity's home"
        );
    }

    /// Same rule, and the case where getting it wrong is worst: an attribute
    /// naming the platform root would otherwise present as a platform admin.
    #[test]
    fn an_unresolved_root_tenant_does_not_confer_platform_admin() {
        let identity = DirectoryIdentity::project(
            user(with_tenant(person(), &PLATFORM_ROOT_TENANT_ID.to_string())),
            None,
        );
        assert_eq!(identity.status, "unassigned");
    }

    #[test]
    fn the_root_tenant_reads_as_platform_admin() {
        let identity = DirectoryIdentity::project(
            user(with_tenant(person(), &PLATFORM_ROOT_TENANT_ID.to_string())),
            Some("root".to_string()),
        );
        assert_eq!(identity.status, "platform_admin");
    }

    /// A tenant attribute that is not a uuid is no different from none.
    #[test]
    fn an_unparsable_tenant_attribute_is_ignored() {
        let identity = DirectoryIdentity::project(user(with_tenant(person(), "not-a-uuid")), None);
        assert_eq!(identity.status, "unassigned");
        assert_eq!(identity.home_tenant_id, None);
    }

    #[test]
    fn the_display_name_joins_the_parts_that_are_there() {
        let identity = DirectoryIdentity::project(user(person()), None);
        assert_eq!(identity.display_name.as_deref(), Some("Ada Lovelace"));

        let mut first_only = person();
        first_only["lastName"] = json!(null);
        let identity = DirectoryIdentity::project(user(first_only), None);
        assert_eq!(identity.display_name.as_deref(), Some("Ada"));
    }

    /// A realm that stores an empty string is the common case: it is not
    /// `null`, and used as-is it renders a name of one space.
    #[test]
    fn blank_name_parts_read_as_absent() {
        let mut blank = person();
        blank["firstName"] = json!("  ");
        blank["lastName"] = json!("");
        assert_eq!(
            DirectoryIdentity::project(user(blank), None).display_name,
            None
        );
    }

    #[test]
    fn the_first_federated_identity_names_the_provider() {
        let mut federated = person();
        federated["federatedIdentities"] = json!([
            { "identityProvider": "github" },
            { "identityProvider": "google" },
        ]);
        let identity = DirectoryIdentity::project(user(federated), None);
        assert_eq!(identity.identity_provider.as_deref(), Some("github"));
        assert_eq!(
            DirectoryIdentity::project(user(person()), None).identity_provider,
            None,
            "a local account has no provider to name"
        );
    }

    #[test]
    fn the_organization_role_comes_from_its_attribute() {
        let mut with_role = person();
        with_role["attributes"] = json!({ "studio_organization_role": ["owner"] });
        let identity = DirectoryIdentity::project(user(with_role), None);
        assert_eq!(identity.organization_role.as_deref(), Some("owner"));
    }

    #[test]
    fn newest_first_and_ties_broken_by_username() {
        let at = |name: &str, ts: Option<i64>| {
            let mut value = person();
            value["username"] = json!(name);
            value["createdTimestamp"] = ts.map_or(json!(null), |t| json!(t));
            DirectoryIdentity::project(user(value), None)
        };
        let mut identities = vec![
            at("carol", Some(100)),
            at("bob", None),
            at("alice", Some(300)),
            at("dave", Some(300)),
        ];
        sort_identities(&mut identities);

        let order: Vec<&str> = identities.iter().map(|i| i.username.as_str()).collect();
        assert_eq!(
            order,
            ["alice", "dave", "carol", "bob"],
            "newest first; equal timestamps by username; no timestamp last"
        );
    }
}
