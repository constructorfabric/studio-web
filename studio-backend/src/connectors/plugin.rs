//! Connector driver plugins.
//!
//! One gear per provider, mirroring the IdP / authn / authz plugin families:
//! each registers a `PluginV1` instance under the connector contract and
//! publishes its [`ConnectorDriver`] as a scoped ClientHub client keyed by the
//! same GTS instance id. The connector gear resolves drivers by that id, so a
//! provider is present exactly when its plugin gear is linked into the
//! assembly — no registry of hardcoded constructors.
//!
//! ## Why one module, and one directory, per gear
//!
//! `#[toolkit::gear(deps = [...])]` expands to a module-scope `use <dep> as
//! _gear_dep_<dep>;` alias for every declared dependency. Two gears in the
//! same module that both depend on `types_registry` therefore emit the same
//! alias twice and fail to compile (E0252). Each gear gets its own child
//! module; the shared config type and helpers stay here and are reachable as
//! `super::*` because private items are visible to descendant modules. Each
//! child lives in `plugins/<provider>/`, beside the `gear.gdl` that describes
//! it to Gearbox: a description names the one file its gear is declared in.

use std::sync::Arc;

use toolkit::client_hub::ClientScope;
use toolkit::context::GearCtx;
use tracing::{info, warn};
use types_registry_sdk::{RegisterResult, TypesRegistryClient};

use super::driver::ConnectorDriver;
use super::gts::plugin_registration;

/// Shared registration path: publish the instance document, then expose the
/// driver under the same GTS id.
async fn register_driver(
    ctx: &GearCtx,
    instance_id: &str,
    vendor: &str,
    priority: i16,
    driver: Arc<dyn ConnectorDriver>,
) -> anyhow::Result<()> {
    let registry = ctx.client_hub().get::<dyn TypesRegistryClient>()?;
    let doc = plugin_registration(instance_id, vendor, priority);
    // A profile that does not declare the connector contract (older config,
    // trimmed deployment) must not fail the boot over an optional feature:
    // skip the scoped registration instead, and studio-connector reports the
    // provider as unavailable.
    match registry.register(vec![doc]).await {
        Ok(results) => {
            if let Err(e) = RegisterResult::ensure_all_ok(&results) {
                warn!(
                    instance_id = %instance_id,
                    "connector driver not registered ({e}) — is \
                     cf.studio.connector.plugin.v1~ declared in this profile?"
                );
                return Ok(());
            }
        }
        Err(e) => {
            warn!(instance_id = %instance_id, "connector driver registration failed: {e}");
            return Ok(());
        }
    }
    ctx.client_hub()
        .register_scoped::<dyn ConnectorDriver>(ClientScope::gts_id(instance_id), driver);
    // What it registered under, beside it: studio-connector selects drivers
    // by vendor in its own init, before the registry serves what was
    // registered in this one.
    ctx.client_hub()
        .register_scoped::<super::driver::DriverRegistration>(
            ClientScope::gts_id(instance_id),
            Arc::new(super::driver::DriverRegistration {
                vendor: vendor.to_owned(),
                priority,
            }),
        );
    info!(instance_id = %instance_id, vendor = %vendor, priority = priority,
          "connector driver registered");
    Ok(())
}

/// Reused by every plugin that calls its provider itself: a plain HTTPS
/// client. Source hosts and chat platforms are public endpoints with ordinary
/// certificates (model providers are reached through studio-llm-proxy, not
/// here); a self-hosted installation behind a private CA is a follow-up (same shape as
/// keycloak-idp-plugin's `custom_ca_certificate_paths`).
fn http_client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent("constructor-studio")
        .build()?)
}

#[path = "plugins/gitlab/mod.rs"]
mod gitlab_plugin;

#[path = "plugins/github/mod.rs"]
mod github_plugin;

#[path = "plugins/bitbucket/mod.rs"]
mod bitbucket_plugin;

/// Anthropic — the credential `@theia/ai-claude-code` authenticates with. Its
/// key test goes out through studio-llm-proxy (ADR-0039), not a client here.
#[path = "plugins/anthropic/mod.rs"]
mod anthropic_plugin;

/// OpenAI — what `@theia/ai-codex` uses. Tested through studio-llm-proxy too.
#[path = "plugins/openai/mod.rs"]
mod openai_plugin;

/* ── Chat platforms ──────────────────────────────────────────────────────────
 *
 * Two gears per platform: a bot-token driver and an incoming-webhook driver.
 * They are separate plugins rather than one plugin with a mode, because the
 * connector gear resolves a driver by GTS id and a connection names a
 * provider — so "Slack with a bot token" and "Slack with a webhook" have to be
 * two provider keys for the catalogue, the API and the form to tell them
 * apart. A deployment that wants only one of the two drops the other gear from
 * its profile and that provider stops being offered.
 */

#[path = "plugins/slack/mod.rs"]
mod slack_plugin;

#[path = "plugins/slack_webhook/mod.rs"]
mod slack_webhook_plugin;

#[path = "plugins/zulip/mod.rs"]
mod zulip_plugin;

#[path = "plugins/zulip_webhook/mod.rs"]
mod zulip_webhook_plugin;

#[path = "plugins/discord/mod.rs"]
mod discord_plugin;

#[path = "plugins/discord_webhook/mod.rs"]
mod discord_webhook_plugin;

#[path = "plugins/kubernetes/mod.rs"]
mod kubernetes_plugin;

#[path = "plugins/gear_repository/mod.rs"]
mod gear_repository_plugin;
