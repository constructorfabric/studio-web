//! Every organization, workspace and project as an object of its own type in
//! the organization's model (ADR-0051, Studio's own model).
//!
//! The tenants themselves stay in account-management, the core. The model
//! holds one object per tenant, `self` of `organization`, `workspace` or
//! `project`, carrying the tenant's id, name and parent: what the attributes
//! cards record onto, what the model editor counts, and what a relation or a
//! query reaches a tenant through. People's attributes on it are theirs; this
//! only keeps the name and the parent in step with account-management.
//!
//! The portal creates workspaces and projects in account-management itself,
//! so nothing here hears of a new one: the start-up sweep, and the periodic
//! one after it, make each tenant's object.

use std::sync::Arc;

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use serde_json::{Value, json};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::mutate::{self, Operation};
use super::query::Query;
use super::service::DomainModelService;
use super::validate::ValidateMode;
use crate::organizations::sdk::{
    ORGANIZATION_TENANT_TYPE, PROJECT_TENANT_TYPE, WORKSPACE_TENANT_TYPE,
};

/// The platform's root tenant: not an organization, so no object of one.
const ROOT: Uuid = Uuid::from_u128(1);

pub struct TenantObjects {
    pub service: Arc<DomainModelService>,
    pub am: Arc<dyn AccountManagementClient>,
}

/// The model type a tenant type is, if any.
pub(crate) fn level_of(tenant_type: Option<&str>) -> Option<&'static str> {
    match tenant_type? {
        t if t == ORGANIZATION_TENANT_TYPE => Some("organization"),
        t if t == WORKSPACE_TENANT_TYPE => Some("workspace"),
        t if t == PROJECT_TENANT_TYPE => Some("project"),
        _ => None,
    }
}

/// What to write so the tenant's object says what account-management says:
/// nothing when it already does, a patch of what moved, or the object.
pub(crate) fn operation_for(
    level: &str,
    tenant: Uuid,
    name: &str,
    parent: Option<Uuid>,
    stored: Option<(&str, &Value)>,
) -> Option<Value> {
    let parent = parent.map(|p| p.to_string());
    match stored {
        Some((id, value)) => {
            let mut set = serde_json::Map::new();
            if value.get("name").and_then(Value::as_str) != Some(name) {
                set.insert("name".into(), json!(name));
            }
            if value.get("parent_tenant_id").and_then(Value::as_str) != parent.as_deref() {
                set.insert("parent_tenant_id".into(), json!(parent));
            }
            (!set.is_empty()).then(|| json!({ "op": "patch", "id": id, "set": set }))
        }
        None => Some(json!({
            "op": "upsert",
            "type": level,
            "key": "self",
            "project_id": tenant.to_string(),
            "value": {
                "tenant_id": tenant.to_string(),
                "name": name,
                "title": name,
                "parent_tenant_id": parent,
            },
        })),
    }
}

#[async_trait]
impl crate::model_sweep::TenantMover for TenantObjects {
    fn name(&self) -> &str {
        "studio-domain-model tenant objects"
    }
    /// After Studio's types are in, so the level types exist.
    fn early(&self) -> bool {
        false
    }
    fn periodic(&self) -> bool {
        true
    }
    async fn prepare(&self, ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<()> {
        if tenant == ROOT {
            return Ok(());
        }
        let t = self
            .am
            .get_tenant(ctx, tenant)
            .await
            .map_err(|e| anyhow::anyhow!("reading tenant {tenant}: {e}"))?;
        let Some(level) = level_of(t.tenant_type.as_deref()) else {
            return Ok(());
        };
        let q = Query::from_json(json!({
            "type": level,
            "project_id": tenant.to_string(),
            "where": { "tenant_id": { "_eq": tenant.to_string() } },
            "limit": 1,
        }))
        .map_err(|e| anyhow::anyhow!("{e}"))?;
        let found = self
            .service
            .query(ctx, &q)
            .await
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let row = found.rows.items.first();
        let Some(op) = operation_for(
            level,
            tenant,
            &t.name,
            t.parent_id.map(|p| p.0),
            row.map(|r| (r.id.as_str(), &r.value)),
        ) else {
            return Ok(());
        };
        let op: Operation = serde_json::from_value(op)?;
        mutate::run(&self.service, ctx, vec![op], ValidateMode::Off)
            .await
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: Uuid = Uuid::from_u128(0xabc);
    const P: Uuid = Uuid::from_u128(0xdef);

    #[test]
    fn a_tenant_without_an_object_gets_one() {
        let op = operation_for("workspace", T, "111", Some(P), None).unwrap();
        assert_eq!(op["op"], "upsert");
        assert_eq!(op["type"], "workspace");
        assert_eq!(op["value"]["tenant_id"], T.to_string());
        assert_eq!(op["value"]["parent_tenant_id"], P.to_string());
    }

    #[test]
    fn an_object_in_step_is_left_alone_and_one_behind_is_patched() {
        let same =
            json!({ "name": "111", "parent_tenant_id": P.to_string(), "cost_center": "CC-7" });
        assert!(operation_for("workspace", T, "111", Some(P), Some(("w", &same))).is_none());
        let op = operation_for("workspace", T, "Labs", Some(P), Some(("w", &same))).unwrap();
        assert_eq!(op["op"], "patch");
        assert_eq!(
            op["set"],
            json!({ "name": "Labs" }),
            "people's fields are not touched"
        );
    }

    #[test]
    fn only_studio_s_levels_are_objects() {
        assert_eq!(level_of(Some(PROJECT_TENANT_TYPE)), Some("project"));
        assert_eq!(
            level_of(Some("gts.cf.core.am.tenant_type.v1~other.v1~")),
            None
        );
        assert_eq!(level_of(None), None);
    }
}
