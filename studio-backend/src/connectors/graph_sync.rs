//! Turn a connected repository into a knowledge graph.
//!
//! # Why this lives in the connector gear
//!
//! Walking a repository is provider work: the tree and the contributor list
//! come from GitHub's API through the same driver and the same credential as
//! every other call here, and the catalogue lookup that turns a connection id
//! into an authenticated driver is private to this module. The knowledge graph
//! is only where the result is written — the gear reaches it through
//! `GraphStorageClientV1` in `ClientHub`, in process, with the caller's own
//! security context, so the rows land in the caller's tenant and under the
//! caller's authorization.
//!
//! # The shape of the graph
//!
//! ```text
//!   project ──includes──▶ repository ──contains──▶ directory ──contains──▶ file
//!                              ▲                        └──contains──▶ directory
//!                              └──contributed_to── person
//! ```
//!
//! Node keys are derived, not random, and every key carries the repository's
//! full path. Re-running a sync therefore converges instead of duplicating —
//! the gear upserts on `(tenant, node_key)` — and two repositories that both
//! contain `src/main.rs` stay two different nodes.

use std::collections::BTreeSet;
use std::sync::Arc;

use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::service::ConnectorService;
use crate::graph_storage::sdk::{EdgeInput, GraphStorageClientV1, NodeInput};

/// Node types this producer writes.
const T_REPOSITORY: &str = "cf.studio.kg.repository.v1~";
const T_DIRECTORY: &str = "cf.studio.kg.directory.v1~";
const T_FILE: &str = "cf.studio.kg.file.v1~";
const T_PERSON: &str = "cf.studio.kg.person.v1~";
const T_PROJECT: &str = "cf.studio.kg.project.v1~";

/// Edge types this producer writes.
const T_CONTAINS: &str = "cf.studio.kg.contains.v1~";
const T_CONTRIBUTED_TO: &str = "cf.studio.kg.contributed_to.v1~";
const T_INCLUDES: &str = "cf.studio.kg.includes.v1~";

/// How many rows go in one ingest call.
///
/// Well under the gear's default admission ceiling (10k nodes / 20k edges per
/// batch) so a sync does not depend on that ceiling staying where it is.
const BATCH: usize = 500;

/// What to synchronise.
#[derive(Debug, Clone)]
pub struct SyncRequest<'a> {
    /// Connection whose credential reaches the repository.
    pub connection_id: Uuid,
    /// Tenant context the caller is acting in.
    pub tenant: Uuid,
    /// Namespaced repository path, e.g. `constructorfabric/gears-rust`.
    pub repo_full_path: &'a str,
    /// Ref to read the tree at; `None` means the default branch.
    pub git_ref: Option<&'a str>,
    /// Cap on tree entries turned into nodes.
    pub max_entries: usize,
    /// Cap on contributors turned into nodes.
    pub max_contributors: u32,
    /// Project to attach the repository to, when the caller has one.
    pub project_id: Option<Uuid>,
    /// Display name of that project.
    pub project_name: Option<&'a str>,
}

/// What a synchronisation did.
#[derive(Debug, Clone, Default)]
pub struct SyncOutcome {
    /// Ref the tree was actually read at.
    pub git_ref: String,
    /// Nodes inserted or updated.
    pub nodes_upserted: u64,
    /// Edges inserted or updated.
    pub edges_upserted: u64,
    /// File nodes written.
    pub files: usize,
    /// Directory nodes written.
    pub directories: usize,
    /// Person nodes written.
    pub contributors: usize,
    /// Whether the provider truncated its tree, or `max_entries` did.
    pub truncated: bool,
    /// Node id of the repository, so a client can seed a traversal with it.
    pub repo_node_key: String,
}

/// Walk `request.repo_full_path` and write it into the caller's graph.
///
/// # Errors
/// Returns an error when the provider call fails, when the connection cannot
/// be resolved, or when the graph rejects a batch.
pub async fn sync_repository(
    connectors: &ConnectorService,
    graph: &Arc<dyn GraphStorageClientV1>,
    ctx: &SecurityContext,
    request: &SyncRequest<'_>,
) -> anyhow::Result<SyncOutcome> {
    let (driver, auth, _connection) = connectors
        .driver_and_auth(ctx, request.tenant, request.connection_id)
        .await?;

    let tree = driver
        .repo_tree(&auth, request.repo_full_path, request.git_ref)
        .await?;
    let people = driver
        .contributors(&auth, request.repo_full_path, request.max_contributors)
        .await?;

    // Every type is registered before anything references it: the gear rejects
    // a batch naming an unregistered type, and rejects it wholesale.
    for (type_id, kind) in [
        (T_REPOSITORY, "node"),
        (T_DIRECTORY, "node"),
        (T_FILE, "node"),
        (T_PERSON, "node"),
        (T_PROJECT, "node"),
        (T_CONTAINS, "edge"),
        (T_CONTRIBUTED_TO, "edge"),
        (T_INCLUDES, "edge"),
    ] {
        graph.register_type(ctx, type_id, kind, None).await?;
    }

    let repo = request.repo_full_path;
    let repo_key = format!("repo:{repo}");

    let mut nodes: Vec<NodeInput> = Vec::new();
    let mut edges: Vec<EdgeInput> = Vec::new();

    nodes.push(NodeInput {
        node_key: repo_key.clone(),
        type_id: T_REPOSITORY.to_owned(),
        name: repo.to_owned(),
        search_text: Some(format!("{repo} repository {}", tree.git_ref)),
        payload: Some(serde_json::json!({
            "full_path": repo,
            "git_ref": tree.git_ref,
        })),
        embedding: None,
    });

    if let Some(project_id) = request.project_id {
        let project_key = format!("project:{project_id}");
        let project_name = request.project_name.unwrap_or("project");
        nodes.push(NodeInput {
            node_key: project_key.clone(),
            type_id: T_PROJECT.to_owned(),
            name: project_name.to_owned(),
            search_text: Some(format!("{project_name} project")),
            payload: Some(serde_json::json!({ "project_id": project_id })),
            embedding: None,
        });
        edges.push(EdgeInput {
            type_id: T_INCLUDES.to_owned(),
            from: project_key,
            to: repo_key.clone(),
            payload: None,
        });
    }

    // Ancestors are synthesised rather than taken on trust. GitHub does return
    // a `tree` entry per directory, but a provider that returned only blobs
    // would otherwise produce files hanging off nothing.
    let mut entries = tree.entries;
    let truncated_by_us = entries.len() > request.max_entries;
    entries.truncate(request.max_entries);

    let mut directories: BTreeSet<String> = BTreeSet::new();
    for entry in &entries {
        if entry.is_dir {
            directories.insert(entry.path.clone());
        }
        for ancestor in ancestors(&entry.path) {
            directories.insert(ancestor);
        }
    }

    for dir in &directories {
        nodes.push(NodeInput {
            node_key: format!("dir:{repo}:{dir}"),
            type_id: T_DIRECTORY.to_owned(),
            name: basename(dir).to_owned(),
            search_text: Some(format!("{dir} directory {repo}")),
            payload: Some(serde_json::json!({ "path": dir, "repository": repo })),
            embedding: None,
        });
        edges.push(EdgeInput {
            type_id: T_CONTAINS.to_owned(),
            from: parent_key(repo, &repo_key, dir),
            to: format!("dir:{repo}:{dir}"),
            payload: None,
        });
    }

    let mut files = 0usize;
    for entry in entries.iter().filter(|e| !e.is_dir) {
        files += 1;
        let key = format!("file:{repo}:{}", entry.path);
        let name = basename(&entry.path);
        nodes.push(NodeInput {
            node_key: key.clone(),
            type_id: T_FILE.to_owned(),
            name: name.to_owned(),
            // The extension is spelled out as its own word so a search for
            // "rust" or "md" reaches files the tokenizer would otherwise only
            // see glued to a filename.
            search_text: Some(format!(
                "{} {name} {} {repo}",
                entry.path,
                extension(name).unwrap_or("")
            )),
            payload: Some(serde_json::json!({
                "path": entry.path,
                "extension": extension(name),
                "repository": repo,
            })),
            embedding: None,
        });
        edges.push(EdgeInput {
            type_id: T_CONTAINS.to_owned(),
            from: parent_key(repo, &repo_key, &entry.path),
            to: key,
            payload: None,
        });
    }

    for person in &people {
        let key = format!("person:{}", person.login);
        let display = person.display_name.as_deref().unwrap_or(&person.login);
        nodes.push(NodeInput {
            node_key: key.clone(),
            type_id: T_PERSON.to_owned(),
            name: display.to_owned(),
            search_text: Some(format!(
                "{} {display} contributor person {} commits",
                person.login, person.contributions
            )),
            payload: Some(serde_json::json!({ "login": person.login })),
            embedding: None,
        });
        edges.push(EdgeInput {
            type_id: T_CONTRIBUTED_TO.to_owned(),
            from: key,
            to: repo_key.clone(),
            // The commit count belongs to the relation, not to the person:
            // the same account contributes different amounts to each
            // repository it touches.
            payload: Some(serde_json::json!({ "contributions": person.contributions })),
        });
    }

    // Nodes first, then edges, each in its own call: an edge is rejected unless
    // both endpoints already exist or arrive in the same batch, and splitting
    // the two makes that true regardless of how the chunks fall.
    let mut outcome = SyncOutcome {
        git_ref: tree.git_ref,
        files,
        directories: directories.len(),
        contributors: people.len(),
        truncated: tree.truncated || truncated_by_us,
        repo_node_key: repo_key,
        ..SyncOutcome::default()
    };

    for chunk in nodes.chunks(BATCH) {
        outcome.nodes_upserted += graph.ingest(ctx, chunk, &[]).await?.nodes_upserted;
    }
    for chunk in edges.chunks(BATCH) {
        outcome.edges_upserted += graph.ingest(ctx, &[], chunk).await?.edges_upserted;
    }

    Ok(outcome)
}

/// Every proper ancestor directory of `path`, shallowest first.
///
/// `a/b/c.rs` yields `a` and `a/b`. A path with no separator has none.
fn ancestors(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut acc = String::new();
    let parts: Vec<&str> = path.split('/').collect();
    for part in &parts[..parts.len().saturating_sub(1)] {
        if !acc.is_empty() {
            acc.push('/');
        }
        acc.push_str(part);
        out.push(acc.clone());
    }
    out
}

/// Key of the node that contains `path`: its parent directory, or the
/// repository itself for a top-level entry.
fn parent_key(repo: &str, repo_key: &str, path: &str) -> String {
    match path.rfind('/') {
        Some(cut) => format!("dir:{repo}:{}", &path[..cut]),
        None => repo_key.to_owned(),
    }
}

/// Last path segment.
fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Extension of a file name, without the dot.
///
/// A leading dot is not a separator: `.gitignore` is a name, not an extension.
fn extension(name: &str) -> Option<&str> {
    let cut = name.rfind('.')?;
    if cut == 0 {
        None
    } else {
        Some(&name[cut + 1..])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ancestors_are_every_proper_prefix() {
        assert_eq!(
            ancestors("a/b/c.rs"),
            vec!["a".to_string(), "a/b".to_string()]
        );
        assert!(ancestors("README.md").is_empty());
    }

    /// A top-level entry hangs off the repository, not off a directory that
    /// does not exist. Getting this wrong produces a graph with no root.
    #[test]
    fn a_top_level_entry_hangs_off_the_repository() {
        assert_eq!(parent_key("o/r", "repo:o/r", "README.md"), "repo:o/r");
        assert_eq!(parent_key("o/r", "repo:o/r", "src/main.rs"), "dir:o/r:src");
    }

    #[test]
    fn a_dotfile_has_no_extension() {
        assert_eq!(extension(".gitignore"), None);
        assert_eq!(extension("main.rs"), Some("rs"));
        assert_eq!(extension("Makefile"), None);
    }
}
