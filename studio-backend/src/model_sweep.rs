//! Moving every tenant's records into the domain model, or back out of it, in
//! the background when the process starts (ADR-0051 §8a).
//!
//! Each gear moves an owner's records on first touch — but the first touch is
//! somebody's request, and in a large organization that person waits for the
//! move. So the gears that move records register here, and shortly after
//! start one sweep walks the tenant tree and asks each of them to make every
//! tenant ready, as the gear itself (a `service` subject: it decides who may
//! read the records afterwards, as it always did). A request that arrives
//! first still moves what it touches; the markers make the sweep's second
//! visit a no-op. Every replica sweeps; the moves are idempotent.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use account_management_sdk::AccountManagementClient;
use async_trait::async_trait;
use toolkit_odata::{CursorV1, ODataQuery};
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

/// Something that keeps a tenant's records in the model, and can make one
/// tenant ready ahead of its first request.
#[async_trait]
pub trait TenantMover: Send + Sync {
    /// For the log.
    fn name(&self) -> &str;
    /// Make `tenant` ready. `ctx` is the gear's own identity in the tenant's
    /// organization (the model's tenant).
    async fn prepare(&self, ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<()>;
    /// Runs before the others for each tenant: what puts objects where the
    /// others then look.
    fn early(&self) -> bool {
        false
    }
    /// Runs again every [`PERIOD`] after the first sweep: what keeps up with
    /// tenants made since the start rather than moving records once.
    fn periodic(&self) -> bool {
        false
    }
}

/// How often the periodic movers run after the start-up sweep.
const PERIOD: Duration = Duration::from_secs(300);

fn movers() -> &'static Mutex<Vec<Arc<dyn TenantMover>>> {
    static MOVERS: OnceLock<Mutex<Vec<Arc<dyn TenantMover>>>> = OnceLock::new();
    MOVERS.get_or_init(Mutex::default)
}

/// Take part in the start-up sweep.
pub fn register(mover: Arc<dyn TenantMover>) {
    if let Ok(mut m) = movers().lock() {
        m.push(mover);
    }
}

/// The identity the sweep acts as in `org`: a gear's own, with no bearer.
fn gear_ctx(org: Uuid) -> anyhow::Result<SecurityContext> {
    SecurityContext::builder()
        .subject_id(Uuid::from_u128(0x5ee7_0000_0000_4000_8000_0000_0000_0051))
        .subject_type("service")
        .subject_tenant_id(org)
        .token_scopes(vec!["*".to_owned()])
        .build()
        .map_err(|e| anyhow::anyhow!("model sweep: cannot build a service context: {e}"))
}

/// Start the sweep, once per process, `after` the start.
pub fn start(am: Arc<dyn AccountManagementClient>, root: Uuid, after: Duration) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(after).await;
        match sweep(am.as_ref(), root).await {
            Ok((orgs, tenants)) => info!(orgs, tenants, "model sweep: every tenant is ready"),
            Err(e) => {
                warn!(error = %e, "model sweep stopped; first requests will move what they touch")
            }
        }
        loop {
            tokio::time::sleep(PERIOD).await;
            if let Err(e) = sweep_with(am.as_ref(), root, |m| m.periodic()).await {
                warn!(error = %e, "periodic model sweep stopped; it runs again next period");
            }
        }
    });
}

async fn children(
    am: &dyn AccountManagementClient,
    ctx: &SecurityContext,
    parent: Uuid,
) -> anyhow::Result<Vec<Uuid>> {
    const MAX_PAGES: usize = 50;
    let mut out = Vec::new();
    let mut query = ODataQuery::default();
    for _ in 0..MAX_PAGES {
        let page = am
            .list_children(ctx, parent, &query)
            .await
            .map_err(|e| anyhow::anyhow!("listing the children of {parent}: {e}"))?;
        out.extend(page.items.into_iter().map(|t| t.id.0));
        let Some(next) = page.page_info.next_cursor else {
            return Ok(out);
        };
        query = ODataQuery::default().with_cursor(
            CursorV1::decode(&next).map_err(|e| anyhow::anyhow!("undecodable cursor: {e}"))?,
        );
    }
    Ok(out)
}

/// Walk the tree: every organization under `root` (and the root itself, the
/// platform's own tier), and every tenant inside each.
pub async fn sweep(am: &dyn AccountManagementClient, root: Uuid) -> anyhow::Result<(usize, usize)> {
    sweep_with(am, root, |_| true).await
}

/// The sweep, with the movers `pick` keeps.
async fn sweep_with(
    am: &dyn AccountManagementClient,
    root: Uuid,
    pick: impl Fn(&dyn TenantMover) -> bool,
) -> anyhow::Result<(usize, usize)> {
    let mut movers: Vec<Arc<dyn TenantMover>> = movers()
        .lock()
        .map(|m| m.iter().filter(|m| pick(m.as_ref())).cloned().collect())
        .unwrap_or_default();
    movers.sort_by_key(|m| !m.early());
    if movers.is_empty() {
        return Ok((0, 0));
    }
    let root_ctx = gear_ctx(root)?;
    let mut orgs = vec![root];
    orgs.extend(children(am, &root_ctx, root).await?);
    let mut tenants = 0;
    for org in &orgs {
        let ctx = gear_ctx(*org)?;
        // The organization and everything under it, breadth first.
        let mut queue = vec![*org];
        let mut seen = HashSet::new();
        while let Some(tenant) = queue.pop() {
            if !seen.insert(tenant) {
                continue;
            }
            if tenant != root || *org == root {
                for mover in &movers {
                    if let Err(e) = mover.prepare(&ctx, tenant).await {
                        warn!(mover = mover.name(), %tenant, error = %e, "model sweep: a tenant could not be made ready");
                    }
                }
                tenants += 1;
            }
            if *org != root {
                queue.extend(children(am, &ctx, tenant).await.unwrap_or_default());
            }
        }
    }
    Ok((orgs.len(), tenants))
}
