use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use axum::Router;
use tokio_util::sync::CancellationToken;
use toolkit::api::OpenApiRegistry;
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};

use super::config::StudioSessionConfig;
use super::docker::DockerDriver;
use super::driver::SessionDriver;
use super::k8s::KubernetesDriver;
use super::reap_task;
use super::rest;
use super::service::SessionService;

/// Studio's first own gear: launches per-workspace Theia IDE containers.
///
/// MVP scope (ADR-0003): docker-compose/local Docker via bollard, loopback
/// port publishing, tenant-scoped in-memory session registry, age-based
/// reaper. The k8s successor replaces the Docker driver with per-session
/// Pods (theia-cloud model) behind the same REST contract.
#[toolkit::gear(
    name = "studio-session",
    deps = [account_management, credstore],
    capabilities = [rest, stateful]
)]
pub struct StudioSessionGear {
    service: OnceLock<Arc<SessionService>>,
}

impl Default for StudioSessionGear {
    fn default() -> Self {
        Self {
            service: OnceLock::new(),
        }
    }
}

#[async_trait]
impl Gear for StudioSessionGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: StudioSessionConfig = ctx.config_or_default()?;
        if !cfg.enabled {
            info!("studio-session: disabled by config — session APIs will answer 503");
            return Ok(()); // service stays unset; REST mounts the disabled stub
        }
        info!(
            image = %cfg.image,
            ports = format!("{}-{}", cfg.port_range_start, cfg.port_range_end),
            "studio-session: initializing"
        );
        // Pick the driver by config. A driver that cannot reach its runtime
        // (no Docker socket, no cluster) must NOT fail the whole backend —
        // boot with sessions unavailable instead.
        let driver: Arc<dyn SessionDriver> = match cfg.driver.as_str() {
            "kubernetes" | "k8s" => match KubernetesDriver::connect(cfg.clone()).await {
                Ok(d) => Arc::new(d),
                Err(e) => {
                    warn!(
                        "studio-session: Kubernetes unavailable ({e:#}) — sessions disabled for this run"
                    );
                    return Ok(());
                }
            },
            "docker" => match DockerDriver::connect(cfg.clone()) {
                Ok(d) => Arc::new(d),
                Err(e) => {
                    warn!(
                        "studio-session: Docker unavailable ({e:#}) — sessions disabled for this run"
                    );
                    return Ok(());
                }
            },
            other => {
                warn!(
                    "studio-session: unknown driver '{other}' — sessions disabled (use 'docker' or 'kubernetes')"
                );
                return Ok(());
            }
        };
        let service = SessionService::new(cfg, driver);

        // credstore client: resolves repo PATs for private clones (optional —
        // sessions without tokens work regardless).
        match ctx
            .client_hub()
            .get::<dyn credstore_sdk::CredStoreClientV1>()
        {
            Ok(client) => service.set_credstore(client).await,
            Err(e) => warn!(
                "studio-session: credstore client unavailable ({e}); private repo tokens disabled"
            ),
        }

        // account-management client: reads the caller's IdP record so a
        // session's commits carry the person's name rather than the
        // product's (optional — a session without it starts and pushes just
        // the same, its commits simply keep the fallback author).
        match ctx
            .client_hub()
            .get::<dyn account_management_sdk::AccountManagementClient>()
        {
            Ok(client) => service.set_account_management(client).await,
            Err(e) => {
                warn!("studio-session: account-management unavailable ({e}); commits unattributed")
            }
        }

        // Re-attach sessions that survived a backend restart.
        match service.adopt_existing().await {
            Ok(n) if n > 0 => info!("studio-session: adopted {n} existing session container(s)"),
            Ok(_) => {}
            Err(e) => warn!("studio-session: could not list existing containers: {e:#}"),
        }

        // Publish the in-process discovery client for the studio-theia bridge
        // gear (ADR-0010). Registering unconditionally is harmless: when
        // `theia_control_enabled` is off, resolution returns None.
        ctx.client_hub()
            .register::<dyn crate::studio_session::sdk::StudioSessionDiscoveryClientV1>(Arc::new(
                crate::studio_session::sdk::StudioSessionDiscoveryLocalClient::new(service.clone()),
            ));

        // Reaping expired sessions is a `session.reap` run, fired by a
        // schedule — see `super::reap_task` for what that replaced. Registered
        // here because the service it needs is built here.
        crate::tasks::registry::register(Arc::new(reap_task::SessionReapTask::new(
            service.clone(),
        )))?;

        self.service
            .set(service)
            .map_err(|_| anyhow::anyhow!("studio-session gear already initialized"))?;
        Ok(())
    }
}

#[async_trait]
impl toolkit::contracts::RestApiCapability for StudioSessionGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        // None = sessions disabled (config flag or no Docker): the routes
        // still mount and answer 503 with a clear message.
        let service = self.service.get().cloned();
        Ok(rest::register_routes(router, openapi, service))
    }
}

#[async_trait]
impl toolkit::contracts::RunnableCapability for StudioSessionGear {
    /// Keeps the session image warm. Reaping used to live here too, as a
    /// 60-second timer in every replica; it is a `session.reap` schedule now
    /// (see [`super::reap_task`]).
    ///
    /// NB: `start()` must RETURN — the runtime awaits it before starting the
    /// next gear in topo order. The keeper therefore runs in a spawned task.
    async fn start(&self, _cancel: CancellationToken) -> anyhow::Result<()> {
        let Some(service) = self.service.get().cloned() else {
            return Ok(()); // sessions disabled — nothing to keep warm
        };
        // Background image keeper: boot pull + notify-driven refreshes, so
        // launch requests never pull inline (30s gateway deadline).
        tokio::spawn(SessionService::image_keeper(service));
        Ok(())
    }

    async fn stop(&self, _deadline_token: CancellationToken) -> anyhow::Result<()> {
        // Sessions intentionally outlive the backend: adopt_existing()
        // re-attaches them on the next start.
        Ok(())
    }
}
