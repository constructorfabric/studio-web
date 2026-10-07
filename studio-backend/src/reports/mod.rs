//! studio-reports -- the reports a Studio draws, and where each one's data
//! comes from in an organization (ADR-0033).
//!
//! A report is a **definition** (`definition.rs`) drawn over a **data set**.
//! The definition says which sheets the report has and, for a table, which
//! columns; the planning team's roadmap workbook is the built-in
//! `back_roadmap`. The data set today is the roadmap board as the catalogue
//! reads it (`components_catalog::port`) with the planning team's plan
//! (`roadmap/plan.rs`). An organization configures a report once -- a GitHub
//! connection and the plan file in its repository (`source.rs`) -- and a
//! refresh (`reports.refresh`) reads the plan again and syncs the board.
//!
//! What stays in the catalogue is reading the board: a board is a source of
//! component facts too, shown on a gear's card whether or not anyone draws a
//! report.

pub mod definition;
mod github;
pub mod gts;
pub mod plan_edit;
pub mod refresh_task;
mod rest;
pub mod roadmap;
pub mod service;
pub mod source;
mod store;
pub mod xlsx;

use std::sync::Arc;

use async_trait::async_trait;
use axum::Router;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::RestApiCapability;
use toolkit::{Gear, GearCtx};
use tracing::info;
use types_registry_sdk::{RegisterResult, TypesRegistryClient};

use crate::components_catalog::port::RoadmapCatalog;
use service::{CatalogLink, ReportsService};

#[toolkit::gear(
    name = "studio-reports",
    deps = [types_registry, account_management, credstore],
    capabilities = [rest]
)]
#[derive(Default)]
pub struct StudioReportsGear {
    service: std::sync::OnceLock<Arc<ReportsService>>,
}

#[async_trait]
impl Gear for StudioReportsGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let registry = ctx.client_hub().get::<dyn TypesRegistryClient>()?;
        let results = registry.register(gts::type_schemas()).await?;
        RegisterResult::ensure_all_ok(&results)?;
        info!("studio-reports: types registered");
        Ok(())
    }
}

fn build_store(ctx: &GearCtx) -> Arc<dyn store::ReportStore> {
    #[cfg(feature = "graph")]
    {
        match ctx
            .client_hub()
            .get::<dyn graph_storage_sdk::GraphStorageClientV1>()
        {
            Ok(client) => return Arc::new(store::GraphStore::new(client)),
            Err(e) => tracing::warn!(
                error = %e,
                "studio-reports: graph-storage client unavailable -- report sources are kept in memory"
            ),
        }
    }
    let _ = ctx;
    Arc::new(store::MemoryStore::default())
}

#[async_trait]
impl RestApiCapability for StudioReportsGear {
    fn register_rest(
        &self,
        ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        let hub = ctx.client_hub();
        let catalog: CatalogLink = {
            let hub = Arc::clone(&hub);
            Arc::new(move || {
                hub.get::<dyn RoadmapCatalog>().map_err(|_| {
                    anyhow::anyhow!("the components catalogue is not part of this deployment")
                })
            })
        };
        let reader = crate::components_catalog::build_connectors(ctx)
            .map(|c| Arc::new(github::GitHubPlanReader::new(c)) as Arc<dyn github::PlanReader>);
        if reader.is_none() {
            info!(
                "studio-reports: no GitHub connector -- plans can be uploaded, not read from a repository"
            );
        }
        let schedules: service::SchedulesLink = {
            let hub = Arc::clone(&hub);
            Arc::new(move || {
                hub.get::<dyn crate::scheduler::port::Schedules>()
                    .map_err(|_| {
                        anyhow::anyhow!("studio-scheduler is not running in this deployment")
                    })
            })
        };
        let service = Arc::new(
            ReportsService::new(build_store(ctx), catalog, reader).with_schedules(schedules),
        );
        crate::tasks::registry::register(Arc::new(refresh_task::RefreshTask::new(
            Arc::clone(&service),
            Arc::clone(&hub),
        )))?;
        let _ = self.service.set(Arc::clone(&service));
        // Who reaches an organization: the guard documents, kits and sessions
        // already put in front of a tenant a request names.
        let access = Arc::new(crate::studio_session::access::TenantMembership::new(
            hub.get::<dyn account_management_sdk::AccountManagementClient>()?,
        ));
        Ok(rest::register_routes(router, openapi, service, hub, access))
    }
}

/// A security context for tests, in one organization.
#[cfg(test)]
pub(crate) fn test_ctx(tenant: u128) -> toolkit_security::SecurityContext {
    toolkit_security::SecurityContext::builder()
        .subject_id(uuid::Uuid::from_u128(0xca7))
        .subject_type("service")
        .subject_tenant_id(uuid::Uuid::from_u128(tenant))
        .build()
        .expect("security context")
}
