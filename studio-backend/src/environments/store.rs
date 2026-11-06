//! Where environments, bindings and deployment records are kept: one
//! account-management metadata row each, on the organization (environments,
//! deployments) or the project (bindings).
//!
//! Reads are the caller's, so a person reads only what their tenants reach.
//! Writes of environments and deployments are this gear's, as the service:
//! the PDP refuses anybody else's write of those two documents
//! (`studio_authz_plugin::GEAR_HELD_METADATA`), which is what makes the
//! administrator check here the only way to change them.

use std::sync::Arc;

use account_management_sdk::{AccountManagementClient, UpsertMetadataRequest};
use anyhow::anyhow;
use gts::GtsTypeId;
use serde::Serialize;
use serde::de::DeserializeOwned;
use toolkit_canonical_errors::CanonicalError;
use toolkit_security::SecurityContext;
use uuid::Uuid;

/// The subject this gear writes as. Fixed, so an audit of account-management
/// says which gear changed a row.
pub const SERVICE_SUBJECT_ID: Uuid = Uuid::from_u128(0x5e7d_0e4b_9a21_4c6e_8f03_e17a_2b94_d043);

/// The identity this gear writes its own documents with, in `tenant`.
pub fn service_context(tenant: Uuid) -> anyhow::Result<SecurityContext> {
    SecurityContext::builder()
        .subject_id(SERVICE_SUBJECT_ID)
        .subject_type("service")
        .subject_tenant_id(tenant)
        .token_scopes(vec!["*".to_owned()])
        .build()
        .map_err(|e| anyhow!("studio-environments: cannot build a service context: {e}"))
}

/// How many times a write re-reads and tries again when somebody else wrote
/// the same row in between.
const WRITE_ATTEMPTS: usize = 4;

#[derive(Clone)]
pub struct Store {
    am: Arc<dyn AccountManagementClient>,
}

impl Store {
    pub fn new(am: Arc<dyn AccountManagementClient>) -> Self {
        Self { am }
    }

    pub fn am(&self) -> &Arc<dyn AccountManagementClient> {
        &self.am
    }

    /// The row `type_id` on `tenant` and its version, read as `ctx`; the
    /// default and version 0 when there is none yet. Any other failure is an
    /// error: treating it as "empty" and writing would wipe the row.
    pub async fn read<T: DeserializeOwned + Default>(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        type_id: &str,
    ) -> anyhow::Result<(T, i64)> {
        match self
            .am
            .get_metadata(ctx, tenant, GtsTypeId::new(type_id))
            .await
        {
            Ok(entry) => {
                let value = serde_json::from_value(entry.value)
                    .map_err(|e| anyhow!("the stored {type_id} is unreadable: {e}"))?;
                Ok((value, entry.version))
            }
            Err(CanonicalError::NotFound { .. }) => Ok((T::default(), 0)),
            Err(e) => Err(anyhow!("cannot read {type_id}: {e}")),
        }
    }

    /// Read, change and write back the row `type_id` on `tenant` as `ctx`,
    /// version-checked so two writers do not lose each other's change.
    /// `change` may refuse; its answer is returned with the written value.
    pub async fn update<T, R, E>(
        &self,
        ctx: &SecurityContext,
        tenant: Uuid,
        type_id: &str,
        mut change: impl FnMut(&mut T) -> Result<R, E>,
    ) -> anyhow::Result<Result<(T, R), E>>
    where
        T: DeserializeOwned + Serialize + Default,
    {
        let mut last = None;
        for _ in 0..WRITE_ATTEMPTS {
            let (mut value, version): (T, i64) = self.read(ctx, tenant, type_id).await?;
            let answer = match change(&mut value) {
                Ok(answer) => answer,
                Err(refused) => return Ok(Err(refused)),
            };
            let mut request =
                UpsertMetadataRequest::new(GtsTypeId::new(type_id), serde_json::to_value(&value)?);
            if version > 0 {
                request = request.with_expected_version(version);
            }
            match self.am.upsert_metadata(ctx, tenant, request).await {
                Ok(_) => return Ok(Ok((value, answer))),
                Err(e) => last = Some(e),
            }
        }
        Err(anyhow!(
            "cannot write {type_id}: {}",
            last.map(|e| e.to_string()).unwrap_or_default()
        ))
    }

    /// A tenant's name, read as `ctx`. An error when account-management
    /// does not answer it, or answers no name: a namespace is made of it,
    /// and one made of nothing is not the project's.
    pub async fn tenant_name(&self, ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<String> {
        let t = self
            .am
            .get_tenant(ctx, tenant)
            .await
            .map_err(|e| anyhow!("account-management did not answer tenant {tenant}: {e}"))?;
        named(tenant, t.name)
    }
}

/// `name` as a tenant's name: not blank.
fn named(tenant: Uuid, name: String) -> anyhow::Result<String> {
    if name.trim().is_empty() {
        Err(anyhow!("tenant {tenant} has no name"))
    } else {
        Ok(name)
    }
}

#[cfg(test)]
mod name_tests {
    use super::*;

    #[test]
    fn a_blank_tenant_name_is_an_error_not_a_namespace() {
        let t = Uuid::from_u128(5);
        assert_eq!(named(t, "shop".into()).unwrap(), "shop");
        let e = named(t, "  ".into()).unwrap_err().to_string();
        assert!(
            e.contains("has no name") && e.contains(&t.to_string()),
            "{e}"
        );
    }
}
