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

use futures_util::StreamExt;
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

/// `sub` of a checkout as a directory the engine may read: what it resolves to
/// once links are followed must be a directory strictly inside the checkout.
/// [`readable_path`] judges the text only, and git checks out committed
/// symlinks -- a `studio-backend -> ../../<another checkout>` link would
/// otherwise hand the engine another repository, another tenant's included.
/// Asked again after every refresh, since a pull can turn a directory into a
/// link.
pub fn contained_dir(checkout: &std::path::Path, sub: &str) -> Option<std::path::PathBuf> {
    let base = checkout.canonicalize().ok()?;
    let dir = checkout.join(sub).canonicalize().ok()?;
    (dir != base && dir.starts_with(&base) && dir.is_dir()).then_some(dir)
}

/// What one project's repositories said this time.
pub enum ProjectRead {
    /// Its product file, and the roots that file names.
    Read {
        roots: Vec<GearRoot>,
        file: ProjectFile,
    },
    /// Every source answered, and none keeps a product file.
    NoFile,
    /// A source could not be read this time -- still being cloned, a failed
    /// fetch, or the read ran out of time -- before a product file was found.
    /// What was read last time stands.
    Unread,
}

/// How many projects' repositories are read at once.
const PARALLEL_PROJECTS: usize = 4;

/// How long one read of an organization's projects may take in all. Past it
/// the projects not yet read keep what they had: a request waits at most
/// this, not one [`CHECKOUT_WAIT`] per slow source in turn.
const READ_DEADLINE: std::time::Duration = std::time::Duration::from_secs(25);

/// The organization's projects' own gear directories as roots, and each
/// project's product file. Projects are read a few at a time under one
/// deadline; one that could not be read keeps its roots and file from the
/// last read, so a slow or failing repository neither drops the project's
/// gears nor makes the next refresh a new corpus generation. Errors are
/// logged: one unreadable repository does not take the organization's corpus
/// with it.
pub async fn read(
    gearbox: &Arc<Gearbox>,
    connectors: &Connectors,
    hub: &Arc<ClientHub>,
    ctx: &SecurityContext,
    org: Uuid,
) -> (Vec<GearRoot>, Vec<(Uuid, ProjectFile)>) {
    let previous_files: Vec<(Uuid, ProjectFile)> = gearbox.project_files_of(org);
    let previous_roots: Vec<GearRoot> = gearbox
        .roots_in(Some(org))
        .into_iter()
        .filter(|r| r.subdir.is_some())
        .collect();
    let (Some(service), Ok(projects), Ok(am)) = (
        connectors.get(),
        hub.get::<dyn crate::organizations::port::ProjectsOf>(),
        hub.get::<dyn account_management_sdk::AccountManagementClient>(),
    ) else {
        return (previous_roots, previous_files);
    };
    let projects = match projects.projects_of(ctx, org).await {
        Ok(p) => p,
        Err(e) => {
            warn!(organization_id = %org, error = %format!("{e:#}"), "studio-product: the organization's projects could not be listed");
            return (previous_roots, previous_files);
        }
    };
    let deadline = tokio::time::Instant::now() + READ_DEADLINE;
    let reads: Vec<(Uuid, ProjectRead)> = futures_util::stream::iter(projects)
        .map(|project| {
            let (service, am) = (&service, &am);
            async move {
                let read = tokio::time::timeout_at(
                    deadline,
                    read_project(gearbox, service, am.as_ref(), ctx, org, project.id),
                )
                .await
                .unwrap_or_else(|_| {
                    warn!(project_id = %project.id, "studio-product: a project's repositories were not read in time; its last product file stands");
                    ProjectRead::Unread
                });
                (project.id, read)
            }
        })
        .buffered(PARALLEL_PROJECTS)
        .collect()
        .await;
    merge(reads, &previous_roots, &previous_files)
}

/// One project's product file and the roots it names: its first source that
/// keeps one.
async fn read_project(
    gearbox: &Arc<Gearbox>,
    service: &Arc<crate::connectors::sdk::ConnectorService>,
    am: &dyn account_management_sdk::AccountManagementClient,
    ctx: &SecurityContext,
    org: Uuid,
    project: Uuid,
) -> ProjectRead {
    // No config, or none the caller sees: no sources, as before.
    let sources = crate::project_sources::read(am, ctx, project)
        .await
        .unwrap_or_default();
    let mut unread = false;
    for source in sources {
        let Some((corpus, connection)) = source_corpus(service, ctx, project, &source).await else {
            continue;
        };
        let branch = corpus.git_ref.clone();
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
                warn!(project_id = %project, repo = %source.full_path, "studio-product: a project source is still being cloned; its gears are read on the next refresh");
                unread = true;
                continue;
            }
            Some(Err(e)) => {
                warn!(project_id = %project, repo = %source.full_path, error = %format!("{e:#}"), "studio-product: a project source could not be checked out for its product file");
                unread = true;
                continue;
            }
        };
        let Ok(text) = std::fs::read_to_string(clone.dir.join(PRODUCT_FILE)) else {
            continue;
        };
        let described = describe(&text);
        let roots = described
            .path_sources
            .iter()
            .filter_map(|(id, path)| {
                let sub = readable_path(id, path)?;
                contained_dir(&clone.dir, &sub)?;
                Some(GearRoot {
                    id: id.clone(),
                    source: CorpusSource {
                        label: format!("{} · {sub}", corpus.label),
                        ..corpus.clone()
                    },
                    connection_id: Some(connection),
                    organization: true,
                    subdir: Some(sub),
                })
            })
            .collect();
        return ProjectRead::Read {
            roots,
            file: ProjectFile {
                organization: org,
                repo: source.full_path.clone(),
                branch,
                path: PRODUCT_FILE.to_owned(),
                commit: clone.commit.clone(),
                gears: described.gears,
            },
        };
    }
    if unread {
        ProjectRead::Unread
    } else {
        ProjectRead::NoFile
    }
}

/// The organization's project roots and files from this read, in project
/// order. A project read this time gives what it said; one that could not be
/// read keeps its last file and the roots read beside it. A source id is a
/// root once, for the first project that names it.
fn merge(
    reads: Vec<(Uuid, ProjectRead)>,
    previous_roots: &[GearRoot],
    previous_files: &[(Uuid, ProjectFile)],
) -> (Vec<GearRoot>, Vec<(Uuid, ProjectFile)>) {
    let mut roots = Vec::new();
    let mut files = Vec::new();
    let mut taken: BTreeSet<String> = BTreeSet::new();
    for (project, read) in reads {
        let (these, file) = match read {
            ProjectRead::Read { roots, file } => (roots, file),
            ProjectRead::NoFile => continue,
            ProjectRead::Unread => {
                let Some((_, file)) = previous_files.iter().find(|(p, _)| *p == project) else {
                    continue;
                };
                let kept = previous_roots
                    .iter()
                    .filter(|r| r.source.repo == file.repo && r.source.git_ref == file.branch)
                    .cloned()
                    .collect();
                (kept, file.clone())
            }
        };
        roots.extend(these.into_iter().filter(|r| taken.insert(r.id.clone())));
        files.push((project, file));
    }
    (roots, files)
}

/// A project source as the corpus reads a repository: its clone URL and
/// credentials through its connection, at its branch. `None` for a source
/// read through no connection the caller can use.
async fn source_corpus(
    service: &Arc<crate::connectors::sdk::ConnectorService>,
    ctx: &SecurityContext,
    project: Uuid,
    source: &crate::project_sources::ProjectSource,
) -> Option<(CorpusSource, Uuid)> {
    let connection = source.connection_id?;
    let tenant = service.locate(ctx, project, connection).await?;
    let (driver, auth, _) = match service.driver_and_auth(ctx, tenant, connection).await {
        Ok(found) => found,
        Err(e) => {
            warn!(project_id = %project, repo = %source.full_path, error = %format!("{e:#}"), "studio-product: a project source is not readable");
            return None;
        }
    };
    let url = driver.clone_url(&auth.base_url, &source.full_path).ok()?;
    let (username, token) = driver.clone_credentials(&auth.token);
    let branch = source.branch.clone().unwrap_or_default();
    Some((
        CorpusSource {
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
            git_ref: branch,
        },
        connection,
    ))
}

/// The project's home repository (the source its description travels with,
/// `project_sources::description_home`), checked out on the server at its
/// branch in the one clone the corpus reads it from (ADR-0060 §6): what a
/// check resolves the description's `path(...)` sources in, as a build does.
/// `None` for a project with no home source the server can read; an error
/// while the first clone is still running, or when it failed.
pub async fn home_checkout(
    gearbox: &Arc<Gearbox>,
    connectors: &Connectors,
    am: &dyn account_management_sdk::AccountManagementClient,
    ctx: &SecurityContext,
    project: Uuid,
) -> Option<anyhow::Result<super::gearbox::HomeCheckout>> {
    let service = connectors.get()?;
    let sources = crate::project_sources::read(am, ctx, project)
        .await
        .unwrap_or_default();
    let home = crate::project_sources::description_home(&sources)?.clone();
    let (corpus, connection) = source_corpus(&service, ctx, project, &home).await?;
    let probe = GearRoot {
        id: String::new(),
        source: corpus.clone(),
        connection_id: Some(connection),
        organization: true,
        subdir: Some(String::new()),
    };
    let dir = checkout_dir(gearbox.workdir(), &probe);
    let (gb, at, src) = (Arc::clone(gearbox), dir.clone(), corpus.clone());
    let job = tokio::task::spawn_blocking(move || gb.home_checkout_at(&at, &src));
    let clone = match tokio::time::timeout(CHECKOUT_WAIT, job).await {
        Ok(Ok(Ok(c))) => c,
        Ok(Ok(Err(e))) => {
            return Some(Err(
                e.context(format!("{} could not be checked out", home.full_path))
            ));
        }
        Ok(Err(e)) => return Some(Err(anyhow::anyhow!("the checkout task failed: {e}"))),
        Err(_) => {
            return Some(Err(super::gearbox::HomeStillReading(
                home.full_path.clone(),
            )
            .into()));
        }
    };
    Some(Ok(super::gearbox::HomeCheckout {
        id: home.dir.clone(),
        repo: home.full_path.clone(),
        url: home.clone_url.clone(),
        dir: clone.dir,
        commit: clone.commit,
    }))
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

    fn root(id: &str, repo: &str) -> GearRoot {
        GearRoot {
            id: id.into(),
            source: CorpusSource {
                label: repo.into(),
                key: repo.into(),
                repo: repo.into(),
                url: format!("https://example.test/{repo}.git"),
                username: String::new(),
                token: String::new(),
                git_ref: "main".into(),
            },
            connection_id: None,
            organization: true,
            subdir: Some(id.into()),
        }
    }

    fn file(repo: &str, gear: &str) -> ProjectFile {
        ProjectFile {
            organization: Uuid::nil(),
            repo: repo.into(),
            branch: "main".into(),
            path: PRODUCT_FILE.into(),
            commit: None,
            gears: vec![gear.into()],
        }
    }

    #[test]
    fn a_project_not_read_this_time_keeps_its_last_file_and_roots() {
        let (shop, crm, blog) = (Uuid::from_u128(1), Uuid::from_u128(2), Uuid::from_u128(3));
        let previous_roots = [
            root("shop-backend", "acme/shop"),
            root("crm-backend", "acme/crm"),
        ];
        let previous_files = [
            (shop, file("acme/shop", "old")),
            (crm, file("acme/crm", "crm")),
        ];
        let (roots, files) = merge(
            vec![
                (
                    shop,
                    ProjectRead::Read {
                        roots: vec![root("shop-backend", "acme/shop")],
                        file: file("acme/shop", "new"),
                    },
                ),
                (crm, ProjectRead::Unread),
                (blog, ProjectRead::NoFile),
            ],
            &previous_roots,
            &previous_files,
        );
        let ids: Vec<&str> = roots.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(
            ids,
            ["shop-backend", "crm-backend"],
            "crm's root is kept, not dropped"
        );
        assert_eq!(files.len(), 2);
        assert_eq!(
            files[0].1.gears,
            ["new"],
            "a project read this time says what it says now"
        );
        assert_eq!(files[1], (crm, file("acme/crm", "crm")));
    }

    #[test]
    fn a_source_id_is_one_root_for_the_first_project_that_names_it() {
        let (a, b) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let read = |repo: &str| ProjectRead::Read {
            roots: vec![root("backend", repo)],
            file: file(repo, "g"),
        };
        let (roots, files) = merge(vec![(a, read("acme/a")), (b, read("acme/b"))], &[], &[]);
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].source.repo, "acme/a");
        assert_eq!(files.len(), 2);
    }

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

    #[test]
    fn a_root_is_read_only_where_it_resolves_inside_its_checkout() {
        let scratch =
            std::env::temp_dir().join(format!("studio-project-roots-{}", uuid::Uuid::new_v4()));
        let checkout = scratch.join("checkout");
        let elsewhere = scratch.join("another-tenant");
        std::fs::create_dir_all(checkout.join("crates/gears")).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(checkout.join("README.md"), "").unwrap();

        let inside = contained_dir(&checkout, "crates/gears").expect("a real directory");
        assert!(inside.ends_with("gears"));
        assert_eq!(contained_dir(&checkout, "missing"), None);
        assert_eq!(
            contained_dir(&checkout, "README.md"),
            None,
            "a file is no root"
        );
        assert_eq!(
            contained_dir(&checkout, "crates/.."),
            None,
            "the checkout itself"
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&elsewhere, checkout.join("studio-backend")).unwrap();
            assert_eq!(
                contained_dir(&checkout, "studio-backend"),
                None,
                "a committed link out of the checkout is not followed"
            );
            std::os::unix::fs::symlink(checkout.join("crates"), checkout.join("linked")).unwrap();
            assert!(
                contained_dir(&checkout, "linked/gears").is_some(),
                "a link that stays inside is fine"
            );
        }
        std::fs::remove_dir_all(&scratch).unwrap();
    }
}
