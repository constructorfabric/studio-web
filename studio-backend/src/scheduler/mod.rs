//! studio-scheduler — the thing that knows what time it is.
//!
//! ## Why it is a gear of its own
//!
//! It owns schedules and nothing else: on each tick it works out which are due
//! and enqueues runs into `studio-tasks`. It executes no work, so a bug in cron
//! arithmetic cannot stop a repository import, and a deployment that wants
//! background work without automatic firing simply drops this gear's
//! `database:` block — the queue keeps working, nothing fires on its own.
//!
//! ## What the platform already had, and why this is still here
//!
//! Nothing in gears-rust schedules anything: 35 gears, no cron, no timer. The
//! one place a `Schedule` entity exists is `serverless-runtime`'s design — and
//! that gear ships **no code at all** (documents only, in every checkout), and
//! its own thin-host ADR says the host "runs no scheduler, polling loop, or
//! timer mechanism", delegating timing to a backend plugin over Temporal,
//! EventBridge or Azure Durable. Adopting it for cron would mean adopting
//! Temporal.
//!
//! So the vocabulary is borrowed and the mechanism is not: the expression
//! shape (`{kind: cron|interval, value}`), the IANA `timezone`, the
//! concurrency policy (`allow | forbid | replace`) and the missed-schedule
//! policy (`skip | catch_up | backfill`) are spelled exactly as
//! `gts.cf.core.sless.schedule.v1~` spells them, so a schedule written today
//! moves to that gear as data if it ever lands.
//!
//! ## Two properties worth knowing
//!
//! * **One firer.** A tick runs under a PostgreSQL advisory lock, so a second
//!   replica does not double-fire ([`ticker`]).
//! * **At-least-once firing, exactly-once runs.** The scheduler cannot commit
//!   its bookkeeping in the same transaction as an enqueue into another gear's
//!   database, so a crash mid-firing re-fires. Every firing carries the
//!   idempotency key `<schedule_id>:<scheduled_for>`, which makes the repeat
//!   the same run ([`service`]).

pub mod cron;
mod entity;
mod migrations;
mod policy;
mod rest;
pub mod service;
mod ticker;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use axum::Router;
use serde::Deserialize;
use tokio_util::sync::CancellationToken;
use toolkit::api::OpenApiRegistry;
use toolkit::contracts::{DatabaseCapability, RunnableCapability};
use toolkit::{Gear, GearCtx};
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

use service::SchedulerService;

/// The platform root tenant, as `account-management.bootstrap.root_id` sets it
/// in every shipped profile. Schedules belong to it — see [`service`] for why
/// they are platform-level rather than per tenant.
const DEFAULT_OWNER_TENANT: Uuid = Uuid::from_u128(1);

/// How often the ticker looks for due schedules.
///
/// A minute, because the finest schedule this gear can express is a minute: a
/// tighter tick would only find the same rows again. It also bounds how late a
/// firing can be, which is the honest accuracy claim — a schedule fires within
/// a tick of its instant, not on it.
const DEFAULT_TICK_SECS: u64 = 60;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    /// Tenant the schedule table belongs to. Must match
    /// `account-management.bootstrap.root_id`; a mismatch is not an error, it
    /// is an empty schedule list.
    #[serde(default = "default_owner")]
    pub owner_tenant_id: Uuid,
    /// Seconds between ticks.
    #[serde(default = "default_tick")]
    pub tick_seconds: u64,
    /// Off by default in no profile, but here so an operator can stop firing
    /// without dropping the gear or its schedules.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            owner_tenant_id: default_owner(),
            tick_seconds: default_tick(),
            enabled: default_enabled(),
        }
    }
}

fn default_owner() -> Uuid {
    DEFAULT_OWNER_TENANT
}
fn default_tick() -> u64 {
    DEFAULT_TICK_SECS
}
fn default_enabled() -> bool {
    true
}

/// The identity the ticker and the boot-time schedule registration act as.
///
/// There is no request behind a schedule firing, and nothing persists whoever
/// created the schedule — the same stance `studio-tasks`' dispatcher takes.
fn service_identity(tenant: Uuid) -> anyhow::Result<SecurityContext> {
    SecurityContext::builder()
        .subject_id(SERVICE_SUBJECT_ID)
        .subject_type("service")
        .subject_tenant_id(tenant)
        .token_scopes(vec!["*".to_owned()])
        .build()
        .map_err(|e| anyhow::anyhow!("studio-scheduler: cannot build a service context: {e}"))
}

/// Fixed, because it appears in `created_by` on every schedule this gear
/// registers for the platform.
pub const SERVICE_SUBJECT_ID: Uuid = Uuid::from_u128(0x7b3f_02ac_6d51_4e28_bf94_1c07_a35d_8e6b);

#[toolkit::gear(
    name = "studio-scheduler",
    deps = [account_management],
    capabilities = [rest, db, stateful]
)]
#[derive(Default)]
pub struct StudioSchedulerGear {
    service: OnceLock<Option<Arc<SchedulerService>>>,
    db: OnceLock<toolkit_db::Db>,
    config: OnceLock<Config>,
    ticker: OnceLock<CancellationToken>,
}

#[async_trait]
impl Gear for StudioSchedulerGear {
    async fn init(&self, ctx: &GearCtx) -> anyhow::Result<()> {
        let cfg: Config = ctx.config_or_default()?;
        let db = match ctx.db_required() {
            Ok(db) => db.db(),
            Err(e) => {
                warn!(
                    "studio-scheduler: no database configured — gear stands down (nothing \
                     fires on its own; the schedules API answers 503): {e}"
                );
                self.service
                    .set(None)
                    .map_err(|_| anyhow::anyhow!("studio-scheduler already initialized"))?;
                return Ok(());
            }
        };

        let service = SchedulerService::new(db.clone(), ctx.client_hub(), cfg.owner_tenant_id);
        let _ = self.db.set(db);
        let owner = cfg.owner_tenant_id;
        let tick = cfg.tick_seconds;
        let enabled = cfg.enabled;
        self.config
            .set(cfg)
            .map_err(|_| anyhow::anyhow!("studio-scheduler already initialized"))?;
        self.service
            .set(Some(service))
            .map_err(|_| anyhow::anyhow!("studio-scheduler already initialized"))?;

        info!(
            owner_tenant = %owner,
            tick_seconds = tick,
            enabled,
            "studio-scheduler: initialized"
        );
        Ok(())
    }
}

impl DatabaseCapability for StudioSchedulerGear {
    fn migrations(&self) -> Vec<Box<dyn toolkit_db::sea_orm_migration::MigrationTrait>> {
        use toolkit_db::sea_orm_migration::MigratorTrait;
        migrations::Migrator::migrations()
    }
}

#[async_trait]
impl RunnableCapability for StudioSchedulerGear {
    /// Register the schedules the platform owns, then start the ticker.
    ///
    /// Both belong here rather than in `init`: registering a schedule
    /// validates its task type against the handler registry, and the gears that
    /// register handlers do so in their own `init` — which may run after this
    /// one. The `start` phase runs after every gear has initialized, so by now
    /// the registry is complete.
    async fn start(&self, cancel: CancellationToken) -> anyhow::Result<()> {
        let (Some(Some(service)), Some(cfg), Some(db)) =
            (self.service.get(), self.config.get(), self.db.get())
        else {
            return Ok(()); // stood down in init
        };
        if !cfg.enabled {
            info!("studio-scheduler: disabled by config — nothing will fire");
            return Ok(());
        }

        if let Err(e) = register_platform_schedules(service).await {
            // A schedule that cannot be registered is a warning, not a failed
            // boot: the deployment still works, it just is not sweeping.
            warn!("studio-scheduler: could not register the platform schedules: {e:#}");
        }

        let token = cancel.child_token();
        let _ = self.ticker.set(token.clone());
        ticker::spawn(
            Arc::clone(service),
            db.clone(),
            Duration::from_secs(cfg.tick_seconds.clamp(5, 3600)),
            token,
        );
        Ok(())
    }

    async fn stop(&self, _deadline: CancellationToken) -> anyhow::Result<()> {
        if let Some(token) = self.ticker.get() {
            token.cancel();
        }
        Ok(())
    }
}

/// The schedules this deployment should always have.
///
/// Registered with `ensure`, which does not overwrite: an operator who changed
/// the cadence or switched one off keeps that across restarts.
async fn register_platform_schedules(service: &Arc<SchedulerService>) -> anyhow::Result<()> {
    let ctx = service_identity(service.owner())?;
    // Concatenated by hand rather than collected through a registry: this is
    // a single-binary assembly, the list is short, and a `grep
    // platform_schedules` finds every gear that contributes one.
    let wanted = crate::tasks::platform_schedules()
        .into_iter()
        .chain(crate::studio_session::platform_schedules());
    for schedule in wanted {
        // A schedule for work nothing in this process can run would fire every
        // cadence and dead-letter every time. The gears that own the work
        // register their handlers before this phase, so the registry is the
        // honest answer to "is this a deployment where that job exists?" —
        // sessions, for instance, stand down where there is no container
        // runtime to reach.
        if !crate::tasks::registry::known_task_types().contains(&schedule.task_type) {
            info!(
                schedule = schedule.name,
                task_type = schedule.task_type,
                "studio-scheduler: nothing here can run this — not creating its schedule"
            );
            continue;
        }
        match service
            .ensure(
                &ctx,
                service::NewSchedule {
                    name: schedule.name,
                    task_type: schedule.task_type,
                    payload: schedule.payload,
                    expression_kind: "cron",
                    expression: schedule.cron,
                    timezone: Some("UTC"),
                    concurrency: Some("forbid"),
                    missed_policy: Some("skip"),
                    max_catch_up_runs: Some(1),
                    enabled: true,
                },
            )
            .await
        {
            Ok(row) => info!(
                schedule = %row.name,
                next_run_at = %row.next_run_at,
                "studio-scheduler: platform schedule in place"
            ),
            Err(e) => warn!(
                schedule = schedule.name,
                "studio-scheduler: platform schedule not registered: {e:#}"
            ),
        }
    }
    Ok(())
}

#[async_trait]
impl toolkit::contracts::RestApiCapability for StudioSchedulerGear {
    fn register_rest(
        &self,
        _ctx: &GearCtx,
        router: Router,
        openapi: &dyn OpenApiRegistry,
    ) -> anyhow::Result<Router> {
        Ok(rest::register_routes(
            router,
            openapi,
            self.service.get().cloned().flatten(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_owner_is_the_platform_root_the_profiles_bootstrap() {
        // `account-management.bootstrap.root_id` in every shipped profile.
        assert_eq!(
            DEFAULT_OWNER_TENANT.to_string(),
            "00000000-0000-0000-0000-000000000001"
        );
    }

    #[test]
    fn the_config_defaults_are_usable_without_a_config_block() {
        let cfg = Config::default();
        assert_eq!(cfg.owner_tenant_id, DEFAULT_OWNER_TENANT);
        assert_eq!(cfg.tick_seconds, 60);
        assert!(cfg.enabled);
    }
}
