//! The loop that notices a schedule is due.
//!
//! ## One firer, however many processes
//!
//! Every interval loop already in this assembly — `studio-session`'s reaper,
//! the platform gateway's directory sync — fires in every process that runs it.
//! That is harmless for a reaper that converges, and wrong for a scheduler: two
//! replicas would each fire the nightly import, and "exactly once per instant"
//! is the one thing a schedule promises.
//!
//! So a tick runs under a PostgreSQL advisory lock (`Db::try_lock`), and a
//! process that cannot take it does nothing that tick. No leader election, no
//! Redis, no cluster provider: the database every replica already shares is
//! the natural place for "only one of you".
//!
//! Firing is still idempotent on top of that ([`super::service`]), because a
//! lock does not survive the process losing it mid-tick.

use std::sync::Arc;
use std::time::Duration;

use time::OffsetDateTime;
use tokio_util::sync::CancellationToken;
use toolkit_db::Db;
use tracing::{debug, info, warn};

use super::service::SchedulerService;

/// The lock every firing process contends for.
const LOCK_KEY: &str = "ticker";

/// How many schedules one tick will fire. A cap, not a limit on the deployment:
/// anything still due is picked up by the next tick, in `next_run_at` order, so
/// a backlog drains rather than starving.
const MAX_PER_TICK: u64 = 50;

/// Start the ticker. Returns immediately; the loop lives in a spawned task
/// tied to `cancel`, which is the shape `RunnableCapability::start` requires.
pub fn spawn(
    service: Arc<SchedulerService>,
    db: Db,
    tick: Duration,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        info!(
            tick_secs = tick.as_secs(),
            "studio-scheduler: ticker started"
        );
        loop {
            tokio::select! {
                () = cancel.cancelled() => break,
                () = tokio::time::sleep(tick) => {
                    if let Err(e) = tick_once(&service, &db).await {
                        // A failed tick is not fatal: the schedules are still
                        // in the table and still due next time.
                        warn!("studio-scheduler: tick failed: {e:#}");
                    }
                }
            }
        }
        info!("studio-scheduler: ticker stopped");
    })
}

/// One pass: take the lock, fire what is due, release.
async fn tick_once(service: &Arc<SchedulerService>, db: &Db) -> anyhow::Result<()> {
    // `try_lock`, never `lock`: a ticker that waited for the lock would queue
    // up behind another replica and then fire a burst of stale ticks.
    let Some(_guard) = db
        .try_lock(
            "studio-scheduler",
            LOCK_KEY,
            toolkit_db::LockConfig::default(),
        )
        .await?
    else {
        debug!("studio-scheduler: another process holds the ticker lock — skipping this tick");
        return Ok(());
    };

    let now = OffsetDateTime::now_utc();
    let due = service.due(now, MAX_PER_TICK).await?;
    if due.is_empty() {
        return Ok(());
    }

    // The ticker acts as the platform tenant's service identity: there is no
    // request behind a schedule, and nothing persists whoever created it.
    let ctx = super::service_identity(service.owner())?;
    let mut fired = 0usize;
    for schedule in &due {
        match service.fire(&ctx, schedule, now).await {
            Ok(runs) => fired += runs.len(),
            // One bad schedule must not stop the others: a cron expression that
            // no longer parses, a task type whose gear was unlinked.
            Err(e) => warn!(
                schedule = %schedule.name,
                "studio-scheduler: could not fire this schedule: {e:#}"
            ),
        }
    }
    if fired > 0 {
        info!(
            schedules = due.len(),
            runs = fired,
            "studio-scheduler: tick enqueued work"
        );
    }
    Ok(())
}
