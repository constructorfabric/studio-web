//! The index, against the engine the assembly actually runs.
//!
//! The claim this module makes is that a page served from Postgres is the page
//! the in-process path would have served from the graph — same rows, same
//! order, same total, same cursor behaviour. So most of what follows asks both
//! the same question and compares, with [`page_of_nodes`] over the graph's own
//! projection as the reference. The server comes from [`crate::test_pg`].

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::OnceCell;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::super::graph::{
    GraphStore, GtsNode, InMemoryGraphStore, NodePageQuery, PageStart, page_of_nodes,
};
use super::super::gts;
use super::super::migrations::Migrator;
use super::{ArtifactIndex, FillState, IndexedGraphStore, fill_tenant};

/// A database of this suite's own, migrated once. Not the shared one: every
/// suite that migrates the shared database creates the same `_test` history
/// table, and two doing it at the same instant collide on it.
static MIGRATED: OnceCell<String> = OnceCell::const_new();

async fn dsn() -> &'static str {
    MIGRATED
        .get_or_init(|| async {
            let dsn = crate::test_pg::fresh_database("artifact_index").await;
            let conn = connect_db(&dsn, ConnectOpts::default())
                .await
                .unwrap_or_else(|e| panic!("connect to {dsn} failed: {e}"));
            run_migrations_for_testing(&conn, Migrator::migrations())
                .await
                .expect("run migrations");
            dsn
        })
        .await
}

async fn index() -> Arc<ArtifactIndex> {
    let conn = connect_db(dsn().await, ConnectOpts::default())
        .await
        .expect("connect");
    Arc::new(ArtifactIndex::new(
        DBProvider::<anyhow::Error>::new(conn).db(),
    ))
}

/// A caller in a tenant no other test uses: the suite shares one database and
/// keeps itself apart by tenant, which is also the boundary under test.
fn ctx() -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::new_v4())
        .subject_type("user")
        .subject_tenant_id(Uuid::new_v4())
        .build()
        .expect("security context")
}

const WS: &str = "11111111-1111-1111-1111-111111111111";
const PROJECT: &str = "22222222-2222-2222-2222-222222222222";
const OTHER: &str = "33333333-3333-3333-3333-333333333333";

fn node(type_id: &'static str, id: &str, value: Value) -> GtsNode {
    GtsNode {
        type_id,
        instance_id: id.to_owned(),
        value,
    }
}

/// A graph with the shapes the listings meet: two scopes, two repositories,
/// ties on `updated_at`, nodes with no `updated_at`, directories, a node in a
/// workspace only, one in another project, ids whose byte order differs from a
/// locale's (dashes and upper case), and text a `LIKE` would misread.
fn fixture() -> Vec<GtsNode> {
    let mut out = Vec::new();
    for i in 0..40u32 {
        let repo = if i % 3 == 0 { "acme/web" } else { "acme/api" };
        let scope = match i % 5 {
            0 => json!({ "workspace_id": WS }),
            4 => json!({ "workspace_id": WS, "project_id": OTHER }),
            _ => json!({ "workspace_id": WS, "project_id": PROJECT }),
        };
        let mut v = json!({
            "repo": repo,
            "title": format!("Issue {i} about 100%_done"),
            "author": if i % 2 == 0 { "Alice" } else { "Bob" },
            "number": i + 1,
        });
        // Every fourth one ties with its neighbour; every seventh has none.
        if i % 7 != 0 {
            v["updated_at"] = json!(format!("2026-09-{:02}T10:00:00Z", 1 + (i / 4) % 28));
        }
        merge(&mut v, &scope);
        let id = if i % 2 == 0 {
            format!("a-{i:03}")
        } else {
            format!("A{i:03}")
        };
        out.push(node(gts::ISSUE_TYPE, &id, v));
    }
    for i in 0..30u32 {
        let mut v = json!({
            "repo": if i % 2 == 0 { "acme/web" } else { "acme/api" },
            "path": format!("docs/spec-{i}.md"),
            "full_path": format!("acme/docs/spec-{i}.md"),
            "is_dir": i % 10 == 9,
            "updated_at": format!("2026-08-{:02}T00:00:00Z", 1 + i % 28),
            "text_excerpt": "short",
        });
        merge(
            &mut v,
            &json!({ "workspace_id": WS, "project_id": PROJECT }),
        );
        out.push(node(gts::FILE_TYPE, &format!("f-{i:03}"), v));
    }
    out.push(node(
        gts::FILE_TYPE,
        "f-nopath",
        json!({ "workspace_id": WS, "project_id": PROJECT, "repo": "acme/web" }),
    ));
    out.push(node(
        gts::REPO_TYPE,
        "r-web",
        json!({ "workspace_id": WS, "project_id": PROJECT, "full_path": "acme/web" }),
    ));
    out.push(node(
        gts::COMMIT_TYPE,
        "c-1",
        json!({ "workspace_id": WS, "project_id": PROJECT, "repo": "acme/web", "sha": "abc" }),
    ));
    out
}

fn merge(into: &mut Value, from: &Value) {
    if let (Some(a), Some(b)) = (into.as_object_mut(), from.as_object()) {
        for (k, v) in b {
            a.insert(k.clone(), v.clone());
        }
    }
}

/// An in-memory graph holding the fixture, an indexed store in front of it,
/// and the index filled.
async fn filled(ctx: &SecurityContext) -> (Arc<InMemoryGraphStore>, IndexedGraphStore) {
    let graph = Arc::new(InMemoryGraphStore::default());
    graph
        .upsert_nodes(ctx, &fixture())
        .await
        .expect("seed graph");
    let index = index().await;
    let fills = FillState::default();
    fill_tenant(&*graph, &index, &fills, ctx)
        .await
        .expect("fill");
    let store = IndexedGraphStore::new(graph.clone(), index);
    assert!(
        store.ready(ctx).await,
        "a filled tenant is served from the index"
    );
    (graph, store)
}

fn ids(nodes: &[GtsNode]) -> Vec<&str> {
    nodes.iter().map(|n| n.instance_id.as_str()).collect()
}

#[tokio::test]
async fn every_page_matches_the_graph() {
    let ctx = ctx();
    let (graph, store) = filled(&ctx).await;

    let types = [
        None,
        Some("issue"),
        Some("file"),
        Some(gts::REPO_TYPE),
        Some("commit"),
    ];
    let scopes = [WS, PROJECT, OTHER, "nobody"];
    let repos = [None, Some("acme/web")];
    let needles = [
        None,
        Some("alice"),
        Some("100%_"),
        Some("%"),
        Some("1"),
        Some("spec-2"),
    ];
    let mut checked = 0;
    for type_filter in types {
        let projection = graph.list(&ctx, type_filter).await.expect("graph list");
        for scope in scopes {
            for repo in repos {
                for needle in needles {
                    for by_updated in [false, true] {
                        for start in [
                            PageStart::Offset(0),
                            PageStart::Offset(7),
                            PageStart::Offset(1000),
                            PageStart::After("a-012"),
                            PageStart::After("A013"),
                            PageStart::After("not-there"),
                        ] {
                            let q = NodePageQuery {
                                type_filter,
                                scope: Some(scope),
                                repo,
                                needle,
                                by_updated,
                                start,
                                limit: 5,
                            };
                            let want = page_of_nodes(&projection, &q);
                            let got = store.page(&ctx, &q).await.expect("index page");
                            assert_eq!(
                                (ids(&got.nodes), got.total, got.start),
                                (ids(&want.nodes), want.total, want.start),
                                "{q:?}"
                            );
                            checked += 1;
                        }
                    }
                }
            }
        }
    }
    assert_eq!(checked, 5 * 4 * 2 * 6 * 2 * 6);
}

#[tokio::test]
async fn a_page_carries_the_graph_payload() {
    let ctx = ctx();
    let (graph, store) = filled(&ctx).await;
    let q = NodePageQuery {
        type_filter: Some("file"),
        scope: Some(PROJECT),
        repo: None,
        needle: None,
        by_updated: false,
        start: PageStart::Offset(0),
        limit: 200,
    };
    let want = page_of_nodes(&graph.list(&ctx, Some("file")).await.unwrap(), &q);
    let got = store.page(&ctx, &q).await.unwrap();
    let values = |p: &[GtsNode]| {
        p.iter()
            .map(|n| (n.type_id, n.value.clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(values(&got.nodes), values(&want.nodes));
}

#[tokio::test]
async fn scoped_reads_match_the_graph() {
    let ctx = ctx();
    let (graph, store) = filled(&ctx).await;
    for type_filter in [
        None,
        Some("issue"),
        Some("file"),
        Some("commit"),
        Some("spec_finding"),
    ] {
        for scope in [WS, PROJECT, OTHER] {
            let set = |nodes: Vec<GtsNode>| {
                nodes
                    .into_iter()
                    .map(|n| (n.instance_id, n.value.to_string()))
                    .collect::<BTreeSet<_>>()
            };
            let want = graph.list_in_scope(&ctx, type_filter, scope).await.unwrap();
            let got = store.list_in_scope(&ctx, type_filter, scope).await.unwrap();
            assert_eq!(set(got), set(want.clone()), "{type_filter:?} {scope}");
            assert_eq!(
                store
                    .count_in_scope(&ctx, type_filter, scope)
                    .await
                    .unwrap(),
                want.len() as u64
            );
        }
    }
    for scope in [WS, PROJECT, OTHER] {
        let mut want = graph.files_in_scope(&ctx, scope).await.unwrap();
        let mut got = store.files_in_scope(&ctx, scope).await.unwrap();
        want.sort_by(|a, b| a.node_id.cmp(&b.node_id));
        got.sort_by(|a, b| a.node_id.cmp(&b.node_id));
        assert_eq!(got, want, "{scope}");
    }
}

#[tokio::test]
async fn a_sync_after_the_fill_is_visible_at_once() {
    let ctx = ctx();
    let (_graph, store) = filled(&ctx).await;
    let fresh = node(
        gts::ISSUE_TYPE,
        "a-000",
        json!({ "workspace_id": WS, "project_id": PROJECT, "title": "Renamed", "updated_at": "2027-01-01T00:00:00Z" }),
    );
    store.upsert_nodes(&ctx, &[fresh]).await.unwrap();
    let page = store
        .page(
            &ctx,
            &NodePageQuery {
                type_filter: Some("issue"),
                scope: Some(PROJECT),
                repo: None,
                needle: None,
                by_updated: true,
                start: PageStart::Offset(0),
                limit: 1,
            },
        )
        .await
        .unwrap();
    assert_eq!(ids(&page.nodes), ["a-000"]);
    assert_eq!(page.nodes[0].value["title"], "Renamed");
}

#[tokio::test]
async fn a_forgotten_file_leaves_every_page_at_once() {
    let ctx = ctx();
    let (graph, store) = filled(&ctx).await;
    let gone: Vec<GtsNode> = graph
        .list_in_scope(&ctx, Some("file"), PROJECT)
        .await
        .unwrap()
        .into_iter()
        .take(3)
        .collect();
    assert_eq!(store.delete_nodes(&ctx, &gone).await.unwrap(), 3);
    assert!(
        store.ready(&ctx).await,
        "a clean delete keeps the tenant on the index"
    );
    let q = NodePageQuery {
        type_filter: Some("file"),
        scope: Some(PROJECT),
        repo: None,
        needle: None,
        by_updated: false,
        start: PageStart::Offset(0),
        limit: 200,
    };
    let want = page_of_nodes(&graph.list(&ctx, Some("file")).await.unwrap(), &q);
    let got = store.page(&ctx, &q).await.unwrap();
    assert_eq!((ids(&got.nodes), got.total), (ids(&want.nodes), want.total));
    for n in &gone {
        assert!(!ids(&got.nodes).contains(&n.instance_id.as_str()));
    }
}

/// A file's content goes to the graph and never to the index: no page lists
/// it, even when asked for by name, and the file's own row stays light. A
/// prune retiring both keeps the tenant on the index.
#[tokio::test]
async fn a_files_content_never_becomes_a_row() {
    let ctx = ctx();
    let (graph, store) = filled(&ctx).await;
    let scope = json!({ "workspace_id": WS, "project_id": PROJECT });
    let mut file = node(
        gts::FILE_TYPE,
        "f-content",
        json!({ "repo": "acme/web", "path": "docs/with-text.md", "has_text": true }),
    );
    merge(&mut file.value, &scope);
    let mut content = gts::file_content_node(&file, "# words").expect("text has content");
    merge(&mut content.value, &scope);
    store
        .upsert_nodes(&ctx, &[file.clone(), content.clone()])
        .await
        .unwrap();
    assert!(store.ready(&ctx).await);

    let page = |type_filter| NodePageQuery {
        type_filter,
        scope: Some(PROJECT),
        repo: None,
        needle: None,
        by_updated: false,
        start: PageStart::Offset(0),
        limit: 1000,
    };
    let everything = store.page(&ctx, &page(None)).await.unwrap();
    assert!(ids(&everything.nodes).contains(&"f-content"));
    assert!(!ids(&everything.nodes).contains(&content.instance_id.as_str()));
    let files = store.page(&ctx, &page(Some("file"))).await.unwrap();
    let row = files
        .nodes
        .iter()
        .find(|n| n.instance_id == "f-content")
        .expect("the file is listed");
    assert!(row.value.get("text").is_none() && row.value.get("text_excerpt").is_none());
    let named = store
        .page(&ctx, &page(Some(gts::FILE_CONTENT_TYPE)))
        .await
        .unwrap();
    assert_eq!(named.total, 0);
    // The graph holds it, so search still finds the file through it.
    assert_eq!(
        ids(&graph.search(&ctx, "words", 10).await.unwrap()),
        ["f-content"]
    );

    store.delete_nodes(&ctx, &[content]).await.unwrap();
    store.delete_nodes(&ctx, &[file]).await.unwrap();
    assert!(store.ready(&ctx).await);
    let after = store.page(&ctx, &page(Some("file"))).await.unwrap();
    assert!(!ids(&after.nodes).contains(&"f-content"));
}

#[tokio::test]
async fn a_fill_never_overwrites_what_a_sync_wrote() {
    let ctx = ctx();
    let tenant = ctx.subject_tenant_id();
    let index = index().await;
    let newer = node(
        gts::ISSUE_TYPE,
        "x",
        json!({ "workspace_id": WS, "title": "new" }),
    );
    let older = node(
        gts::ISSUE_TYPE,
        "x",
        json!({ "workspace_id": WS, "title": "old" }),
    );
    index
        .write(
            tenant,
            vec![super::row_of(tenant, &newer, newer.value.clone())],
            true,
        )
        .await
        .unwrap();
    // Every row of this chunk conflicts, which the ORM reports as "nothing
    // inserted" — the fill must take that as the ordinary outcome.
    index
        .write(
            tenant,
            vec![super::row_of(tenant, &older, older.value.clone())],
            false,
        )
        .await
        .unwrap();
    let rows = index.list(tenant, Some("issue"), WS).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].value["title"], "new");
}

#[tokio::test]
async fn an_unfilled_tenant_reads_the_graph_and_fills_behind_it() {
    let ctx = ctx();
    let graph = Arc::new(InMemoryGraphStore::default());
    graph.upsert_nodes(&ctx, &fixture()).await.unwrap();
    let index = index().await;
    let store = IndexedGraphStore::new(graph.clone(), index.clone());

    // Nothing in the index yet, and the answer is still complete.
    let want = graph.count_in_scope(&ctx, None, PROJECT).await.unwrap();
    assert!(want > 0);
    assert_eq!(
        store.count_in_scope(&ctx, None, PROJECT).await.unwrap(),
        want
    );

    let tenant = ctx.subject_tenant_id();
    let mut filled = false;
    for _ in 0..100 {
        if index.is_filled(tenant).await.unwrap() {
            filled = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(filled, "the first read starts a fill");
    assert_eq!(index.count(tenant, None, PROJECT).await.unwrap(), want);
}

#[tokio::test]
async fn a_withdrawn_fill_sends_readers_back_to_the_graph() {
    let ctx = ctx();
    let (graph, store) = filled(&ctx).await;
    // What a failed index write does after the graph took the batch.
    store.index.unfill(ctx.subject_tenant_id()).await.unwrap();
    // The graph now has a node the index never saw.
    let late = node(
        gts::ISSUE_TYPE,
        "late",
        json!({ "workspace_id": WS, "project_id": PROJECT }),
    );
    graph.upsert_nodes(&ctx, &[late]).await.unwrap();
    let want = graph
        .count_in_scope(&ctx, Some("issue"), PROJECT)
        .await
        .unwrap();
    assert_eq!(
        store
            .count_in_scope(&ctx, Some("issue"), PROJECT)
            .await
            .unwrap(),
        want
    );
}

#[test]
fn a_fill_that_outlives_a_failed_write_is_not_trusted() {
    let fills = FillState::default();
    let tenant = Uuid::new_v4();
    let at_start = fills.generation(tenant);
    fills.bump(tenant);
    assert_ne!(fills.generation(tenant), at_start);
    assert_eq!(fills.generation(Uuid::new_v4()), at_start, "per tenant");
}

#[tokio::test]
async fn tenants_do_not_see_each_other() {
    let (a, b) = (ctx(), ctx());
    let (_graph, store) = filled(&a).await;
    // `b` has no fill row, so it would read its (empty) graph — ask the index
    // directly instead, which is the boundary under test.
    let rows = store
        .index
        .list(b.subject_tenant_id(), None, PROJECT)
        .await
        .unwrap();
    assert!(rows.is_empty());
}

#[test]
fn nul_is_stripped_before_it_reaches_postgres() {
    let n = node(
        gts::FILE_TYPE,
        "f",
        json!({ "path": "a\u{0}b", "k\u{0}": ["x\u{0}"] }),
    );
    let row = super::row_of(Uuid::nil(), &n, n.value.clone());
    assert_eq!(row.path, "ab");
    assert_eq!(row.payload, json!({ "path": "ab", "k": ["x"] }));
}

#[test]
fn like_metacharacters_are_escaped() {
    assert_eq!(super::escape_like(r"100%_\x"), r"100\%\_\\x");
}
