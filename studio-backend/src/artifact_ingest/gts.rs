//! GTS identifiers, type schemas and instance normalization for artifacts.
//!
//! Type ids and the free-form registration documents live here; the full
//! property schemas are in `studio-backend/gts/artifact/*.schema.json` (the
//! graph-store contract). Instance ids are deterministic (uuid5 of a stable
//! key) so re-syncing the same entity upserts rather than duplicates.

use serde_json::{Value, json};
use uuid::Uuid;

use super::comment_threads::{ThreadCounts, Waiting};
use super::graph::{GtsEdge, GtsNode};
use crate::connectors::driver::{
    RemoteComment, RemoteCommit, RemoteFile, RemoteIssue, RemotePullRequest,
};

/// Fixed namespace for uuid5 instance ids (studio artifact graph).
const INSTANCE_NS: Uuid = Uuid::from_u128(0xcf57_0000_0000_4000_8000_0000_0000_0001);

pub const REPO_TYPE: &str = "gts.cf.studio.artifact.repo.v1~";
pub const ISSUE_TYPE: &str = "gts.cf.studio.artifact.issue.v1~";
pub const PULL_REQUEST_TYPE: &str = "gts.cf.studio.artifact.pull_request.v1~";
pub const FILE_TYPE: &str = "gts.cf.studio.artifact.file.v1~";
pub const USER_TYPE: &str = "gts.cf.studio.artifact.user.v1~";
/// A spec-quality finding about a document (bloat / traceability / leak /
/// purpose). Materialized from a detector result by the portal.
pub const SPEC_FINDING_TYPE: &str = "gts.cf.studio.artifact.spec_finding.v1~";
/// A comment on an issue or pull request.
pub const COMMENT_TYPE: &str = "gts.cf.studio.artifact.comment.v1~";
/// A commit in a repository.
pub const COMMIT_TYPE: &str = "gts.cf.studio.artifact.commit.v1~";
/// What search sees of a file's text: a bounded excerpt, beside the file
/// rather than inside it.
///
/// It used to be a field of the file node, and every listing of files paid
/// for it. graph-storage projects whole payloads — it cannot select fields —
/// so the Specs screen, which wants a path and a repository per file, read
/// 2.3 KB of excerpt out of every 2.7 KB file node, and a tenant's 9,577 files
/// took 48 pages and eight seconds to walk. Search is the only reader the
/// excerpt ever had, and search reaches it here just as well.
pub const FILE_CONTENT_TYPE: &str = "gts.cf.studio.artifact.file_content.v1~";

/// Every artifact node type, for registering and enumerating.
pub const ALL_NODE_TYPES: [&str; 9] = [
    REPO_TYPE,
    ISSUE_TYPE,
    PULL_REQUEST_TYPE,
    FILE_TYPE,
    USER_TYPE,
    SPEC_FINDING_TYPE,
    COMMENT_TYPE,
    COMMIT_TYPE,
    FILE_CONTENT_TYPE,
];

/// The node types the artifact listing returns by default — the four
/// first-class artifacts. The rest (`user`, `spec_finding`, `comment`,
/// `commit`) are graph detail: present in the graph, but only listed when a
/// caller asks for one explicitly by its GTS type id.
pub const LISTABLE_NODE_TYPES: [&str; 4] = [REPO_TYPE, FILE_TYPE, ISSUE_TYPE, PULL_REQUEST_TYPE];

/// Resolve the listing `type` filter into the concrete node types to project.
///
/// * `None` -> [`LISTABLE_NODE_TYPES`] (the four first-class artifacts).
/// * `Some(id)` -> that one type, matched by its full GTS id
///   (`gts.cf.studio.artifact.<t>.v1~`); the bare leaf (`issue`, `file`, ...)
///   is also accepted for older callers. An unknown value resolves to nothing,
///   so a typo lists no rows rather than silently listing everything.
pub fn resolve_listable_types(type_filter: Option<&str>) -> Vec<&'static str> {
    match type_filter.map(str::trim).filter(|s| !s.is_empty()) {
        None => LISTABLE_NODE_TYPES.to_vec(),
        Some(f) => ALL_NODE_TYPES
            .into_iter()
            .filter(|t| is_listed(t))
            .filter(|t| *t == f || type_leaf(t) == f)
            .collect(),
    }
}

/// Whether nodes of this type are ever listed — by `/nodes`, the artifact
/// index or anything else that reads the graph back as rows.
///
/// Every type is, except a file's content. It is not an artifact but a part of
/// one, reached only through search, and it is the bytes that listing files
/// stopped carrying: listing it, or mirroring it into the index, would put them
/// straight back.
pub fn is_listed(type_id: &str) -> bool {
    type_id != FILE_CONTENT_TYPE
}

/// The leaf name of an artifact type id: `issue` from
/// `gts.cf.studio.artifact.issue.v1~` (the token before the version).
fn type_leaf(type_id: &str) -> &str {
    let toks: Vec<&str> = type_id.trim_end_matches('~').split('.').collect();
    if toks.len() >= 2 {
        toks[toks.len() - 2]
    } else {
        type_id
    }
}

// ── Relation (edge) types ── namespace `rel`. Endpoints are node instance ids.
/// issue / pull_request → repo.
pub const REL_ARTIFACT_OF: &str = "gts.cf.studio.rel.artifact_of.v1~";
/// repo → file.
pub const REL_CONTAINS: &str = "gts.cf.studio.rel.contains.v1~";
/// issue / pull_request → user (the author).
pub const REL_AUTHORED_BY: &str = "gts.cf.studio.rel.authored_by.v1~";
/// pull_request → file (a file the PR changed).
pub const REL_MODIFIES: &str = "gts.cf.studio.rel.modifies.v1~";
/// document ↔ document — near-duplicate found by the bloat detector.
pub const REL_DUPLICATES: &str = "gts.cf.studio.rel.duplicates.v1~";
/// document → document — a traceability link from the traceability detector.
pub const REL_TRACES_TO: &str = "gts.cf.studio.rel.traces_to.v1~";
/// spec_finding → document — the document a finding is about.
pub const REL_FINDING_ON: &str = "gts.cf.studio.rel.finding_on.v1~";
/// comment → issue / pull_request — the artifact a comment is on.
pub const REL_COMMENT_ON: &str = "gts.cf.studio.rel.comment_on.v1~";
/// file_content → file — the file an excerpt was taken from.
pub const REL_CONTENT_OF: &str = "gts.cf.studio.rel.content_of.v1~";

/// Every relation type, for registering in the graph.
pub const ALL_EDGE_TYPES: [&str; 9] = [
    REL_ARTIFACT_OF,
    REL_CONTAINS,
    REL_AUTHORED_BY,
    REL_MODIFIES,
    REL_DUPLICATES,
    REL_TRACES_TO,
    REL_FINDING_ON,
    REL_COMMENT_ON,
    REL_CONTENT_OF,
];

/// The graph-storage families our types derive from.
///
/// Derivation is not decoration: `family` is declared required with no default
/// on the two bases, so a type deriving straight from a base resolves no family
/// and cannot be instantiated. Artifacts are *owned* nodes — the graph is their
/// system of record here — and the relations are *static* edges, replaced
/// wholesale by a re-sync.
const OWNED_NODE_FAMILY: &str = "gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~";
const STATIC_EDGE_FAMILY: &str = "gts.cf.core.graph.edge.v1~cf.core.graph.static_edge.v1~";

/// The type id the graph-storage gear stores this artifact type under.
///
/// A derived type carries its ancestry in the identifier: our
/// `gts.cf.studio.artifact.file.v1~` becomes
/// `gts.cf.core.graph.node.v1~cf.core.graph.owned_node.v1~cf.studio.artifact.file.v1~`.
pub fn graph_type_id(our_type: &str) -> String {
    let leaf = our_type.strip_prefix("gts.").unwrap_or(our_type);
    let family = if ALL_EDGE_TYPES.contains(&our_type) {
        STATIC_EDGE_FAMILY
    } else {
        OWNED_NODE_FAMILY
    };
    format!("{family}{leaf}")
}

/// Reverse of [`graph_type_id`]: map a graph-storage type id back to our
/// `&'static` constant so a node read back becomes a [`GtsNode`].
pub fn our_type_from_graph(graph_type: &str) -> Option<&'static str> {
    ALL_NODE_TYPES
        .into_iter()
        .find(|t| graph_type_id(t) == graph_type)
}

/// The node types, with a title and a description each.
const NODE_TYPE_DOCS: [(&str, &str, &str); 9] = [
    (
        REPO_TYPE,
        "Repository",
        "A source repository ingested from a connector.",
    ),
    (
        ISSUE_TYPE,
        "Issue",
        "An issue pulled from the connector API.",
    ),
    (
        PULL_REQUEST_TYPE,
        "PullRequest",
        "A pull/merge request pulled from the connector API.",
    ),
    (
        FILE_TYPE,
        "File",
        "A file in the repository tree pulled from the connector API.",
    ),
    (
        USER_TYPE,
        "User",
        "An account that authored issues, pull requests, comments or commits.",
    ),
    (
        SPEC_FINDING_TYPE,
        "SpecFinding",
        "A spec-quality finding (bloat/traceability/leak/purpose) about a document.",
    ),
    (
        COMMENT_TYPE,
        "Comment",
        "A comment on an issue or pull request pulled from the connector API.",
    ),
    (
        COMMIT_TYPE,
        "Commit",
        "A commit in the repository pulled from the connector API.",
    ),
    (
        FILE_CONTENT_TYPE,
        "FileContent",
        "A bounded excerpt of a text file, kept beside the file for search.",
    ),
];

/// The relation types, with a title and a description each — the catalog side
/// of [`ALL_EDGE_TYPES`].
const EDGE_TYPE_DOCS: [(&str, &str, &str); 9] = [
    (
        REL_ARTIFACT_OF,
        "ArtifactOf",
        "An issue or pull request and the repository it belongs to.",
    ),
    (
        REL_CONTAINS,
        "Contains",
        "A repository and a file in its tree.",
    ),
    (
        REL_AUTHORED_BY,
        "AuthoredBy",
        "An issue or pull request and the account that authored it.",
    ),
    (
        REL_MODIFIES,
        "Modifies",
        "A pull request and a file it changed.",
    ),
    (
        REL_DUPLICATES,
        "Duplicates",
        "Two documents the bloat detector found to be near-duplicates.",
    ),
    (
        REL_TRACES_TO,
        "TracesTo",
        "A traceability link between two documents, from the traceability detector.",
    ),
    (
        REL_FINDING_ON,
        "FindingOn",
        "A spec-quality finding and the document it is about.",
    ),
    (
        REL_COMMENT_ON,
        "CommentOn",
        "A comment and the issue or pull request it is on.",
    ),
    (
        REL_CONTENT_OF,
        "ContentOf",
        "A file's searchable excerpt and the file it was taken from.",
    ),
];

/// GTS Type Schemas registered with the **platform types-registry** at gear
/// init. Declared free-form (`type: object`) — the same shape the studio types
/// use in `config/*.yaml` — so registration never trips the closed-envelope
/// narrowing check; the full property schemas live alongside as JSON files and
/// are the graph contract.
///
/// Nodes *and* relations, and no type is held back: the platform registry is
/// the catalog of everything, so every type this gear puts in graph-storage
/// must be findable here too. `crate::gts_inventory` asserts that direction as
/// an invariant — a graph type with no catalog entry is a registry that
/// disagrees with the graph.
pub fn type_schemas() -> Vec<Value> {
    NODE_TYPE_DOCS
        .into_iter()
        .chain(EDGE_TYPE_DOCS)
        .map(|(id, title, description)| {
            json!({
                "$id": format!("gts://{id}"),
                "$schema": "http://json-schema.org/draft-07/schema#",
                "title": title,
                "description": description,
                "type": "object",
            })
        })
        .collect()
}

/// Payload paths the gear indexes for lexical search, declared once on every
/// artifact type. The gear composes the search text from these on write, so a
/// producer no longer supplies a `search_text` string; a path a node's payload
/// does not have is simply skipped.
///
/// `text_excerpt` is still here, and so still on the file type, although no
/// file node carries one any more. It cannot come off: graph-storage holds a
/// registered schema immutable, and `file.v1` re-registered with other traits
/// is a conflict that fails the whole registration batch, on every tenant that
/// already has the old one. A `file.v2` would not help either — a node's type
/// cannot change under its key, so it would mean a new key for every file and
/// for every binding and relation that names one. Left declared, the path
/// resolves to nothing on a file and costs nothing.
const FULL_TEXT_PATHS: [&str; 12] = [
    "/payload/title",
    "/payload/path",
    "/payload/full_path",
    "/payload/state",
    "/payload/author",
    "/payload/login",
    "/payload/labels",
    "/payload/body",
    "/payload/message",
    "/payload/summary",
    "/payload/severity",
    "/payload/text_excerpt",
];

/// Payload paths the gear embeds — what a node "is about", so a semantic hit
/// and a keyword hit agree on the same content. Identifiers and states carry
/// no meaning a vector could rank, so they stay lexical-only.
const VECTOR_PATHS: [&str; 8] = [
    "/payload/title",
    "/payload/path",
    "/payload/full_path",
    "/payload/body",
    "/payload/message",
    "/payload/summary",
    "/payload/login",
    "/payload/text_excerpt",
];

/// What the file-content type searches and embeds: the excerpt, and the path
/// beside it, which is what the file type searched and embedded for a text
/// file before the two were split — so a query ranks the same text as it did.
///
/// Its own declaration rather than the shared one, because a new type is free
/// to say exactly what it holds.
const CONTENT_PATHS: [&str; 2] = ["/payload/path", "/payload/text_excerpt"];

/// The same types as **graph-storage** ontology entries.
///
/// A separate document set, because the two registries answer different
/// questions: the platform registry catalogs what a studio artifact is, while
/// graph-storage needs a type that derives from one of its families — a type
/// deriving straight from a base fixes no `family` and is refused, and one
/// declared free-form has no chain to validate against at all. The traits
/// declare which payload paths the gear searches and embeds.
pub fn graph_node_type_schemas() -> Vec<Value> {
    NODE_TYPE_DOCS
        .into_iter()
        .map(|(id, title, description)| {
            let mut schema = derived_schema(id, title, description, OWNED_NODE_FAMILY);
            schema["x-gts-traits"] = if id == FILE_CONTENT_TYPE {
                json!({
                    "full_text_search": CONTENT_PATHS,
                    "vector_search": CONTENT_PATHS,
                })
            } else {
                json!({
                    "full_text_search": FULL_TEXT_PATHS,
                    "vector_search": VECTOR_PATHS,
                })
            };
            schema
        })
        .collect()
}

/// The relation types, deriving from the static-edge family: they are replaced
/// by a scope re-sync, unlike analysis edges.
pub fn graph_edge_type_schemas() -> Vec<Value> {
    ALL_EDGE_TYPES
        .into_iter()
        .map(|id| {
            derived_schema(
                id,
                "Relation",
                "A relation between two artifact nodes.",
                STATIC_EDGE_FAMILY,
            )
        })
        .collect()
}

fn derived_schema(id: &str, title: &str, description: &str, family: &str) -> Value {
    json!({
        "$id": format!("gts://{}", graph_type_id(id)),
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": title,
        "description": description,
        "type": "object",
        "allOf": [{ "$ref": format!("gts://{family}") }],
    })
}

/// Deterministic instance id from a stable composite key.
fn anon_id(parts: &[&str]) -> String {
    Uuid::new_v5(&INSTANCE_NS, parts.join("|").as_bytes()).to_string()
}

/// The repository node. `scope_key` is the project (or workspace for a
/// workspace-level source), so attaching the same connection/repository to
/// two Studio projects creates two independently scoped artifact graphs.
pub fn repo_node(
    scope_key: &str,
    connector_id: &str,
    provider: &str,
    repo_full_path: &str,
) -> GtsNode {
    GtsNode {
        type_id: REPO_TYPE,
        instance_id: anon_id(&[scope_key, connector_id, repo_full_path, "repo"]),
        value: json!({
            "connector_id": connector_id,
            "provider": provider,
            "full_path": repo_full_path,
        }),
    }
}

/// What a completed sync pulled for one repository — recorded on the repo node
/// so a reader can tell a never-synced source from a synced one without
/// counting its children.
#[derive(Debug, Clone, Copy, Default)]
pub struct RepoSyncStats {
    pub issues: usize,
    pub pull_requests: usize,
    pub files: usize,
    pub comments: usize,
    pub commits: usize,
    /// Unresolved review threads across the repository's open pull requests,
    /// or `None` when the provider cannot say.
    ///
    /// Absent rather than zero. A GitLab source has no answer here, and
    /// writing `0` would claim nothing is waiting on review — a different,
    /// and often wrong, statement. The key is simply omitted, so a reader
    /// distinguishes "none open" from "never asked".
    pub open_review_threads: Option<usize>,
    /// Unresolved comment threads the repository carries in `.studio/comments`,
    /// across every document — the conversation about the work, where
    /// `open_review_threads` is the conversation about the code under review.
    ///
    /// Absent when the sync had no checkout to read, for the same reason as its
    /// neighbour: a repository listed through a connector's tree API has no
    /// sidecars in hand, and `0` would claim it has none.
    pub open_document_threads: Option<usize>,
}

/// The repository node re-stated once a sync has finished: same instance id as
/// [`repo_node`], so it upserts over the record written when the sync started,
/// plus when it finished and what came in. This is the repository's sync status
/// as far as any reader is concerned.
pub fn repo_synced_node(
    scope_key: &str,
    connector_id: &str,
    provider: &str,
    repo_full_path: &str,
    synced_at: &str,
    stats: RepoSyncStats,
    waiting: &[Waiting],
) -> GtsNode {
    let mut node = repo_node(scope_key, connector_id, provider, repo_full_path);
    if let Some(obj) = node.value.as_object_mut() {
        obj.insert("synced_at".to_string(), json!(synced_at));
        obj.insert("issues".to_string(), json!(stats.issues));
        obj.insert("pull_requests".to_string(), json!(stats.pull_requests));
        obj.insert("files".to_string(), json!(stats.files));
        obj.insert("comments".to_string(), json!(stats.comments));
        obj.insert("commits".to_string(), json!(stats.commits));
        if let Some(open) = stats.open_review_threads {
            obj.insert("open_review_threads".to_string(), json!(open));
        }
        if let Some(open) = stats.open_document_threads {
            obj.insert("open_document_threads".to_string(), json!(open));
        }
        /*
         * Who those threads are waiting on, so a portal can answer "does this
         * project want something from me" without a checkout of its own. The
         * id is the author record's — `oidc:<subject>` for a signed-in person,
         * which is what a portal can match against whoever is looking.
         *
         * Written only when the sync had sidecars to read, and then even when
         * the list is empty: on a repository with a conversation, "nobody is
         * waiting" is an answer, while on one that was never read it is a
         * guess.
         */
        if stats.open_document_threads.is_some() {
            obj.insert(
                "waiting_on".to_string(),
                json!(
                    waiting
                        .iter()
                        .map(|person| json!({
                            "id": person.id,
                            "name": person.name,
                            "threads": person.threads,
                        }))
                        .collect::<Vec<_>>()
                ),
            );
        }
    }
    node
}

pub fn issue_node(
    scope_key: &str,
    repo_id: &str,
    connector_id: &str,
    repo_full_path: &str,
    i: RemoteIssue,
) -> GtsNode {
    GtsNode {
        type_id: ISSUE_TYPE,
        instance_id: anon_id(&[scope_key, connector_id, repo_full_path, "issue", &i.id]),
        value: json!({
            "repo": repo_id,
            "external_id": i.id,
            "number": i.number,
            "title": i.title,
            "state": i.state,
            "author": i.author,
            "body": i.body,
            "url": i.url,
            "labels": i.labels,
            "created_at": i.created_at,
            "updated_at": i.updated_at,
        }),
    }
}

pub fn file_node(
    scope_key: &str,
    repo_id: &str,
    connector_id: &str,
    repo_full_path: &str,
    f: RemoteFile,
) -> GtsNode {
    GtsNode {
        type_id: FILE_TYPE,
        instance_id: anon_id(&[scope_key, connector_id, repo_full_path, "file", &f.path]),
        value: json!({
            "repo": repo_id,
            "path": f.path,
            "sha": f.sha,
            "is_dir": f.is_dir,
            "size": f.size,
        }),
    }
}

/// A File node built from a real checkout on disk: same identity as the
/// tree-API node (keyed on path, so the two channels upsert the same instance),
/// but carrying the snapshot `commit` and whether the file `has_text`.
///
/// Not the text itself. What search needs of it is the file's content node
/// ([`file_content_node`]), so a listing of files stays a listing of paths.
///
/// `threads` is the conversation the repository carries about this file in
/// `.studio/comments/` (see [`super::comment_threads`]), and is `None` for a
/// file nobody has commented on. Absent rather than zero, for
/// `open_review_threads`'s reason: "no open threads" and "never commented on"
/// are different states, and a reader is entitled to tell them apart.
#[allow(clippy::too_many_arguments)]
pub fn file_node_cloned(
    scope_key: &str,
    repo_id: &str,
    connector_id: &str,
    repo_full_path: &str,
    path: &str,
    size: u64,
    has_text: bool,
    commit: Option<&str>,
    threads: Option<ThreadCounts>,
) -> GtsNode {
    let mut node = GtsNode {
        type_id: FILE_TYPE,
        instance_id: anon_id(&[scope_key, connector_id, repo_full_path, "file", path]),
        value: json!({
            "repo": repo_id,
            "path": path,
            "is_dir": false,
            "size": size,
            "commit": commit,
            "has_text": has_text,
        }),
    };
    if let (Some(counts), Some(obj)) = (threads, node.value.as_object_mut()) {
        obj.insert("open_threads".to_string(), json!(counts.open));
        obj.insert("resolved_threads".to_string(), json!(counts.resolved));
    }
    node
}

/// The instance id of a file's content node.
///
/// Derived from the file's own id, so whoever holds a file can name its
/// content without reading anything: the prune that forgets a file forgets
/// its content by this, and a re-sync upserts the same node.
pub fn file_content_instance_id(file_id: &str) -> String {
    anon_id(&[file_id, "content"])
}

/// The content node of `file`, or `None` when there is no text to search.
///
/// It carries `text`, which the graph backend bounds to a `text_excerpt` on
/// the way in (the ceiling lives with the store that has one), and enough of
/// the file to be read without it: `file` to map a search hit back, `path`
/// and `repo` to say which file it is. The scope fields are stamped on by the
/// batch that stamps the file's, so `node_in_scope` answers the same for both.
pub fn file_content_node(file: &GtsNode, text: &str) -> Option<GtsNode> {
    if text.trim().is_empty() {
        return None;
    }
    Some(GtsNode {
        type_id: FILE_CONTENT_TYPE,
        instance_id: file_content_instance_id(&file.instance_id),
        value: json!({
            "file": file.instance_id,
            "repo": file.value.get("repo"),
            "path": file.value.get("path"),
            "text": text,
        }),
    })
}

/// file_content → file.
pub fn content_of_edge(content_id: &str, file_id: &str) -> GtsEdge {
    GtsEdge {
        type_id: REL_CONTENT_OF,
        from: content_id.to_string(),
        to: file_id.to_string(),
    }
}

/// One pull request. `open_threads` is its unresolved review conversations,
/// or `None` when the provider does not report them and for a pull request
/// that is no longer open — nothing is waiting on a merged branch.
pub fn pull_request_node(
    scope_key: &str,
    repo_id: &str,
    connector_id: &str,
    repo_full_path: &str,
    p: RemotePullRequest,
    open_threads: Option<usize>,
) -> GtsNode {
    GtsNode {
        type_id: PULL_REQUEST_TYPE,
        instance_id: anon_id(&[
            scope_key,
            connector_id,
            repo_full_path,
            "pull_request",
            &p.id,
        ]),
        value: json!({
            "repo": repo_id,
            "external_id": p.id,
            "number": p.number,
            "title": p.title,
            "state": p.state,
            "author": p.author,
            "body": p.body,
            "url": p.url,
            "source_branch": p.source_branch,
            "target_branch": p.target_branch,
            "merged": p.merged,
            "open_threads": open_threads,
            "created_at": p.created_at,
            "updated_at": p.updated_at,
        }),
    }
}

/// A user node (issue/PR author). Keyed per source attachment and connection,
/// so the same login in two project graphs stays distinct. `title` mirrors the
/// login so the graph's node name is the handle.
pub fn user_node(scope_key: &str, connector_id: &str, provider: &str, login: &str) -> GtsNode {
    GtsNode {
        type_id: USER_TYPE,
        instance_id: anon_id(&[scope_key, connector_id, "user", login]),
        value: json!({
            "provider": provider,
            "login": login,
            "title": login,
        }),
    }
}

/// A comment on an issue or pull request. `title` is a short snippet so the
/// graph node name is readable; `body` carries the full text.
pub fn comment_node(
    scope_key: &str,
    repo_id: &str,
    connector_id: &str,
    repo_full_path: &str,
    c: RemoteComment,
) -> GtsNode {
    let snippet = c.body.as_deref().map(|b| {
        let s: String = b.chars().take(80).collect();
        if b.chars().count() > 80 {
            format!("{s}…")
        } else {
            s
        }
    });
    GtsNode {
        type_id: COMMENT_TYPE,
        instance_id: anon_id(&[scope_key, connector_id, repo_full_path, "comment", &c.id]),
        value: json!({
            "repo": repo_id,
            "external_id": c.id,
            "target_number": c.target_number,
            "author": c.author,
            "title": snippet,
            "body": c.body,
            "url": c.url,
            "created_at": c.created_at,
            "updated_at": c.updated_at,
        }),
    }
}

/// A commit node. `title` is the first line of the message (the subject line).
pub fn commit_node(
    scope_key: &str,
    repo_id: &str,
    connector_id: &str,
    repo_full_path: &str,
    c: RemoteCommit,
) -> GtsNode {
    let subject = c
        .message
        .as_deref()
        .map(|m| m.lines().next().unwrap_or("").to_string());
    let short_sha: String = c.sha.chars().take(7).collect();
    GtsNode {
        type_id: COMMIT_TYPE,
        instance_id: anon_id(&[scope_key, connector_id, repo_full_path, "commit", &c.sha]),
        value: json!({
            "repo": repo_id,
            "sha": c.sha,
            "short_sha": short_sha,
            "title": subject,
            "message": c.message,
            "author": c.author,
            "author_name": c.author_name,
            "url": c.url,
            "created_at": c.created_at,
        }),
    }
}

/// comment → issue / pull_request (the artifact the comment is on).
pub fn comment_on_edge(comment_id: &str, target_id: &str) -> GtsEdge {
    GtsEdge {
        type_id: REL_COMMENT_ON,
        from: comment_id.to_string(),
        to: target_id.to_string(),
    }
}

/// The instance id a File node has for `path` — so an edge can reference a file
/// without rebuilding its node (identity is keyed on path, same as `file_node`).
pub fn file_instance_id(
    scope_key: &str,
    connector_id: &str,
    repo_full_path: &str,
    path: &str,
) -> String {
    anon_id(&[scope_key, connector_id, repo_full_path, "file", path])
}

/// A user-uploaded or Studio-generated file node (no connector/repo). Bytes
/// remain in file-storage; this node carries hierarchy metadata and a durable
/// file/version reference. Repository-ingested file nodes use `file_node`
/// instead and never enter this path.
pub fn project_artifact_file_node(
    organization_id: &str,
    workspace_id: &str,
    project_id: &str,
    origin: &str,
    path: &str,
    size: u64,
    object_ref: Value,
) -> GtsNode {
    // A repeated upload of the same project/path creates a new immutable
    // file-storage version and updates this stable node's object_ref.
    GtsNode {
        type_id: FILE_TYPE,
        instance_id: anon_id(&[project_id, "project_artifact", path]),
        value: json!({
            "repo": project_id,
            "path": path,
            "is_dir": false,
            "size": size,
            "origin": origin,
            "organization_id": organization_id,
            "workspace_id": workspace_id,
            "project_id": project_id,
            "storage": "file-storage",
            "object_ref": object_ref,
            "has_text": false,
        }),
    }
}

/// issue / pull_request → repo.
pub fn artifact_of_edge(artifact_id: &str, repo_id: &str) -> GtsEdge {
    GtsEdge {
        type_id: REL_ARTIFACT_OF,
        from: artifact_id.to_string(),
        to: repo_id.to_string(),
    }
}

/// repo → file.
pub fn contains_edge(repo_id: &str, file_id: &str) -> GtsEdge {
    GtsEdge {
        type_id: REL_CONTAINS,
        from: repo_id.to_string(),
        to: file_id.to_string(),
    }
}

/// issue / pull_request → user (author).
pub fn authored_by_edge(artifact_id: &str, user_id: &str) -> GtsEdge {
    GtsEdge {
        type_id: REL_AUTHORED_BY,
        from: artifact_id.to_string(),
        to: user_id.to_string(),
    }
}

/// pull_request → file (a file it changed).
pub fn modifies_edge(pr_id: &str, file_id: &str) -> GtsEdge {
    GtsEdge {
        type_id: REL_MODIFIES,
        from: pr_id.to_string(),
        to: file_id.to_string(),
    }
}

// ── Spec-quality findings (materialized from detector results) ──

/// Deterministic finding instance id — idempotent per (detector, subject doc),
/// so re-running a detector upserts the same finding rather than duplicating.
pub fn spec_finding_instance_id(detector: &str, subject_id: &str) -> String {
    anon_id(&["spec_finding", detector, subject_id])
}

/// A spec-quality finding node about `subject_id` (a document node instance id).
/// `title` mirrors the summary so the graph node name reads as the verdict.
/// One detector's verdict on one document.
///
/// `recorded_at` is when this run produced it, not when the document changed.
/// The instance id is keyed on (detector, subject), so a re-run UPSERTS —
/// there is one finding per detector per document, and the timestamp is the
/// only thing that says how old the answer is. Without it a reader cannot
/// order two findings, tell a check from this morning from one from March, or
/// build a feed out of them at all.
#[allow(clippy::too_many_arguments)]
pub fn spec_finding_node(
    detector: &str,
    subject_id: &str,
    path: Option<&str>,
    severity: Option<&str>,
    summary: Option<&str>,
    score: Option<f64>,
    details: Value,
    recorded_at: &str,
) -> GtsNode {
    GtsNode {
        type_id: SPEC_FINDING_TYPE,
        instance_id: spec_finding_instance_id(detector, subject_id),
        value: json!({
            "detector": detector,
            "subject": subject_id,
            "path": path,
            "severity": severity,
            "title": summary,
            "summary": summary,
            "score": score,
            "details": details,
            "recorded_at": recorded_at,
        }),
    }
}

/// spec_finding → document (the document a finding is about).
pub fn finding_on_edge(finding_id: &str, subject_id: &str) -> GtsEdge {
    GtsEdge {
        type_id: REL_FINDING_ON,
        from: finding_id.to_string(),
        to: subject_id.to_string(),
    }
}

/// document ↔ document (bloat near-duplicate). Endpoints are ordered so the pair
/// upserts once regardless of which direction the caller sends.
pub fn duplicates_edge(a: &str, b: &str) -> GtsEdge {
    let (from, to) = if a <= b { (a, b) } else { (b, a) };
    GtsEdge {
        type_id: REL_DUPLICATES,
        from: from.to_string(),
        to: to.to_string(),
    }
}

/// document → document (a traceability link).
pub fn traces_to_edge(from: &str, to: &str) -> GtsEdge {
    GtsEdge {
        type_id: REL_TRACES_TO,
        from: from.to_string(),
        to: to.to_string(),
    }
}

#[cfg(test)]
mod tests {

    /// The classification pass names the node the walk is about to store, and
    /// it computes that name through [`file_instance_id`] rather than by
    /// repeating the key. If the two ever disagree, every binding points at a
    /// node that does not exist — silently, because a binding keeps working
    /// and simply never matches anything in the graph.
    #[test]
    fn the_file_key_is_the_same_whoever_asks_for_it() {
        let node = file_node_cloned(
            "scope",
            "repo-id",
            "connector",
            "acme/specs",
            "docs/adr/0007.md",
            42,
            true,
            Some("deadbeef"),
            None,
        );
        assert_eq!(
            node.instance_id,
            file_instance_id("scope", "connector", "acme/specs", "docs/adr/0007.md"),
        );
    }

    /// A file nobody has commented on carries no thread keys at all, and one
    /// that has been carries both.
    ///
    /// Absent rather than zero, for `open_review_threads`'s reason: a reader
    /// has to be able to tell "this document's conversation is settled" from
    /// "this document has never been discussed", and a `0` that means either
    /// says neither.
    #[test]
    fn thread_counts_are_absent_until_there_are_threads() {
        let plain = file_node_cloned(
            "scope",
            "repo-id",
            "connector",
            "acme/specs",
            "docs/prd.md",
            42,
            false,
            None,
            None,
        );
        assert!(plain.value.get("open_threads").is_none());
        assert!(plain.value.get("resolved_threads").is_none());

        let discussed = file_node_cloned(
            "scope",
            "repo-id",
            "connector",
            "acme/specs",
            "docs/prd.md",
            42,
            false,
            None,
            Some(ThreadCounts {
                open: 0,
                resolved: 3,
            }),
        );
        assert_eq!(discussed.value.get("open_threads"), Some(&json!(0)));
        assert_eq!(discussed.value.get("resolved_threads"), Some(&json!(3)));
    }

    /// And the tree-API node keys on the same thing, so a repository ingested
    /// both ways is one node per file rather than two.
    #[test]
    fn the_tree_and_the_clone_agree_on_a_files_identity() {
        let from_tree = file_node(
            "scope",
            "repo-id",
            "connector",
            "acme/specs",
            RemoteFile {
                path: "docs/adr/0007.md".to_string(),
                sha: "abc".to_string(),
                is_dir: false,
                size: Some(42),
            },
        );
        assert_eq!(
            from_tree.instance_id,
            file_instance_id("scope", "connector", "acme/specs", "docs/adr/0007.md"),
        );
    }

    use super::*;

    #[test]
    fn project_artifact_node_keeps_hierarchy_and_only_an_object_reference() {
        let object_ref = json!({
            "storage": "file-storage",
            "file_id": "0198af9a-77bc-7e01-b620-bb237979866b",
            "version_id": "0198af9a-77bc-7e01-b620-bb237979866c",
            "checksum": "sha256:abc123",
        });
        let node = project_artifact_file_node(
            "organization-1",
            "workspace-1",
            "project-1",
            "generated",
            "report.pdf",
            42,
            object_ref.clone(),
        );

        assert_eq!(node.value["organization_id"], "organization-1");
        assert_eq!(node.value["workspace_id"], "workspace-1");
        assert_eq!(node.value["project_id"], "project-1");
        assert_eq!(node.value["origin"], "generated");
        assert_eq!(node.value["storage"], "file-storage");
        assert_eq!(node.value["object_ref"], object_ref);
        assert!(node.value.get("text").is_none());
    }

    #[test]
    fn project_artifact_identity_is_stable_across_versions() {
        let first = project_artifact_file_node(
            "organization-1",
            "workspace-1",
            "project-1",
            "manual",
            "brief.md",
            1,
            json!({ "version_id": "version-1" }),
        );
        let second = project_artifact_file_node(
            "organization-1",
            "workspace-1",
            "project-1",
            "manual",
            "brief.md",
            2,
            json!({ "version_id": "version-2" }),
        );

        assert_eq!(first.instance_id, second.instance_id);
        assert_ne!(first.value["object_ref"], second.value["object_ref"]);
    }

    #[test]
    fn graph_type_ids_derive_from_a_family_and_round_trip() {
        let id = graph_type_id(FILE_TYPE);
        assert!(id.starts_with(OWNED_NODE_FAMILY), "{id}");
        assert!(id.ends_with("cf.studio.artifact.file.v1~"), "{id}");
        assert_eq!(our_type_from_graph(&id), Some(FILE_TYPE));
        assert!(graph_type_id(REL_CONTAINS).starts_with(STATIC_EDGE_FAMILY));
        assert_eq!(graph_node_type_schemas().len(), ALL_NODE_TYPES.len());
        assert_eq!(graph_edge_type_schemas().len(), ALL_EDGE_TYPES.len());
    }

    /// The file node is metadata only, and its text goes to a content node
    /// that names it, under an id anyone holding the file can compute.
    #[test]
    fn a_files_text_is_its_content_node_not_its_own() {
        let file = file_node_cloned(
            "scope",
            "repo-id",
            "connector",
            "acme/specs",
            "docs/prd.md",
            42,
            true,
            Some("deadbeef"),
            None,
        );
        assert!(file.value.get("text").is_none());
        assert!(file.value.get("text_excerpt").is_none());
        assert_eq!(file.value["has_text"], true);

        let content = file_content_node(&file, "# PRD").expect("text has a content node");
        assert_eq!(content.type_id, FILE_CONTENT_TYPE);
        assert_eq!(
            content.instance_id,
            file_content_instance_id(&file.instance_id)
        );
        assert_ne!(content.instance_id, file.instance_id);
        assert_eq!(content.value["file"], file.instance_id.as_str());
        assert_eq!(content.value["path"], "docs/prd.md");
        assert_eq!(content.value["repo"], "repo-id");
        assert_eq!(content.value["text"], "# PRD");

        assert!(file_content_node(&file, "  \n").is_none());
    }

    /// graph-storage refuses a changed schema under a registered id, and one
    /// refusal fails the whole batch. The file type's traits are therefore
    /// frozen as they were registered, excerpt path and all; only the new
    /// content type declares the narrower pair.
    #[test]
    fn the_file_type_keeps_the_traits_it_was_registered_with() {
        let schemas = graph_node_type_schemas();
        let traits = |our: &str| {
            let id = format!("gts://{}", graph_type_id(our));
            schemas
                .iter()
                .find(|s| s["$id"] == id.as_str())
                .map(|s| s["x-gts-traits"].clone())
                .expect("the type is registered")
        };
        assert_eq!(
            traits(FILE_TYPE),
            json!({ "full_text_search": FULL_TEXT_PATHS, "vector_search": VECTOR_PATHS })
        );
        assert_eq!(
            traits(FILE_CONTENT_TYPE),
            json!({ "full_text_search": CONTENT_PATHS, "vector_search": CONTENT_PATHS })
        );
        assert!(graph_type_id(REL_CONTENT_OF).starts_with(STATIC_EDGE_FAMILY));
    }

    #[test]
    fn repository_identity_is_independent_per_project_attachment() {
        let first = repo_node("project-a", "github-connection", "github", "acme/example");
        let second = repo_node("project-b", "github-connection", "github", "acme/example");

        assert_ne!(first.instance_id, second.instance_id);
        assert_eq!(first.value["full_path"], second.value["full_path"]);
    }
}

#[cfg(test)]
mod listable_type_tests {
    use super::*;

    #[test]
    fn default_lists_only_the_four_first_class_artifacts() {
        let t = resolve_listable_types(None);
        assert_eq!(
            t.len(),
            4,
            "default listing should expose exactly four types"
        );
        for want in [REPO_TYPE, FILE_TYPE, ISSUE_TYPE, PULL_REQUEST_TYPE] {
            assert!(t.contains(&want), "missing default type {want}");
        }
        assert!(
            !t.contains(&USER_TYPE),
            "user is graph detail, not listed by default"
        );
        assert!(
            !t.contains(&COMMIT_TYPE),
            "commit is graph detail, not listed by default"
        );
    }

    #[test]
    fn type_filter_matches_full_gts_id_and_bare_leaf() {
        assert_eq!(resolve_listable_types(Some(ISSUE_TYPE)), vec![ISSUE_TYPE]);
        assert_eq!(resolve_listable_types(Some("issue")), vec![ISSUE_TYPE]);
        assert_eq!(
            resolve_listable_types(Some(PULL_REQUEST_TYPE)),
            vec![PULL_REQUEST_TYPE]
        );
        assert_eq!(
            resolve_listable_types(Some("pull_request")),
            vec![PULL_REQUEST_TYPE]
        );
        assert!(
            resolve_listable_types(Some("does_not_exist")).is_empty(),
            "an unknown type lists nothing, not everything"
        );
    }
}
