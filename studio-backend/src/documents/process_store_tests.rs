//! The process catalogue under each storage strategy, and the move from the
//! tables into the model.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::Value;
use time::OffsetDateTime;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::{PortSource, ProcessStorage, ProcessStore};
use crate::documents::entity::{capability, stage};
use crate::documents::repo::{capability_row_id, stage_row_id};
use crate::domain_model::port::{DomainObjects, StoredObject, TypeNeed};

/// The model as the port shows it: objects by `(entity, scope, key)`, and the
/// types a gear asked for.
#[derive(Default)]
struct Model {
    objects: Mutex<HashMap<(String, String, String), Value>>,
    types: Mutex<Vec<String>>,
}

#[async_trait]
impl DomainObjects for Model {
    async fn upsert(
        &self,
        _: &SecurityContext,
        _: &str,
        _: &str,
        _: Value,
    ) -> anyhow::Result<String> {
        unreachable!("the process store writes in a scope")
    }

    async fn list(&self, _: &SecurityContext, _: &str) -> anyhow::Result<Vec<StoredObject>> {
        unreachable!("the process store reads in a scope")
    }

    async fn upsert_in(
        &self,
        _: &SecurityContext,
        entity: &str,
        key: &str,
        scope: &str,
        payload: Value,
    ) -> anyhow::Result<String> {
        let id = format!("{entity}|{scope}|{key}");
        self.objects
            .lock()
            .unwrap()
            .insert((entity.into(), scope.into(), key.into()), payload);
        Ok(id)
    }

    async fn list_in(
        &self,
        _: &SecurityContext,
        entity: &str,
        scope: &str,
    ) -> anyhow::Result<Vec<StoredObject>> {
        Ok(self
            .objects
            .lock()
            .unwrap()
            .iter()
            .filter(|((e, s, _), _)| e == entity && s == scope)
            .map(|((e, s, k), v)| StoredObject {
                instance_id: format!("{e}|{s}|{k}"),
                payload: v.clone(),
            })
            .collect())
    }

    async fn delete(&self, _: &SecurityContext, instance_id: &str) -> anyhow::Result<()> {
        let mut parts = instance_id.splitn(3, '|');
        let key = (
            parts.next().unwrap().to_string(),
            parts.next().unwrap().to_string(),
            parts.next().unwrap().to_string(),
        );
        self.objects.lock().unwrap().remove(&key);
        Ok(())
    }

    async fn ensure_type(&self, _: &SecurityContext, need: &TypeNeed) -> anyhow::Result<()> {
        self.types.lock().unwrap().push(need.id.clone());
        Ok(())
    }
}

fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::new_v4())
        .subject_tenant_id(Uuid::new_v4())
        .build()
        .unwrap()
}

fn stage_row(owner: Uuid, key: &str, label: &str) -> stage::Model {
    let now = OffsetDateTime::now_utc();
    stage::Model {
        id: stage_row_id(owner, key),
        tenant_id: owner,
        key: key.into(),
        label: label.into(),
        required: true,
        ordinal: 25,
        requires: r#"["prd"]"#.into(),
        gates: r#"["completeness"]"#.into(),
        checks: r#"["tests"]"#.into(),
        hidden: false,
        created_at: now,
        updated_at: now,
    }
}

fn capability_row(owner: Uuid, key: &str) -> capability::Model {
    let now = OffsetDateTime::now_utc();
    capability::Model {
        id: capability_row_id(owner, key),
        tenant_id: owner,
        key: key.into(),
        label: "Sign-in".into(),
        terms: r#"["oidc","keycloak"]"#.into(),
        contracts: r#"["authn"]"#.into(),
        nonfunctional: false,
        hidden: false,
        created_at: now,
        updated_at: now,
    }
}

async fn stores() -> (
    Arc<crate::documents::repo::DocumentsRepo>,
    Arc<Model>,
    ProcessStore,
) {
    let repo = Arc::new(crate::documents::repo_tests::repo().await);
    let model = Arc::new(Model::default());
    let store = ProcessStore {
        repo: repo.clone(),
        storage: ProcessStorage::Model,
        port: PortSource::Fixed(model.clone()),
        moved: Mutex::default(),
        typed: Mutex::default(),
    };
    (repo, model, store)
}

#[tokio::test]
async fn rows_move_into_the_model_on_first_read_and_leave_the_tables() {
    let (repo, model, store) = stores().await;
    let ws = Uuid::new_v4();
    repo.upsert_stage(stage_row(ws, "review", "Review"))
        .await
        .unwrap();
    repo.upsert_capability(capability_row(ws, "auth"))
        .await
        .unwrap();

    let stages = store.list_stages(&ctx(), &[ws]).await.unwrap();
    assert_eq!(stages.len(), 1);
    let st = &stages[0];
    assert_eq!(
        (st.key.as_str(), st.label.as_str(), st.ordinal, st.required),
        ("review", "Review", 25, true)
    );
    assert_eq!(
        (st.requires.as_str(), st.gates.as_str(), st.checks.as_str()),
        (r#"["prd"]"#, r#"["completeness"]"#, r#"["tests"]"#)
    );
    let caps = store.list_capabilities(&ctx(), &[ws]).await.unwrap();
    assert_eq!(caps[0].terms, r#"["oidc","keycloak"]"#);
    assert_eq!(caps[0].contracts, r#"["authn"]"#);

    assert!(
        repo.list_stages(&[ws]).await.unwrap().is_empty(),
        "the stage row moved"
    );
    assert!(
        repo.list_capabilities(&[ws]).await.unwrap().is_empty(),
        "the capability row moved"
    );
    assert_eq!(model.objects.lock().unwrap().len(), 2);
    let types = model.types.lock().unwrap().clone();
    assert!(
        types.contains(&"lifecycle-stage".to_string()) && types.contains(&"capability".to_string())
    );
}

#[tokio::test]
async fn writes_and_reverts_land_in_the_model() {
    let (repo, model, store) = stores().await;
    let org = Uuid::new_v4();
    store
        .upsert_stage(&ctx(), stage_row(org, "ship", "Ship"))
        .await
        .unwrap();
    assert!(
        repo.list_stages(&[org]).await.unwrap().is_empty(),
        "nothing written to the tables"
    );
    assert_eq!(store.list_stages(&ctx(), &[org]).await.unwrap().len(), 1);

    assert!(store.delete_stage(&ctx(), org, "ship").await.unwrap());
    assert!(
        !store.delete_stage(&ctx(), org, "ship").await.unwrap(),
        "nothing left to revert"
    );
    assert!(store.list_stages(&ctx(), &[org]).await.unwrap().is_empty());
    assert!(model.objects.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_tables_strategy_keeps_the_rows() {
    let (repo, model, mut store) = stores().await;
    store.storage = ProcessStorage::Tables;
    let ws = Uuid::new_v4();
    store
        .upsert_stage(&ctx(), stage_row(ws, "plan", "Plan"))
        .await
        .unwrap();
    assert_eq!(repo.list_stages(&[ws]).await.unwrap().len(), 1);
    assert!(model.objects.lock().unwrap().is_empty());
}
