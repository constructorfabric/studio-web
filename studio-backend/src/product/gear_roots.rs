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
//! While the platform has none, the deployment's corpus stays its one root.

use std::sync::Arc;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use toolkit_security::SecurityContext;
use tracing::warn;
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

/// Read the platform's gear repositories into the engine, when due or when
/// `now`.
pub async fn refresh(gearbox: &Gearbox, connectors: &Connectors, ctx: &SecurityContext, now: bool) {
    if !now && !gearbox.roots_due() {
        return;
    }
    let Some(service) = connectors.get() else {
        return;
    };
    let listed = match acting_in(ctx, PLATFORM_ROOT_TENANT) {
        Ok(root) => service.gear_repositories(&root, PLATFORM_ROOT_TENANT).await,
        Err(e) => Err(e),
    };
    match listed {
        Ok(list) => gearbox.use_repositories(list.into_iter().map(root_of).collect()),
        // Keep the roots there are; the next request tries again.
        Err(e) => {
            gearbox.mark_roots_checked();
            warn!(error = %format!("{e:#}"), "studio-product: the platform's gear repositories could not be read");
        }
    }
}

/// The scope a request about organization `org` reads, with the
/// organization's own gear repositories read into the engine when due (or
/// `now`). The platform's root and no organization are the platform's scope.
/// The caller has already shown that `ctx` reaches `org`.
pub async fn scope_for(
    gearbox: &Arc<Gearbox>,
    connectors: &Connectors,
    hub: &Arc<toolkit::client_hub::ClientHub>,
    ctx: &SecurityContext,
    org: Option<Uuid>,
    now: bool,
) -> Scope {
    let org = org.filter(|o| *o != PLATFORM_ROOT_TENANT)?;
    if (now || gearbox.org_roots_due(org))
        && let Some(service) = connectors.get()
    {
        let listed = match acting_in(ctx, org) {
            Ok(octx) => service.gear_repositories(&octx, org).await,
            Err(e) => Err(e),
        };
        // Its projects' own gears too: the directories their product.gdl
        // names, read from the repositories they are already connected by.
        let (project_roots, files) = match acting_in(ctx, org) {
            Ok(octx) => super::project_roots::read(gearbox, connectors, hub, &octx, org).await,
            Err(_) => Default::default(),
        };
        gearbox.use_project_files(org, files);
        match listed {
            Ok(list) => {
                let mut roots: Vec<GearRoot> = list.into_iter().map(root_of).collect();
                let fresh: Vec<GearRoot> = project_roots
                    .into_iter()
                    .filter(|p| roots.iter().all(|r| r.id != p.id))
                    .collect();
                roots.extend(fresh);
                gearbox.use_org_repositories(org, roots);
            }
            Err(e) => {
                gearbox.mark_org_roots_checked(org);
                warn!(organization_id = %org, error = %format!("{e:#}"), "studio-product: the organization's gear repositories could not be read");
            }
        }
    }
    Some(org)
}

/// The layer that does [`refresh`] on the way into an engine route.
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
        refresh(&gearbox, &connectors, ctx, now).await;
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
}
