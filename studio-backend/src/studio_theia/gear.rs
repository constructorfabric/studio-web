//! Composition root for the studio-theia bridge gear (ADR-0010).

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::{Gear, GearCtx, RestApiCapability};
use tracing::info;

use crate::studio_theia::config::StudioTheiaConfig;
use crate::studio_theia::control_client::TheiaControlLocalClient;
use crate::studio_theia::discovery::{
    ControlTokenResolver, StudioSessionResolver, TheiaEndpointResolver,
};
use crate::studio_theia::rest;
use crate::studio_theia::sdk::TheiaControlClientV1;
use crate::studio_theia::service::TheiaService;
#[cfg(not(feature = "theia-event-broker"))]
use crate::studio_theia::sink::StudioEventsSink;

/// Backend-to-backend bridge to the per-session Theia node backend.
///
/// Publishes [`TheiaControlClientV1`] (studio→Theia control calls) and mounts
/// the Theia→studio event ingress. Endpoint discovery is resolved lazily from
/// `ClientHub` via [`StudioSessionResolver`] (phase 2); the event ingress
/// authenticates the S2S token and republishes onto `studio-events` — the
/// portal's stream — or onto `event-broker` under its feature. Dormant unless
/// `studio-theia.enabled = true`.
#[toolkit::gear(name = "studio-theia", capabilities = [rest])]
pub struct StudioTheiaGear {
    service: OnceLock<Arc<TheiaService>>,
    ingress_path: OnceLock<String>,
}

impl Default for StudioTheiaGear {
    fn default() -> Self {
        Self {
            service: OnceLock::new(),
            ingress_path: OnceLock::new(),
        }
    }
}

#[async_trait]
impl Gear for StudioTheiaGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: StudioTheiaConfig = ctx.config_or_default()?;
        // Remember the path even when disabled, so REST still mounts the (503)
        // ingress at the configured location.
        let _ = self.ingress_path.set(cfg.event_ingress_path.clone());

        if !cfg.enabled {
            info!("studio-theia: disabled by config — bridge dormant, ingress answers 503");
            return Ok(());
        }

        info!(
            control_port = cfg.control_port,
            ingress = %cfg.event_ingress_path,
            "studio-theia: initializing (discovery unwired — ADR-0010 phase 2)"
        );

        // Discovery is looked up lazily from ClientHub inside the resolver, so
        // this does not depend on studio-session having initialized first.
        // One backing resolver, two trait views: endpoint discovery (under the
        // caller's ctx) and token reverse-resolve (the ingress's auth primitive).
        let resolver = Arc::new(StudioSessionResolver::new(ctx.client_hub()));
        let endpoint_resolver: Arc<dyn TheiaEndpointResolver> = resolver.clone();
        let token_resolver: Arc<dyn ControlTokenResolver> = resolver;
        // Feature selects the sink: the broker sink under `theia-event-broker`,
        // otherwise the zero-infra logging sink. Both are `dyn TheiaEventSink`.
        #[cfg(feature = "theia-event-broker")]
        let sink: Arc<dyn crate::studio_theia::sink::TheiaEventSink> = Arc::new(
            crate::studio_theia::sink::EventBrokerEventSink::new(ctx.client_hub()),
        );
        #[cfg(not(feature = "theia-event-broker"))]
        let sink: Arc<dyn crate::studio_theia::sink::TheiaEventSink> =
            Arc::new(StudioEventsSink::new(ctx.client_hub()));
        let service = Arc::new(TheiaService::new(
            cfg,
            endpoint_resolver,
            token_resolver,
            sink,
        )?);

        // Publish the in-process client so other gears can drive the IDE
        // without going through HTTP themselves.
        ctx.client_hub()
            .register::<dyn TheiaControlClientV1>(Arc::new(TheiaControlLocalClient::new(
                service.clone(),
            )));

        self.service
            .set(service)
            .map_err(|_| anyhow::anyhow!("studio-theia gear already initialized"))?;
        Ok(())
    }
}

impl RestApiCapability for StudioTheiaGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let path = self
            .ingress_path
            .get()
            .cloned()
            .unwrap_or_else(|| "/studio-theia/v1/events".to_string());
        // None = gear disabled: the endpoints still mount and answer 503.
        let service = self.service.get().cloned();
        let client: Option<Arc<dyn TheiaControlClientV1>> = service
            .clone()
            .map(|s| Arc::new(TheiaControlLocalClient::new(s)) as Arc<dyn TheiaControlClientV1>);
        Ok(rest::register_routes(
            router, openapi, &path, service, client,
        ))
    }
}
