//! Where the engine's corpus comes from: the gear repositories (ADR-0046).
//!
//! A gear repository is a connection of the `gear-repository` kind. The
//! platform's are the ones the root tenant holds; an organization's own are
//! the ones it holds itself (phase 3). The engine reads the platform's
//! together, in the order they were added, and an organization's corpus is
//! the platform's followed by its own. Listing them needs a caller's security
//! context, so they are read on the way into a request that may use the
//! engine -- the platform's by this layer, on every engine route of this gear
//! and the catalogue's, an organization's by [`scope_for`], when a request
//! names it -- at most once a minute; a change is checked out on the next use.
//! Only a first read is waited for; a due one runs in the background while
//! the request is served from the roots read last.
//! While the platform has none, the deployment's corpus stays its one root.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use toolkit_security::SecurityContext;
use tracing::{info, warn};
use uuid::Uuid;

use super::gearbox::{CorpusSource, GearRoot, Gearbox, Scope};
use crate::connectors::sdk::{Connectors, GearRepositorySource, ownership::PLATFORM_ROOT_TENANT};

/// The routes whose handlers may run the engine.
const ENGINE_ROUTES: [&str; 2] = ["/studio-product/", "/studio-components-catalog/"];

/// The checkout key of a repository at a ref: the same repository connected
/// twice -- by the platform and by an organization, or by two organizations
/// -- under the same source id is one clone.
pub(super) fn checkout_key(url: &str, git_ref: &str) -> String {
    use sha2::Digest as _;
    let digest = sha2::Sha256::digest(format!("{}#{}", url.trim(), git_ref.trim()).as_bytes());
    let hex: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
    format!("gearbox-{hex}")
}

/// A gear repository as a root of the corpus.
pub fn root_of(r: GearRepositorySource) -> GearRoot {
    GearRoot {
        source: CorpusSource {
            label: if r.git_ref.is_empty() {
                r.repo.clone()
            } else {
                format!("{}@{}", r.repo, r.git_ref)
            },
            key: checkout_key(&r.url, &r.git_ref),
            repo: r.source_id.clone(),
            url: r.url,
            username: r.username,
            token: r.token,
            git_ref: r.git_ref,
        },
        id: r.source_id,
        connection_id: Some(r.connection_id),
        organization: false,
        subdir: None,
    }
}

/// `ctx`'s subject acting in `tenant`, where the gear repositories read are
/// held: the root for the platform's, an organization for its own.
fn acting_in(ctx: &SecurityContext, tenant: Uuid) -> anyhow::Result<SecurityContext> {
    crate::org_scope::acting_in(ctx, tenant)
        .map_err(|e| anyhow::anyhow!("cannot read the gear repositories of {tenant}: {e}"))
}

/// The engine's status, asked with `?refresh=true`: the Sources page asks so
/// right after it adds or removes a repository, and reads the list anew.
const STATUS_ROUTE: &str = "/studio-product/v1/gearbox";

/// How long the warm-up waits for the connector service: another gear
/// publishes it, and this gear's `init` may run first.
const WARM_UP_WAIT: Duration = Duration::from_secs(30);

/// The subject the warm-up reads the platform's gear repositories as: the
/// gear's own, the one its explanations are written with.
fn service_context() -> anyhow::Result<SecurityContext> {
    SecurityContext::builder()
        .subject_id(super::explanations::SERVICE_SUBJECT_ID)
        .subject_type("service")
        .subject_tenant_id(PLATFORM_ROOT_TENANT)
        .token_scopes(vec!["*".to_owned()])
        .build()
        .map_err(|e| anyhow::anyhow!("studio-product: cannot build a service context: {e}"))
}

/// Read the platform's list into the engine, then load its corpus, at start.
/// Warming the deployment's corpus alone, as before, was a clone the first
/// request threw away as soon as it read the platform's repositories in its
/// place. When the list cannot be read here the first request reads it, as
/// it did before.
pub async fn warm_up(gearbox: &Gearbox, connectors: &Connectors) {
    let deadline = tokio::time::Instant::now() + WARM_UP_WAIT;
    while connectors.get().is_none() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    if connectors.get().is_some() {
        let _reading = gearbox.roots_reading().lock().await;
        let read = match service_context() {
            Ok(ctx) => read_platform(gearbox, connectors, &ctx).await,
            Err(e) => Err(e),
        };
        if let Err(e) = read {
            warn!(error = %format!("{e:#}"), "studio-product: the platform's gear repositories could not be read at start; the first request reads them");
        }
    }
    let started = std::time::Instant::now();
    match gearbox.catalogue_json(None).await {
        Ok(_) => info!(
            elapsed_ms = started.elapsed().as_millis(),
            "studio-product: corpus warmed up"
        ),
        Err(e) => warn!(error = %format!("{e:#}"), "studio-product: corpus warm-up failed"),
    }
}

/// The platform's gear repositories, read into the engine.
async fn read_platform(
    gearbox: &Gearbox,
    connectors: &Connectors,
    ctx: &SecurityContext,
) -> anyhow::Result<()> {
    let Some(service) = connectors.get() else {
        return Ok(());
    };
    let root = acting_in(ctx, PLATFORM_ROOT_TENANT)?;
    let list = service
        .gear_repositories(&root, PLATFORM_ROOT_TENANT)
        .await?;
    gearbox.use_repositories(list.into_iter().map(root_of).collect());
    Ok(())
}

/// Read the platform's gear repositories into the engine, when due or when
/// `now`, and wait for it. One read runs at a time: a request that arrives
/// during one waits for it and then finds the list read.
pub async fn refresh(gearbox: &Gearbox, connectors: &Connectors, ctx: &SecurityContext, now: bool) {
    if !now && !gearbox.roots_due() {
        return;
    }
    let _reading = gearbox.roots_reading().lock().await;
    if !now && !gearbox.roots_due() {
        return;
    }
    if let Err(e) = read_platform(gearbox, connectors, ctx).await {
        // Keep the roots there are; the next request tries again.
        gearbox.mark_roots_checked();
        warn!(error = %format!("{e:#}"), "studio-product: the platform's gear repositories could not be read");
    }
}

/// [`refresh`] on a task of its own: the request goes on with the list there
/// is. Nothing is started while a read is running.
fn refresh_in_background(gearbox: Arc<Gearbox>, connectors: Connectors, ctx: SecurityContext) {
    tokio::spawn(async move {
        let Ok(_reading) = gearbox.roots_reading().try_lock() else {
            return;
        };
        if !gearbox.roots_due() {
            return;
        }
        if let Err(e) = read_platform(&gearbox, &connectors, &ctx).await {
            gearbox.mark_roots_checked();
            warn!(error = %format!("{e:#}"), "studio-product: the platform's gear repositories could not be read");
        }
    });
}

/// Organization `org`'s own gear repositories followed by its projects' own
/// roots, less any project root whose id a repository already has.
fn org_roots(listed: Vec<GearRepositorySource>, project_roots: Vec<GearRoot>) -> Vec<GearRoot> {
    let mut roots: Vec<GearRoot> = listed.into_iter().map(root_of).collect();
    let fresh: Vec<GearRoot> = project_roots
        .into_iter()
        .filter(|p| roots.iter().all(|r| r.id != p.id))
        .collect();
    roots.extend(fresh);
    roots
}

/// What stands when organization `org`'s projects cannot be read at all: the
/// roots and product files read last time -- not none, which would drop
/// every project's gears -- and the reason, logged and said beside them.
fn projects_not_read(
    gearbox: &Gearbox,
    org: Uuid,
    e: &anyhow::Error,
) -> super::project_roots::OrgProjects {
    let reason = format!("the organization's projects could not be read: {e:#}");
    warn!(organization_id = %org, %reason, "studio-product: the organization's project roots were not read");
    super::project_roots::OrgProjects {
        roots: gearbox.org_project_roots(org),
        files: gearbox.project_files_of(org),
        unreadable: vec![super::project_roots::UnreadableSource {
            project_id: None,
            source: super::project_roots::ORGANIZATION_PROJECTS.to_owned(),
            reason,
        }],
    }
}

/// Read organization `org`'s gear repositories and its projects' own roots
/// and product files into the engine: the slow part is the projects', a
/// clone or fetch of each repository (bounded by `project_roots`' deadline).
async fn read_org(
    gearbox: &Arc<Gearbox>,
    connectors: &Connectors,
    hub: &Arc<toolkit::client_hub::ClientHub>,
    ctx: &SecurityContext,
    org: Uuid,
) {
    let Some(service) = connectors.get() else {
        return;
    };
    let started = std::time::Instant::now();
    let listed = match acting_in(ctx, org) {
        Ok(octx) => service.gear_repositories(&octx, org).await,
        Err(e) => Err(e),
    };
    // Its projects' own gears too: the directories their product.gdl
    // names, read from the repositories they are already connected by.
    let read = match acting_in(ctx, org) {
        Ok(octx) => super::project_roots::read(gearbox, connectors, hub, &octx, org).await,
        Err(e) => projects_not_read(gearbox, org, &e),
    };
    let project_roots = read.roots;
    gearbox.use_project_files(org, read.files);
    gearbox.use_unreadable_sources(org, read.unreadable);
    match listed {
        Ok(list) => gearbox.use_org_repositories(org, org_roots(list, project_roots)),
        Err(e) => {
            gearbox.mark_org_roots_checked(org);
            warn!(organization_id = %org, error = %format!("{e:#}"), "studio-product: the organization's gear repositories could not be read");
        }
    }
    info!(organization_id = %org, elapsed_ms = started.elapsed().as_millis(), "studio-product: the organization's roots were read");
}

/// Organization `org`'s own gear repositories read now, beside the project
/// roots read last time: what `?refresh=true` needs to show a repository just
/// added, without waiting for every project's repository to be fetched.
async fn list_org_now(
    gearbox: &Gearbox,
    connectors: &Connectors,
    ctx: &SecurityContext,
    org: Uuid,
) {
    let Some(service) = connectors.get() else {
        return;
    };
    let listed = match acting_in(ctx, org) {
        Ok(octx) => service.gear_repositories(&octx, org).await,
        Err(e) => Err(e),
    };
    match listed {
        Ok(list) => {
            gearbox.use_org_repositories(org, org_roots(list, gearbox.org_project_roots(org)));
        }
        Err(e) => {
            warn!(organization_id = %org, error = %format!("{e:#}"), "studio-product: the organization's gear repositories could not be read");
        }
    }
}

/// The scope a request about organization `org` reads, with the
/// organization's own gear repositories read into the engine when due (or
/// `now`). The platform's root and no organization are the platform's scope.
/// The caller has already shown that `ctx` reaches `org`.
///
/// Only the first read of an organization is waited for: there is nothing to
/// serve before it. After that a due read runs on a task of its own, one per
/// organization at a time, and the request serves the roots there are -- on
/// studio-dev a read on the way in fetched every project's repository and
/// held the request up to 25 s once a minute.
pub async fn scope_for(
    gearbox: &Arc<Gearbox>,
    connectors: &Connectors,
    hub: &Arc<toolkit::client_hub::ClientHub>,
    ctx: &SecurityContext,
    org: Option<Uuid>,
    now: bool,
) -> Scope {
    let org = org.filter(|o| *o != PLATFORM_ROOT_TENANT)?;
    if connectors.get().is_none() {
        return Some(org);
    }
    let first = !gearbox.org_roots_ever_read(org);
    // One request claims a due read; the others serve the roots there are.
    if !gearbox.begin_org_refresh(org, now) {
        return Some(org);
    }
    if first {
        if let Some(_reading) = gearbox.claim_org_read(org) {
            read_org(gearbox, connectors, hub, ctx, org).await;
        }
        return Some(org);
    }
    if now {
        list_org_now(gearbox, connectors, ctx, org).await;
    }
    let (gearbox, connectors, hub, ctx) = (
        Arc::clone(gearbox),
        connectors.clone(),
        Arc::clone(hub),
        ctx.clone(),
    );
    tokio::spawn(async move {
        let Some(_reading) = gearbox.claim_org_read(org) else {
            return;
        };
        read_org(&gearbox, &connectors, &hub, &ctx, org).await;
    });
    Some(org)
}

/// The layer that does [`refresh`] on the way into an engine route. Only a
/// list never read, or one asked for `now`, is waited for; a due one is read
/// in the background while the request goes on with the list there is.
pub async fn layer(
    gearbox: Arc<Gearbox>,
    connectors: Connectors,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    let now = path == STATUS_ROUTE
        && request
            .uri()
            .query()
            .is_some_and(|q| q.split('&').any(|kv| kv == "refresh=true"));
    if ENGINE_ROUTES.iter().any(|p| path.starts_with(p))
        && let Some(ctx) = request.extensions().get::<SecurityContext>()
    {
        if now || !gearbox.roots_ever_read() {
            refresh(&gearbox, &connectors, ctx, now).await;
        } else if gearbox.roots_due() {
            refresh_in_background(Arc::clone(&gearbox), connectors.clone(), ctx.clone());
        }
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_repository_at_one_ref_is_one_clone_whoever_connected_it() {
        let a = checkout_key("https://github.com/acme/gears.git", "");
        assert_eq!(a, checkout_key(" https://github.com/acme/gears.git", ""));
        assert_ne!(a, checkout_key("https://github.com/acme/gears.git", "v2"));
        assert_ne!(a, checkout_key("https://github.com/acme/other.git", ""));
        assert!(a.starts_with("gearbox-") && a.len() == "gearbox-".len() + 12);
    }

    fn repository(source_id: &str) -> GearRepositorySource {
        GearRepositorySource {
            connection_id: Uuid::from_u128(1),
            source_id: source_id.into(),
            repo: format!("acme/{source_id}"),
            url: format!("https://github.com/acme/{source_id}.git"),
            git_ref: String::new(),
            username: "x-access-token".into(),
            token: String::new(),
            create_target: false,
        }
    }

    #[test]
    fn an_organizations_repositories_come_first_and_a_project_root_never_doubles_one() {
        let project_root = |id: &str| GearRoot {
            subdir: Some(id.to_owned()),
            ..root_of(repository(id))
        };
        let roots = org_roots(
            vec![repository("acme-gears")],
            vec![project_root("shop-backend"), project_root("acme-gears")],
        );
        let ids: Vec<(&str, bool)> = roots
            .iter()
            .map(|r| (r.id.as_str(), r.subdir.is_some()))
            .collect();
        assert_eq!(ids, [("acme-gears", false), ("shop-backend", true)]);
    }

    fn gearbox() -> Arc<Gearbox> {
        Arc::new(Gearbox::new(super::super::gearbox::GearboxConfig {
            bin: "gearbox".into(),
            workdir: std::env::temp_dir(),
            corpus_url: String::new(),
            corpus_ref: "main".into(),
            corpus_id: "gears-rust".into(),
            refresh: Duration::from_secs(600),
        }))
    }

    #[test]
    fn projects_not_read_keep_their_roots_and_say_why() {
        let gearbox = gearbox();
        let org = Uuid::from_u128(0x0b);
        let project_root = GearRoot {
            subdir: Some("shop-backend".to_owned()),
            ..root_of(repository("shop-backend"))
        };
        gearbox.use_org_repositories(org, vec![project_root]);
        let read = projects_not_read(&gearbox, org, &anyhow::anyhow!("no scope for {org}"));
        assert_eq!(read.roots.len(), 1, "the last roots stand, not none");
        assert_eq!(read.unreadable.len(), 1);
        assert_eq!(
            read.unreadable[0].source,
            super::super::project_roots::ORGANIZATION_PROJECTS
        );
        assert!(read.unreadable[0].reason.contains("no scope for"));
        gearbox.use_unreadable_sources(org, read.unreadable.clone());
        assert_eq!(gearbox.unreadable_sources_of(org), read.unreadable);
        assert!(
            gearbox
                .unreadable_sources_of(Uuid::from_u128(0x0c))
                .is_empty()
        );
    }

    #[test]
    fn one_read_of_an_organizations_roots_runs_at_a_time() {
        let gearbox = gearbox();
        let org = Uuid::from_u128(0x0a);
        assert!(!gearbox.org_roots_ever_read(org));
        gearbox.use_org_repositories(org, vec![root_of(repository("acme-gears"))]);
        assert!(gearbox.org_roots_ever_read(org));
        // A read running holds the organization: a second is not started.
        let reading = gearbox.claim_org_read(org).expect("nothing reads yet");
        assert!(gearbox.claim_org_read(org).is_none());
        drop(reading);
        assert!(gearbox.claim_org_read(org).is_some());
    }
}
