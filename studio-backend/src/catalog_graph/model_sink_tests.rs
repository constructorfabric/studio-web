//! The catalogue as domain objects: the move out of the graph store, reads by
//! type, deletes, snapshots, counts, and who may write.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;

use serde_json::json;
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::gts::{self as cgts, GtsEdge, GtsNode};
use super::model_sink::ModelSink;
use super::sink::{CatalogSink, MemorySink};
use crate::domain_model::port::{DomainObjects, in_memory};

fn ctx(tenant: Uuid) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(1))
        .subject_tenant_id(tenant)
        .token_scopes(vec!["*".to_string()])
        .build()
        .expect("test security context")
}

fn gear(name: &str) -> GtsNode {
    GtsNode {
        type_id: cgts::GEAR_TYPE,
        instance_id: format!("{}cf.studio.gear.{name}.v1", cgts::GEAR_TYPE),
        value: json!({"name": name}),
    }
}

fn version(name: &str, num: &str) -> GtsNode {
    GtsNode {
        type_id: cgts::CRATE_VERSION_TYPE,
        instance_id: format!("{}cf.studio.v.{name}.{num}", cgts::CRATE_VERSION_TYPE),
        value: json!({"crate": name, "num": num}),
    }
}

fn rig() -> (ModelSink, Arc<MemorySink>, Arc<dyn DomainObjects>) {
    let legacy = Arc::new(MemorySink::tenant_scoped());
    let port = in_memory();
    let sink = ModelSink::with_port(
        legacy.clone(),
        Arc::clone(&port),
        "studio-components-catalog",
    );
    (sink, legacy, port)
}

#[tokio::test]
async fn what_the_graph_store_held_moves_on_the_first_touch() {
    let org = Uuid::new_v4();
    let (sink, legacy, port) = rig();
    legacy
        .upsert(&ctx(org), &[gear("auth"), gear("core")], &[])
        .await
        .unwrap();

    let gears = sink.list(&ctx(org), Some("gear.v1")).await.unwrap();
    let mut names: Vec<&str> = gears
        .iter()
        .map(|n| n.value["name"].as_str().unwrap())
        .collect();
    names.sort_unstable();
    assert_eq!(names, ["auth", "core"]);
    assert!(
        gears
            .iter()
            .all(|n| n.type_id == cgts::GEAR_TYPE && n.instance_id.contains("cf.studio.gear."))
    );

    let (objects, _) = port
        .query(&ctx(org), json!({"type": "gear"}))
        .await
        .unwrap();
    assert_eq!(objects.len(), 2, "each gear is a model object");

    legacy
        .upsert(&ctx(org), &[gear("late")], &[])
        .await
        .unwrap();
    assert_eq!(
        sink.list(&ctx(org), Some("gear.v1")).await.unwrap().len(),
        2,
        "moved once"
    );
}

#[tokio::test]
async fn a_sync_writes_nodes_and_relations_and_a_delete_removes_one() {
    let org = Uuid::new_v4();
    let (sink, _, _) = rig();
    let g = gear("auth");
    let v = version("auth", "1.0.0");
    let edge = GtsEdge {
        type_id: cgts::REL_HAS_VERSION,
        from: g.instance_id.clone(),
        to: v.instance_id.clone(),
    };
    sink.upsert(&ctx(org), &[g.clone(), v.clone()], &[edge])
        .await
        .unwrap();
    assert_eq!(sink.list(&ctx(org), None).await.unwrap().len(), 2);
    assert_eq!(
        sink.count_of_type(&ctx(org), cgts::CRATE_VERSION_TYPE, 10)
            .await
            .unwrap(),
        (1, false)
    );

    sink.delete(&ctx(org), &v.instance_id).await.unwrap();
    assert!(
        sink.list(&ctx(org), Some("crate_version"))
            .await
            .unwrap()
            .is_empty()
    );
    sink.upsert(&ctx(org), std::slice::from_ref(&v), &[])
        .await
        .unwrap();
    assert_eq!(
        sink.list(&ctx(org), Some("crate_version"))
            .await
            .unwrap()
            .len(),
        1,
        "the key is writable again"
    );
}

#[tokio::test]
async fn a_tenant_reads_its_own_catalogue() {
    let (sink, _, _) = rig();
    let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
    sink.upsert(&ctx(a), &[gear("mine")], &[]).await.unwrap();
    assert!(
        sink.list(&ctx(b), Some("gear.v1"))
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn snapshots_are_read_by_day_and_component() {
    let org = Uuid::new_v4();
    let (sink, _, _) = rig();
    let snap = |c: &str, day: i64| GtsNode {
        type_id: cgts::COMPONENT_SNAPSHOT_TYPE,
        instance_id: format!("snap:{c}:{day}"),
        value: json!({"component": c, "day": day, "date": "d"}),
    };
    sink.write_snapshots(
        &ctx(org),
        &[snap("auth", 10), snap("auth", 11), snap("core", 10)],
    )
    .await
    .unwrap();
    assert_eq!(
        sink.snapshots(&ctx(org), Some("auth"), 10, 11)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        sink.snapshots(&ctx(org), None, 0, 100).await.unwrap().len(),
        3
    );
}

#[tokio::test]
async fn the_catalogue_is_its_gears_and_refused_to_the_generic_writes() {
    let org = Uuid::new_v4();
    let (sink, _, port) = rig();
    sink.upsert(&ctx(org), &[gear("auth")], &[]).await.unwrap();
    let refused = port
        .upsert(&ctx(org), "gear", "forged", json!({"name": "forged"}))
        .await
        .unwrap_err();
    assert!(
        refused
            .to_string()
            .contains("kept by studio-components-catalog"),
        "{refused}"
    );
    let types = sink.node_types(&ctx(org)).await.unwrap();
    assert!(
        types.iter().any(|t| t.leaf_id == "gear"),
        "components are chosen among the model's types"
    );
}

#[tokio::test]
async fn switching_back_returns_the_catalogue_to_the_graph_store() {
    let org = Uuid::new_v4();
    let (sink, legacy, port) = rig();
    sink.upsert(&ctx(org), &[gear("auth"), version("auth", "1.0.0")], &[])
        .await
        .unwrap();
    assert!(legacy.list(&ctx(org), None).await.unwrap().is_empty());

    let back = ModelSink::returning_with_port(
        legacy.clone(),
        Arc::clone(&port),
        "studio-components-catalog",
    );
    let listed = back.list(&ctx(org), None).await.unwrap();
    assert_eq!(
        listed.len(),
        2,
        "the graph store answers with what came back"
    );
    let (left, _) = port
        .query(&ctx(org), json!({"type": "gear"}))
        .await
        .unwrap();
    assert!(left.is_empty(), "the model keeps no copy");
}
