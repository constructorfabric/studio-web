use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use account_management_sdk::AccountManagementClient;
use anyhow::{Context, Result, bail};
use futures_util::stream::{self, StreamExt};
use reqwest::Client;
use serde::Deserialize;
use toolkit_security::SecurityContext;
use tracing::warn;
use uuid::Uuid;

use crate::user_profile::AssignmentRecorder;

pub const PLATFORM_ROOT_TENANT_ID: Uuid = Uuid::from_u128(1);
const HOME_TENANT_ATTRIBUTE: &str = "tenant_id";
const ORGANIZATION_ROLE_ATTRIBUTE: &str = "studio_organization_role";
const TENANT_GROUP_ROOT: &str = "tenants";
/// Records asked for per page of a Keycloak admin listing.
const PAGE_SIZE: usize = 200;
/// Pages one listing will read before giving up and saying so. Ten pages of
/// full representations is already a heavy screen; past that, the answer is
/// that this deployment needs the directory to paginate to its caller rather
/// than read the realm on every load.
const MAX_PAGES: usize = 10;

/// What one read of the realm saw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Directory {
    /// Newest first, ties by username.
    pub identities: Vec<DirectoryIdentity>,
    /// `true` when the read stopped at its page ceiling rather than at the end
    /// of the realm. The caller is then looking at part of the directory, and
    /// saying so is the difference between a screen that is short and a screen
    /// that is wrong.
    pub truncated: bool,
}

/// How many federated-identity lookups the directory listing runs at once.
/// Small on purpose: the listing is capped at 200 users, and the admin API is
/// shared with every other gear that talks to Keycloak.
const FEDERATION_LOOKUP_WINDOW: usize = 8;

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

/// One external account Keycloak has brokered onto a realm user, as the admin
/// API returns it.
///
/// Keycloak does **not** ship this on `UserRepresentation`: neither
/// `GET /users?briefRepresentation=false` nor `GET /users/{id}` carries a
/// `federatedIdentities` key (checked against Keycloak 26.7, the pinned image).
/// It is only available from the dedicated
/// `GET /users/{id}/federated-identity` — which is why this is read one user at
/// a time, and why the field used to be silently absent.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FederatedIdentity {
    identity_provider: String,
    #[serde(default)]
    user_id: String,
    #[serde(default)]
    user_name: String,
}

/// An external account the IdP has confirmed a realm user controls.
///
/// The confirmation is real: the person completed the provider's own
/// authorization flow and the provider named the account it resolved to. That is
/// the same class of proof as a personal access token passing
/// `ConnectorDriver::test()` (ADR-0012 §2) — from a channel that costs the
/// person nothing beyond signing in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FederatedAccount {
    /// The realm's identity-provider alias — `github`, `google`, `microsoft`.
    /// Aligned with the connector provider keys on purpose.
    pub provider: String,
    /// The provider's own stable id for the account.
    pub user_id: String,
    /// The handle at the provider. Empty for a provider that reports none.
    pub user_name: String,
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
            // Not available on a user representation at all — `list` fills it
            // from the dedicated per-user endpoint.
            identity_provider: None,
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

/// Where each page of a listing starts: `0, 200, 400, …`, [`MAX_PAGES`] of
/// them.
///
/// A named iterator rather than an index arithmetic in the loop, because this
/// is where paging goes wrong — a window that never advances asks Keycloak for
/// the same page for ever, and one that advances by the wrong step skips
/// people silently. Both are visible here and neither is visible in a `for`
/// header.
fn page_offsets() -> impl Iterator<Item = usize> {
    (0..MAX_PAGES).map(|page| page * PAGE_SIZE)
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

    /// Read a Keycloak admin listing to its end, a page at a time.
    ///
    /// Keycloak pages everything and defaults to a small window, so a single
    /// request answers "the first N" and says nothing about the rest. That is
    /// the wrong shape for both callers here: the directory sorts what it gets
    /// *after* reading it, so a cap applied in Keycloak's order silently drops
    /// people the screen would have put at the top; and the membership sync
    /// removes the tenant groups it did not ask for, so one it never saw stays.
    ///
    /// [`MAX_PAGES`] bounds it anyway — a realm larger than anyone expected
    /// must not turn one screen into an unbounded number of admin calls. The
    /// flag says whether the ceiling was reached, so a caller can tell the
    /// difference between "that is everyone" and "that is as far as we read".
    async fn paged<T: serde::de::DeserializeOwned>(
        &self,
        token: &str,
        url: &str,
        what: &'static str,
    ) -> Result<(Vec<T>, bool)> {
        let mut out: Vec<T> = Vec::new();
        for offset in page_offsets() {
            let first = offset.to_string();
            let batch = self
                .http
                .get(url)
                .bearer_auth(token)
                .query(&[
                    ("first", first.as_str()),
                    ("max", PAGE_SIZE.to_string().as_str()),
                    ("briefRepresentation", "false"),
                ])
                .send()
                .await
                .with_context(|| format!("list Keycloak {what}"))?
                .error_for_status()
                .with_context(|| format!("Keycloak rejected the {what} listing"))?
                .json::<Vec<T>>()
                .await
                .with_context(|| format!("decode Keycloak {what} response"))?;

            // A short page is the end of the listing — Keycloak has no total
            // to compare against, so this is what "no more" looks like.
            let short = batch.len() < PAGE_SIZE;
            out.extend(batch);
            if short {
                return Ok((out, false));
            }
        }
        Ok((out, true))
    }

    /// Every identity in the realm, and whether the read stopped short of the
    /// end (see [`Self::paged`]).
    async fn keycloak_users(&self, token: &str) -> Result<(Vec<KeycloakUser>, bool)> {
        let url = format!("{}/admin/realms/{}/users", self.admin_base_url, self.realm);
        self.paged(token, &url, "users").await
    }

    /// The external accounts brokered onto one realm user.
    ///
    /// One request per user, because that is the only endpoint that answers it
    /// (see [`FederatedIdentity`]). A realm user with no brokered login gets an
    /// empty list, not an error.
    async fn federated_identities(
        &self,
        token: &str,
        user_id: &str,
    ) -> Result<Vec<FederatedAccount>> {
        let url = format!(
            "{}/admin/realms/{}/users/{}/federated-identity",
            self.admin_base_url, self.realm, user_id
        );
        let identities = self
            .http
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .context("list Keycloak federated identities")?
            .error_for_status()
            .context("Keycloak rejected the federated-identity request")?
            .json::<Vec<FederatedIdentity>>()
            .await
            .context("decode Keycloak federated identities response")?;
        Ok(identities
            .into_iter()
            .map(|identity| FederatedAccount {
                provider: identity.identity_provider,
                user_id: identity.user_id,
                user_name: identity.user_name,
            })
            .collect())
    }

    /// The external accounts brokered onto `subject`, for a caller that already
    /// knows the subject is its own.
    ///
    /// This is the whole surface behind `FederatedIdentityReader`: one subject,
    /// read-only. The identity gear asks it about the person signed in right
    /// now, so it must not become a way to enumerate anybody else's accounts.
    pub async fn federated_accounts(&self, subject: &str) -> Result<Vec<FederatedAccount>> {
        let token = self.admin_token().await?;
        self.federated_identities(&token, subject).await
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
        // Paged for the same reason, with a sharper consequence: the loop below
        // removes the tenant groups this identity is in and should not be, so a
        // group the listing never reached would leave the identity a member of
        // an organization it has been moved out of.
        let (current, truncated) = self
            .paged::<KeycloakGroup>(token, &groups_url, "user groups")
            .await?;
        if truncated {
            warn!(
                %identity_id,
                "studio-identity-directory: this identity is in more groups than one listing \
                 reads — a stale organization membership may survive the move"
            );
        }

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

    /// The realm's identities, newest first, and whether that is all of them.
    pub async fn list(&self, ctx: &SecurityContext) -> Result<Directory> {
        let token = self.admin_token().await?;
        let (users, truncated) = self.keycloak_users(&token).await?;
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

        // Which broker each identity came in through. Keycloak ships no
        // `federatedIdentities` on a user representation, so this is a separate
        // request per user — the only endpoint that answers it — run
        // concurrently with a small window rather than page-deep sequentially.
        // A failure for one user leaves that label empty instead of failing the
        // whole directory: the label is informational, the listing is not.
        //
        // Owned ids, so the futures borrow nothing from `identities`: a closure
        // that borrows it cannot be proven general enough over the lifetimes
        // the stream combinator needs.
        let ids: Vec<String> = identities.iter().map(|i| i.id.clone()).collect();
        let labels = stream::iter(ids.into_iter().map(|id| {
            let token = token.clone();
            async move {
                self.federated_identities(&token, &id)
                    .await
                    .ok()
                    .and_then(|accounts| {
                        accounts.into_iter().next().map(|account| account.provider)
                    })
            }
        }))
        .buffered(FEDERATION_LOOKUP_WINDOW)
        .collect::<Vec<_>>()
        .await;
        for (identity, label) in identities.iter_mut().zip(labels) {
            identity.identity_provider = label;
        }

        sort_identities(&mut identities);
        Ok(Directory {
            identities,
            truncated,
        })
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
        // Where the assignment is *recorded* as Studio membership. Borrowed
        // rather than held on the service, for the same reason the connector
        // guard borrows its resolver: the identity gear already reads this one
        // for its own proof channel, and owning each other would leave the pair
        // unconstructible in either order.
        memberships: Option<&dyn AssignmentRecorder>,
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
        crate::access_config::set_owner_grant(
            self.account_management.as_ref(),
            ctx,
            tenant_id,
            &tenant.name,
            &identity_id_string,
            organization_role == crate::access_config::ROLE_OWNER,
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

        // The membership record — the authority for organization access under
        // ADR-0011 §2, and what the portal now reads to build a person's
        // organization list. Written last (the IdP representations come first,
        // and there is no transaction across the two systems) but NOT optional:
        // without this row the person is assigned as far as Keycloak is
        // concerned and has no organization as far as Studio is concerned, and
        // reporting that as success would hide it from the only person who
        // could fix it. Every write here is idempotent, so the repair is to
        // call the assignment again.
        if let Some(memberships) = memberships {
            memberships
                .record_assignment(&identity_id_string, tenant_id, organization_role)
                .await
                .with_context(|| {
                    format!(
                        "identity {identity_id_string} was assigned in the IdP but recording the                          Studio membership of {tenant_id} failed; re-run the assignment"
                    )
                })?;
        }
        Ok(())
    }

    /// Record a Studio membership for every identity the IdP already calls
    /// assigned.
    ///
    /// The migration ADR-0011 Phase 4 item 3 asks for. Until now `tenant_id` on
    /// the Keycloak user *was* the assignment, so every identity assigned before
    /// this change has no membership row and would read as having no
    /// organization at all once the portal starts asking `membership` instead.
    ///
    /// Idempotent: `record_assignment` upserts, so re-running only refreshes.
    /// Returns `(recorded, failed)` — one identity's failure does not abandon
    /// the rest, because a partial backfill that names its casualties is more
    /// useful than an all-or-nothing one that leaves nothing behind.
    pub async fn backfill_memberships(
        &self,
        ctx: &SecurityContext,
        memberships: &dyn AssignmentRecorder,
    ) -> Result<(usize, usize)> {
        let mut recorded = 0usize;
        let mut failed = 0usize;
        for identity in self.list(ctx).await?.identities {
            // `home_tenant_id` is `Some` only when the attribute names a tenant
            // that still exists, so an identity pointing at a deleted tenant is
            // already excluded here rather than recorded as a member of nothing.
            let Some(tenant_id) = identity.home_tenant_id else {
                continue;
            };
            let role = identity.organization_role.as_deref().unwrap_or("member");
            match memberships
                .record_assignment(&identity.id, tenant_id, role)
                .await
            {
                Ok(()) => recorded += 1,
                Err(error) => {
                    failed += 1;
                    warn!(
                        identity = %identity.id,
                        tenant = %tenant_id,
                        "membership backfill failed for one identity: {error:#}"
                    );
                }
            }
        }
        Ok((recorded, failed))
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

    /// The arithmetic paging gets wrong. A window that never advances asks
    /// Keycloak for page one for ever; one that advances by the wrong step
    /// leaves people out with nothing to show for it. Neither is visible in
    /// the loop that consumes this.
    #[test]
    fn the_pages_start_at_zero_and_advance_by_a_whole_page() {
        let offsets: Vec<usize> = super::page_offsets().collect();
        assert_eq!(offsets.first(), Some(&0), "the first page starts at zero");
        assert_eq!(offsets.len(), super::MAX_PAGES);
        for pair in offsets.windows(2) {
            assert_eq!(
                pair[1] - pair[0],
                super::PAGE_SIZE,
                "a gap or an overlap between pages loses or repeats records"
            );
        }
    }

    /// What the ceiling actually is, spelled out. Raising either constant
    /// changes how much of a realm one screen reads, which is a decision about
    /// how heavy that screen is allowed to be — not an implementation detail.
    #[test]
    fn the_ceiling_is_two_thousand_identities() {
        assert_eq!(super::MAX_PAGES * super::PAGE_SIZE, 2_000);
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

    /// The projection cannot name the broker, and must not pretend to.
    ///
    /// This test used to assert the opposite: that `project` reads
    /// `federatedIdentities` off the user representation and names the first
    /// entry. Keycloak sends no such key — not from
    /// `GET /users?briefRepresentation=false` and not from `GET /users/{id}`
    /// (checked against 26.7, the pinned image) — so that branch was unreachable
    /// and the column it filled had always been `None` in production.
    ///
    /// The label now comes from the dedicated `/users/{id}/federated-identity`
    /// endpoint, which `list` calls per user. That needs the admin API, so it is
    /// covered on a stand rather than here; what is left to pin is that a
    /// projection of a bare representation invents nothing.
    #[test]
    fn the_projection_does_not_invent_a_provider() {
        let mut federated = person();
        // Even handed the shape Keycloak never sends, the projection stays
        // silent: guessing from a field that does not arrive is what produced a
        // permanently empty column.
        federated["federatedIdentities"] = json!([{ "identityProvider": "github" }]);
        assert_eq!(
            DirectoryIdentity::project(user(federated), None).identity_provider,
            None
        );
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
