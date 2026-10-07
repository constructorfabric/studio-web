use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::{Value, json};

use super::*;
use crate::components_catalog::port::ComponentValues as Component;
use crate::reports::github::FileText;
use crate::reports::source::PlanFile;
use crate::reports::store::MemoryStore;
use crate::scheduler::port::{ScheduleSpec, ScheduleView, Schedules};

/// A catalogue that remembers what it was asked to sync.
#[derive(Default)]
struct FakeCatalog {
    planned: Vec<Value>,
    synced: Mutex<Vec<BoardSource>>,
    fail: bool,
}

#[async_trait]
impl RoadmapCatalog for FakeCatalog {
    async fn planned(&self, _ctx: &SecurityContext) -> Result<Vec<Value>> {
        Ok(self.planned.clone())
    }
    async fn components(&self, _ctx: &SecurityContext) -> Result<Vec<Component>> {
        Ok(Vec::new())
    }
    async fn sync_board(&self, _ctx: &SecurityContext, board: BoardSource) -> Result<Uuid> {
        if self.fail {
            anyhow::bail!("studio-tasks has no database configured");
        }
        self.synced.lock().unwrap().push(board);
        Ok(Uuid::from_u128(77))
    }
}

/// A repository with one file in it.
struct FakeRepo {
    text: &'static str,
    asked: Mutex<Vec<String>>,
    /// The tenant the connection lives in; another tenant does not find it.
    connection_tenant: Uuid,
}

#[async_trait]
impl PlanReader for FakeRepo {
    async fn connection(
        &self,
        _ctx: &SecurityContext,
        tenant: Uuid,
        _c: Option<Uuid>,
    ) -> Result<()> {
        if tenant != self.connection_tenant {
            anyhow::bail!("the board cannot be read: connection not found");
        }
        Ok(())
    }

    async fn read(
        &self,
        _ctx: &SecurityContext,
        _t: Uuid,
        _c: Option<Uuid>,
        file: &PlanFile,
    ) -> Result<FileText> {
        self.asked.lock().unwrap().push(file.display());
        if file.path == "missing.yaml" {
            anyhow::bail!("{} is not visible to this connection", file.display());
        }
        if file.path == "README.md" {
            return Ok(FileText {
                text: "# A readme

prose"
                    .into(),
                sha: None,
            });
        }
        Ok(FileText {
            text: self.text.to_string(),
            sha: Some("abc123".into()),
        })
    }
}

const PLAN: &str = "board: constructorfabric/48\nroots: [3342]\nconsumers: { A: Acronis }\nusers:\n  alice: { team: t }\n";

fn ctx() -> SecurityContext {
    crate::reports::test_ctx(0x7e4a47)
}

fn service(catalog: Arc<FakeCatalog>, repo: Option<Arc<FakeRepo>>) -> ReportsService {
    let link: CatalogLink = Arc::new(move || Ok(Arc::clone(&catalog) as Arc<dyn RoadmapCatalog>));
    ReportsService::new(
        Arc::new(MemoryStore::default()),
        link,
        repo.map(|r| r as Arc<dyn PlanReader>),
    )
}

fn repo() -> Arc<FakeRepo> {
    Arc::new(FakeRepo {
        text: PLAN,
        asked: Mutex::new(Vec::new()),
        connection_tenant: ctx().subject_tenant_id(),
    })
}

#[tokio::test]
async fn an_unsaved_source_is_an_empty_one() {
    let s = service(Arc::default(), None);
    let src = s.source(&ctx(), "roadmap").await.unwrap();
    assert_eq!(src.report, "roadmap");
    assert!(src.plan_file.is_none() && src.snapshot.is_none());
}

#[tokio::test]
async fn an_uploaded_plan_is_its_own_snapshot() {
    let s = service(Arc::default(), None);
    let saved = s
        .save_source(
            &ctx(),
            ReportSource {
                report: "roadmap".into(),
                plan_yaml: Some(PLAN.into()),
                ..ReportSource::default()
            },
        )
        .await
        .unwrap();
    let snap = saved.snapshot.expect("snapshot");
    assert_eq!(snap.from, "upload");
    assert_eq!(snap.text, PLAN.trim());
    let (plan, parsed) = ReportsService::plan_of(&s.source(&ctx(), "roadmap").await.unwrap());
    assert!(plan.is_some());
    assert_eq!(parsed.users.len(), 1);
}

#[tokio::test]
async fn a_source_that_does_not_read_is_refused_before_it_is_saved() {
    let s = service(Arc::default(), None);
    let err = s
        .save_source(
            &ctx(),
            ReportSource {
                report: "roadmap".into(),
                plan_file: Some("not a file".into()),
                ..ReportSource::default()
            },
        )
        .await
        .unwrap_err();
    assert!(err.contains("names no file"), "{err}");
    assert!(
        s.source(&ctx(), "roadmap")
            .await
            .unwrap()
            .plan_file
            .is_none()
    );
}

#[tokio::test]
async fn a_refresh_reads_the_file_and_syncs_the_board_it_names() {
    let catalog = Arc::new(FakeCatalog::default());
    let repo = repo();
    let s = service(Arc::clone(&catalog), Some(Arc::clone(&repo)));
    s.save_source(
        &ctx(),
        ReportSource {
            report: "roadmap".into(),
            plan_file: Some("constructorfabric/cf-internal:gears/gears.yaml@main".into()),
            ..ReportSource::default()
        },
    )
    .await
    .unwrap();
    let r = s.refresh(&ctx(), "roadmap").await.expect("refreshed");
    assert_eq!(r.sync_run, Some(Uuid::from_u128(77)));
    assert_eq!(
        *repo.asked.lock().unwrap(),
        vec!["constructorfabric/cf-internal:gears/gears.yaml@main"]
    );
    let synced = catalog.synced.lock().unwrap().clone();
    assert_eq!(synced.len(), 1);
    assert_eq!(
        (synced[0].owner.as_str(), synced[0].number),
        ("constructorfabric", 48)
    );
    assert_eq!(synced[0].roots, vec!["3342"]);
    assert_eq!(
        synced[0].consumers.get("A").map(String::as_str),
        Some("Acronis")
    );
    assert_eq!(synced[0].tenant, ctx().subject_tenant_id());
    let stored = s.source(&ctx(), "roadmap").await.unwrap();
    let snap = stored.snapshot.expect("snapshot");
    assert_eq!(
        (snap.from.as_str(), snap.sha.as_deref()),
        (
            "constructorfabric/cf-internal:gears/gears.yaml@main",
            Some("abc123")
        )
    );
    assert_eq!(
        stored.last_refresh.and_then(|r| r.sync_run),
        Some(Uuid::from_u128(77))
    );
}

#[tokio::test]
async fn a_failed_refresh_is_recorded_and_keeps_the_last_plan() {
    let catalog = Arc::new(FakeCatalog::default());
    let s = service(Arc::clone(&catalog), Some(repo()));
    s.save_source(
        &ctx(),
        ReportSource {
            report: "roadmap".into(),
            plan_file: Some("o/r:gears.yaml".into()),
            ..ReportSource::default()
        },
    )
    .await
    .unwrap();
    s.refresh(&ctx(), "roadmap").await.expect("first read");
    // The file goes away: the refresh fails, says why, and the report is
    // still drawn from the plan read last time.
    let mut src = s.source(&ctx(), "roadmap").await.unwrap();
    src.plan_file = Some("o/r:missing.yaml".into());
    let kept = src.snapshot.clone();
    s.store.put(&ctx(), &src).await.unwrap();
    let err = s.refresh(&ctx(), "roadmap").await.unwrap_err();
    assert!(format!("{err:#}").contains("not visible"), "{err:#}");
    let after = s.source(&ctx(), "roadmap").await.unwrap();
    assert!(
        after
            .last_refresh
            .as_ref()
            .and_then(|r| r.error.as_deref())
            .is_some_and(|e| e.contains("not visible"))
    );
    assert_eq!(after.snapshot, kept);
    assert_eq!(catalog.synced.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_refresh_without_a_board_anywhere_says_so() {
    let s = service(Arc::default(), None);
    s.save_source(
        &ctx(),
        ReportSource {
            report: "roadmap".into(),
            plan_yaml: Some("users: {}\n".into()),
            ..ReportSource::default()
        },
    )
    .await
    .unwrap();
    let err = s.refresh(&ctx(), "roadmap").await.unwrap_err();
    assert!(format!("{err:#}").contains("no board"), "{err:#}");
}

/// What dev showed: the source was saved with the organization's connection
/// and refreshed in a tenant that does not hold it. The sync it queued could
/// not read the board, succeeded anyway, and the report said nothing.
#[tokio::test]
async fn a_connection_this_tenant_does_not_hold_fails_the_refresh_before_any_sync() {
    let catalog = Arc::new(FakeCatalog::default());
    let elsewhere = Arc::new(FakeRepo {
        text: PLAN,
        asked: Mutex::new(Vec::new()),
        connection_tenant: Uuid::from_u128(0xc31da936),
    });
    let s = service(Arc::clone(&catalog), Some(elsewhere));
    s.save_source(
        &ctx(),
        ReportSource {
            report: "roadmap".into(),
            plan_yaml: Some(PLAN.into()),
            connection_id: Some(Uuid::from_u128(0xdd)),
            ..ReportSource::default()
        },
    )
    .await
    .unwrap();
    let err = s.refresh(&ctx(), "roadmap").await.unwrap_err();
    assert!(
        format!("{err:#}").contains("connection not found"),
        "{err:#}"
    );
    assert!(catalog.synced.lock().unwrap().is_empty(), "no sync queued");
    let after = s.source(&ctx(), "roadmap").await.unwrap();
    assert!(
        after
            .last_refresh
            .and_then(|r| r.error)
            .is_some_and(|e| e.contains("cannot be read")),
        "the error is on the source, where the screen reads it"
    );
}

#[tokio::test]
async fn a_file_with_no_connector_to_read_it_says_so() {
    let s = service(Arc::default(), None);
    s.save_source(
        &ctx(),
        ReportSource {
            report: "roadmap".into(),
            plan_file: Some("o/r:p.yaml".into()),
            board: Some("o/1".into()),
            ..ReportSource::default()
        },
    )
    .await
    .unwrap();
    let err = s.refresh(&ctx(), "roadmap").await.unwrap_err();
    assert!(
        format!("{err:#}").contains("no GitHub connector"),
        "{err:#}"
    );
}

#[tokio::test]
async fn a_changed_file_drops_the_snapshot_of_the_old_one() {
    let s = service(Arc::default(), Some(repo()));
    s.save_source(
        &ctx(),
        ReportSource {
            report: "roadmap".into(),
            plan_file: Some("o/r:a.yaml".into()),
            ..ReportSource::default()
        },
    )
    .await
    .unwrap();
    s.refresh(&ctx(), "roadmap").await.unwrap();
    // Saved again with the same file: the snapshot stays.
    let same = s
        .save_source(
            &ctx(),
            ReportSource {
                report: "roadmap".into(),
                plan_file: Some("o/r:a.yaml".into()),
                ..ReportSource::default()
            },
        )
        .await
        .unwrap();
    assert!(same.snapshot.is_some());
    assert!(same.last_refresh.is_some());
    // Another file: what was read from the old one is no longer this plan.
    let other = s
        .save_source(
            &ctx(),
            ReportSource {
                report: "roadmap".into(),
                plan_file: Some("o/r:b.yaml".into()),
                ..ReportSource::default()
            },
        )
        .await
        .unwrap();
    assert!(other.snapshot.is_none());
}

#[test]
fn the_plan_picks_the_definition_and_the_report_has_its_own() {
    let roadmap = kind("roadmap").expect("roadmap");
    assert_eq!(
        ReportsService::definition_of(roadmap, None).unwrap().id,
        "back_roadmap"
    );
    let plan = parse_plan("report: back_roadmap\n").unwrap();
    assert_eq!(
        ReportsService::definition_of(roadmap, Some(&plan))
            .unwrap()
            .id,
        "back_roadmap"
    );
    let plan = parse_plan("report:\n  id: mine\n  sheets:\n    - kind: people\n").unwrap();
    assert_eq!(
        ReportsService::definition_of(roadmap, Some(&plan))
            .unwrap()
            .id,
        "mine"
    );
    let plan = parse_plan("report: weekly\n").unwrap();
    assert!(ReportsService::definition_of(roadmap, Some(&plan)).is_err());
    assert!(kind("nope").is_none());
}

#[tokio::test]
async fn a_workbook_is_drawn_with_the_plans_definition() {
    let catalog = Arc::new(FakeCatalog {
        planned: vec![json!({
            "board": "o/projects/48", "ix": 0, "gear": true, "number": 1, "title": "CORE - X",
            "url": "https://github.com/o/r/issues/1", "assignees": ["alice"],
            "sheet": { "milestone": "26.11", "fields": { "Implemenation": "Todo" } },
        })],
        ..FakeCatalog::default()
    });
    let s = service(catalog, None);
    s.save_source(
        &ctx(),
        ReportSource {
            report: "roadmap".into(),
            plan_yaml: Some("report:\n  sheets:\n    - kind: people\n      name: Team\n".into()),
            ..ReportSource::default()
        },
    )
    .await
    .unwrap();
    let bytes = s
        .workbook(
            &ctx(),
            kind("roadmap").unwrap(),
            Date::from_calendar_date(2026, time::Month::October, 1).unwrap(),
        )
        .await
        .unwrap();
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("xl/worksheets/sheet1.xml"));
    assert!(!text.contains("xl/worksheets/sheet2.xml"), "one sheet only");
}

#[tokio::test]
async fn a_file_that_is_not_a_plan_is_refused_and_the_board_is_not_synced() {
    let catalog = Arc::new(FakeCatalog::default());
    let s = service(Arc::clone(&catalog), Some(repo()));
    s.save_source(
        &ctx(),
        ReportSource {
            report: "roadmap".into(),
            plan_file: Some("o/r:README.md".into()),
            board: Some("o/48".into()),
            ..ReportSource::default()
        },
    )
    .await
    .unwrap();
    let err = s.refresh(&ctx(), "roadmap").await.unwrap_err();
    assert!(format!("{err:#}").contains("not a mapping"), "{err:#}");
    assert!(catalog.synced.lock().unwrap().is_empty());
    assert!(
        s.source(&ctx(), "roadmap")
            .await
            .unwrap()
            .snapshot
            .is_none()
    );
}

#[tokio::test]
async fn an_upload_is_kept_until_it_is_taken_back_or_a_file_replaces_it() {
    let s = service(Arc::default(), Some(repo()));
    let up = |t: Option<&str>, file: Option<&str>| ReportSource {
        report: "roadmap".into(),
        plan_yaml: t.map(str::to_string),
        plan_file: file.map(str::to_string),
        ..ReportSource::default()
    };
    let saved = s.save_source(&ctx(), up(Some(PLAN), None)).await.unwrap();
    assert!(
        saved.plan_yaml.is_none(),
        "the text is the snapshot's, not the source's"
    );
    // Saved again without an upload: still the plan.
    let again = s.save_source(&ctx(), up(None, None)).await.unwrap();
    assert_eq!(
        again.snapshot.as_ref().map(|x| x.from.as_str()),
        Some("upload")
    );
    // Taken back.
    let cleared = s.save_source(&ctx(), up(Some(""), None)).await.unwrap();
    assert!(cleared.snapshot.is_none());
    // Uploaded, then a file named: the upload stays the plan until the
    // file is read, then the file's is.
    s.save_source(&ctx(), up(Some(PLAN), None)).await.unwrap();
    let named = s
        .save_source(&ctx(), up(None, Some("o/r:gears.yaml")))
        .await
        .unwrap();
    assert!(
        named.snapshot.is_none(),
        "a named file is the plan from its first read"
    );
    s.refresh(&ctx(), "roadmap").await.unwrap();
    let read = s.source(&ctx(), "roadmap").await.unwrap();
    assert_eq!(
        read.snapshot.map(|x| x.from),
        Some("o/r:gears.yaml".to_string())
    );
}

#[tokio::test]
async fn a_refresh_of_an_unsaved_source_writes_nothing() {
    let s = service(Arc::default(), None);
    let err = s.refresh(&ctx(), "roadmap").await.unwrap_err();
    assert!(format!("{err:#}").contains("not set up"), "{err:#}");
    // A schedule that fires for an organization that set nothing up must
    // not leave a source behind.
    assert!(s.store.get(&ctx(), "roadmap").await.unwrap().is_none());
}

/// A scheduler that keeps schedules in a list.
#[derive(Default)]
struct FakeSchedules {
    all: Mutex<Vec<(ScheduleSpec, ScheduleView)>>,
}

#[async_trait]
impl Schedules for FakeSchedules {
    async fn find(&self, task_type: &str, matching: &Value) -> Result<Option<ScheduleView>> {
        Ok(self
            .all
            .lock()
            .unwrap()
            .iter()
            .find(|(s, _)| {
                s.task_type == task_type
                    && crate::scheduler::port::payload_matches(&s.payload, matching)
            })
            .map(|(_, v)| v.clone()))
    }
    async fn ensure(&self, _ctx: &SecurityContext, spec: ScheduleSpec) -> Result<ScheduleView> {
        let mut all = self.all.lock().unwrap();
        let view = ScheduleView {
            id: Uuid::from_u128(all.len() as u128 + 1),
            expression: spec.cron.clone(),
            enabled: spec.enabled,
            next_run_at: "2026-10-02T09:00:00Z".into(),
            last_run_id: None,
        };
        match all
            .iter_mut()
            .find(|(s, _)| s.task_type == spec.task_type && s.payload == spec.payload)
        {
            Some((s, v)) => {
                v.enabled = spec.enabled;
                v.expression = spec.cron.clone();
                *s = spec;
                Ok(v.clone())
            }
            None => {
                all.push((spec, view.clone()));
                Ok(view)
            }
        }
    }
}

#[tokio::test]
async fn the_schedule_names_the_organization_and_is_one_per_organization() {
    let sched = Arc::new(FakeSchedules::default());
    let link: SchedulesLink = {
        let sched = Arc::clone(&sched);
        Arc::new(move || Ok(Arc::clone(&sched) as Arc<dyn Schedules>))
    };
    let s = service(Arc::default(), None).with_schedules(link);
    assert!(s.schedule(&ctx(), "roadmap").await.unwrap().is_none());
    let on = s.set_schedule(&ctx(), "roadmap", true, None).await.unwrap();
    assert!(on.enabled);
    assert_eq!(on.expression, HOURLY);
    let (spec, _) = sched.all.lock().unwrap()[0].clone();
    assert_eq!(spec.task_type, crate::reports::refresh_task::TASK_TYPE);
    assert_eq!(spec.payload["report"], "roadmap");
    assert_eq!(
        spec.payload["organization_id"],
        ctx().subject_tenant_id().to_string()
    );
    assert!(spec.name.contains(&ctx().subject_tenant_id().to_string()));
    // Switched off: the same schedule, not a second one.
    let off = s
        .set_schedule(&ctx(), "roadmap", false, None)
        .await
        .unwrap();
    assert!(!off.enabled);
    assert_eq!(sched.all.lock().unwrap().len(), 1);
    // Another organization has its own.
    let other = crate::reports::test_ctx(0xbeef);
    assert!(s.schedule(&other, "roadmap").await.unwrap().is_none());
    s.set_schedule(&other, "roadmap", true, Some("*/30 * * * *"))
        .await
        .unwrap();
    assert_eq!(sched.all.lock().unwrap().len(), 2);
    assert_eq!(
        s.schedule(&other, "roadmap")
            .await
            .unwrap()
            .map(|v| v.expression),
        Some("*/30 * * * *".into())
    );
    assert_eq!(
        s.schedule(&ctx(), "roadmap")
            .await
            .unwrap()
            .map(|v| v.enabled),
        Some(false)
    );
}

#[tokio::test]
async fn without_a_scheduler_there_is_no_schedule_and_switching_one_on_says_why() {
    let s = service(Arc::default(), None);
    assert!(s.schedule(&ctx(), "roadmap").await.unwrap().is_none());
    let err = s
        .set_schedule(&ctx(), "roadmap", true, None)
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("schedules nothing"), "{err:#}");
}

fn person(login: &str) -> crate::reports::plan_edit::PersonDto {
    crate::reports::plan_edit::PersonDto {
        login: login.into(),
        alias: None,
        team: None,
        unit: None,
        power: Some(1.0),
        email: None,
    }
}

#[tokio::test]
async fn a_plan_edited_here_is_studios_and_a_stale_edit_is_refused() {
    let s = service(Arc::default(), Some(repo()));
    s.save_source(
        &ctx(),
        ReportSource {
            report: "roadmap".into(),
            plan_file: Some("o/r:gears.yaml".into()),
            ..ReportSource::default()
        },
    )
    .await
    .unwrap();
    s.refresh(&ctx(), "roadmap").await.unwrap();
    let read = s.source(&ctx(), "roadmap").await.unwrap();
    let rev = read.snapshot.as_ref().unwrap().revision;
    assert_eq!(rev, 1, "the first read is revision 1");

    let saved = s
        .edit_plan(
            &ctx(),
            "roadmap",
            rev,
            Section::People(vec![person("alice"), person("bob-example")]),
        )
        .await
        .expect("saved");
    let snap = saved.snapshot.as_ref().unwrap();
    assert_eq!(snap.from, FROM_STUDIO);
    assert_eq!(snap.revision, 2);
    assert_eq!(snap.edited_by, Some(ctx().subject_id().to_string()));
    assert!(saved.plan_file.is_none(), "the file is let go");
    // The keys the screen did not edit are still there.
    let (_, doc) = s.plan_document(&ctx(), "roadmap").await.unwrap();
    assert_eq!(
        doc.get("board").and_then(Yaml::as_str),
        Some("constructorfabric/48")
    );
    assert_eq!(ReportsService::plan_of(&saved).1.users.len(), 2);

    // A second editor still holding revision 1 is refused, and nothing moves.
    let err = s
        .edit_plan(&ctx(), "roadmap", rev, Section::People(Vec::new()))
        .await
        .unwrap_err();
    assert!(
        matches!(err, PlanEditError::Stale { current: 2 }),
        "{err:?}"
    );
    // A refresh no longer reads the file over the edit.
    s.refresh(&ctx(), "roadmap").await.unwrap();
    let after = s.source(&ctx(), "roadmap").await.unwrap();
    assert_eq!(after.snapshot.as_ref().unwrap().revision, 2);
}

#[tokio::test]
async fn an_edit_that_breaks_the_plan_is_refused_and_a_first_one_starts_it() {
    let s = service(Arc::default(), None);
    let err = s
        .edit_plan(
            &ctx(),
            "roadmap",
            0,
            Section::People(vec![crate::reports::plan_edit::PersonDto {
                team: Some("nobody".into()),
                ..person("alice")
            }]),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(&err, PlanEditError::Invalid(m) if m.contains("there is no team `nobody`")),
        "{err:?}"
    );
    assert!(
        s.source(&ctx(), "roadmap")
            .await
            .unwrap()
            .snapshot
            .is_none()
    );
    let first = s
        .edit_plan(&ctx(), "roadmap", 0, Section::People(vec![person("alice")]))
        .await
        .expect("a plan with nothing before it");
    assert_eq!(first.snapshot.unwrap().revision, 1);
}
