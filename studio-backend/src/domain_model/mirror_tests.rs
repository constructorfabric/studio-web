//! The read model, against the engine the assembly runs.
//!
//! The claim is that a query answered from Postgres is the query the graph
//! path would have answered — same rows, same order, same totals, same
//! groups — because a tenant moves from one to the other when its fill
//! completes. So most of what follows asks both the same question over the
//! same objects and compares. The server comes from [`crate::test_pg`].

use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::OnceCell;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::super::migrations::Migrator;
use super::super::mutate::{self, Operation};
use super::super::ontology::Ontology;
use super::super::query::{Outcome, Query};
use super::super::service::DomainModelService;
use super::super::store::{DomainStore, InMemoryDomainStore};
use super::super::validate::ValidateMode;
use super::{DomainMirror, FillState, IndexedDomainStore, fill_tenant};

static MIGRATED: OnceCell<String> = OnceCell::const_new();

async fn dsn() -> &'static str {
    MIGRATED
        .get_or_init(|| async {
            let dsn = crate::test_pg::fresh_database("domain_mirror").await;
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

async fn mirror() -> Arc<DomainMirror> {
    let conn = connect_db(dsn().await, ConnectOpts::default())
        .await
        .expect("connect");
    Arc::new(DomainMirror::new(
        DBProvider::<anyhow::Error>::new(conn).db(),
    ))
}

/// A caller in a tenant of its own: the suite shares one database and keeps
/// itself apart by tenant.
fn ctx_in(tenant: Uuid) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(1))
        .subject_tenant_id(tenant)
        .token_scopes(vec!["*".to_string()])
        .build()
        .expect("test security context")
}

/// The same objects behind two services: one reads the graph (the in-memory
/// store), the other the read model in front of it.
struct Pair {
    graph: DomainModelService,
    sql: DomainModelService,
    inner: Arc<InMemoryDomainStore>,
    mirror: Arc<DomainMirror>,
    ctx: SecurityContext,
}

impl Pair {
    async fn new(tenant: Uuid) -> Self {
        let inner = Arc::new(InMemoryDomainStore::default());
        let mirror = mirror().await;
        Self {
            graph: DomainModelService::new(inner.clone()),
            sql: DomainModelService::new(Arc::new(IndexedDomainStore::new(
                inner.clone(),
                mirror.clone(),
            ))),
            inner,
            mirror,
            ctx: ctx_in(tenant),
        }
    }

    /// Written through the read model's store, so both halves have it.
    async fn write(&self, ops: Value) {
        let ops: Vec<Operation> = serde_json::from_value(ops).expect("operations");
        mutate::run(&self.sql, &self.ctx, ops, ValidateMode::Off)
            .await
            .unwrap_or_else(|e| panic!("{e:?}"));
    }

    async fn fill(&self) {
        fill_tenant(
            self.inner.as_ref() as &dyn DomainStore,
            &self.mirror,
            &FillState::default(),
            &self.ctx,
            &Ontology::load(),
        )
        .await
        .expect("fill");
    }

    async fn both(&self, ty: &str, body: Value) -> (Outcome, Outcome) {
        let q = query(ty, body);
        let g = self
            .graph
            .query(&self.ctx, &q)
            .await
            .unwrap_or_else(|e| panic!("graph: {e:?}"));
        let s = self
            .sql
            .query(&self.ctx, &q)
            .await
            .unwrap_or_else(|e| panic!("sql: {e:?}"));
        assert_eq!(g.source, "graph");
        assert_eq!(
            s.source, "read_model",
            "the fill should have made the read model answer"
        );
        (g, s)
    }

    async fn same(&self, ty: &str, body: Value) -> Value {
        let (g, s) = self.both(ty, body.clone()).await;
        let (g, s) = (shape(&g), shape(&s));
        assert_eq!(g, s, "graph and read model differ on {ty} {body}");
        s
    }
}

fn query(ty: &str, body: Value) -> Query {
    let mut body = body;
    let aggregate = body
        .as_object_mut()
        .and_then(|o| o.remove("aggregate"))
        .map(|a| serde_json::from_value(a).expect("aggregate"));
    let offset = body
        .as_object_mut()
        .and_then(|o| o.remove("offset"))
        .and_then(|o| o.as_u64())
        .map(|o| o as usize);
    Query {
        type_ref: ty.to_string(),
        selection: serde_json::from_value(body).expect("selection"),
        aggregate,
        offset,
        ..Default::default()
    }
}

fn shape(o: &Outcome) -> Value {
    json!({
        "items": o.rows.items.iter().map(|r| r.to_json()).collect::<Vec<_>>(),
        "total": o.rows.total,
        "complete": o.rows.complete,
        "groups": o.groups.as_ref().map(|gs| gs.iter().map(|g| json!({"key": g.key, "count": g.count})).collect::<Vec<_>>()),
    })
}

fn names(v: &Value) -> Vec<String> {
    v["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            r["value"]["title"]
                .as_str()
                .or(r["value"]["name"].as_str())
                .unwrap_or("")
                .to_string()
        })
        .collect()
}

/// Risks with numbers, text, absent and null fields, and a list; teams that
/// deliver projects.
async fn seeded(tenant: u128) -> Pair {
    let p = Pair::new(Uuid::from_u128(tenant)).await;
    p.write(json!([
        {"op": "upsert", "type": "risk", "key": "r1", "value": {"title": "DB outage", "score": 0.9, "impact": "critical", "status": "mitigating"}},
        {"op": "upsert", "type": "risk", "key": "r2", "value": {"title": "Late vendor", "score": 0.5, "impact": "high", "status": "identified"}},
        {"op": "upsert", "type": "risk", "key": "r3", "value": {"title": "db schema drift", "score": 0.2, "impact": "low", "status": "closed"}},
        {"op": "upsert", "type": "risk", "key": "r4", "value": {"title": "Key person", "impact": "high"}},
        {"op": "upsert", "type": "risk", "key": "r5", "value": {"title": "Zebra", "score": null, "impact": "medium", "status": "identified"}},
        {"op": "upsert", "type": "risk", "key": "r6", "value": {"title": "Ärger", "score": 2, "impact": "high", "status": "accepted"}},
        {"op": "upsert", "type": "risk", "key": "r7", "value": {"title": "Budget", "score": "unknown", "impact": "medium", "status": "analyzing"}},
        {"op": "upsert", "type": "team", "key": "core", "value": {"name": "Core", "aliases": ["kernel", "base"]}, "as": "core"},
        {"op": "upsert", "type": "team", "key": "edge", "value": {"name": "Edge", "aliases": []}, "as": "edge"},
        {"op": "upsert", "type": "project", "key": "apollo", "value": {"name": "Apollo", "status": "active"}, "as": "apollo"},
        {"op": "upsert", "type": "project", "key": "gemini", "value": {"name": "Gemini", "status": "paused"}, "as": "gemini"},
        {"op": "upsert", "type": "project", "key": "mercury", "value": {"name": "Mercury", "status": "active"}, "as": "mercury"},
        {"op": "link", "relation": "team.delivers", "from": "$core", "to": "$apollo"},
        {"op": "link", "relation": "team.delivers", "from": "$core", "to": "$gemini"},
        {"op": "link", "relation": "team.delivers", "from": "$edge", "to": "$gemini"},
    ]))
    .await;
    p.fill().await;
    p
}

#[tokio::test]
async fn filters_answer_the_same_from_postgres_as_from_the_graph() {
    let p = seeded(0xd001).await;
    for w in [
        json!({}),
        json!({"score": {"_gt": 0.5}}),
        json!({"score": {"_gte": 0.5}}),
        json!({"score": {"_lt": 1}}),
        json!({"score": {"_eq": 2}}),
        json!({"score": {"_neq": 0.5}}),
        json!({"score": {"_is_null": true}}),
        json!({"score": {"_is_null": false}}),
        json!({"_not": {"score": {"_lt": 0.3}}}),
        json!({"impact": {"_in": ["high", "critical"]}}),
        json!({"impact": {"_nin": ["high", "critical"]}}),
        json!({"impact": {"_in": []}}),
        json!({"status": {"_neq": "closed"}}),
        json!({"status": {"_gt": "identified"}}),
        json!({"title": {"_contains": "db"}}),
        json!({"title": {"_contains": "OUTAGE"}}),
        json!({"_or": [{"impact": {"_eq": "low"}}, {"score": {"_gte": 0.9}}]}),
        json!({"_and": [{"impact": {"_eq": "high"}}, {"_not": {"status": {"_is_null": true}}}]}),
        json!({"score": {"_eq": "unknown"}}),
        json!({"score": {"_gt": "a"}}),
    ] {
        p.same("risk", json!({"where": w, "limit": 200})).await;
    }
    let all = p.same("risk", json!({"limit": 200})).await;
    let id = all["items"][0]["id"].clone();
    let one = p.same("risk", json!({"where": {"id": {"_eq": id}}})).await;
    assert_eq!(one["total"], json!(1));

    for w in [
        json!({"aliases": {"_contains": "kernel"}}),
        json!({"aliases": {"_contains": "KERNEL"}}),
        json!({"name": {"_contains": "or"}}),
    ] {
        p.same("team", json!({"where": w})).await;
    }
}

#[tokio::test]
async fn orders_and_pages_answer_the_same() {
    let p = seeded(0xd002).await;
    let by_title = p
        .same(
            "risk",
            json!({"order_by": [{"field": "title"}], "limit": 200}),
        )
        .await;
    // Byte order, as the in-memory path has it: upper case before lower,
    // and the umlaut after every ASCII letter.
    assert_eq!(
        names(&by_title),
        [
            "Budget",
            "DB outage",
            "Key person",
            "Late vendor",
            "Zebra",
            "db schema drift",
            "Ärger"
        ]
    );
    for body in [
        json!({"order_by": [{"field": "title", "direction": "desc"}]}),
        json!({"order_by": [{"field": "impact"}, {"field": "title", "direction": "desc"}]}),
        json!({"order_by": [{"field": "status", "direction": "desc"}]}),
        json!({"order_by": [{"field": "title"}], "offset": 2, "limit": 3}),
        json!({"order_by": [{"field": "title"}], "offset": 50}),
        json!({"where": {"impact": {"_eq": "high"}}, "order_by": [{"field": "title"}], "limit": 1}),
        json!({"fields": ["title"], "order_by": [{"field": "title"}]}),
    ] {
        p.same("risk", body).await;
    }
    // Numbers by value with the absent ones last, both ways. The one risk
    // whose score is text is left out: two kinds have no order between them.
    for dir in ["asc", "desc"] {
        let body = json!({
            "where": {"_not": {"score": {"_eq": "unknown"}}},
            "order_by": [{"field": "score", "direction": dir}],
        });
        let out = p.same("risk", body).await;
        let last: Vec<String> = names(&out).into_iter().rev().take(2).collect();
        assert!(
            last.contains(&"Key person".to_string()) && last.contains(&"Zebra".to_string()),
            "{out}"
        );
    }
}

/// Every row once, in the order of the whole listing, page by page.
async fn walk(
    s: &DomainModelService,
    ctx: &SecurityContext,
    ty: &str,
    body: &Value,
) -> Vec<String> {
    let mut q = query(ty, body.clone());
    let mut ids = Vec::new();
    loop {
        let out = s.query(ctx, &q).await.unwrap_or_else(|e| panic!("{e:?}"));
        ids.extend(out.rows.items.iter().map(|r| r.id.clone()));
        match out.next_cursor {
            Some(c) => q.cursor = Some(c),
            None => return ids,
        }
    }
}

#[tokio::test]
async fn cursors_walk_the_same_pages_from_postgres_as_from_the_graph() {
    let p = seeded(0xd006).await;
    let no_text_score = json!({"_not": {"score": {"_eq": "unknown"}}});
    for (order, filter) in [
        (json!([{"field": "title"}]), json!({})),
        (json!([{"field": "title", "direction": "desc"}]), json!({})),
        (
            json!([{"field": "impact"}, {"field": "title", "direction": "desc"}]),
            json!({}),
        ),
        // Absent and null scores sit last both ways; a page boundary on them
        // has to find what follows.
        (json!([{"field": "score"}]), no_text_score.clone()),
        (
            json!([{"field": "score", "direction": "desc"}]),
            no_text_score.clone(),
        ),
        (
            json!([{"field": "status", "direction": "desc"}, {"field": "score"}]),
            no_text_score,
        ),
        (json!([]), json!({})),
    ] {
        let whole = json!({"where": filter, "order_by": order, "limit": 200});
        let (g, s) = p.both("risk", whole.clone()).await;
        let expected: Vec<String> = s.rows.items.iter().map(|r| r.id.clone()).collect();
        assert_eq!(
            expected,
            g.rows
                .items
                .iter()
                .map(|r| r.id.clone())
                .collect::<Vec<_>>(),
            "{whole}"
        );
        for limit in [1, 2, 3] {
            let paged = json!({"where": filter, "order_by": order, "limit": limit});
            assert_eq!(
                walk(&p.graph, &p.ctx, "risk", &paged).await,
                expected,
                "graph {paged}"
            );
            assert_eq!(
                walk(&p.sql, &p.ctx, "risk", &paged).await,
                expected,
                "sql {paged}"
            );
        }
    }
    // A cursor from one executor reads on in the other: the read model can
    // fill between two pages.
    let body = json!({"order_by": [{"field": "title"}], "limit": 3});
    let first = p
        .graph
        .query(&p.ctx, &query("risk", body.clone()))
        .await
        .unwrap();
    let mut q = query("risk", body);
    q.cursor = first.next_cursor;
    let rest = p.sql.query(&p.ctx, &q).await.unwrap();
    assert_eq!(names(&shape(&rest))[0], "Late vendor");
}

#[tokio::test]
async fn relations_both_ways_and_nested_answer_the_same() {
    let p = seeded(0xd003).await;
    let teams = p
        .same(
            "team",
            json!({"order_by": [{"field": "name"}], "include": {"delivers": {"order_by": [{"field": "name"}]}}}),
        )
        .await;
    assert_eq!(
        teams["items"][0]["relations"]["delivers"]["total"],
        json!(2)
    );

    let projects = p
        .same(
            "project",
            json!({"order_by": [{"field": "name"}], "include": {"~delivers": {"order_by": [{"field": "name"}]}}}),
        )
        .await;
    let gemini = &projects["items"][1];
    assert_eq!(gemini["value"]["name"], json!("Gemini"));
    assert_eq!(names(&gemini["relations"]["~delivers"]), ["Core", "Edge"]);
    assert_eq!(
        projects["items"][2]["relations"]["~delivers"]["total"],
        json!(0)
    );

    p.same(
        "team",
        json!({"include": {"delivers": {"where": {"status": {"_eq": "active"}}, "limit": 1,
            "include": {"~delivers": {"fields": ["name"]}}}}}),
    )
    .await;
}

#[tokio::test]
async fn aggregates_answer_the_same() {
    let p = seeded(0xd004).await;
    let by_impact = p
        .same(
            "risk",
            json!({"aggregate": {"group_by": ["impact"]}, "limit": 1}),
        )
        .await;
    assert_eq!(by_impact["groups"][0], json!({"key": ["high"], "count": 3}));
    p.same(
        "risk",
        json!({"aggregate": {"group_by": ["impact", "status"]}}),
    )
    .await;
    p.same("risk", json!({"aggregate": {"group_by": ["score"]}}))
        .await;
    p.same(
        "risk",
        json!({"where": {"impact": {"_eq": "high"}}, "aggregate": {"group_by": []}}),
    )
    .await;
}

#[tokio::test]
async fn writes_after_the_fill_reach_the_read_model() {
    let p = seeded(0xd005).await;
    p.write(json!([
        {"op": "upsert", "type": "risk", "key": "r8", "value": {"title": "New", "score": 0.7, "impact": "low"}, "as": "r8"},
        {"op": "patch", "id": "$r8", "set": {"impact": "critical"}},
    ]))
    .await;
    let all = p
        .same(
            "risk",
            json!({"where": {"impact": {"_eq": "critical"}}, "order_by": [{"field": "title"}]}),
        )
        .await;
    assert_eq!(names(&all), ["DB outage", "New"]);

    let gemini = p
        .same("project", json!({"where": {"name": {"_eq": "Gemini"}}}))
        .await;
    let core = p
        .same("team", json!({"where": {"name": {"_eq": "Core"}}}))
        .await;
    p.write(json!([
        {"op": "unlink", "relation": "team.delivers", "from": core["items"][0]["id"], "to": gemini["items"][0]["id"]},
        {"op": "delete", "id": all["items"][1]["id"]},
    ]))
    .await;
    let teams = p
        .same(
            "team",
            json!({"order_by": [{"field": "name"}], "include": {"delivers": {}}}),
        )
        .await;
    assert_eq!(
        teams["items"][0]["relations"]["delivers"]["total"],
        json!(1)
    );
    let critical = p
        .same("risk", json!({"where": {"impact": {"_eq": "critical"}}}))
        .await;
    assert_eq!(
        names(&critical),
        ["DB outage"],
        "the deleted risk left both"
    );
}

#[tokio::test]
async fn an_unfilled_tenant_reads_the_graph_and_starts_a_fill() {
    let tenant = Uuid::from_u128(0xd006);
    let inner = Arc::new(InMemoryDomainStore::default());
    let store = IndexedDomainStore::new(inner.clone(), mirror().await);
    let ctx = ctx_in(tenant);
    let model = Ontology::load();
    assert!(store.read_model(&ctx, &model).await.is_none());
    // The fill runs in the background; it finds nothing and declares the
    // tenant complete.
    for _ in 0..50 {
        if store.read_model(&ctx, &model).await.is_some() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("the fill never completed");
}

// ── ADR-0035 on the SQL path: what a project-scoped grant lets through ─────

use super::super::access::{Access, AccessError, ObjectPolicy, TenantParents};
use toolkit_security::{AccessScope, ScopeConstraint, ScopeFilter, pep_properties};

const ORG: Uuid = Uuid::from_u128(0xd0a0);
const MINE: Uuid = Uuid::from_u128(0xd0a1);
const THEIRS: Uuid = Uuid::from_u128(0xd0a2);

struct Tree;
#[async_trait::async_trait]
impl TenantParents for Tree {
    async fn parent_of(&self, _ctx: &SecurityContext, t: Uuid) -> Option<Uuid> {
        (t == MINE || t == THEIRS).then_some(ORG)
    }
}

struct OneProject;
#[async_trait::async_trait]
impl ObjectPolicy for OneProject {
    async fn access(
        &self,
        ctx: &SecurityContext,
        _action: &str,
        _entity: Option<&str>,
    ) -> Result<Access, AccessError> {
        let only = ScopeFilter::in_uuids(pep_properties::OWNER_TENANT_ID, vec![MINE]);
        let subtree =
            ScopeFilter::InTenantSubtree(toolkit_security::InTenantSubtreeScopeFilter::new(
                pep_properties::OWNER_TENANT_ID,
                toolkit_security::ScopeValue::Uuid(ORG),
            ));
        Ok(Access::new(
            ctx,
            AccessScope::from_constraints(vec![ScopeConstraint::new(vec![subtree, only])]),
            Some(Arc::new(Tree)),
        ))
    }
}

#[tokio::test]
async fn a_project_grant_narrows_the_sql_root_its_total_and_its_relations() {
    let p = Pair::new(ORG).await;
    p.write(json!([
        {"op": "upsert", "type": "team", "key": "core", "project_id": MINE.to_string(), "value": {"name": "core"}, "as": "core"},
        {"op": "upsert", "type": "project", "key": "apollo", "project_id": MINE.to_string(), "value": {"name": "apollo"}, "as": "a"},
        {"op": "upsert", "type": "project", "key": "gemini", "project_id": THEIRS.to_string(), "value": {"name": "gemini"}, "as": "g"},
        {"op": "link", "relation": "team.delivers", "from": "$core", "to": "$a"},
        {"op": "link", "relation": "team.delivers", "from": "$core", "to": "$g"},
    ]))
    .await;
    p.fill().await;
    let narrowed = DomainModelService::new(Arc::new(IndexedDomainStore::new(
        p.inner.clone(),
        p.mirror.clone(),
    )))
    .with_policy(Arc::new(OneProject));

    let out = narrowed
        .query(&p.ctx, &query("project", json!({})))
        .await
        .unwrap();
    assert_eq!(out.source, "read_model");
    assert_eq!(out.rows.total, 1, "a hidden row is not counted either");
    assert_eq!(out.rows.items[0].value["name"], json!("apollo"));

    let out = narrowed
        .query(
            &p.ctx,
            &query("project", json!({"aggregate": {"group_by": []}})),
        )
        .await
        .unwrap();
    assert_eq!(out.groups.unwrap()[0].count, 1);

    let out = narrowed
        .query(&p.ctx, &query("team", json!({"include": {"delivers": {}}})))
        .await
        .unwrap();
    assert_eq!(out.rows.items[0].relations["delivers"].total, 1);
}
