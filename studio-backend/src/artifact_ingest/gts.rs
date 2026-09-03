//! GTS identifiers, type schemas and instance normalization for artifacts.
//!
//! Type ids and the free-form registration documents live here; the full
//! property schemas are in `studio-backend/gts/artifact/*.schema.json` (the
//! graph-store contract). Instance ids are deterministic (uuid5 of a stable
//! key) so re-syncing the same entity upserts rather than duplicates.

use serde_json::{Value, json};
use uuid::Uuid;

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

/// Every artifact node type, for registering and enumerating.
pub const ALL_NODE_TYPES: [&str; 8] = [
    REPO_TYPE,
    ISSUE_TYPE,
    PULL_REQUEST_TYPE,
    FILE_TYPE,
    USER_TYPE,
    SPEC_FINDING_TYPE,
    COMMENT_TYPE,
    COMMIT_TYPE,
];

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

/// Every relation type, for registering in the graph.
pub const ALL_EDGE_TYPES: [&str; 8] = [
    REL_ARTIFACT_OF,
    REL_CONTAINS,
    REL_AUTHORED_BY,
    REL_MODIFIES,
    REL_DUPLICATES,
    REL_TRACES_TO,
    REL_FINDING_ON,
    REL_COMMENT_ON,
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
const NODE_TYPE_DOCS: [(&str, &str, &str); 8] = [
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
];

/// GTS Type Schemas registered with the **platform types-registry** at gear
/// init. Declared free-form (`type: object`) — the same shape the studio types
/// use in `config/*.yaml` — so registration never trips the closed-envelope
/// narrowing check; the full property schemas live alongside as JSON files and
/// are the graph contract.
pub fn type_schemas() -> Vec<Value> {
    NODE_TYPE_DOCS
        .into_iter()
        .filter(|(id, _, _)| *id != USER_TYPE)
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
            schema["x-gts-traits"] = json!({
                "full_text_search": FULL_TEXT_PATHS,
                "vector_search": VECTOR_PATHS,
            });
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
/// but carrying the snapshot `commit` and, for text files, their `text`.
#[allow(clippy::too_many_arguments)]
pub fn file_node_cloned(
    scope_key: &str,
    repo_id: &str,
    connector_id: &str,
    repo_full_path: &str,
    path: &str,
    size: u64,
    text: Option<String>,
    commit: Option<&str>,
) -> GtsNode {
    GtsNode {
        type_id: FILE_TYPE,
        instance_id: anon_id(&[scope_key, connector_id, repo_full_path, "file", path]),
        value: json!({
            "repo": repo_id,
            "path": path,
            "is_dir": false,
            "size": size,
            "commit": commit,
            "has_text": text.is_some(),
            "text": text,
        }),
    }
}

pub fn pull_request_node(
    scope_key: &str,
    repo_id: &str,
    connector_id: &str,
    repo_full_path: &str,
    p: RemotePullRequest,
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
pub fn spec_finding_node(
    detector: &str,
    subject_id: &str,
    path: Option<&str>,
    severity: Option<&str>,
    summary: Option<&str>,
    score: Option<f64>,
    details: Value,
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

    #[test]
    fn repository_identity_is_independent_per_project_attachment() {
        let first = repo_node("project-a", "github-connection", "github", "acme/example");
        let second = repo_node("project-b", "github-connection", "github", "acme/example");

        assert_ne!(first.instance_id, second.instance_id);
        assert_eq!(first.value["full_path"], second.value["full_path"]);
    }
}
