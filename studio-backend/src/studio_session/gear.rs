use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use axum::Router;
use tokio_util::sync::CancellationToken;
use toolkit::api::OpenApiRegistry;
use toolkit::{Gear, GearCtx};
use tracing::{info, warn};

use super::access::{TenantMembership, WorkspaceAccess};
use super::config::StudioSessionConfig;
use super::desktop::DesktopLeases;
use super::desktop_rest;
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
    /// Desktop leases need no driver, so they live beside the service rather
    /// than in it, and answer when container sessions are disabled.
    desktops: Arc<DesktopLeases>,
    desktop_access: OnceLock<Arc<dyn WorkspaceAccess>>,
}

impl Default for StudioSessionGear {
    fn default() -> Self {
        Self {
            service: OnceLock::new(),
            desktops: Arc::default(),
            desktop_access: OnceLock::new(),
        }
    }
}

#[async_trait]
impl Gear for StudioSessionGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: StudioSessionConfig = ctx.config_or_default()?;
        // A desktop session is a lease, not a container: it is authorized the
        // same way and needs nothing else, so it is set up before anything
        // that can turn container sessions off.
        if let Ok(client) = ctx
            .client_hub()
            .get::<dyn account_management_sdk::AccountManagementClient>()
        {
            let _ = self
                .desktop_access
                .set(Arc::new(TenantMembership::new(client)));
        }
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

        // account-management client, doing two jobs. It reads the caller's IdP
        // record so a session's commits carry the person's name rather than the
        // product's, and it answers whether the caller reaches the workspace at
        // all.
        //
        // The first job was optional and the second is not: a session without
        // attribution starts and pushes just the same, but an authorization
        // question nobody can answer is not a yes. Without this client the
        // service refuses every session and says so per call — see
        // `SessionService::may_reach`.
        match ctx
            .client_hub()
            .get::<dyn account_management_sdk::AccountManagementClient>()
        {
            Ok(client) => {
                // Two jobs from one client, and the second is the one with teeth:
                // it decides who reaches a workspace at all (see `access.rs`).
                service
                    .set_workspace_access(Arc::new(TenantMembership::new(Arc::clone(&client))))
                    .await;
                service.set_account_management(client).await;
            }
            Err(e) => {
                warn!(
                    "studio-session: account-management unavailable ({e}); \
                     commits unattributed AND no session can be authorized"
                )
            }
        }

        // Re-attach sessions that survived a backend restart.
        match service.adopt_existing().await {
            Ok(n) if n > 0 => info!("studio-session: adopted {n} existing session container(s)"),
            Ok(_) => {}
            Err(e) => warn!("studio-session: could not list existing containers: {e:#}"),
        }

        // Publish the in-process discovery client for the studio-theia bridge
        // gear (ADR-0022). Registering unconditionally is harmless: when
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

        // Waiting for a session to answer is also a run — see
        // `super::ready_task` for why the browser could not keep doing it.
        crate::tasks::registry::register(Arc::new(super::ready_task::SessionReadyTask::new(
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
        let router = rest::register_routes(router, openapi, service, _ctx.client_hub());
        Ok(desktop_rest::register_routes(
            router,
            openapi,
            desktop_rest::Desktops {
                leases: Arc::clone(&self.desktops),
                access: self.desktop_access.get().cloned(),
            },
        ))
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
