//! The reports gear's service: what reports there are, where each one's data
//! comes from in an organization, and drawing them.
//!
//! A report is a definition over a data set. Today there is one data set --
//! the roadmap board as the catalogue reads it, with the planning team's plan
//! -- and one report over it, `roadmap`. Another report over the same data is
//! another definition; another data set is another entry in [`REPORTS`].

use std::sync::Arc;

use anyhow::{Result, anyhow};
use serde_yaml::Value as Yaml;
use time::{Date, OffsetDateTime, format_description::well_known::Rfc3339};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::definition::Definition;
use super::github::PlanReader;
use super::plan_edit::{self, Section};
use super::roadmap::plan::{Plan, parse as parse_plan};
use super::roadmap::summary::{ComponentValues, RoadmapReportDto, build as build_summary};
use super::roadmap::workbook;
use super::source::{Effective, FROM_STUDIO, PlanSnapshot, Refresh, ReportSource};

/// Why a plan edit was not saved.
#[derive(Debug)]
pub enum PlanEditError {
    /// Somebody saved since the caller read it.
    Stale {
        current: u64,
    },
    /// The plan would not hold together, with every reason.
    Invalid(String),
    Other(anyhow::Error),
}
use super::store::ReportStore;
use crate::components_catalog::port::{BoardSource, RoadmapCatalog, RoadmapFields};
use crate::scheduler::port::{ScheduleSpec, ScheduleView, Schedules};

/// A report this deployment can draw.
#[derive(Clone, Copy, Debug)]
pub struct ReportKind {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    /// The definition drawn when the plan names none.
    pub default_definition: &'static str,
}

pub const REPORTS: [ReportKind; 1] = [ReportKind {
    id: "roadmap",
    title: "Backend roadmap",
    description: "Every gear the roadmap board plans: stage, milestone, progress, who needs it, \
                  and each team's remaining work scheduled against its people -- the planning \
                  team's back_roadmap workbook.",
    default_definition: "back_roadmap",
}];

pub fn kind(id: &str) -> Option<&'static ReportKind> {
    REPORTS.iter().find(|k| k.id == id)
}

/// Where the catalogue is reached: resolved per call, so this gear does not
/// care which gear initialized first.
pub type CatalogLink = Arc<dyn Fn() -> Result<Arc<dyn RoadmapCatalog>> + Send + Sync>;

/// Where the scheduler is reached, likewise.
pub type SchedulesLink = Arc<dyn Fn() -> Result<Arc<dyn Schedules>> + Send + Sync>;

/// Hourly, on the hour.
pub const HOURLY: &str = "0 * * * *";

pub struct ReportsService {
    store: Arc<dyn ReportStore>,
    catalog: CatalogLink,
    reader: Option<Arc<dyn PlanReader>>,
    schedules: Option<SchedulesLink>,
}

fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

impl ReportsService {
    pub fn new(
        store: Arc<dyn ReportStore>,
        catalog: CatalogLink,
        reader: Option<Arc<dyn PlanReader>>,
    ) -> Self {
        Self {
            store,
            catalog,
            reader,
            schedules: None,
        }
    }

    /// The organization's source for a report; an empty one when it saved
    /// none, so a caller always has something to show and edit.
    pub async fn source(&self, ctx: &SecurityContext, report: &str) -> Result<ReportSource> {
        Ok(self
            .store
            .get(ctx, report)
            .await?
            .unwrap_or_else(|| ReportSource {
                report: report.to_string(),
                ..ReportSource::default()
            }))
    }

    /// Save what a person configured. An uploaded plan becomes the snapshot
    /// at once and `""` takes one back; otherwise the plan as last read is
    /// kept unless the file it was read from changed.
    pub async fn save_source(
        &self,
        ctx: &SecurityContext,
        mut next: ReportSource,
    ) -> Result<ReportSource, String> {
        next.validate()?;
        let prev = self
            .source(ctx, &next.report)
            .await
            .map_err(|e| format!("{e:#}"))?;
        next.last_refresh = prev.last_refresh.clone();
        // Uploaded or edited here: a plan no file stands behind.
        let uploaded = |s: &Option<PlanSnapshot>| {
            s.as_ref()
                .is_some_and(|s| s.from == "upload" || s.from == FROM_STUDIO)
        };
        let revision = prev.snapshot.as_ref().map_or(0, |s| s.revision) + 1;
        next.snapshot = match next.plan_yaml.take() {
            Some(text) if !text.trim().is_empty() => Some(PlanSnapshot {
                text: text.trim().to_string(),
                from: "upload".into(),
                sha: None,
                read_at: now(),
                revision,
                edited_by: Some(ctx.subject_id().to_string()),
            }),
            // Taken back: what was uploaded is no longer the plan.
            Some(_) if uploaded(&prev.snapshot) => None,
            _ if prev.plan_file == next.plan_file => prev.snapshot,
            // Another file: the plan is that file's, from its first read.
            _ => None,
        };
        self.store
            .put(ctx, &next)
            .await
            .map_err(|e| format!("{e:#}"))?;
        Ok(next)
    }

    /// The plan as a document, and the source it is on. A source with no plan
    /// yet answers an empty one at revision 0, which a first save starts.
    pub async fn plan_document(
        &self,
        ctx: &SecurityContext,
        report: &str,
    ) -> Result<(ReportSource, Yaml)> {
        let source = self.source(ctx, report).await?;
        let doc = match &source.snapshot {
            Some(s) => parse_plan(&s.text).map_err(|e| anyhow!("the plan is not YAML: {e}"))?,
            None => Yaml::Mapping(serde_yaml::Mapping::new()),
        };
        Ok((source, doc))
    }

    /// Save one section of the plan, made against `revision`.
    ///
    /// The plan's home is Studio from here on: the file it was read from is
    /// let go, so the next refresh does not read it over this edit.
    pub async fn edit_plan(
        &self,
        ctx: &SecurityContext,
        report: &str,
        revision: u64,
        section: Section,
    ) -> Result<ReportSource, PlanEditError> {
        let (mut source, mut doc) = self
            .plan_document(ctx, report)
            .await
            .map_err(PlanEditError::Other)?;
        let current = source.snapshot.as_ref().map_or(0, |s| s.revision);
        if revision != current {
            return Err(PlanEditError::Stale { current });
        }
        plan_edit::apply(&mut doc, section).map_err(PlanEditError::Invalid)?;
        plan_edit::validate(&doc).map_err(PlanEditError::Invalid)?;
        let text = plan_edit::to_text(&doc).map_err(PlanEditError::Invalid)?;
        source.report = report.to_string();
        source.plan_file = None;
        source.snapshot = Some(PlanSnapshot {
            text,
            from: FROM_STUDIO.into(),
            sha: None,
            read_at: now(),
            revision: current + 1,
            edited_by: Some(ctx.subject_id().to_string()),
        });
        self.store
            .put(ctx, &source)
            .await
            .map_err(PlanEditError::Other)?;
        Ok(source)
    }

    /// The plan the report is drawn with: the last one read.
    pub fn plan_of(source: &ReportSource) -> (Option<Yaml>, Plan) {
        let Some(snap) = &source.snapshot else {
            return (None, Plan::default());
        };
        match parse_plan(&snap.text) {
            Ok(v) => {
                let plan = Plan::from_value(&v);
                (Some(v), plan)
            }
            Err(_) => (None, Plan::default()),
        }
    }

    /// Which definition a report is drawn with: the plan's, else its own.
    pub fn definition_of(kind: &ReportKind, plan: Option<&Yaml>) -> Result<Definition, String> {
        match plan.and_then(|p| p.get("report")) {
            Some(v) => Definition::from_plan(v),
            None => Definition::preset(kind.default_definition)
                .ok_or_else(|| format!("the built-in `{}` does not read", kind.default_definition)),
        }
    }

    /// Read the plan again and queue a sync of the board: what keeps a
    /// report current. Records what it did on the source either way.
    /// Where the scheduler is: a deployment without it has no schedules.
    pub fn with_schedules(mut self, link: SchedulesLink) -> Self {
        self.schedules = Some(link);
        self
    }

    /// The payload of the schedule that keeps this organization's report
    /// current: the organization is the caller's, written by this gear.
    pub fn schedule_payload(ctx: &SecurityContext, report: &str) -> serde_json::Value {
        serde_json::json!({ "report": report, "organization_id": ctx.subject_tenant_id() })
    }

    fn schedules(&self) -> Result<Arc<dyn Schedules>> {
        let link = self.schedules.as_ref().ok_or_else(|| {
            anyhow!("this deployment schedules nothing (studio-scheduler has no database)")
        })?;
        link()
    }

    /// The schedule that keeps the report current, if there is one.
    pub async fn schedule(
        &self,
        ctx: &SecurityContext,
        report: &str,
    ) -> Result<Option<ScheduleView>> {
        let Ok(s) = self.schedules() else {
            return Ok(None);
        };
        s.find(
            super::refresh_task::TASK_TYPE,
            &Self::schedule_payload(ctx, report),
        )
        .await
    }

    /// Switch it on or off, creating it the first time.
    pub async fn set_schedule(
        &self,
        ctx: &SecurityContext,
        report: &str,
        enabled: bool,
        cron: Option<&str>,
    ) -> Result<ScheduleView> {
        let tenant = ctx.subject_tenant_id();
        self.schedules()?
            .ensure(
                ctx,
                ScheduleSpec {
                    // Names are unique per tenant, and every one of these
                    // lives in the platform's: the organization makes it one.
                    name: format!("Refresh the {report} report of {tenant}"),
                    task_type: super::refresh_task::TASK_TYPE,
                    payload: Self::schedule_payload(ctx, report),
                    cron: cron.unwrap_or(HOURLY).to_string(),
                    enabled,
                },
            )
            .await
    }

    pub async fn refresh(&self, ctx: &SecurityContext, report: &str) -> Result<Refresh> {
        // Nothing saved: nothing to refresh, and nothing to write -- a
        // refresh never makes a source up.
        let Some(mut source) = self.store.get(ctx, report).await? else {
            anyhow::bail!("this organization has not set up the {report} report yet");
        };
        let outcome = self.refresh_inner(ctx, &mut source).await;
        let record = match &outcome {
            Ok(run) => Refresh {
                at: now(),
                sync_run: Some(*run),
                error: None,
            },
            Err(e) => Refresh {
                at: now(),
                sync_run: None,
                error: Some(format!("{e:#}")),
            },
        };
        source.last_refresh = Some(record.clone());
        self.store.put(ctx, &source).await?;
        outcome.map(|_| record)
    }

    async fn refresh_inner(
        &self,
        ctx: &SecurityContext,
        source: &mut ReportSource,
    ) -> Result<Uuid> {
        let tenant = ctx.subject_tenant_id();
        if let Some(file) = source.file() {
            let file = file.map_err(|e| anyhow!(e))?;
            let reader = self.reader.as_ref().ok_or_else(|| {
                anyhow!(
                    "this deployment has no GitHub connector to read {} with",
                    file.display()
                )
            })?;
            let read = reader
                .read(ctx, tenant, source.connection_id, &file)
                .await?;
            let parsed = parse_plan(&read.text)
                .map_err(|e| anyhow!("{} is not YAML: {e}", file.display()))?;
            if !parsed.is_mapping() {
                return Err(anyhow!(
                    "{} is not a plan: its top level is not a mapping",
                    file.display()
                ));
            }
            let revision = source.snapshot.as_ref().map_or(0, |s| s.revision) + 1;
            source.snapshot = Some(PlanSnapshot {
                text: read.text,
                from: file.display(),
                sha: read.sha,
                read_at: now(),
                revision,
                edited_by: None,
            });
        }
        let (plan, _) = Self::plan_of(source);
        let effective = source.effective(plan.as_ref()).map_err(|e| anyhow!(e))?;
        // The sync reads the board later and cannot fail the refresh over it,
        // so a connection that does not resolve here is said here.
        if let Some(reader) = &self.reader {
            reader.connection(ctx, tenant, source.connection_id).await?;
        }
        let catalog = (self.catalog)()?;
        catalog
            .sync_board(ctx, board_source(tenant, source.connection_id, &effective))
            .await
    }

    /// The report's JSON summary.
    pub async fn summary(&self, ctx: &SecurityContext) -> Result<RoadmapReportDto> {
        let catalog = (self.catalog)()?;
        let components = catalog.components(ctx).await?;
        let planned = catalog.planned(ctx).await?;
        let views: Vec<ComponentValues<'_>> = components
            .iter()
            .map(|c| ComponentValues {
                name: &c.name,
                category: &c.category,
                values: &c.values,
            })
            .collect();
        Ok(build_summary(&views, &planned))
    }

    /// The report's workbook, as of `today`.
    pub async fn workbook(
        &self,
        ctx: &SecurityContext,
        kind: &ReportKind,
        today: Date,
    ) -> Result<Vec<u8>> {
        let source = self.source(ctx, kind.id).await?;
        let (plan_value, plan) = Self::plan_of(&source);
        let def = Self::definition_of(kind, plan_value.as_ref()).map_err(|e| anyhow!(e))?;
        let planned = (self.catalog)()?.planned(ctx).await?;
        Ok(workbook::build(&planned, &plan, &def, today))
    }
}

/// The board sync a report's effective settings ask for.
pub fn board_source(tenant: Uuid, connection_id: Option<Uuid>, e: &Effective) -> BoardSource {
    BoardSource {
        tenant,
        connection_id,
        owner: e.board.owner.clone(),
        number: e.board.number,
        consumers: e.consumers.clone(),
        fields: RoadmapFields::default(),
        roots: e.roots.clone(),
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
