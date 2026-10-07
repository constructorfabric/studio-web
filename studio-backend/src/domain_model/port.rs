//! What the domain model offers another gear in the assembly: write an object
//! by key, and read a type's objects. The reports gear mirrors a roadmap
//! plan's units, teams, people and memberships through it.
//!
//! Narrow on purpose. Both calls go through the same path as `POST /objects`
//! and `GET /objects` -- the caller's `SecurityContext`, the PDP's answer for
//! `domain.edit` and `domain.view` (ADR-0035), validation in `warn` -- so a
//! gear can do through here exactly what its caller could do over REST, and
//! nothing more. Changing the model itself is not offered.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use toolkit_security::SecurityContext;

use super::service::{DomainModelService, WriteOptions};
use super::validate::ValidateMode;

/// One stored object.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredObject {
    pub instance_id: String,
    pub payload: Value,
}

#[async_trait]
pub trait DomainObjects: Send + Sync {
    /// Create or replace the object of `entity` (`team`, `org-unit`, …) keyed
    /// by `key`, organization-wide. Answers its instance id, the same for the
    /// same key every time.
    async fn upsert(
        &self,
        ctx: &SecurityContext,
        entity: &str,
        key: &str,
        payload: Value,
    ) -> anyhow::Result<String>;

    /// The objects of `entity` the caller may read.
    async fn list(&self, ctx: &SecurityContext, entity: &str) -> anyhow::Result<Vec<StoredObject>>;
}

/// The domain model's answer to [`DomainObjects`].
pub struct Objects(pub Arc<DomainModelService>);

#[async_trait]
impl DomainObjects for Objects {
    async fn upsert(
        &self,
        ctx: &SecurityContext,
        entity: &str,
        key: &str,
        payload: Value,
    ) -> anyhow::Result<String> {
        let options = WriteOptions {
            scope: None,
            if_absent: false,
            validate: ValidateMode::Warn,
        };
        Ok(self
            .0
            .create_object(ctx, entity, key, options, payload)
            .await?
            .instance_id)
    }

    async fn list(&self, ctx: &SecurityContext, entity: &str) -> anyhow::Result<Vec<StoredObject>> {
        Ok(self
            .0
            .list_objects(ctx, Some(entity), None)
            .await?
            .into_iter()
            .map(|n| StoredObject {
                instance_id: n.instance_id,
                payload: n.value,
            })
            .collect())
    }
}
