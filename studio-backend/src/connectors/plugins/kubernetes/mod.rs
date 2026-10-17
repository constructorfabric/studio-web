use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use toolkit::Gear;
use toolkit::context::GearCtx;

use super::super::driver::ConnectorDriver;
use super::super::gts::KUBERNETES_INSTANCE_ID;
use super::super::kubernetes::KubernetesDriver;
use super::register_driver;

// No `http_client()`: a cluster is reached through kube's own client,
// built per call from the connection's CA and credential.
/// This driver's section: the vendor studio-connector selects drivers by, and
/// its priority among them. Each driver keeps its own, because Gearbox reads a
/// plugin's configuration from the file its gear is declared in.
#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default = "default_vendor")]
    pub vendor: String,
    #[serde(default = "default_priority")]
    pub priority: i16,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            vendor: default_vendor(),
            priority: default_priority(),
        }
    }
}

fn default_vendor() -> String {
    "constructorfabric".into()
}
fn default_priority() -> i16 {
    100
}

#[toolkit::gear(name = "kubernetes-connector-plugin", deps = [types_registry])]
#[derive(Default)]
pub struct KubernetesConnectorPlugin {}

#[async_trait]
impl Gear for KubernetesConnectorPlugin {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: Config = ctx.config_or_default()?;
        let driver: Arc<dyn ConnectorDriver> = Arc::new(KubernetesDriver);
        register_driver(
            ctx,
            KUBERNETES_INSTANCE_ID,
            &cfg.vendor,
            cfg.priority,
            driver,
        )
        .await
    }
}
