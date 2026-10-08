//! What another gear asks studio-product for, through the ClientHub.
//!
//! - [`ProjectProducts`]: a project's records. The catalogue reads a
//!   project's gear repository through it to say what the project's code
//!   depends on.
//! - [`engine`]: the Gearbox engine, when this deployment configures one. The
//!   catalogue asks it what each gear's `gear.gdl` says and checks the gears
//!   repository out with it, so the catalogue and the previews read one
//!   corpus.
//!
//! Both are resolved when used, so a consumer does not depend on the order
//! gears start in.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;

use super::gearbox::Gearbox;

#[async_trait]
pub trait ProjectProducts: Send + Sync + 'static {
    /// The gear repository connected to a project, as recorded:
    /// `{tenant, connection_id, repo, branch}`. `None` when none is connected.
    async fn gear_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<Value>>;
}

#[async_trait]
impl ProjectProducts for super::service::ProductService {
    async fn gear_repo(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
    ) -> anyhow::Result<Option<Value>> {
        Ok(self
            .get_project_repo(ctx, project_id)
            .await?
            .map(|n| n.value))
    }
}

/// [`ProjectProducts`], resolved from the ClientHub when used.
#[derive(Clone)]
pub struct Products {
    hub: Arc<ClientHub>,
}

impl Products {
    pub fn new(hub: Arc<ClientHub>) -> Self {
        Self { hub }
    }

    /// `None` before studio-product has published it, or in an assembly
    /// without it.
    pub fn get(&self) -> Option<Arc<dyn ProjectProducts>> {
        self.hub.get::<dyn ProjectProducts>().ok()
    }
}

/// The Gearbox engine studio-product published at `init`. `None` when
/// `STUDIO_GEARBOX_WORKDIR` is not set, or in an assembly without the gear.
pub fn engine(hub: &ClientHub) -> Option<Arc<Gearbox>> {
    hub.get::<Gearbox>().ok()
}
