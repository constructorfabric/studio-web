//! Objects a platform administrator wrote in the root's model, moved into
//! the organization that owns their scope (ADR-0051 §8a): part of the
//! start-up sweep, and before every gear's own move, so a gear finds its
//! records — and its move markers — where it now looks.

use std::sync::Arc;

use async_trait::async_trait;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::service::DomainModelService;

pub struct Rehome(pub Arc<DomainModelService>);

/// The platform's root tenant.
const ROOT: Uuid = Uuid::from_u128(1);

#[async_trait]
impl crate::model_sweep::TenantMover for Rehome {
    fn name(&self) -> &str {
        "studio-domain-model rehome"
    }
    fn early(&self) -> bool {
        true
    }
    async fn prepare(&self, ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<()> {
        if ctx.subject_tenant_id() == ROOT {
            return Ok(());
        }
        let root =
            crate::org_scope::acting_in(ctx, ROOT).map_err(|e| anyhow::anyhow!("rehome: {e}"))?;
        self.0.rehome_scope(&root, ctx, &tenant.to_string()).await?;
        Ok(())
    }
}

/// The types Studio's own screens need, added to every organization's stored
/// model at start (a model on the seed has them already).
pub struct StudioTypes(pub Arc<DomainModelService>);

#[async_trait]
impl crate::model_sweep::TenantMover for StudioTypes {
    fn name(&self) -> &str {
        "studio-domain-model studio types"
    }
    fn early(&self) -> bool {
        true
    }
    async fn prepare(&self, ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<()> {
        // Once per model: the organization itself, not each of its tenants.
        if ctx.subject_tenant_id() != tenant {
            return Ok(());
        }
        self.0.ensure_studio_types(ctx).await?;
        Ok(())
    }
}
