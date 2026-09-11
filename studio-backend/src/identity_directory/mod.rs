//! Platform-admin identity directory.
//!
//! Account Management lists users only inside one tenant. ADR-0011 needs a
//! separate onboarding view for identities that authenticated successfully but
//! have not been assigned to an organization. This gear keeps the Keycloak
//! Admin API and its credential server-side and exposes a root-scoped read-only
//! projection to the portal.

mod rest;
mod service;

pub use service::FederatedAccount;

use std::sync::{Arc, OnceLock};

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::client_hub::ClientScope;
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};

use service::IdentityDirectoryService;

/// ClientHub key under which the federated-identity reader is published.
pub const IDP_DIRECTORY_INSTANCE_ID: &str = "cf.studio._.idp_directory.v1~";

/// What the IdP knows about one of its own subjects.
///
/// A second proof-of-control channel for identity attribution (ADR-0012
/// follow-up 2): a person who signed in through GitHub has already completed
/// that provider's authorization flow, and the provider named the account. The
/// identity gear turns that into a `confirmed` alias without the person having
/// to produce a personal access token.
///
/// Deliberately one subject at a time and read-only. The identity gear calls it
/// about the person signed in right now; a bulk or arbitrary-subject read would
/// make it an account-enumeration surface, and nothing needs one.
#[async_trait]
pub trait IdpDirectoryReader: Send + Sync + 'static {
    /// The external accounts brokered onto `subject`, or an empty list when the
    /// realm user has no brokered login.
    async fn federated_accounts(&self, subject: &str) -> anyhow::Result<Vec<FederatedAccount>>;

    /// The address the realm has verified for `subject`, lowercased, or `None`
    /// when there is none to trust.
    ///
    /// The only address in this system that may be decided from: the profile
    /// e-mail is self-service and therefore a claim, not a fact.
    async fn verified_email(&self, subject: &str) -> anyhow::Result<Option<String>>;
}

#[async_trait]
impl IdpDirectoryReader for IdentityDirectoryService {
    async fn federated_accounts(&self, subject: &str) -> anyhow::Result<Vec<FederatedAccount>> {
        IdentityDirectoryService::federated_accounts(self, subject).await
    }

    async fn verified_email(&self, subject: &str) -> anyhow::Result<Option<String>> {
        IdentityDirectoryService::verified_email(self, subject).await
    }
}

#[toolkit::gear(
    name = "studio-identity-directory",
    deps = [account_management],
    capabilities = [rest]
)]
#[derive(Default)]
pub struct IdentityDirectoryGear {
    service: OnceLock<Option<Arc<IdentityDirectoryService>>>,
}
#[async_trait]
impl Gear for IdentityDirectoryGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let base_url = std::env::var("STUDIO_IDP_ADMIN_BASE_URL").unwrap_or_default();
        let secret = std::env::var("STUDIO_IDP_ADMIN_SECRET").unwrap_or_default();
        let service = if base_url.trim().is_empty() || secret.is_empty() {
            warn!(
                base_url_set = !base_url.trim().is_empty(),
                secret_set = !secret.is_empty(),
                "studio-identity-directory: Keycloak admin connection is not configured"
            );
            None
        } else {
            let account_management = ctx.client_hub().get::<dyn AccountManagementClient>()?;
            let service = IdentityDirectoryService::new(
                base_url,
                "studio".to_owned(),
                "studio-admin".to_owned(),
                secret,
                account_management,
            )?;
            info!("studio-identity-directory: Keycloak-backed directory configured");
            Some(Arc::new(service))
        };
        // Published in `init` so a consumer resolving it in its own REST phase
        // cannot lose a race: every gear's `init` runs before any gear's
        // `register_rest`. Absent when Keycloak admin is unconfigured, which
        // leaves the identity gear's IdP proof channel unavailable and its
        // connector channel untouched.
        if let Some(svc) = service.clone() {
            let reader: Arc<dyn IdpDirectoryReader> = svc;
            ctx.client_hub().register_scoped::<dyn IdpDirectoryReader>(
                ClientScope::gts_id(IDP_DIRECTORY_INSTANCE_ID),
                reader,
            );
        }

        self.service
            .set(service)
            .map_err(|_| anyhow::anyhow!("studio-identity-directory already initialized"))?;
        Ok(())
    }
}

#[async_trait]
impl toolkit::contracts::RestApiCapability for IdentityDirectoryGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let service = self
            .service
            .get()
            .ok_or_else(|| anyhow::anyhow!("studio-identity-directory not initialized"))?
            .clone();

        // Where an assignment gets recorded as Studio membership. Resolved in
        // the REST phase, which runs after every gear's `init`, so studio-user
        // has certainly published it by now — and absent when that gear is
        // inert, in which case assignment still writes the IdP representations
        // and the backfill route answers 503.
        let memberships = rest::Memberships(
            ctx.client_hub()
                .get_scoped::<dyn crate::user_profile::AssignmentRecorder>(&ClientScope::gts_id(
                    crate::user_profile::IDENTITY_INSTANCE_ID,
                ))
                .inspect_err(|_| {
                    warn!(
                        "studio-identity-directory: studio-user assignment recorder not \
                         registered — assignments will not be recorded as Studio memberships"
                    );
                })
                .ok(),
        );
        Ok(rest::register_routes(router, openapi, service, memberships))
    }
}
