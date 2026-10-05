//! What a source sync hands Spec Quality, and what a run's results are
//! recorded against.
//!
//! Two things the editor's findings depend on and nothing else pins down:
//!
//! * **Which documents a sync analyses.** A document gets findings without
//!   anybody pressing a button only because `classify_ingested` queues
//!   `purpose` and `leak` for the typed documents that are new, changed, or
//!   never had a `purpose` verdict -- and a re-sync of an unchanged, analysed
//!   repository must queue nothing, or every sync pays for the whole
//!   repository again.
//! * **What a result is recorded against.** `record_subjects` maps the paths a
//!   run names to the binding / Studio document / graph node a finding and a
//!   gate verdict land on; a path it cannot map is a result nobody sees.
//!
//! Real PostgreSQL through [`super::repo_tests::repo`], for the reason that
//! module gives. Account management and the task queue are fakes: the first
//! only has to say the workspace exists, and the second is where the test
//! reads what would have run.
#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::{Arc, Mutex};

use account_management_sdk::{
    AccountManagementClient, CreateTenantRequest, IdpNewUser, IdpServiceAccountCredentials,
    IdpServiceAccountSummary, IdpUser, IdpUserPatch, ListUsersQuery, MetadataEntry, Tenant,
    TenantId, TenantStatus, UpdateTenantRequest, UpsertMetadataRequest,
};
use async_trait::async_trait;
use gts::GtsTypeId;
use serde_json::Value;
use time::OffsetDateTime;
use toolkit::client_hub::{ClientHub, ClientScope};
use toolkit_canonical_errors::CanonicalError;
use toolkit_odata::{ODataQuery, Page};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::port::AnalysisRecorder;
use super::repo::binding_row_id;
use super::service::{DocumentsService, IngestedFile, SyncAnalysis};
use crate::documents::port::DetectorVerdict;
use crate::tasks::service::NewRun;
use crate::tasks::{RunView, TASK_QUEUE_INSTANCE_ID, TaskQueue};

// ── fakes ────────────────────────────────────────────────────────────────

/// Says every tenant exists and hangs from nothing, which is all
/// `list_types` asks of it. Everything else is a call these tests never make.
struct EveryTenantExists;

#[async_trait]
impl AccountManagementClient for EveryTenantExists {
    async fn create_tenant(
        &self,
        _: &SecurityContext,
        _: CreateTenantRequest,
    ) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn get_tenant(&self, _: &SecurityContext, id: Uuid) -> Result<Tenant, CanonicalError> {
        let now = OffsetDateTime::now_utc();
        Ok(Tenant {
            id: TenantId(id),
            name: "workspace".to_owned(),
            status: TenantStatus::Active,
            tenant_type: None,
            parent_id: None,
            self_managed: false,
            depth: 1,
            child_count: 0,
            created_at: now,
            updated_at: now,
            deleted_at: None,
        })
    }
    async fn list_children(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &ODataQuery,
    ) -> Result<Page<Tenant>, CanonicalError> {
        unimplemented!()
    }
    async fn update_tenant(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: UpdateTenantRequest,
    ) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn suspend_tenant(&self, _: &SecurityContext, _: Uuid) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn unsuspend_tenant(
        &self,
        _: &SecurityContext,
        _: Uuid,
    ) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn delete_tenant(&self, _: &SecurityContext, _: Uuid) -> Result<Tenant, CanonicalError> {
        unimplemented!()
    }
    async fn create_user(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: IdpNewUser,
    ) -> Result<IdpUser, CanonicalError> {
        unimplemented!()
    }
    async fn get_user(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: Uuid,
    ) -> Result<IdpUser, CanonicalError> {
        unimplemented!()
    }
    async fn list_users(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: ListUsersQuery,
    ) -> Result<Page<IdpUser>, CanonicalError> {
        unimplemented!()
    }
    async fn delete_user(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: Uuid,
    ) -> Result<(), CanonicalError> {
        unimplemented!()
    }
    async fn update_user(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: Uuid,
        _: IdpUserPatch,
    ) -> Result<IdpUser, CanonicalError> {
        unimplemented!()
    }
    async fn create_service_account(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: String,
        _: Vec<String>,
    ) -> Result<IdpServiceAccountCredentials, CanonicalError> {
        unimplemented!()
    }
    async fn list_service_accounts(
        &self,
        _: &SecurityContext,
        _: Uuid,
    ) -> Result<Vec<IdpServiceAccountSummary>, CanonicalError> {
        unimplemented!()
    }
    async fn rotate_service_account_secret(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &str,
    ) -> Result<IdpServiceAccountCredentials, CanonicalError> {
        unimplemented!()
    }
    async fn revoke_service_account(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &str,
    ) -> Result<(), CanonicalError> {
        unimplemented!()
    }
    async fn get_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: GtsTypeId,
    ) -> Result<MetadataEntry, CanonicalError> {
        unimplemented!()
    }
    async fn resolve_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: GtsTypeId,
    ) -> Result<Option<MetadataEntry>, CanonicalError> {
        unimplemented!()
    }
    async fn list_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: &ODataQuery,
    ) -> Result<Page<MetadataEntry>, CanonicalError> {
        unimplemented!()
    }
    async fn upsert_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: UpsertMetadataRequest,
    ) -> Result<MetadataEntry, CanonicalError> {
        unimplemented!()
    }
    async fn delete_metadata(
        &self,
        _: &SecurityContext,
        _: Uuid,
        _: GtsTypeId,
    ) -> Result<(), CanonicalError> {
        unimplemented!()
    }
}

/// Keeps every run it is asked to queue, for the test to read.
#[derive(Default)]
struct RecordingQueue(Mutex<Vec<(String, Value)>>);

#[async_trait]
impl TaskQueue for RecordingQueue {
    async fn enqueue(&self, _: &SecurityContext, run: NewRun<'_>) -> anyhow::Result<Uuid> {
        self.0
            .lock()
            .unwrap()
            .push((run.task_type.to_owned(), run.payload));
        Ok(Uuid::new_v4())
    }
    async fn run(&self, _: Uuid, _: Uuid) -> anyhow::Result<Option<RunView>> {
        Ok(None)
    }
    async fn request_cancel(&self, _: Uuid, _: Uuid) -> anyhow::Result<()> {
        Ok(())
    }
}

// ── rig ──────────────────────────────────────────────────────────────────

/// `spec_quality::is_configured` is one process-wide flag, and these tests
/// set it both ways. Held for the whole of each test that classifies with
/// analysis on, so no two of them see each other's setting.
static CONFIGURED_FLAG: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Rig {
    service: DocumentsService,
    queue: Arc<RecordingQueue>,
    ctx: SecurityContext,
    workspace: Uuid,
}

impl Rig {
    /// A fresh workspace, and a service that analyses what a sync changed,
    /// at most `max_documents` per sync. `None` is a deployment that only
    /// classifies.
    async fn new(max_documents: Option<usize>) -> Self {
        let workspace = Uuid::new_v4();
        let queue = Arc::new(RecordingQueue::default());
        let hub = Arc::new(ClientHub::new());
        hub.register_scoped::<dyn TaskQueue>(
            ClientScope::gts_id(TASK_QUEUE_INSTANCE_ID),
            queue.clone(),
        );
        let service = DocumentsService::new(
            Arc::new(super::repo_tests::repo().await),
            Arc::new(EveryTenantExists),
        )
        .with_sync_analysis(max_documents.map(|max_documents| SyncAnalysis { hub, max_documents }));
        let ctx = SecurityContext::builder()
            .subject_id(Uuid::new_v4())
            .subject_type("user")
            .subject_tenant_id(workspace)
            .build()
            .expect("security context");
        Self {
            service,
            queue,
            ctx,
            workspace,
        }
    }

    /// One sync of `files`; returns (changed documents, runs queued).
    async fn sync(&self, files: &[(&str, &str)]) -> (usize, usize) {
        let files = files
            .iter()
            .map(|(path, content)| IngestedFile {
                node_id: node(path),
                path: (*path).to_owned(),
                content: (*content).to_owned(),
            })
            .collect();
        let outcome = self
            .service
            .classify_ingested(&self.ctx, self.workspace, None, files)
            .await
            .expect("classify");
        (outcome.changed_documents, outcome.analyses_queued)
    }

    /// Everything queued since the last call, by detector.
    fn take_runs(&self) -> Vec<Value> {
        let runs = std::mem::take(&mut *self.queue.0.lock().unwrap());
        assert!(
            runs.iter()
                .all(|(t, _)| t == crate::spec_quality::batch_task::BATCH_TASK_TYPE),
            "a sync queues batch runs only: {runs:?}"
        );
        runs.into_iter().map(|(_, payload)| payload).collect()
    }

    fn binding(&self, path: &str) -> Uuid {
        binding_row_id(self.workspace, None, &node(path))
    }

    /// Record a verdict the way a finished (or refused) run does.
    async fn verdict(&self, path: &str, detector: &str, state: &str) {
        self.service
            .record_detector_verdict(DetectorVerdict {
                workspace_id: self.workspace,
                binding_id: Some(self.binding(path)),
                document_id: None,
                detector: detector.to_owned(),
                state: state.to_owned(),
                task_id: None,
                summary: format!("{detector}: test"),
            })
            .await
            .expect("record verdict");
    }
}

fn node(path: &str) -> String {
    format!("node:{path}")
}

/// A document that declares its type, so classification is not the thing
/// under test.
fn prd(body: &str) -> String {
    format!("---\ntype: prd\n---\n\n# Product requirements\n\n{body}\n")
}

/// The ids of a run's items, in order.
fn item_ids(run: &Value) -> Vec<String> {
    run["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap().to_owned())
        .collect()
}

fn run_for<'a>(runs: &'a [Value], detector: &str) -> Option<&'a Value> {
    runs.iter().find(|r| r["detector"] == detector)
}

fn detectors(runs: &[Value]) -> Vec<&str> {
    runs.iter()
        .map(|r| r["detector"].as_str().unwrap())
        .collect()
}

// ── which documents a sync analyses ──────────────────────────────────────

/// A first sync: every typed document is new. `purpose` and `leak` run on
/// each, `bloat` over the set, and each run carries the subjects its results
/// are recorded against. A source file and an untyped note are not asked
/// about -- the detectors judge a document against its type.
#[tokio::test]
async fn a_first_sync_analyses_every_typed_document_and_records_against_its_binding() {
    let _flag = CONFIGURED_FLAG.lock().await;
    crate::spec_quality::set_configured_for_tests(true);
    let rig = Rig::new(Some(50)).await;

    let (changed, queued) = rig
        .sync(&[
            ("docs/a.md", &prd("first")),
            ("docs/b.md", &prd("second")),
            ("src/main.rs", "fn main() {}"),
        ])
        .await;
    assert_eq!(changed, 2);
    assert_eq!(queued, 3);

    let runs = rig.take_runs();
    assert_eq!(detectors(&runs), ["purpose", "leak", "bloat"]);
    for detector in ["purpose", "leak"] {
        let run = run_for(&runs, detector).unwrap();
        assert_eq!(item_ids(run), ["docs/a.md", "docs/b.md"], "{detector}");
    }
    let purpose = run_for(&runs, "purpose").unwrap();
    let record = &purpose["record"];
    assert_eq!(record["workspace_id"], rig.workspace.to_string());
    let subject = &record["subjects"]["docs/a.md"];
    assert_eq!(subject["node"], node("docs/a.md"));
    assert_eq!(subject["binding_id"], rig.binding("docs/a.md").to_string());
    assert!(
        record["subjects"].get("src/main.rs").is_none(),
        "not a document, not a subject: {record}"
    );
    // Leak judges a document against the type it claims, so it carries one.
    let leak = run_for(&runs, "leak").unwrap();
    assert_eq!(leak["items"][0]["payload"]["doc_type"], "prd");

    let bloat = run_for(&runs, "bloat").unwrap();
    let docs = bloat["items"][0]["payload"]["docs"].as_object().unwrap();
    let mut paths: Vec<&String> = docs.keys().collect();
    paths.sort();
    assert_eq!(paths, ["docs/a.md", "docs/b.md"]);
}

/// The property that makes analysing on sync affordable: nothing changed and
/// everything has a `purpose` verdict, so nothing is queued.
#[tokio::test]
async fn a_resync_of_an_unchanged_analysed_repository_queues_nothing() {
    let _flag = CONFIGURED_FLAG.lock().await;
    crate::spec_quality::set_configured_for_tests(true);
    let rig = Rig::new(Some(50)).await;
    let files = [("docs/a.md", prd("first")), ("docs/b.md", prd("second"))];
    let files: Vec<(&str, &str)> = files.iter().map(|(p, c)| (*p, c.as_str())).collect();
    rig.sync(&files).await;
    rig.take_runs();
    rig.verdict("docs/a.md", "purpose", "passed").await;
    rig.verdict("docs/b.md", "purpose", "failed").await;

    assert_eq!(rig.sync(&files).await, (0, 0));
    assert!(rig.take_runs().is_empty());
}

/// A repository synced before the sync started analysing has documents that
/// never changed and were never analysed. They are picked up -- otherwise
/// they would have no findings until somebody edited each one. Only a
/// `purpose` verdict counts as analysed: a document with a leak verdict
/// alone is still asked about.
#[tokio::test]
async fn an_unchanged_document_that_never_had_a_purpose_verdict_is_analysed() {
    let _flag = CONFIGURED_FLAG.lock().await;
    crate::spec_quality::set_configured_for_tests(true);
    let rig = Rig::new(Some(50)).await;
    let files = [
        ("docs/a.md", prd("first")),
        ("docs/b.md", prd("second")),
        ("docs/c.md", prd("third")),
    ];
    let files: Vec<(&str, &str)> = files.iter().map(|(p, c)| (*p, c.as_str())).collect();
    rig.sync(&files).await;
    rig.take_runs();
    rig.verdict("docs/a.md", "purpose", "passed").await;
    rig.verdict("docs/b.md", "leak", "passed").await;

    let (changed, queued) = rig.sync(&files).await;
    assert_eq!(changed, 0, "nothing's text changed");
    assert_eq!(queued, 3);
    let runs = rig.take_runs();
    assert_eq!(
        item_ids(run_for(&runs, "purpose").unwrap()),
        ["docs/b.md", "docs/c.md"]
    );
    assert_eq!(
        item_ids(run_for(&runs, "leak").unwrap()),
        ["docs/b.md", "docs/c.md"]
    );
    // Bloat still reads the whole typed set: a document can repeat one that
    // is not being re-analysed.
    let bloat = run_for(&runs, "bloat").unwrap();
    assert_eq!(
        bloat["items"][0]["payload"]["docs"]
            .as_object()
            .unwrap()
            .len(),
        3
    );
}

/// A document the service refused is recorded `pending` (see
/// `AnalyzeBatchTask::record_refusal`), and that counts as analysed: a sync
/// must not ask about it again every time.
#[tokio::test]
async fn a_pending_purpose_verdict_counts_as_analysed() {
    let _flag = CONFIGURED_FLAG.lock().await;
    crate::spec_quality::set_configured_for_tests(true);
    let rig = Rig::new(Some(50)).await;
    let a = prd("first");
    rig.sync(&[("docs/a.md", &a)]).await;
    rig.take_runs();
    rig.verdict("docs/a.md", "purpose", "pending").await;

    assert_eq!(rig.sync(&[("docs/a.md", &a)]).await, (0, 0));
}

/// An edit is analysed; its unchanged, analysed neighbour is not -- except by
/// `bloat`, which is over the set.
#[tokio::test]
async fn an_edit_analyses_only_the_edited_document() {
    let _flag = CONFIGURED_FLAG.lock().await;
    crate::spec_quality::set_configured_for_tests(true);
    let rig = Rig::new(Some(50)).await;
    let b = prd("second");
    rig.sync(&[("docs/a.md", &prd("first")), ("docs/b.md", &b)])
        .await;
    rig.take_runs();
    rig.verdict("docs/a.md", "purpose", "passed").await;
    rig.verdict("docs/b.md", "purpose", "passed").await;

    let (changed, queued) = rig
        .sync(&[("docs/a.md", &prd("first, edited")), ("docs/b.md", &b)])
        .await;
    assert_eq!((changed, queued), (1, 3));
    let runs = rig.take_runs();
    assert_eq!(item_ids(run_for(&runs, "purpose").unwrap()), ["docs/a.md"]);
    assert_eq!(item_ids(run_for(&runs, "leak").unwrap()), ["docs/a.md"]);
    assert!(run_for(&runs, "bloat").is_some());
}

/// One document is not a set: there is nothing for it to duplicate.
#[tokio::test]
async fn a_single_typed_document_gets_no_bloat_run() {
    let _flag = CONFIGURED_FLAG.lock().await;
    crate::spec_quality::set_configured_for_tests(true);
    let rig = Rig::new(Some(50)).await;
    assert_eq!(rig.sync(&[("docs/a.md", &prd("only"))]).await, (1, 2));
    assert_eq!(detectors(&rig.take_runs()), ["purpose", "leak"]);
}

/// A first sync of a large repository sees everything as new. Past the cap it
/// analyses the first ones -- changed documents before never-analysed ones --
/// and leaves the rest for the next sync, rather than queueing hours of
/// upstream work. The count of changed documents is still the true one.
#[tokio::test]
async fn a_sync_analyses_at_most_the_cap_changed_documents_first() {
    let _flag = CONFIGURED_FLAG.lock().await;
    crate::spec_quality::set_configured_for_tests(true);
    let rig = Rig::new(Some(2)).await;
    let c = prd("third");
    // c.md is synced (and so known) without ever getting a purpose verdict.
    rig.sync(&[("docs/c.md", &c)]).await;
    rig.take_runs();

    let (changed, queued) = rig
        .sync(&[
            ("docs/c.md", &c),
            ("docs/a.md", &prd("first")),
            ("docs/b.md", &prd("second")),
            ("docs/d.md", &prd("fourth")),
        ])
        .await;
    assert_eq!(changed, 3, "the outcome counts every changed document");
    assert_eq!(queued, 3);
    let runs = rig.take_runs();
    let purpose = run_for(&runs, "purpose").unwrap();
    assert_eq!(
        item_ids(purpose),
        ["docs/a.md", "docs/b.md"],
        "the first changed documents, ahead of the never-analysed c.md"
    );
    let subjects = purpose["record"]["subjects"].as_object().unwrap();
    assert_eq!(subjects.len(), 2, "the record block names only what runs");
    let bloat = run_for(&runs, "bloat").unwrap();
    assert_eq!(
        bloat["items"][0]["payload"]["docs"]
            .as_object()
            .unwrap()
            .len(),
        2,
        "the set is capped too"
    );
}

/// A deployment that cannot reach the service queues nothing a sync did not
/// ask for: those runs could only fail item by item. The sync still says what
/// changed.
#[tokio::test]
async fn nothing_is_queued_when_spec_quality_is_not_configured() {
    let _flag = CONFIGURED_FLAG.lock().await;
    crate::spec_quality::set_configured_for_tests(false);
    let rig = Rig::new(Some(50)).await;
    let outcome = rig
        .sync(&[("docs/a.md", &prd("first")), ("docs/b.md", &prd("second"))])
        .await;
    crate::spec_quality::set_configured_for_tests(true);
    assert_eq!(outcome, (2, 0));
    assert!(rig.take_runs().is_empty());
}

/// A deployment with analysis on sync switched off only classifies.
#[tokio::test]
async fn nothing_is_queued_without_sync_analysis() {
    let _flag = CONFIGURED_FLAG.lock().await;
    crate::spec_quality::set_configured_for_tests(true);
    let rig = Rig::new(None).await;
    let (_, queued) = rig.sync(&[("docs/a.md", &prd("first"))]).await;
    assert_eq!(queued, 0);
    assert!(rig.take_runs().is_empty());
}

// ── what a result is recorded against ────────────────────────────────────

/// A named binding is recorded against its graph node and its own id, at the
/// path the run names it with.
#[tokio::test]
async fn a_named_binding_is_recorded_against_its_node_and_id() {
    let rig = Rig::new(None).await;
    rig.sync(&[("docs/a.md", &prd("first")), ("docs/b.md", &prd("second"))])
        .await;
    let spec = rig
        .service
        .record_subjects(rig.workspace, None, &[rig.binding("docs/a.md")], &[], &[])
        .await
        .unwrap();
    assert_eq!(spec.workspace_id, rig.workspace);
    assert_eq!(spec.subjects.len(), 1, "only what was named");
    let s = &spec.subjects["docs/a.md"];
    assert_eq!(s.node, node("docs/a.md"));
    assert_eq!(s.binding_id, Some(rig.binding("docs/a.md")));
    assert_eq!(s.document_id, None);
}

/// The IDE sends the document on screen as text alone, at its repository
/// path, without naming its binding. That path is still that binding --
/// otherwise its findings would be recorded against nothing and never reach
/// the editor.
#[tokio::test]
async fn an_inline_repository_path_is_its_binding() {
    let rig = Rig::new(None).await;
    rig.sync(&[("docs/a.md", &prd("first")), ("docs/b.md", &prd("second"))])
        .await;
    let spec = rig
        .service
        .record_subjects(
            rig.workspace,
            None,
            &[],
            &[],
            &["docs/b.md".to_owned(), "docs/unknown.md".to_owned()],
        )
        .await
        .unwrap();
    assert_eq!(spec.subjects.len(), 1, "{:?}", spec.subjects);
    assert_eq!(
        spec.subjects["docs/b.md"].binding_id,
        Some(rig.binding("docs/b.md"))
    );
    assert!(
        !spec.subjects.contains_key("docs/unknown.md"),
        "a path with no binding has nothing to be recorded against"
    );
}

/// A Studio document is `studio-doc:<id>` -- whether the request named it
/// or only sent its text at `studio-doc/<id>.md`. A path under that prefix
/// that is not an id names nothing.
#[tokio::test]
async fn a_studio_document_is_recorded_by_its_id_named_or_inline() {
    let rig = Rig::new(None).await;
    let named = Uuid::new_v4();
    let inline = Uuid::new_v4();
    let spec = rig
        .service
        .record_subjects(
            rig.workspace,
            None,
            &[],
            &[named],
            &[
                format!("studio-doc/{inline}.md"),
                "studio-doc/not-an-id.md".to_owned(),
                format!("studio-doc/{inline}.txt"),
            ],
        )
        .await
        .unwrap();
    assert_eq!(spec.subjects.len(), 2, "{:?}", spec.subjects);
    for id in [named, inline] {
        let s = &spec.subjects[&format!("studio-doc/{id}.md")];
        assert_eq!(s.node, format!("studio-doc:{id}"));
        assert_eq!(s.document_id, Some(id));
        assert_eq!(s.binding_id, None);
    }
}

// ── tool configuration ───────────────────────────────────────────────────

/// A kit's example ADR declares its type and fills every section, and is
/// still not one of the project's documents: it is recorded as not one and
/// nothing is asked about it. A person who says otherwise is listened to.
#[tokio::test]
async fn tool_configuration_is_not_a_document_unless_a_person_says_so() {
    use super::model::BindingState;
    use super::service::{BindingAction, BindingDecision};

    let _flag = CONFIGURED_FLAG.lock().await;
    crate::spec_quality::set_configured_for_tests(true);
    let rig = Rig::new(Some(50)).await;
    let kit = ".cf-studio/config/kits/sdlc/artifacts/ADR/examples/example.md";
    let skill = ".claude/skills/review/SKILL.md";
    let files = [
        (kit, prd("an example")),
        (skill, prd("a prompt")),
        ("docs/a.md", prd("ours")),
    ];
    let files: Vec<(&str, &str)> = files.iter().map(|(p, c)| (*p, c.as_str())).collect();

    let (changed, _) = rig.sync(&files).await;
    assert_eq!(changed, 1, "only docs/a.md is a document");
    let runs = rig.take_runs();
    let purpose = run_for(&runs, "purpose").unwrap();
    assert_eq!(item_ids(purpose), ["docs/a.md"]);

    let state_of = |path: &'static str| {
        let rig = &rig;
        async move {
            let (bindings, _) = rig
                .service
                .list_bindings(rig.workspace, None, crate::pagination::PageQuery::default())
                .await
                .unwrap();
            bindings
                .into_iter()
                .find(|b| b.path == path)
                .map(|b| b.state)
                .unwrap()
        }
    };
    assert_eq!(state_of(kit).await, BindingState::NotADocument);
    assert_eq!(state_of(skill).await, BindingState::NotADocument);

    rig.service
        .decide_binding(
            &rig.ctx,
            rig.workspace,
            rig.binding(skill),
            BindingDecision {
                action: BindingAction::Set {
                    type_key: "prd".to_owned(),
                },
                source: None,
                confidence: None,
                content: None,
            },
        )
        .await
        .unwrap();
    rig.sync(&files).await;
    assert_eq!(state_of(skill).await, BindingState::Manual);
    assert_eq!(state_of(kit).await, BindingState::NotADocument);
}
