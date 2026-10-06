//! Enqueue against the engine the assembly runs: coalescing and idempotency
//! keys meeting in one table, under the unique index that keeps a key to one
//! run per tenant.
//!
//! The queue is started for real, because `TaskService` writes the run row and
//! its queue entry in one transaction. Its processor is a no-op that only acks,
//! so the run rows stay exactly as the test leaves them.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;
use tokio::sync::OnceCell;
use toolkit_db::migration_runner::run_migrations_for_testing;
use toolkit_db::outbox::{
    LeasedMessageHandler, MessageResult, OutboxHandle, OutboxMessage, Partitions,
    outbox_migrations_with_prefix,
};
use toolkit_db::sea_orm_migration::MigratorTrait;
use toolkit_db::{ConnectOpts, DBProvider, connect_db};

use super::*;
use crate::tasks::registry::{TaskContext, TaskHandler, TaskOutcome};
use crate::tasks::{TABLE_PREFIX, migrations::Migrator};

const TASK_TYPE: &str = "test.coalesce";

/// A handler so the task type is known; the dispatcher never reaches it,
/// because the queue here is drained by [`AckOnly`].
struct Idle;

#[async_trait]
impl TaskHandler for Idle {
    fn task_type(&self) -> &'static str {
        TASK_TYPE
    }
    async fn run(&self, _: &TaskContext) -> TaskOutcome {
        TaskOutcome::done("nothing")
    }
}

/// Takes queue entries off and touches no run row.
struct AckOnly;

#[async_trait]
impl LeasedMessageHandler for AckOnly {
    async fn handle(&self, _: &OutboxMessage) -> MessageResult {
        MessageResult::Ok
    }
}

static REGISTERED: OnceCell<()> = OnceCell::const_new();

/// A database of its own, migrated, and a service over a running queue.
async fn service(name: &str) -> (Arc<TaskService>, Db, OutboxHandle) {
    REGISTERED
        .get_or_init(|| async {
            // Another suite in this process may have registered it first.
            let _ = registry::register(Arc::new(Idle));
        })
        .await;

    let dsn = crate::test_pg::fresh_database(name).await;
    let conn = connect_db(&dsn, ConnectOpts::default())
        .await
        .unwrap_or_else(|e| panic!("connect to {dsn} failed: {e}"));
    let mut migrations = Migrator::migrations();
    migrations.append(&mut outbox_migrations_with_prefix(TABLE_PREFIX).expect("prefix"));
    run_migrations_for_testing(&conn, migrations)
        .await
        .expect("run migrations");
    let db = DBProvider::<anyhow::Error>::new(conn).db();

    let handle = Outbox::builder(db.clone())
        .table_prefix(TABLE_PREFIX)
        .expect("prefix")
        .queue(
            QUEUE,
            Partitions::of(u16::try_from(PARTITIONS).unwrap_or(u16::MAX)),
        )
        .leased(AckOnly)
        .start()
        .await
        .expect("start the queue");
    let service = TaskService::new(db.clone(), Arc::clone(handle.outbox()));
    (service, db, handle)
}

fn ctx(tenant: Uuid) -> SecurityContext {
    SecurityContext::builder()
        .subject_id(Uuid::new_v4())
        .subject_type("user")
        .subject_tenant_id(tenant)
        .build()
        .expect("security context")
}

fn run(tenant: Uuid, key: Option<&str>) -> NewRun<'_> {
    NewRun {
        tenant,
        task_type: TASK_TYPE,
        payload: json!({ "repo": "a/b" }),
        partition_key: Some("a/b"),
        idempotency_key: key,
        coalesce_queued: true,
        notify_workspace_id: None,
    }
}

/// What a run looks like once a processor has picked it up.
async fn start(db: &Db, tenant: Uuid, id: Uuid) {
    let conn = db.conn().expect("conn");
    entity::Entity::update_many()
        .secure()
        .scope_with(&AccessScope::for_tenant(tenant))
        .filter(Condition::all().add(entity::Column::Id.eq(id)))
        .col_expr(
            entity::Column::State,
            Expr::value(RunState::Running.as_str()),
        )
        .exec(&conn)
        .await
        .expect("mark running");
}

/// The gap this closes: a keyed request joined a waiting run that had no key,
/// the run then started, and the replay of that same request — which no longer
/// finds a WAITING run to join — must still answer the same run.
#[tokio::test]
async fn a_keyed_request_that_joins_a_waiting_run_finds_it_again_after_it_starts() {
    let (svc, db, handle) = service("tasks_coalesce_attach").await;
    let tenant = Uuid::new_v4();
    let ctx = ctx(tenant);

    let first = svc.enqueue(&ctx, run(tenant, None)).await.unwrap();
    assert_eq!(first.idempotency_key, None);

    let joined = svc.enqueue(&ctx, run(tenant, Some("k-1"))).await.unwrap();
    assert_eq!(
        joined.id, first.id,
        "the waiting run is joined, not duplicated"
    );
    assert_eq!(joined.idempotency_key.as_deref(), Some("k-1"));
    let stored = svc.get(&ctx, tenant, first.id).await.unwrap().unwrap();
    assert_eq!(
        stored.idempotency_key.as_deref(),
        Some("k-1"),
        "the key is on the row, not only in the answer"
    );

    start(&db, tenant, first.id).await;
    let replay = svc.enqueue(&ctx, run(tenant, Some("k-1"))).await.unwrap();
    assert_eq!(replay.id, first.id, "the replay answers the run it joined");

    // An unkeyed request now starts fresh work: nothing is waiting any more.
    let fresh = svc.enqueue(&ctx, run(tenant, None)).await.unwrap();
    assert_ne!(fresh.id, first.id);
    handle.stop().await;
}

/// Two different keys are two intents, even for the same payload while the
/// first is still waiting.
#[tokio::test]
async fn a_waiting_run_under_another_key_is_not_joined() {
    let (svc, _db, handle) = service("tasks_coalesce_other_key").await;
    let tenant = Uuid::new_v4();
    let ctx = ctx(tenant);

    let first = svc.enqueue(&ctx, run(tenant, Some("a"))).await.unwrap();
    let second = svc.enqueue(&ctx, run(tenant, Some("b"))).await.unwrap();
    assert_ne!(
        second.id, first.id,
        "a different key starts a run of its own"
    );
    assert_eq!(second.idempotency_key.as_deref(), Some("b"));

    // Each key still answers its own run.
    let replay_a = svc.enqueue(&ctx, run(tenant, Some("a"))).await.unwrap();
    let replay_b = svc.enqueue(&ctx, run(tenant, Some("b"))).await.unwrap();
    assert_eq!(replay_a.id, first.id);
    assert_eq!(replay_b.id, second.id);
    let stored = svc.get(&ctx, tenant, first.id).await.unwrap().unwrap();
    assert_eq!(
        stored.idempotency_key.as_deref(),
        Some("a"),
        "never re-keyed"
    );
    handle.stop().await;
}

/// A keyed request prefers the waiting run with no key over one that answers
/// to somebody else's key.
#[tokio::test]
async fn a_keyed_request_joins_the_unkeyed_waiting_run() {
    let (svc, _db, handle) = service("tasks_coalesce_prefer").await;
    let tenant = Uuid::new_v4();
    let ctx = ctx(tenant);

    let keyed = svc.enqueue(&ctx, run(tenant, Some("a"))).await.unwrap();
    // Not coalesced into `keyed`? It is: an unkeyed request joins any waiting
    // run. Make an unkeyed one by hand instead, with coalescing off.
    let unkeyed = svc
        .enqueue(
            &ctx,
            NewRun {
                coalesce_queued: false,
                ..run(tenant, None)
            },
        )
        .await
        .unwrap();
    assert_ne!(unkeyed.id, keyed.id);

    let joined = svc.enqueue(&ctx, run(tenant, Some("c"))).await.unwrap();
    assert_eq!(joined.id, unkeyed.id);
    handle.stop().await;
}
