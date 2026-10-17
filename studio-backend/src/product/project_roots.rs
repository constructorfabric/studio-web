//! The gears an organization's projects keep in their own repositories,
//! as roots of its corpus, and each project's product as its repository says.
//!
//! A project that holds gears describes itself the way any product does: a
//! `product.gdl` at its repository's root whose `source(id, at = path("…"))`
//! entries name the directories its own gears are in (studio-web's are
//! `studio-backend/`, with a `gear.gdl` beside each). Those directories are
//! roots of the organization's corpus here, after its gear repositories --
//! the project is already connected as a source, so it is not connected a
//! second time as a gear repository -- and the gears the file names are the
//! project's product (`studio-product`'s `GET …/product` answers them).
//!
//! Read with the organization's roots, at most once a minute
//! (`gear_roots::scope_for`), from one clone per repository and branch that
//! the corpus then reads its roots out of.

use std::collections::BTreeSet;
use std::sync::Arc;

use toolkit::client_hub::ClientHub;
use toolkit_security::SecurityContext;
use tracing::warn;
use uuid::Uuid;

use super::gearbox::{CorpusSource, GearRoot, Gearbox, ProjectFile, checkout_dir};
use crate::connectors::sdk::Connectors;

/// The file a project's product is read from, at its repository's root.
pub const PRODUCT_FILE: &str = "product.gdl";

/// What a `product.gdl` says that the corpus and the product need.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Described {
    /// `source(id, at = path("…"))` inside the repository: `(id, path)`.
    pub path_sources: Vec<(String, String)>,
    /// Every gear named, hosts (`use_gear("…")`) and plugins (`plugin("…")`).
    pub gears: Vec<String>,
}

/// Read a product description. A line scan, not the engine: it runs on every
/// project of an organization once a minute, and the engine still checks the
/// file whole when it composes the product.
pub fn describe(gdl: &str) -> Described {
    let quoted_after = |text: &str, marker: &str| -> Vec<String> {
        let mut out = Vec::new();
        let mut rest = text;
        while let Some(at) = rest.find(marker) {
            rest = &rest[at + marker.len()..];
            if let Some(end) = rest.find('"') {
                out.push(rest[..end].to_owned());
            }
        }
        out
    };
    let mut path_sources = Vec::new();
    let mut rest = gdl;
    while let Some(at) = rest.find("source(") {
        rest = &rest[at + "source(".len()..];
        let call = &rest[..rest
            .find("),")
            .or_else(|| rest.find(")\n"))
            .unwrap_or(rest.len())];
        let id = quoted_after(call, "id = \"").into_iter().next();
        let path = quoted_after(call, "path(\"").into_iter().next();
        if let (Some(id), Some(path)) = (id, path) {
            path_sources.push((id, path));
        }
    }
    let mut seen = BTreeSet::new();
    let gears = quoted_after(gdl, "use_gear(\"")
        .into_iter()
        .chain(quoted_after(gdl, "plugin(\""))
        .filter(|g| seen.insert(g.clone()))
        .collect();
    Described {
        path_sources,
        gears,
    }
}

/// A `path(…)` source the corpus can read as a root: inside the repository
/// (no `..`, not absolute) and in a directory named like its id, because the
/// engine names a root by its directory.
pub fn readable_path(id: &str, path: &str) -> Option<String> {
    let path = path.trim().trim_end_matches('/');
    let path = path.strip_prefix("./").unwrap_or(path);
    if path.is_empty() || path == "." || path.starts_with('/') || path.split('/').any(|s| s == "..")
    {
        return None;
    }
    (path.rsplit('/').next() == Some(id)).then(|| path.to_owned())
}

/// The organization's projects' own gear directories as roots, and each
/// project's product file. Errors are logged and the project skipped: one
/// unreadable repository does not take the organization's corpus with it.
pub async fn read(
    gearbox: &Arc<Gearbox>,
    connectors: &Connectors,
    hub: &Arc<ClientHub>,
    ctx: &SecurityContext,
    org: Uuid,
) -> (Vec<GearRoot>, Vec<(Uuid, ProjectFile)>) {
    let mut roots = Vec::new();
    let mut files = Vec::new();
    let (Some(service), Ok(projects), Ok(am)) = (
        connectors.get(),
        hub.get::<dyn crate::organizations::port::ProjectsOf>(),
        hub.get::<dyn account_management_sdk::AccountManagementClient>(),
    ) else {
        return (roots, files);
    };
    let projects = match projects.projects_of(ctx, org).await {
        Ok(p) => p,
        Err(e) => {
            warn!(organization_id = %org, error = %format!("{e:#}"), "studio-product: the organization's projects could not be listed");
            return (roots, files);
        }
    };
    let mut taken: BTreeSet<String> = BTreeSet::new();
    for project in projects {
        let sources = crate::project_sources::read(am.as_ref(), ctx, project.id)
            .await
            .unwrap_or_default();
        for source in sources {
            let Some(connection) = source.connection_id else {
                continue;
            };
            let Some(tenant) = service.locate(ctx, project.id, connection).await else {
                continue;
            };
            let (driver, auth, _) = match service.driver_and_auth(ctx, tenant, connection).await {
                Ok(found) => found,
                Err(e) => {
                    warn!(project_id = %project.id, repo = %source.full_path, error = %format!("{e:#}"), "studio-product: a project source is not readable for its product file");
                    continue;
                }
            };
            let Ok(url) = driver.clone_url(&auth.base_url, &source.full_path) else {
                continue;
            };
            let (username, token) = driver.clone_credentials(&auth.token);
            let branch = source.branch.clone().unwrap_or_default();
            let corpus = CorpusSource {
                label: if branch.is_empty() {
                    source.full_path.clone()
                } else {
                    format!("{}@{branch}", source.full_path)
                },
                key: super::gear_roots::checkout_key(&url, &branch),
                repo: source.full_path.clone(),
                url,
                username: username.to_owned(),
                token: token.to_owned(),
                git_ref: branch.clone(),
            };
            // Where the corpus reads the repository's roots from too: one clone.
            let probe = GearRoot {
                id: String::new(),
                source: corpus.clone(),
                connection_id: Some(connection),
                organization: true,
                subdir: Some(String::new()),
            };
            let dir = checkout_dir(gearbox.workdir(), &probe);
            let clone = match gearbox_checkout(gearbox, &dir, &corpus).await {
                Some(Ok(c)) => c,
                None => {
                    warn!(project_id = %project.id, repo = %source.full_path, "studio-product: a project source is still being cloned; its gears are read on the next refresh");
                    continue;
                }
                Some(Err(e)) => {
                    warn!(project_id = %project.id, repo = %source.full_path, error = %format!("{e:#}"), "studio-product: a project source could not be checked out for its product file");
                    continue;
                }
            };
            let Ok(text) = std::fs::read_to_string(clone.dir.join(PRODUCT_FILE)) else {
                continue;
            };
            let described = describe(&text);
            for (id, path) in &described.path_sources {
                let Some(sub) = readable_path(id, path) else {
                    continue;
                };
                if !clone.dir.join(&sub).is_dir() || !taken.insert(id.clone()) {
                    continue;
                }
                roots.push(GearRoot {
                    id: id.clone(),
                    source: CorpusSource {
                        label: format!("{} · {sub}", corpus.label),
                        ..corpus.clone()
                    },
                    connection_id: Some(connection),
                    organization: true,
                    subdir: Some(sub),
                });
            }
            files.push((
                project.id,
                ProjectFile {
                    organization: org,
                    repo: source.full_path.clone(),
                    branch,
                    path: PRODUCT_FILE.to_owned(),
                    commit: clone.commit.clone(),
                    gears: described.gears,
                },
            ));
            // One product file per project: its first source that has one.
            break;
        }
    }
    (roots, files)
}

/// How long a request waits for a project's repository to be cloned or
/// fetched. A first clone of a large one (studio-web's took over 30 s) runs
/// on, and the next read of the organization's roots finds it done -- a page
/// that waited for it whole answered the gateway's 504 instead.
const CHECKOUT_WAIT: std::time::Duration = std::time::Duration::from_secs(20);

/// [`Gearbox::checkout_at`] off the runtime, waited for at most
/// [`CHECKOUT_WAIT`]: `None` when it is still running.
async fn gearbox_checkout(
    gearbox: &Arc<Gearbox>,
    dir: &std::path::Path,
    source: &CorpusSource,
) -> Option<anyhow::Result<crate::connectors::sdk::git_checkout::CloneResult>> {
    let (gearbox, dir, source) = (Arc::clone(gearbox), dir.to_path_buf(), source.clone());
    let job = tokio::task::spawn_blocking(move || gearbox.checkout_at(&dir, &source));
    match tokio::time::timeout(CHECKOUT_WAIT, job).await {
        Ok(Ok(result)) => Some(result),
        Ok(Err(e)) => Some(Err(anyhow::anyhow!("the checkout task failed: {e}"))),
        Err(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STUDIO: &str = r#"product(
    id = "studio-web",
    sources = [
        source(id = "studio-backend", at = path("studio-backend")),
        source(id = "gears-rust", at = path("../gears-rust"))
    ],
    gears = [
        use_gear("credstore", source = "gears-rust", plugins = [plugin("static-credstore-plugin"), plugin("studio-credstore-pg")]),
        use_gear("studio-documents", source = "studio-backend"),
    ],
)"#;

    #[test]
    fn a_product_file_says_its_path_sources_and_its_gears() {
        let d = describe(STUDIO);
        assert_eq!(
            d.path_sources,
            vec![
                ("studio-backend".to_owned(), "studio-backend".to_owned()),
                ("gears-rust".to_owned(), "../gears-rust".to_owned()),
            ]
        );
        assert_eq!(
            d.gears,
            vec![
                "credstore",
                "studio-documents",
                "static-credstore-plugin",
                "studio-credstore-pg"
            ]
        );
    }

    #[test]
    fn only_a_directory_inside_the_repository_named_like_its_id_is_a_root() {
        assert_eq!(
            readable_path("studio-backend", "studio-backend").as_deref(),
            Some("studio-backend")
        );
        assert_eq!(
            readable_path("gears", "./crates/gears/").as_deref(),
            Some("crates/gears")
        );
        assert_eq!(readable_path("gears-rust", "../gears-rust"), None);
        assert_eq!(readable_path("x", "/abs/x"), None);
        assert_eq!(readable_path("x", "."), None);
        assert_eq!(readable_path("backend", "studio-backend"), None);
    }
}
