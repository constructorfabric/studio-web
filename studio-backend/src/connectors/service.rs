//! Connection catalogue and driver dispatch.
//!
//! A *connection* is configuration: which driver, which installation, which
//! credential, who may see it. It is stored as tenant metadata under
//! [`CONNECTIONS_METADATA_TYPE`] — no new database, and the record is
//! GTS-typed and tenant-scoped by construction.
//!
//! The token is never part of that record. It goes to credstore under a
//! per-connection reference, with the sharing mode carrying the visibility the
//! caller asked for: `personal` keeps it to its owner, `workspace` to the
//! tenant, `organization` lets descendant tenants read it. That is credstore's
//! existing contract, so scope needs no bespoke enforcement here.
//!
//! Reads go through `resolve_metadata`, and the schema declares
//! `inheritance_policy: inherit`, so a workspace sees the connections of its
//! organization. Per AM's contract the nearest row wins whole — a tenant with
//! its own catalogue shadows its ancestors' rather than merging with them —
//! and the walk stops at self-managed barriers, so inheritance never crosses
//! an isolation boundary.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use account_management_sdk::{AccountManagementClient, UpsertMetadataRequest};
use anyhow::{Context, anyhow};
use credstore_sdk::{CredStoreClientV1, SecretRef, SecretValue, SharingMode, WritePrecondition};
use gts::GtsTypeId;
use serde::{Deserialize, Serialize};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::driver::{
    ConnectionAuth, ConnectorCategory, ConnectorDriver, DriverIdentity, NotifyMessage,
    NotifyTarget, RemoteRepo, SentMessage,
};
use super::gts::CONNECTIONS_METADATA_TYPE;
use super::url_guard::check_url;

/// Visibility of a connection, mapped onto credstore sharing modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionScope {
    /// Only the creator.
    Personal,
    /// Everyone in the tenant that owns it.
    Workspace,
    /// The owning tenant and its descendants.
    Organization,
}

impl ConnectionScope {
    pub fn parse(raw: &str) -> anyhow::Result<Self> {
        match raw.trim().to_lowercase().as_str() {
            "personal" => Ok(Self::Personal),
            "" | "workspace" | "tenant" => Ok(Self::Workspace),
            "organization" | "org" | "shared" => Ok(Self::Organization),
            other => Err(anyhow!(
                "unknown scope '{other}' (expected personal | workspace | organization)"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Workspace => "workspace",
            Self::Organization => "organization",
        }
    }

    fn sharing(self) -> SharingMode {
        match self {
            Self::Personal => SharingMode::Private,
            Self::Workspace => SharingMode::Tenant,
            Self::Organization => SharingMode::Shared,
        }
    }
}

/// A stored connection. Serialised into the tenant-metadata catalogue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: Uuid,
    /// Tenant whose catalogue row holds this connection — the organization or
    /// the workspace the creator picked. Recorded because `resolve_metadata`
    /// returns an inherited row without saying whose it was, and both the UI
    /// ("inherited from the organization") and `delete` (which must edit the
    /// owning row) need to know.
    pub owner_tenant_id: Uuid,
    /// Driver key: `gitlab`, `github`, …
    pub provider: String,
    pub label: String,
    /// Account the credential resolved to when it was verified — GitLab or
    /// GitHub username, or a short capability line for a model provider. Kept
    /// so the catalogue can say *whose* credential this is without a round trip
    /// to the provider on every page load.
    #[serde(default)]
    pub account: String,
    pub base_url: String,
    /// credstore reference holding the token. Never returned over the API.
    pub secret_ref: String,
    /// `personal` | `workspace` | `organization`
    pub scope: String,
    /// Subject that created the connection, as a string principal.
    ///
    /// Recorded for `studio-identity` (ADR-0012 §2): a `personal` connection
    /// passed `ConnectorDriver::test()` against the provider, so it is standing
    /// proof that *this* person controls `account`. Without a creator the proof
    /// has nobody to attach to, and guessing is the failure this whole flow
    /// exists to avoid — hence `#[serde(default)]` and an explicit "unknown
    /// owner" branch there rather than a fallback. Catalogue rows written
    /// before this field simply carry an empty string.
    #[serde(default)]
    pub created_by: String,
    pub created_at_epoch_secs: u64,
}

/// One request to add a connection.
///
/// A struct rather than a six-argument list: `provider`, `label`, `base_url`,
/// `token` and `scope` are all strings describing one intent, and positional
/// parameters of the same type are exactly the kind that get silently swapped.
#[derive(Debug, Clone)]
pub struct NewConnection<'a> {
    /// Where the catalogue row goes: an organization (inherited by all its
    /// workspaces) or a single workspace. The caller decides; the gear must not
    /// infer it from the session's tenant.
    pub owner_tenant: Uuid,
    /// Driver key from the provider list.
    pub provider: &'a str,
    /// Human label shown in the UI.
    pub label: &'a str,
    /// Installation root; `None` = the driver's default.
    pub base_url: Option<&'a str>,
    /// Credential, verified before anything is stored.
    pub token: &'a str,
    /// `personal` | `workspace` | `organization` — becomes the credstore
    /// sharing mode of the stored token.
    pub scope: &'a str,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Catalogue {
    #[serde(default)]
    items: Vec<Connection>,
}

/// What [`ConnectorService::delivery_preflight`] found out about a connection.
#[derive(Debug, Clone)]
pub struct DeliveryPreflight {
    pub label: String,
    /// `personal` | `workspace` | `organization`.
    pub scope: String,
    /// Whether the credential already fixes the channel (an incoming webhook).
    pub fixed_target: bool,
}

/// A provider the assembly can actually serve, i.e. one whose plugin gear is
/// linked and registered.
#[derive(Debug, Clone)]
pub struct ProviderInfo {
    pub provider: String,
    pub display_name: String,
    pub default_base_url: String,
    pub instance_id: String,
    /// `source_code` | `ai` | `notification` — decides which affordances the
    /// provider offers: browsing repositories, or posting messages.
    pub category: String,
    /// Field label for the credential ("Personal Access Token (PAT)", "API Key").
    pub credential_label: String,
    /// Placeholder hinting at the credential's shape.
    pub credential_hint: String,
    /// For a notification provider: whether the credential already decides
    /// which channel messages land in (an incoming webhook), so there is no
    /// channel to list and none to pick.
    pub fixed_target: bool,
}

pub struct ConnectorService {
    am: Arc<dyn AccountManagementClient>,
    credstore: Arc<dyn CredStoreClientV1>,
    /// Resolved drivers keyed by provider key, in registration order.
    drivers: BTreeMap<String, (String, Arc<dyn ConnectorDriver>)>,
}

/// The address a connection will actually be used with, checked before it is.
///
/// `base_url` is typed by a tenant member and the backend then makes requests
/// to it carrying that connection's credential, so an unchecked value is a
/// request-forgery primitive — see [`super::url_guard`]. Every path that can
/// set one comes through here: creating a connection, editing one, and probing
/// a credential before it is stored.
///
/// The driver's own default is checked too. It is ours and it passes, so the
/// check costs nothing and means the rule has no exception to remember.
fn resolve_base_url(
    driver: &dyn ConnectorDriver,
    supplied: Option<&str>,
) -> anyhow::Result<String> {
    let raw = supplied
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| driver.default_base_url());
    let url = check_url(raw, "Server URL", driver.base_url_rule())?;
    // Parsed and re-rendered rather than passed through: `Url` has already
    // normalised the host, and what the driver joins paths onto should be what
    // was checked, not the string beside it.
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// Refuse to move a connection to a different address unless its token comes
/// with the request.
///
/// The token is never returned by any route, but it is *used*: a sync clones
/// from `{base_url}/{repo}.git`, and git hands the credential to whatever host
/// that names. So a tenant member could point an organization's connection at
/// a host of their own and read the organization's token out of their own
/// access log.
///
/// The scope guard in `update` does not stop that, and should not: it protects
/// personal connections only, because a shared connection is shared — everyone
/// in the tenant may edit it. What must not be shared is the credential, and
/// the credential is what moving the address gives away.
///
/// Requiring the token alongside the address closes it without inventing a
/// permission. Whoever supplies the credential already holds it, so the move
/// discloses nothing new — and rotating while relocating is what a real
/// migration looks like anyway.
fn address_change_needs_token(
    new_base_url: &str,
    existing_base_url: &str,
    token: Option<&str>,
) -> anyhow::Result<()> {
    if new_base_url != existing_base_url && token.is_none() {
        return Err(anyhow!(
            "changing the address of a connection requires its token — the credential is              sent to whatever host the address names, so moving it without supplying the              token would disclose a credential you may not hold"
        ));
    }
    Ok(())
}

impl ConnectorService {
    pub fn new(
        am: Arc<dyn AccountManagementClient>,
        credstore: Arc<dyn CredStoreClientV1>,
        drivers: Vec<(String, Arc<dyn ConnectorDriver>)>,
    ) -> Arc<Self> {
        let drivers = drivers
            .into_iter()
            .map(|(instance_id, d)| (d.provider().to_string(), (instance_id, d)))
            .collect();
        Arc::new(Self {
            am,
            credstore,
            drivers,
        })
    }

    pub fn providers(&self) -> Vec<ProviderInfo> {
        self.drivers
            .values()
            .map(|(instance_id, d)| ProviderInfo {
                provider: d.provider().to_string(),
                display_name: d.display_name().to_string(),
                default_base_url: d.default_base_url().to_string(),
                instance_id: instance_id.clone(),
                category: d.category().as_str().to_string(),
                credential_label: d.credential_label().to_string(),
                credential_hint: d.credential_hint().to_string(),
                fixed_target: d.fixed_target(),
            })
            .collect()
    }

    fn driver(&self, provider: &str) -> anyhow::Result<&Arc<dyn ConnectorDriver>> {
        self.drivers
            .get(provider)
            .map(|(_, d)| d)
            .ok_or_else(|| anyhow!("no driver for provider '{provider}' in this deployment"))
    }

    fn type_id() -> GtsTypeId {
        GtsTypeId::new(CONNECTIONS_METADATA_TYPE)
    }

    /// Catalogue visible from `tenant`: its own row, or the nearest ancestor's
    /// when it has none. `tenant` is the context the caller is acting in — a
    /// workspace, or an organization — not necessarily the caller's own tenant.
    async fn load(&self, ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<Catalogue> {
        let entry = self
            .am
            .resolve_metadata(ctx, tenant, Self::type_id())
            .await
            .map_err(|e| anyhow!("cannot read the connection catalogue: {e}"))?;
        match entry {
            Some(e) => Ok(serde_json::from_value(e.value).unwrap_or_default()),
            None => Ok(Catalogue::default()),
        }
    }

    /// Catalogue stored directly on `tenant`. Writes must not silently absorb
    /// an inherited catalogue into a child tenant, so mutations read the direct
    /// row only.
    async fn load_own(&self, ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<Catalogue> {
        match self.am.get_metadata(ctx, tenant, Self::type_id()).await {
            Ok(e) => Ok(serde_json::from_value(e.value).unwrap_or_default()),
            // Absent row is the common case on the first connection; AM
            // raises NotFound for an unregistered schema, which the gear logs
            // at init, so treating both as "empty" keeps the happy path clean.
            Err(_) => Ok(Catalogue::default()),
        }
    }

    async fn store(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        catalogue: &Catalogue,
    ) -> anyhow::Result<()> {
        self.am
            .upsert_metadata(
                ctx,
                tenant,
                // #[non_exhaustive]: build through the constructor. No
                // expected_version — last-write-wins is right here, the
                // catalogue is edited by one person at a time and a lost
                // update would only mean re-adding a connection.
                UpsertMetadataRequest::new(Self::type_id(), serde_json::to_value(catalogue)?),
            )
            .await
            .map_err(|e| anyhow!("cannot write the connection catalogue: {e}"))?;
        Ok(())
    }

    pub async fn list(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
    ) -> anyhow::Result<Vec<Connection>> {
        Ok(self.load(ctx, tenant).await?.items)
    }

    async fn find(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
    ) -> anyhow::Result<Connection> {
        self.load(ctx, tenant)
            .await?
            .items
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| anyhow!("connection {id} not found"))
    }

    /// Assemble driver credentials for a stored connection.
    async fn auth(&self, ctx: &SecurityContext, c: &Connection) -> anyhow::Result<ConnectionAuth> {
        let key = SecretRef::new(&c.secret_ref)
            .map_err(|e| anyhow!("bad secret reference '{}': {e}", c.secret_ref))?;
        let secret = self
            .credstore
            .get(ctx, &key)
            .await
            .map_err(|e| anyhow!("credstore: {e}"))?
            .ok_or_else(|| {
                anyhow!(
                    "the token for connection '{}' is not readable — it may belong to \
                     another user (personal scope) or have been removed",
                    c.label
                )
            })?;
        let token = String::from_utf8(secret.value.as_bytes().to_vec())
            .context("stored token is not valid UTF-8")?;
        Ok(ConnectionAuth {
            base_url: c.base_url.clone(),
            token,
        })
    }

    /// Verify credentials, store them, and append the connection. The test
    /// runs *before* anything is written: a typo should not leave a dead
    /// entry behind.
    ///
    /// `owner_tenant` decides the reach of the connection: an organization,
    /// where metadata inheritance makes it visible to every workspace under
    /// it, or a single workspace. That choice belongs to the caller — the
    /// gear must not guess it from the session's tenant.
    pub async fn create(
        &self,
        ctx: &SecurityContext,
        req: NewConnection<'_>,
    ) -> anyhow::Result<(Connection, DriverIdentity)> {
        let NewConnection {
            owner_tenant,
            provider,
            label,
            base_url,
            token,
            scope,
        } = req;
        let driver = self.driver(provider)?;
        let label = label.trim();
        if label.is_empty() {
            return Err(anyhow!("label is required"));
        }
        let token = token.trim();
        if token.is_empty() {
            return Err(anyhow!("token is required"));
        }
        let base_url = resolve_base_url(driver.as_ref(), base_url)?;
        let scope = ConnectionScope::parse(scope)?;

        let identity = driver
            .test(&ConnectionAuth {
                base_url: base_url.clone(),
                token: token.to_string(),
            })
            .await
            .context("the credential was rejected by the provider")?;

        let id = Uuid::new_v4();
        let secret_ref = format!("studio-connection-{id}");
        let key = SecretRef::new(&secret_ref).map_err(|e| anyhow!("bad secret reference: {e}"))?;
        self.credstore
            .create(
                ctx,
                &key,
                SecretValue::new(token.as_bytes().to_vec()),
                scope.sharing(),
            )
            .await
            .map_err(|e| anyhow!("cannot store the token: {e}"))?;

        let connection = Connection {
            id,
            owner_tenant_id: owner_tenant,
            provider: provider.to_string(),
            label: label.to_string(),
            account: identity.account.clone(),
            base_url,
            secret_ref,
            scope: scope.as_str().to_string(),
            created_by: ctx.subject_id().to_string(),
            created_at_epoch_secs: now_secs(),
        };
        let mut catalogue = self.load_own(ctx, owner_tenant).await?;
        catalogue.items.push(connection.clone());
        self.store(ctx, owner_tenant, &catalogue).await?;
        Ok((connection, identity))
    }

    /// Verify a credential without storing anything — the "Test connection"
    /// button next to "Test & save". Takes no security context because
    /// nothing is read from or written to the tenant.
    pub async fn probe(
        &self,
        provider: &str,
        base_url: Option<&str>,
        token: &str,
    ) -> anyhow::Result<DriverIdentity> {
        let driver = self.driver(provider)?;
        let token = token.trim();
        if token.is_empty() {
            return Err(anyhow!("token is required"));
        }
        let base_url = resolve_base_url(driver.as_ref(), base_url)?;
        driver
            .test(&ConnectionAuth {
                base_url,
                token: token.to_string(),
            })
            .await
    }

    /// `tenant` is the context the caller is looking from; the row is edited on
    /// the connection's own tenant, so deleting an inherited connection from a
    /// workspace touches the organization's catalogue — and fails with the
    /// authorization error it should if the caller may not write there.
    pub async fn delete(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
    ) -> anyhow::Result<bool> {
        let Ok(connection) = self.find(ctx, tenant, id).await else {
            return Ok(false);
        };
        let owner = connection.owner_tenant_id;
        let mut catalogue = self.load_own(ctx, owner).await?;
        let Some(pos) = catalogue.items.iter().position(|c| c.id == id) else {
            return Ok(false);
        };
        let removed = catalogue.items.remove(pos);
        self.store(ctx, owner, &catalogue).await?;
        // Best-effort: an orphaned secret is harmless, a failed delete of the
        // catalogue entry would not be.
        if let Ok(key) = SecretRef::new(&removed.secret_ref)
            && let Err(e) = self
                .credstore
                .delete(ctx, &key, WritePrecondition::Exists)
                .await
        {
            tracing::warn!(
                reference = %removed.secret_ref,
                "studio-connector: connection removed but its token could not be deleted ({e})"
            );
        }
        Ok(true)
    }

    /// Change a connection in place: relabel it, point it at a different
    /// installation, or rotate the credential.
    ///
    /// Whatever changed, the result is verified against the provider before
    /// anything is written — the same rule `create` follows, for the same
    /// reason: a stored credential that was never accepted is a failure
    /// discovered later, by a clone, with no obvious cause.
    ///
    /// This exists because the alternative was delete-and-recreate, which
    /// changes the connection id — and every workspace source references a
    /// connection by id, so rotating an expired PAT would silently orphan them.
    /// The id and the credstore reference are deliberately preserved.
    ///
    /// The scope is NOT changeable: it maps onto the secret's credstore sharing
    /// mode, and moving a secret between sharing classes is a transition
    /// credstore governs, not a field edit. Changing who can see a connection
    /// stays a delete-and-recreate.
    pub async fn update(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
        label: Option<&str>,
        base_url: Option<&str>,
        token: Option<&str>,
    ) -> anyhow::Result<(Connection, DriverIdentity)> {
        let existing = self.find(ctx, tenant, id).await?;
        let driver = self.driver(&existing.provider)?;

        // A personal connection is edited only by the person it belongs to.
        //
        // Not a general permission rule — the catalogue is otherwise
        // tenant-visible — but this row is now evidence: `studio-identity`
        // reads `(created_by, account)` as proof that the creator controls that
        // account (ADR-0012 §2). Rotating the token re-stamps `account` below
        // while `created_by` stays put, so without this guard a tenant member
        // could point somebody else's personal connection at an account of
        // their choosing and have the verification recorded against that
        // person. Rows predating `created_by` carry an empty string and stay
        // editable as before; the identity fold skips them for the same reason.
        if existing.scope == ConnectionScope::Personal.as_str()
            && !existing.created_by.trim().is_empty()
            && existing.created_by != ctx.subject_id().to_string()
        {
            return Err(anyhow!(
                "connection {id} is personal to another user and cannot be edited"
            ));
        }

        let label = match label {
            Some(l) => {
                let l = l.trim();
                if l.is_empty() {
                    return Err(anyhow!("label must not be empty"));
                }
                l.to_string()
            }
            None => existing.label.clone(),
        };

        // An explicitly empty base_url means "back to the provider default",
        // which is the only way to undo a typo'd self-hosted URL. Anything
        // else is checked, for the same reason it is on create — this is the
        // other way to point a stored credential at an address of one's own.
        //
        // An unchanged address is left alone rather than re-checked: a row
        // stored before the guard existed stays editable, and the change being
        // made is not the thing to refuse it over.
        let base_url = match base_url {
            Some(u) if u.trim().is_empty() => resolve_base_url(driver.as_ref(), None)?,
            Some(u) => resolve_base_url(driver.as_ref(), Some(u))?,
            None => existing.base_url.clone(),
        };

        // No new token: verify the change against the credential already
        // stored, so relocating an installation cannot quietly leave a
        // connection that has never been proven to work.
        address_change_needs_token(&base_url, &existing.base_url, token)?;

        let rotating = token.is_some();
        let token = match token {
            Some(t) => {
                let t = t.trim();
                if t.is_empty() {
                    return Err(anyhow!("token must not be empty"));
                }
                t.to_string()
            }
            None => self.auth(ctx, &existing).await?.token,
        };

        let identity = driver
            .test(&ConnectionAuth {
                base_url: base_url.clone(),
                token: token.clone(),
            })
            .await
            .context("the credential was rejected by the provider")?;

        if rotating {
            let key = SecretRef::new(&existing.secret_ref)
                .map_err(|e| anyhow!("bad secret reference: {e}"))?;
            let scope = ConnectionScope::parse(&existing.scope)?;
            // If-Match:* overwrites whichever generation holds the reference —
            // the SDK's documented rewrite path — so the reference itself, and
            // therefore every source pointing at it, survives the rotation.
            self.credstore
                .put(
                    ctx,
                    &key,
                    SecretValue::new(token.into_bytes()),
                    scope.sharing(),
                    WritePrecondition::Exists,
                )
                .await
                .map_err(|e| anyhow!("cannot store the new token: {e}"))?;
        }

        // The catalogue row lives in the OWNING tenant, which is not
        // necessarily the one being viewed: an inherited connection is edited
        // where it is defined.
        let owner = existing.owner_tenant_id;
        let mut catalogue = self.load_own(ctx, owner).await?;
        let Some(slot) = catalogue.items.iter_mut().find(|c| c.id == id) else {
            return Err(anyhow!(
                "connection {id} is inherited from tenant {owner} and cannot be edited from here"
            ));
        };
        slot.label = label;
        slot.base_url = base_url;
        // Re-stamp the account: a rotated credential may belong to a different
        // person, and a stale name here is exactly the kind of thing nobody
        // notices until it matters.
        slot.account = identity.account.clone();
        let updated = slot.clone();
        self.store(ctx, owner, &catalogue).await?;
        Ok((updated, identity))
    }

    pub async fn test(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
    ) -> anyhow::Result<(Connection, DriverIdentity)> {
        let c = self.find(ctx, tenant, id).await?;
        let driver = self.driver(&c.provider)?;
        let auth = self.auth(ctx, &c).await?;
        let identity = driver.test(&auth).await?;
        Ok((c, identity))
    }

    /// Resolve a connection into the driver that speaks its provider and the
    /// credential to speak with.
    ///
    /// Exposed because the knowledge-graph producer ([`super::graph_sync`])
    /// needs the same two things every other provider call needs, and the
    /// pieces that assemble them — the catalogue lookup and the credstore
    /// read — are private to this module for good reason.
    #[cfg_attr(not(feature = "graph"), allow(dead_code))]
    pub async fn driver_and_auth(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
    ) -> anyhow::Result<(Arc<dyn ConnectorDriver>, ConnectionAuth, Connection)> {
        let c = self.find(ctx, tenant, id).await?;
        let driver = Arc::clone(self.driver(&c.provider)?);
        let auth = self.auth(ctx, &c).await?;
        Ok((driver, auth, c))
    }

    pub async fn repositories(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
        search: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<RemoteRepo>> {
        let c = self.find(ctx, tenant, id).await?;
        let driver = self.driver(&c.provider)?;
        let auth = self.auth(ctx, &c).await?;
        driver.list_repositories(&auth, search, limit).await
    }

    /// What the caller must know about a connection before queuing a delivery
    /// against it: whether it can deliver at all, whether a target is needed,
    /// and whose credential it is.
    ///
    /// Resolved with the *caller's* context on purpose. A queued delivery is
    /// later performed by a background worker under the gear's own identity, so
    /// the moment to find out that a connection is unusable is while there is
    /// still a request to answer with a 400 — not three retries later in a dead
    /// letter, where nobody is looking.
    pub async fn delivery_preflight(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
    ) -> anyhow::Result<DeliveryPreflight> {
        let c = self.find(ctx, tenant, id).await?;
        let driver = self.driver(&c.provider)?;
        if driver.category() != ConnectorCategory::Notification {
            return Err(anyhow!(
                "connection '{}' is a {} connection — it delivers no messages",
                c.label,
                driver.display_name()
            ));
        }
        Ok(DeliveryPreflight {
            label: c.label.clone(),
            scope: c.scope.clone(),
            fixed_target: driver.fixed_target(),
        })
    }

    /// Channels a notification connection can post to.
    ///
    /// Empty for a webhook connection is not what happens: the driver refuses,
    /// and the REST layer says why rather than showing an empty picker that
    /// looks like a permissions problem.
    pub async fn notification_targets(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
        search: Option<&str>,
        limit: u32,
    ) -> anyhow::Result<Vec<NotifyTarget>> {
        let c = self.find(ctx, tenant, id).await?;
        let driver = self.driver(&c.provider)?;
        let auth = self.auth(ctx, &c).await?;
        driver.list_targets(&auth, search, limit).await
    }

    /// Deliver one message through a connection.
    ///
    /// The connection is the unit of authorization: reaching it means the
    /// caller could read its catalogue row and its secret, which is what
    /// credstore's sharing mode already governs. Nothing further is checked
    /// here — a member of a workspace may post through that workspace's
    /// connections, and a personal one stays readable only by its owner.
    ///
    /// A message is not retried. A chat platform that refuses one is refusing
    /// for a reason the caller should see (a channel the bot is not in, a
    /// revoked webhook, a rate limit), and a queue that hides that behind
    /// eventual delivery is a different feature — one with durable state,
    /// which this gear does not have.
    pub async fn send_message(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        id: Uuid,
        target: Option<&str>,
        message: &NotifyMessage,
    ) -> anyhow::Result<(Connection, SentMessage)> {
        let c = self.find(ctx, tenant, id).await?;
        let driver = self.driver(&c.provider)?;
        let auth = self.auth(ctx, &c).await?;
        let sent = driver.send_message(&auth, target, message).await?;
        Ok((c, sent))
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

#[cfg(test)]
mod base_url_rule_tests {
    //! What each driver will let a connection point at.
    //!
    //! The rule is per driver because only the driver knows whether its
    //! provider has a self-hosted form, and the two answers have opposite
    //! failure modes: pinning a self-hostable provider locks a deployment out
    //! of its own installation, while leaving a hosted one open lets a stored
    //! API key be sent to an address somebody typed.

    use super::{address_change_needs_token, resolve_base_url};
    use crate::connectors::ai_providers::{AnthropicDriver, OpenAiDriver};
    use crate::connectors::bitbucket::BitbucketDriver;
    use crate::connectors::driver::ConnectorDriver;
    use crate::connectors::github::GitHubDriver;
    use crate::connectors::gitlab::GitLabDriver;

    fn http() -> reqwest::Client {
        reqwest::Client::new()
    }

    fn drivers() -> Vec<Box<dyn ConnectorDriver>> {
        vec![
            Box::new(GitHubDriver::new(http())),
            Box::new(GitLabDriver::new(http())),
            Box::new(BitbucketDriver::new(http())),
            Box::new(AnthropicDriver::new(http())),
            Box::new(OpenAiDriver::new(http())),
        ]
    }

    /// Moving a connection is how a credential leaves. Not a hypothetical: a
    /// sync clones from `{base_url}/{repo}.git`, and git hands the token to
    /// whatever host that names.
    #[test]
    fn moving_a_connection_without_its_token_is_refused() {
        let err = address_change_needs_token("https://evil.example", "https://gitlab.com", None)
            .expect_err("a move with no token must be refused");
        assert!(
            err.to_string().contains("requires its token"),
            "the refusal must say what is missing, got: {err}"
        );
    }

    /// Supplying the token proves the caller already holds it, so the move
    /// discloses nothing — and relocating while rotating is what a real
    /// migration looks like.
    #[test]
    fn moving_a_connection_with_its_token_is_allowed() {
        assert!(
            address_change_needs_token(
                "https://gitlab.constr.dev",
                "https://gitlab.com",
                Some("t")
            )
            .is_ok()
        );
    }

    /// Everything else about a connection stays editable by anyone who can see
    /// it. A shared connection is shared; it is the credential that is not.
    #[test]
    fn editing_a_connection_without_moving_it_needs_no_token() {
        assert!(
            address_change_needs_token("https://gitlab.com", "https://gitlab.com", None).is_ok()
        );
    }

    /// The finding this guard closes: any of these, typed into the address
    /// field, made the backend fetch it with the connection's credential and
    /// hand the first part of the reply back in an error.
    #[test]
    fn no_driver_accepts_an_internal_address() {
        for driver in drivers() {
            for target in [
                "http://169.254.169.254/latest/meta-data/",
                "https://169.254.169.254/latest/meta-data/",
                "https://127.0.0.1:8090/cf",
                "https://10.0.0.5/api",
                "https://backend.svc.cluster.local/cf",
                "https://localhost/api",
            ] {
                assert!(
                    resolve_base_url(driver.as_ref(), Some(target)).is_err(),
                    "{} accepted {target}",
                    driver.provider()
                );
            }
        }
    }

    /// Every driver's own default must pass its own rule, or the provider is
    /// unusable without an address being typed.
    #[test]
    fn every_default_passes_its_own_rule() {
        for driver in drivers() {
            let resolved = resolve_base_url(driver.as_ref(), None)
                .unwrap_or_else(|e| panic!("{} rejects its own default: {e}", driver.provider()));
            assert_eq!(resolved, driver.default_base_url());
        }
    }

    /// Source hosts are self-hostable, so a deployment's own installation is
    /// the normal case and must be allowed.
    #[test]
    fn a_source_host_accepts_a_self_hosted_installation() {
        for driver in [
            Box::new(GitHubDriver::new(http())) as Box<dyn ConnectorDriver>,
            Box::new(GitLabDriver::new(http())),
            Box::new(BitbucketDriver::new(http())),
        ] {
            assert!(
                resolve_base_url(driver.as_ref(), Some("https://git.constr.dev")).is_ok(),
                "{} refused a self-hosted installation",
                driver.provider()
            );
        }
    }

    /// Model providers have one set of endpoints. An address anywhere else is
    /// a stored API key pointed somewhere it was not issued for.
    #[test]
    fn a_model_provider_is_pinned_to_its_own_hosts() {
        for driver in [
            Box::new(AnthropicDriver::new(http())) as Box<dyn ConnectorDriver>,
            Box::new(OpenAiDriver::new(http())),
        ] {
            assert!(
                resolve_base_url(driver.as_ref(), Some("https://api.example.org")).is_err(),
                "{} accepted a foreign host",
                driver.provider()
            );
        }
        // Their own hosts, and subdomains of them, stay usable.
        let anthropic: Box<dyn ConnectorDriver> = Box::new(AnthropicDriver::new(http()));
        assert!(resolve_base_url(anthropic.as_ref(), Some("https://api.anthropic.com/v1")).is_ok());
    }
}
