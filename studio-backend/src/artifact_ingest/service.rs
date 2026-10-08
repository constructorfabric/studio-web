//! Ingest orchestration: connector source → normalized GTS nodes → graph store.
//!
//! Three channels feed the artifact graph: issues and pull requests (connector
//! API), and files. Files come from a real, shallow git clone into a mounted
//! volume when one is configured (`work_root`), so File nodes carry the actual
//! checkout — including text-file content; without a volume the pipeline falls
//! back to the connector's tree API (metadata only).
//!
//! A sync can take seconds (cloning), so it runs as a `artifact.ingest` run on
//! `studio-tasks` — see [`super::ingest_task`]. This service is the pipeline
//! only: it is handed a resolved token and a place to report progress, and the
//! connection is passed explicitly (`provider`, `base_url`, `connector_id`) so
//! it stays testable on its own.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::anyhow;
use credstore_sdk::{CredStoreClientV1, SecretRef};
use toolkit_security::SecurityContext;

use super::clone;
use super::comment_threads;
use super::graph::{GraphStore, GtsEdge, GtsNode};
use super::gts;
use crate::connectors::sdk::{ConnectionAuth, ConnectorDriver, PullRequestThreads};
use tracing::{info, warn};
use uuid::Uuid;

use crate::documents::port::{DocumentClassifier, IngestedDocument, is_prose_path};
use crate::tasks::sdk::SyncReporter;

/// Hard cap on pages per channel — a runaway loop backstop, not a real limit.
const MAX_PAGES: u32 = 50;
const PER_PAGE: u32 = 100;
/// Backstop on file nodes per sync, so a giant monorepo can't flood the graph.
const MAX_FILES: usize = 10_000;
/// Backstops on comment/commit nodes per sync — the same "don't flood the
/// graph" guard as files. Hitting one is logged (not silent truncation).
const MAX_COMMENTS: usize = 20_000;
const MAX_COMMITS: usize = 20_000;
/// How many open pull requests the review-thread query walks.
///
/// Not a flood guard — the query stores nothing per pull request beyond one
/// integer. It is a cost guard: each pull request asks for up to a hundred
/// threads, and a repository with more than two hundred open pull requests has
/// a review backlog no metric is going to summarise anyway.
const MAX_THREAD_PULLS: u32 = 200;
/// Chunk sizes for flushing to the graph store. graph-storage caps a single
/// ingest at ~10k nodes / 20k edges (and a per-payload ceiling), so we upsert
/// in bounded batches instead of one giant call — this also bounds memory and
/// makes a mid-sync failure partial rather than all-or-nothing.
///
/// Edges went from 5 000 to 1 000 per call: each call is one graph-storage
/// transaction held in this process, and at 5 000 the ingest of a large
/// repository was part of the peak that OOM-killed studio-dev's backend
/// (studio-web#561).
const NODE_CHUNK: usize = 1_000;
const EDGE_CHUNK: usize = 1_000;
/// The files whose text a sync reads: what it classifies, and the comment
/// logs it counts threads from. Everything else is listed by its path.
///
/// A sync used to read every text file, source included, and store an excerpt
/// of each in the graph for a search endpoint nothing called — on studio-dev
/// 19,950 content nodes, 136 MB with their embeddings (2026-10-05).
fn synced_text(path: &str) -> bool {
    is_prose_path(path) || comment_threads::is_sidecar(path)
}

/// The stored file nodes of ONE repository in ONE source scope whose path a
/// complete listing of that repository no longer has.
///
/// `repo_id` is enough to narrow to both at once: a file node's `repo` field
/// is its repository node's instance id, and that id is a uuid5 of the source
/// scope as well as the repository, so the same repository attached to two
/// projects is two ids and neither sync can reach the other's files. A node
/// with no `path` is left alone — nothing says it is gone.
///
/// `listed` is `None` unless the listing was COMPLETE, and then nothing is
/// gone. A failed walk reads as no files and a truncated one as fewer, and
/// believing either would forget files the repository still has — after a
/// failed clone, all of them.
fn gone_files<'a>(
    stored: &'a [GtsNode],
    repo_id: &str,
    listed: Option<&HashSet<String>>,
) -> Vec<&'a GtsNode> {
    let Some(listed) = listed else {
        return Vec::new();
    };
    stored
        .iter()
        .filter(|n| n.type_id == gts::FILE_TYPE)
        .filter(|n| n.value.get("repo").and_then(serde_json::Value::as_str) == Some(repo_id))
        .filter(|n| {
            n.value
                .get("path")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|path| !listed.contains(path))
        })
        .collect()
}

/// The content nodes that go with `gone` files.
///
/// Named rather than read: a content node's id is derived from its file's, so
/// finding them costs nothing, where listing them would be the heaviest walk
/// this gear has — it is where the excerpts went. Only a file that `has_text`
/// was given one. Asking for the others would not fail, but a retire is an
/// upsert, and for a key that was never written it would write one.
fn gone_contents(gone: &[GtsNode]) -> Vec<GtsNode> {
    gone.iter()
        .filter(|n| n.value.get("has_text").and_then(serde_json::Value::as_bool) == Some(true))
        .map(|n| GtsNode {
            type_id: gts::FILE_CONTENT_TYPE,
            instance_id: gts::file_content_instance_id(&n.instance_id),
            value: serde_json::Value::Null,
        })
        .collect()
}

/// A repository attachment a prune leaves alone: the connection and path a
/// sync of it is asked for.
#[derive(Debug, Clone)]
pub struct KeptRepo {
    pub connector_id: String,
    pub repo_full_path: String,
}

/// What a prune forgot.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct PruneSummary {
    /// Repository nodes.
    pub repos: usize,
    /// Their issues, pull requests, files, comments and commits.
    pub nodes: usize,
    /// Document bindings recorded against those files.
    pub bindings: usize,
}

/// True when a node was stored for exactly this attachment scope — the one a
/// sync with these ids stamps (see `store_node_batch`).
///
/// Exact, unlike the listing's `node_in_scope`: that one lets a workspace see
/// every project under it, which is right for reading and would be a disaster
/// for forgetting. A workspace-level prune must not reach into its projects.
fn in_attachment(
    value: &serde_json::Value,
    workspace_id: Option<&str>,
    project_id: Option<&str>,
) -> bool {
    let field = |key: &str| value.get(key).and_then(serde_json::Value::as_str);
    match (project_id, workspace_id) {
        (Some(project), _) => field("project_id") == Some(project),
        (None, Some(workspace)) => {
            field("workspace_id") == Some(workspace) && field("project_id").is_none()
        }
        (None, None) => field("workspace_id").is_none() && field("project_id").is_none(),
    }
}

/// What a sync has counted.
///
/// Reported live through the progress bridge as the sync runs, and again as the
/// run's final result when it finishes — one shape, so the poll endpoint reads
/// a half-finished sync and a completed one the same way.
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
pub struct SyncSummary {
    #[serde(default)]
    pub issues: usize,
    #[serde(default)]
    pub pull_requests: usize,
    #[serde(default)]
    pub files: usize,
    #[serde(default)]
    pub comments: usize,
    #[serde(default)]
    pub commits: usize,
    /// Unresolved review threads across the repository's open pull requests,
    /// or `None` when the provider cannot report them.
    ///
    /// Unlike its neighbours this is not a running total: it is the review
    /// state of the repository, read once before the pull-request walk and
    /// unchanged by it. It is therefore absent from the live progress ticks
    /// and present on the run's final result.
    #[serde(default)]
    pub open_review_threads: Option<usize>,
    /// Unresolved comment threads across the repository's own documents, or
    /// `None` when this sync had no checkout to read them from.
    ///
    /// Its neighbour above counts the conversation about the code under
    /// review; this counts the conversation about the work. Also not a running
    /// total, and so also absent from the progress ticks.
    #[serde(default)]
    pub open_document_threads: Option<usize>,
    /// Nodes already flushed to the graph store — the objects that are
    /// queryable right now, mid-sync.
    #[serde(default)]
    pub stored: usize,
    /// Files the graph held for this repository that its complete listing no
    /// longer has, forgotten by this sync. Zero after a partial listing, which
    /// forgets nothing. Like the thread counts, only on the final result.
    #[serde(default)]
    pub pruned: usize,
}

impl SyncSummary {
    /// This value as a progress detail. Infallible in practice — six integers
    /// always serialize — and an empty document rather than a panic if not.
    fn as_detail(self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_else(|_| serde_json::json!({}))
    }
}

pub struct IngestService {
    credstore: Arc<dyn CredStoreClientV1>,
    /// provider key (`github`, …) → driver.
    drivers: HashMap<String, Arc<dyn ConnectorDriver>>,
    graph: Arc<dyn GraphStore>,
    /// studio-documents, when that gear is running: a sync ends by asking it
    /// what the prose files it just read are. `None` leaves a repository
    /// ingested but unclassified, which is what a deployment without the
    /// documents database gets.
    classifier: Option<Arc<dyn DocumentClassifier>>,
    /// The studio-session workspaces root (`STUDIO_WORKSPACES_ROOT`). When a
    /// sync names a workspace + repo dir and the session gear has already
    /// cloned it here, ingest reads that checkout instead of cloning its own —
    /// one clone, always consistent with what the IDE shows.
    workspaces_root: Option<PathBuf>,
    /// Fallback own-clone volume (`STUDIO_ARTIFACT_WORKDIR`). `None` = no
    /// fallback clone → tree-API metadata when no workspace checkout exists.
    work_root: Option<PathBuf>,
}

/// One spec-quality finding to persist. Built by the portal from a detector
/// result; `subject` is the document node's instance id.
pub struct QualityFinding {
    pub detector: String,
    pub subject: String,
    pub path: Option<String>,
    pub severity: Option<String>,
    pub summary: Option<String>,
    pub score: Option<f64>,
    pub details: serde_json::Value,
}

/// A relation between two document nodes derived from a detector (bloat
/// duplicate / traceability link). Endpoints are node instance ids.
pub struct QualityLink {
    pub from: String,
    pub to: String,
}

/// Validated project-artifact metadata passed from the REST boundary to the
/// graph adapter. Keeping it as one value prevents hierarchy fields from being
/// accidentally reordered or omitted as the contract evolves.
pub struct ProjectArtifact<'a> {
    pub organization_id: &'a str,
    pub workspace_id: &'a str,
    pub project_id: &'a str,
    pub origin: &'a str,
    pub path: &'a str,
    pub size: u64,
    pub object_ref: serde_json::Value,
}

impl IngestService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        credstore: Arc<dyn CredStoreClientV1>,
        drivers: HashMap<String, Arc<dyn ConnectorDriver>>,
        graph: Arc<dyn GraphStore>,
        classifier: Option<Arc<dyn DocumentClassifier>>,
        workspaces_root: Option<PathBuf>,
        work_root: Option<PathBuf>,
    ) -> Self {
        Self {
            credstore,
            drivers,
            graph,
            classifier,
            workspaces_root,
            work_root,
        }
    }

    /// Resolve the connector token from credstore. Needs the request's security
    /// context, so it is done up front (in the handler) before a sync is spawned
    /// into the background.
    ///
    /// `Ok(None)` means the reference resolved to nothing this identity can
    /// read — removed, never stored, or out of scope. That is NOT an error
    /// here: a public repository syncs and clones perfectly well without
    /// credentials, and refusing the whole sync over a missing token turns a
    /// working public repo into a 500. The session gear made the same choice
    /// years-of-code earlier, logging `cloning without credentials` and
    /// carrying on; a private repository still fails, but with the provider's
    /// own 404/401 instead of ours.
    ///
    /// `Err` is reserved for the two cases a caller must treat differently: a
    /// malformed reference (a bug, permanent) and credstore itself being
    /// unreachable (transient, worth retrying).
    pub async fn resolve_token(
        &self,
        ctx: &SecurityContext,
        secret_ref: &str,
    ) -> anyhow::Result<Option<String>> {
        let key = SecretRef::new(secret_ref).map_err(|e| anyhow!("bad secret reference: {e}"))?;
        let Some(secret) = self
            .credstore
            .get(ctx, &key)
            .await
            .map_err(|e| anyhow!("credstore: {e}"))?
        else {
            return Ok(None);
        };
        String::from_utf8(secret.value.as_bytes().to_vec())
            .map(Some)
            .map_err(|_| anyhow!("stored token is not valid UTF-8"))
    }

    /// Pull issues + PRs + files for one repository and upsert them into the
    /// graph, reporting each phase (and the counts so far) to `progress`.
    #[allow(clippy::too_many_arguments)]
    pub async fn run_sync(
        &self,
        ctx: &SecurityContext,
        provider: &str,
        base_url: Option<&str>,
        connector_id: &str,
        repo_full_path: &str,
        since: Option<&str>,
        token: &str,
        workspace_id: Option<&str>,
        project_id: Option<&str>,
        repo_dir: Option<&str>,
        progress: &SyncReporter,
    ) -> anyhow::Result<SyncSummary> {
        let driver = self
            .drivers
            .get(provider)
            .ok_or_else(|| anyhow!("no driver for provider '{provider}' (plugin not linked?)"))?;

        let base_url = match base_url.map(str::trim).filter(|s| !s.is_empty()) {
            Some(b) => b.to_string(),
            None => driver.default_base_url().to_string(),
        };
        let auth = ConnectionAuth {
            base_url: base_url.clone(),
            token: token.to_string(),
        };

        // What the walk turns up, kept for the classification pass at the end.
        //
        // Every file, not only the prose — but a non-prose one carries no
        // content, because the verdict for it is its path. Copying a
        // repository's source bytes to be told what its own extensions already
        // say would still be the expensive way to learn nothing; sending the
        // path is what lets the classifier RECORD the answer instead of
        // silently dropping the file, which left it reading as "not scanned"
        // on the Specs screen forever.
        //
        // Still only from a checkout: a tree-API sync has no text to offer at
        // all, so it has nothing to classify.
        let mut scanned: Vec<IngestedDocument> = Vec::new();

        let mut nodes: Vec<GtsNode> = Vec::new();
        // Relations between the nodes, and the author nodes they reference.
        // `pr_refs` and `file_paths` are collected so PR→file (`modifies`) edges
        // can be built once both PRs and the file set are known.
        let mut edges: Vec<GtsEdge> = Vec::new();
        let mut users: HashMap<String, GtsNode> = HashMap::new();
        let mut pr_refs: Vec<(i64, String)> = Vec::new();
        let mut file_paths: HashSet<String> = HashSet::new();
        // issue/PR number → its node instance id, so a comment (which only knows
        // the number it is on) can be linked to the right artifact node.
        let mut by_number: HashMap<i64, String> = HashMap::new();
        // The same connector/repository may be attached to more than one
        // Studio project. Include that attachment scope in every deterministic
        // graph key so a sync in one project cannot overwrite the other.
        let source_scope = project_id.or(workspace_id).unwrap_or("unscoped");

        // Link an issue/PR to its author: intern a user node and add an
        // authored_by edge. No-op when the author is unknown.
        let author_edge = |edges: &mut Vec<GtsEdge>,
                           users: &mut HashMap<String, GtsNode>,
                           artifact_id: &str,
                           author: Option<&str>| {
            if let Some(login) = author.map(str::trim).filter(|s| !s.is_empty()) {
                let u = gts::user_node(source_scope, connector_id, provider, login);
                edges.push(gts::authored_by_edge(artifact_id, &u.instance_id));
                users.entry(u.instance_id.clone()).or_insert(u);
            }
        };

        let repo = gts::repo_node(source_scope, connector_id, provider, repo_full_path);
        let repo_id = repo.instance_id.clone();
        nodes.push(repo);

        // How many nodes this sync has stored so far. `nodes` holds only the
        // ones not stored yet: every flush writes them and empties it, so a
        // sync never keeps a repository's worth of nodes -- file text included
        // -- in memory at once (studio-web#561). Flush the repo node right away.
        let mut flushed = 0usize;
        self.flush_and_report(
            ctx,
            progress,
            &mut nodes,
            &mut flushed,
            workspace_id,
            project_id,
            "pulling issues…",
            0,
            0,
            0,
            0,
            0,
        )
        .await?;

        progress.set("pulling issues…");
        let mut issues = 0usize;
        for page in 1..=MAX_PAGES {
            let batch = driver
                .list_issues(&auth, repo_full_path, since, page, PER_PAGE)
                .await?;
            if batch.is_empty() {
                break;
            }
            issues += batch.len();
            for i in batch {
                let author = i.author.clone();
                let number = i.number;
                let node = gts::issue_node(source_scope, &repo_id, connector_id, repo_full_path, i);
                edges.push(gts::artifact_of_edge(&node.instance_id, &repo_id));
                author_edge(&mut edges, &mut users, &node.instance_id, author.as_deref());
                by_number.insert(number, node.instance_id.clone());
                nodes.push(node);
            }
            // Flush this page of issues immediately — they show up in the graph
            // (and the live count climbs) before the whole sync completes.
            self.flush_and_report(
                ctx,
                progress,
                &mut nodes,
                &mut flushed,
                workspace_id,
                project_id,
                "pulling issues…",
                issues,
                0,
                0,
                0,
                0,
            )
            .await?;
        }

        // Review threads before the pull requests themselves: the count belongs
        // ON each pull-request node, so it has to be in hand before the nodes
        // are built. Best-effort — a provider that cannot answer, or one that
        // errors, leaves the metric unset and costs the sync nothing else.
        progress.set("reading review threads…");
        let threads = match driver
            .open_review_threads(&auth, repo_full_path, MAX_THREAD_PULLS)
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    repo = repo_full_path,
                    "studio-artifact-ingest: review threads unavailable — metric left unset"
                );
                None
            }
        };
        // Set by the checkout walk below, which is the only place that can
        // know: the sidecars are files in the repository.
        let mut open_document_threads: Option<usize> = None;
        let open_review_threads = threads
            .as_ref()
            .map(|list| list.iter().map(|t| t.open).sum::<usize>());
        let threads_by_number: HashMap<i64, PullRequestThreads> = threads
            .into_iter()
            .flatten()
            .map(|t| (t.number, t))
            .collect();

        progress.set("pulling pull requests…");
        let mut pull_requests = 0usize;
        for page in 1..=MAX_PAGES {
            let batch = driver
                .list_pull_requests(&auth, repo_full_path, since, page, PER_PAGE)
                .await?;
            if batch.is_empty() {
                break;
            }
            pull_requests += batch.len();
            for p in batch {
                let author = p.author.clone();
                let number = p.number;
                // Only an open pull request has threads and reviews worth
                // reading; a merged one is nobody's queue, so they stay unset
                // rather than being reported as none.
                let review = threads_by_number.get(&number);
                // Everyone asked to review it, everyone who did, and everyone
                // it is assigned to, each as an account in the graph. The edges
                // only ever accumulate (a re-sync upserts); who is owed what
                // NOW is on the node.
                let mut reviewers: Vec<String> = p.requested_reviewers.clone();
                reviewers.extend(
                    review
                        .iter()
                        .flat_map(|r| r.reviews.iter().map(|rv| rv.login.clone())),
                );
                let assignees = p.assignees.clone();
                let node = gts::pull_request_node(
                    source_scope,
                    &repo_id,
                    connector_id,
                    repo_full_path,
                    p,
                    review,
                );
                let pr_id = node.instance_id.clone();
                edges.push(gts::artifact_of_edge(&pr_id, &repo_id));
                author_edge(&mut edges, &mut users, &pr_id, author.as_deref());
                for (logins, edge) in [
                    (
                        reviewers,
                        gts::reviewed_by_edge as fn(&str, &str) -> GtsEdge,
                    ),
                    (assignees, gts::assigned_to_edge),
                ] {
                    let mut seen = HashSet::new();
                    for login in logins.iter().map(|l| l.trim()).filter(|l| !l.is_empty()) {
                        if !seen.insert(login.to_lowercase()) {
                            continue;
                        }
                        let u = gts::user_node(source_scope, connector_id, provider, login);
                        edges.push(edge(&pr_id, &u.instance_id));
                        users.entry(u.instance_id.clone()).or_insert(u);
                    }
                }
                by_number.insert(number, pr_id.clone());
                pr_refs.push((number, pr_id));
                nodes.push(node);
            }
            self.flush_and_report(
                ctx,
                progress,
                &mut nodes,
                &mut flushed,
                workspace_id,
                project_id,
                "pulling pull requests…",
                issues,
                pull_requests,
                0,
                0,
                0,
            )
            .await?;
        }

        // Files come from, in order of preference:
        //   1. the studio-session workspace checkout, if the IDE already cloned
        //      it — one shared clone, always what the IDE shows;
        //   2. our own shallow clone, if a fallback volume is configured;
        //   3. the connector tree API (metadata only).
        // Best-effort: a failure here never discards the issue/PR nodes.
        let mut files = 0usize;
        // Whether `file_paths` ends up holding EVERY file the repository has.
        // Only then may the sync forget the ones it used to have: each failure
        // below reads as an empty or short listing, and forgetting against one
        // of those would wipe the repository's files from the graph.
        let mut listing_complete = false;
        // The IDE materializes each repo under the tenant that opened Studio —
        // the project tenant when opened from a project. Prefer `project_id`
        // for the checkout path; fall back to `workspace_id` for a
        // workspace-level open.
        let on_disk: Option<(PathBuf, clone::Walk, Option<String>)> = if let Some(dir) =
            self.shared_checkout_dir(project_id.or(workspace_id), repo_dir)
        {
            progress.set("reading workspace files…");
            let (username, password) = driver.clone_credentials(token);
            match self
                .walk_shared_checkout(dir, username.to_string(), password.to_string())
                .await
            {
                Ok(v) => Some(v),
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        repo = repo_full_path,
                        "studio-artifact-ingest: reading the workspace checkout failed — skipping files"
                    );
                    // An incomplete walk, so nothing is forgotten over it.
                    Some((PathBuf::new(), clone::Walk::default(), None))
                }
            }
        } else if let Some(work_root) = self.work_root.clone() {
            progress.set("cloning repository…");
            match self
                .clone_files(
                    driver,
                    work_root,
                    connector_id,
                    repo_full_path,
                    &base_url,
                    token,
                )
                .await
            {
                Ok(v) => Some(v),
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        repo = repo_full_path,
                        "studio-artifact-ingest: clone failed — skipping files"
                    );
                    // An incomplete walk, so nothing is forgotten over it.
                    Some((PathBuf::new(), clone::Walk::default(), None))
                }
            }
        } else {
            None
        };

        // The conversation the repository carries about its own documents.
        //
        // Read from the same walk, before anything is consumed from it: the
        // sidecars and the documents they belong to are both ordinary files in
        // this list, and a count has to be in hand before the document's node
        // is built. `None` when there was no checkout — a repository listed
        // through a connector's tree API has no sidecars to read, and claiming
        // it has no threads would be a different statement from not knowing.
        let mut threads = comment_threads::RepositoryThreads::default();
        if let Some((_, walk, _)) = on_disk.as_ref() {
            threads = comment_threads::fold_repository(
                walk.files
                    .iter()
                    .filter_map(|wf| wf.text.as_deref().map(|text| (wf.path.as_str(), text))),
            );
            open_document_threads =
                Some(threads.documents.values().map(|counts| counts.open).sum());
        }

        // Content nodes an earlier sync of this repository wrote, to retire
        // once its files are rewritten without them. Read before the walk
        // rewrites them, since `has_text` is how a file says it had one.
        let legacy_contents = self.legacy_contents(ctx, source_scope, &repo_id).await;

        match on_disk {
            Some((_dir, walk, commit)) => {
                // The walk stops at the same cap, and says so when it does.
                listing_complete = walk.complete && walk.files.len() <= MAX_FILES;
                for wf in walk.files.into_iter().take(MAX_FILES) {
                    files += 1;
                    let file_id =
                        gts::file_instance_id(source_scope, connector_id, repo_full_path, &wf.path);
                    edges.push(gts::contains_edge(&repo_id, &file_id));
                    file_paths.insert(wf.path.clone());
                    // The graph keeps what a file is, not what it says: the
                    // text stays in the checkout, where everything that reads
                    // a document (the classifier, Spec Quality, the editor)
                    // reads it.
                    nodes.push(gts::file_node_cloned(
                        source_scope,
                        &repo_id,
                        connector_id,
                        repo_full_path,
                        &wf.path,
                        wf.size,
                        commit.as_deref(),
                        threads.documents.get(&wf.path).copied(),
                    ));
                    // What the classifier reads, moved rather than copied.
                    if is_prose_path(&wf.path) {
                        if let Some(content) = wf.text {
                            scanned.push(IngestedDocument {
                                node_id: file_id.clone(),
                                path: wf.path.clone(),
                                content,
                            });
                        }
                        // Prose the walk could not read is left alone rather
                        // than called undetermined: nothing has looked at it.
                    } else {
                        scanned.push(IngestedDocument {
                            node_id: file_id.clone(),
                            path: wf.path.clone(),
                            content: String::new(),
                        });
                    }
                    // Store the files as the walk goes rather than after it,
                    // so their nodes and content leave memory a chunk at a time.
                    if nodes.len() >= NODE_CHUNK {
                        self.flush_and_report(
                            ctx,
                            progress,
                            &mut nodes,
                            &mut flushed,
                            workspace_id,
                            project_id,
                            "reading files…",
                            issues,
                            pull_requests,
                            files,
                            0,
                            0,
                        )
                        .await?;
                    }
                }
            }
            None => {
                // No checkout available — fall back to connector metadata.
                progress.set("listing files…");
                match driver.list_files(&auth, repo_full_path, None).await {
                    Ok(listing) => {
                        let blobs: Vec<_> =
                            listing.files.into_iter().filter(|f| !f.is_dir).collect();
                        listing_complete = !listing.truncated && blobs.len() <= MAX_FILES;
                        for f in blobs.into_iter().take(MAX_FILES) {
                            files += 1;
                            let path = f.path.clone();
                            let file_id = gts::file_instance_id(
                                source_scope,
                                connector_id,
                                repo_full_path,
                                &path,
                            );
                            edges.push(gts::contains_edge(&repo_id, &file_id));
                            file_paths.insert(path);
                            nodes.push(gts::file_node(
                                source_scope,
                                &repo_id,
                                connector_id,
                                repo_full_path,
                                f,
                            ));
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            repo = repo_full_path,
                            "studio-artifact-ingest: file listing failed — skipping files"
                        );
                    }
                }
            }
        }

        // Decide what every file is, now, while the whole repository's text is
        // in hand. Doing it here rather than on someone pressing a button later
        // is the difference between a synced repository whose documents are
        // known and one that merely has files in it.
        //
        // It never fails the sync. The repository is ingested either way, and
        // the pass is idempotent, so a failure costs a re-run of the cheap half
        // rather than the clone.
        if let (Some(classifier), Some(workspace)) = (
            self.classifier.as_ref(),
            workspace_id.and_then(|w| Uuid::parse_str(w).ok()),
        ) && !scanned.is_empty()
        {
            let count = scanned.len();
            progress.set(format!("classifying {count} file(s)…"));
            let project = project_id.and_then(|p| Uuid::parse_str(p).ok());
            match classifier
                .classify_ingested(ctx, workspace, project, std::mem::take(&mut scanned))
                .await
            {
                Ok(counts) => info!(
                    classified = counts.classified,
                    not_documents = counts.not_documents,
                    kept = counts.kept,
                    changed_documents = counts.changed_documents,
                    analyses_queued = counts.analyses_queued,
                    repo = repo_full_path,
                    "studio-artifact-ingest: files classified"
                ),
                Err(e) => warn!(
                    error = %e,
                    repo = repo_full_path,
                    "studio-artifact-ingest: classification failed; the repository is ingested but its documents are unidentified"
                ),
            }
        }

        // Flush the file nodes gathered from the checkout/tree before deriving
        // PR→file links (those are edges, whose endpoints must already exist).
        self.flush_and_report(
            ctx,
            progress,
            &mut nodes,
            &mut flushed,
            workspace_id,
            project_id,
            "reading files…",
            issues,
            pull_requests,
            files,
            0,
            0,
        )
        .await?;

        // The excerpts the files above no longer have. Best-effort, like the
        // prune below: a failure leaves them for the next sync, and costs
        // nothing but the space they already took.
        if !legacy_contents.is_empty() {
            match self.graph.delete_nodes(ctx, &legacy_contents).await {
                Ok(retired) => info!(
                    retired,
                    repo = repo_full_path,
                    "studio-artifact-ingest: retired the file excerpts an earlier sync stored"
                ),
                Err(e) => warn!(
                    error = %e,
                    repo = repo_full_path,
                    "studio-artifact-ingest: could not retire stored file excerpts; the next sync retries"
                ),
            }
        }

        // Forget what the repository no longer has. Everything above only
        // ever adds, so a file deleted or moved away stayed in the graph — and
        // stayed a document on the Specs screen — however often the repository
        // was re-synced.
        progress.set("forgetting deleted files…");
        let pruned = self
            .prune_gone_files(
                ctx,
                &repo_id,
                listing_complete.then_some(&file_paths),
                workspace_id,
                project_id,
                repo_full_path,
            )
            .await;

        // PR → file (`modifies`): one API call per PR, best-effort, and only for
        // files we actually ingested so every edge endpoint exists in the graph.
        if !pr_refs.is_empty() && !file_paths.is_empty() {
            progress.set("linking pull requests to files…");
            for (number, pr_id) in &pr_refs {
                match driver
                    .pull_request_files(&auth, repo_full_path, *number)
                    .await
                {
                    Ok(paths) => {
                        for path in paths {
                            if file_paths.contains(&path) {
                                let file_id = gts::file_instance_id(
                                    source_scope,
                                    connector_id,
                                    repo_full_path,
                                    &path,
                                );
                                edges.push(gts::modifies_edge(pr_id, &file_id));
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            repo = repo_full_path,
                            pr = number,
                            "studio-artifact-ingest: PR file listing failed — skipping its links"
                        );
                    }
                }
            }
        }

        // Comments on issues and PRs. Best-effort and paged; each links to the
        // issue/PR node by number (`comment_on`) and to its author.
        progress.set("pulling comments…");
        let mut comments = 0usize;
        for page in 1..=MAX_PAGES {
            let batch = match driver
                .list_comments(&auth, repo_full_path, since, page, PER_PAGE)
                .await
            {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        repo = repo_full_path,
                        "studio-artifact-ingest: comment listing failed — skipping comments"
                    );
                    break;
                }
            };
            if batch.is_empty() {
                break;
            }
            comments += batch.len();
            for c in batch {
                let author = c.author.clone();
                let target = by_number.get(&c.target_number).cloned();
                let node =
                    gts::comment_node(source_scope, &repo_id, connector_id, repo_full_path, c);
                let comment_id = node.instance_id.clone();
                if let Some(target_id) = target {
                    edges.push(gts::comment_on_edge(&comment_id, &target_id));
                }
                author_edge(&mut edges, &mut users, &comment_id, author.as_deref());
                nodes.push(node);
            }
            self.flush_and_report(
                ctx,
                progress,
                &mut nodes,
                &mut flushed,
                workspace_id,
                project_id,
                "pulling comments…",
                issues,
                pull_requests,
                files,
                comments,
                0,
            )
            .await?;
            if comments >= MAX_COMMENTS {
                tracing::warn!(
                    repo = repo_full_path,
                    cap = MAX_COMMENTS,
                    "studio-artifact-ingest: comment cap reached — remaining comments not ingested"
                );
                break;
            }
        }

        // Commits. Best-effort and paged; each links to the repo (`artifact_of`)
        // and to its author. Commit→file links are deferred (one extra call per
        // commit — see the batching plan).
        progress.set("pulling commits…");
        let mut commits = 0usize;
        for page in 1..=MAX_PAGES {
            let batch = match driver
                .list_commits(&auth, repo_full_path, since, page, PER_PAGE)
                .await
            {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        repo = repo_full_path,
                        "studio-artifact-ingest: commit listing failed — skipping commits"
                    );
                    break;
                }
            };
            if batch.is_empty() {
                break;
            }
            commits += batch.len();
            for c in batch {
                let author = c.author.clone();
                let node =
                    gts::commit_node(source_scope, &repo_id, connector_id, repo_full_path, c);
                let commit_id = node.instance_id.clone();
                edges.push(gts::artifact_of_edge(&commit_id, &repo_id));
                author_edge(&mut edges, &mut users, &commit_id, author.as_deref());
                nodes.push(node);
            }
            self.flush_and_report(
                ctx,
                progress,
                &mut nodes,
                &mut flushed,
                workspace_id,
                project_id,
                "pulling commits…",
                issues,
                pull_requests,
                files,
                comments,
                commits,
            )
            .await?;
            if commits >= MAX_COMMITS {
                tracing::warn!(
                    repo = repo_full_path,
                    cap = MAX_COMMITS,
                    "studio-artifact-ingest: commit cap reached — remaining commits not ingested"
                );
                break;
            }
        }
        tracing::info!(
            repo = repo_full_path,
            comments,
            commits,
            "studio-artifact-ingest: pulled comments and commits"
        );

        // Author nodes discovered along the way join the batch, then a final
        // flush stores them plus anything appended since the last page. Node
        // tenant-tagging happens inside `store_node_batch`, so every flushed
        // batch is already scoped (see rest.rs `scope`).
        nodes.extend(users.into_values());
        progress.set("storing…");
        self.flush_and_report(
            ctx,
            progress,
            &mut nodes,
            &mut flushed,
            workspace_id,
            project_id,
            "storing…",
            issues,
            pull_requests,
            files,
            comments,
            commits,
        )
        .await?;

        // Stamp the sync onto the repository node — same instance id, so this
        // upserts over the record written when the sync started. A reader (the
        // project dashboard) then sees "last synced <when>, <what came in>"
        // instead of having to infer it from the presence of child nodes.
        let synced_at = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        nodes.push(gts::repo_synced_node(
            source_scope,
            connector_id,
            provider,
            repo_full_path,
            &synced_at,
            gts::RepoSyncStats {
                issues,
                pull_requests,
                files,
                comments,
                commits,
                open_review_threads,
                open_document_threads,
            },
            &threads.waiting,
        ));
        self.flush_and_report(
            ctx,
            progress,
            &mut nodes,
            &mut flushed,
            workspace_id,
            project_id,
            "storing…",
            issues,
            pull_requests,
            files,
            comments,
            commits,
        )
        .await?;

        // Relations last — every endpoint node is now stored. Additive: a
        // rejected edge chunk is logged and skipped (its nodes are already
        // stored and the sync still succeeds) rather than failing the whole job.
        let (total_nodes, total_edges) = (flushed, edges.len());
        let mut edge_errors = 0usize;
        for chunk in edges.chunks(EDGE_CHUNK) {
            if let Err(e) = self.graph.upsert_edges(ctx, chunk).await {
                edge_errors += chunk.len();
                tracing::warn!(
                    error = %e,
                    repo = repo_full_path,
                    chunk = chunk.len(),
                    "studio-artifact-ingest: edge chunk upsert failed — skipped"
                );
            }
        }
        tracing::info!(
            repo = repo_full_path,
            nodes = total_nodes,
            edges = total_edges,
            edge_errors,
            node_chunk = NODE_CHUNK,
            edge_chunk = EDGE_CHUNK,
            "studio-artifact-ingest: stored graph (chunked)"
        );

        // Only now, with this attachment fully stored: an older attachment of
        // the same repository is still the better answer until then. Never
        // fails the sync — what is left is found again by the next one.
        progress.set("forgetting older copies…");
        if let Err(e) = self
            .prune_superseded(ctx, workspace_id, project_id, &repo_id, repo_full_path)
            .await
        {
            warn!(
                error = %e,
                repo = repo_full_path,
                "studio-artifact-ingest: could not forget an older attachment of this repository"
            );
        }

        Ok(SyncSummary {
            issues,
            pull_requests,
            files,
            comments,
            commits,
            open_review_threads,
            open_document_threads,
            stored: total_nodes,
            pruned,
        })
    }

    /// Clone (or update) the repository on a blocking thread, then walk it.
    async fn clone_files(
        &self,
        driver: &Arc<dyn ConnectorDriver>,
        work_root: PathBuf,
        connector_id: &str,
        repo_full_path: &str,
        base_url: &str,
        token: &str,
    ) -> anyhow::Result<(PathBuf, clone::Walk, Option<String>)> {
        let clone_url = driver.clone_url(base_url, repo_full_path)?;
        let (username, password) = driver.clone_credentials(token);
        let username = username.to_string();
        let password = password.to_string();
        let connector_id = connector_id.to_string();
        let repo = repo_full_path.to_string();

        tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let res = clone::clone_or_update(
                &work_root,
                &connector_id,
                &repo,
                &clone_url,
                &username,
                &password,
                None,
            )?;
            let walked = clone::walk(&res.dir, &synced_text)?;
            Ok((res.dir, walked, res.commit))
        })
        .await
        .map_err(|e| anyhow!("clone task did not finish: {e}"))?
    }

    /// The studio-session checkout for this repo, if it exists on disk:
    /// `{workspaces_root}/{workspace_id}/{repo_dir}`. This is the same working
    /// copy the IDE bind-mounts — reading it means one shared clone. Returns
    /// `None` when nothing names a workspace, no root is configured, the path is
    /// unsafe, or the checkout has not been materialized yet (IDE not opened).
    fn shared_checkout_dir(
        &self,
        workspace_id: Option<&str>,
        repo_dir: Option<&str>,
    ) -> Option<PathBuf> {
        let root = self.workspaces_root.as_ref()?;
        let ws = workspace_id.map(str::trim).filter(|s| !s.is_empty())?;
        let dir = repo_dir.map(str::trim).filter(|s| !s.is_empty())?;
        // Path-traversal guard: the workspace id is a uuid (no separators), and
        // the repo dir may nest (`a/b`) but never escape.
        if ws.contains('/') || ws.contains('\\') || ws.contains("..") {
            return None;
        }
        if dir
            .split(['/', '\\'])
            .any(|seg| seg.is_empty() || seg == "..")
        {
            return None;
        }
        let path = root.join(ws).join(dir);
        path.is_dir().then_some(path)
    }

    /// Re-sync: pull the shared checkout up to the remote
    /// (`clone::update_shared_checkout`, a fast-forward only when nothing would
    /// be lost), then read it. A failed fetch -- no network, no credential --
    /// reads the checkout as it stands and says so, which is no worse than
    /// before.
    async fn walk_shared_checkout(
        &self,
        dir: PathBuf,
        username: String,
        password: String,
    ) -> anyhow::Result<(PathBuf, clone::Walk, Option<String>)> {
        tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            match clone::update_shared_checkout(&dir, &username, &password) {
                Ok(clone::CheckoutUpdate::Advanced { from, to }) => tracing::info!(
                    dir = %dir.display(), %from, %to,
                    "studio-artifact-ingest: pulled the shared checkout up to the remote"
                ),
                Ok(clone::CheckoutUpdate::Kept { reason }) => tracing::warn!(
                    dir = %dir.display(), %reason,
                    "studio-artifact-ingest: shared checkout not updated — reading it as it stands"
                ),
                Ok(clone::CheckoutUpdate::Current) => {}
                Err(e) => tracing::warn!(
                    error = %e, dir = %dir.display(),
                    "studio-artifact-ingest: could not fetch the shared checkout's branch — reading it as it stands"
                ),
            }
            let commit = clone::head_commit(&dir);
            let walked = clone::walk(&dir, &synced_text)?;
            Ok((dir, walked, commit))
        })
        .await
        .map_err(|e| anyhow!("workspace read did not finish: {e}"))?
    }

    /// Walk an existing checkout on a blocking thread (no clone), reading text
    /// content, and capture its HEAD commit.
    async fn walk_checkout(
        &self,
        dir: PathBuf,
    ) -> anyhow::Result<(PathBuf, clone::Walk, Option<String>)> {
        tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let commit = clone::head_commit(&dir);
            let walked = clone::walk(&dir, &|_| true)?;
            Ok((dir, walked, commit))
        })
        .await
        .map_err(|e| anyhow!("workspace read did not finish: {e}"))?
    }

    /// The content nodes earlier syncs stored beside this repository's files,
    /// named by the files that still say they have one.
    ///
    /// Read from the index (one query), and empty once a sync has rewritten
    /// every file: a file node written since carries no `has_text`. When no
    /// stored repository has any left, this and its call can go.
    async fn legacy_contents(
        &self,
        ctx: &SecurityContext,
        scope: &str,
        repo_id: &str,
    ) -> Vec<GtsNode> {
        match self
            .graph
            .list_in_scope(ctx, Some(gts::FILE_TYPE), scope)
            .await
        {
            Ok(files) => {
                let ours: Vec<GtsNode> = files
                    .into_iter()
                    .filter(|n| {
                        n.value.get("repo").and_then(serde_json::Value::as_str) == Some(repo_id)
                    })
                    .collect();
                gone_contents(&ours)
            }
            Err(e) => {
                warn!(error = %e, "studio-artifact-ingest: could not read the stored files; their excerpts stay for the next sync");
                Vec::new()
            }
        }
    }

    /// Forget the files the graph holds for this repository that a complete
    /// listing no longer has: their document bindings, then their content
    /// nodes, then their own. Returns how many files were forgotten.
    ///
    /// Best-effort, like every other phase after the issues and pull requests:
    /// a failure is a warning and forgets nothing more, and the next sync
    /// computes the same set again and retries.
    ///
    /// Bindings go first. A binding whose node is gone cannot be found again —
    /// the stale set is read from the graph, and a forgotten node is no longer
    /// in it — so if the documents gear refuses, the nodes are kept for the
    /// next sync to try both. The reverse failure is harmless: a node whose
    /// bindings are already gone is simply forgotten on the next attempt.
    ///
    /// It reads the whole file projection to do this. That read is the cost of
    /// graph-storage not filtering on payload fields (see [`GraphStore::list`]),
    /// and it is paid once per sync, after the file flush has already dropped
    /// the cached projection.
    async fn prune_gone_files(
        &self,
        ctx: &SecurityContext,
        repo_id: &str,
        listed: Option<&HashSet<String>>,
        workspace_id: Option<&str>,
        project_id: Option<&str>,
        repo_full_path: &str,
    ) -> usize {
        // `gone_files` would answer "nothing" for a partial listing anyway;
        // asking here first saves the projection read that answer needs.
        if listed.is_none() {
            info!(
                repo = repo_full_path,
                "studio-artifact-ingest: file listing incomplete; nothing forgotten this sync"
            );
            return 0;
        }
        let stored = match self.graph.list(ctx, Some(gts::FILE_TYPE)).await {
            Ok(nodes) => nodes,
            Err(e) => {
                warn!(
                    error = %e,
                    repo = repo_full_path,
                    "studio-artifact-ingest: could not read the stored files; nothing forgotten this sync"
                );
                return 0;
            }
        };
        let gone: Vec<GtsNode> = gone_files(&stored, repo_id, listed)
            .into_iter()
            .cloned()
            .collect();
        if gone.is_empty() {
            return 0;
        }

        let mut bindings = 0usize;
        if let (Some(classifier), Some(workspace)) = (
            self.classifier.as_ref(),
            workspace_id.and_then(|w| Uuid::parse_str(w).ok()),
        ) {
            let project = project_id.and_then(|p| Uuid::parse_str(p).ok());
            let node_ids = gone.iter().map(|n| n.instance_id.clone()).collect();
            match classifier
                .forget_ingested(ctx, workspace, project, node_ids)
                .await
            {
                Ok(n) => bindings = n,
                Err(e) => {
                    warn!(
                        error = %e,
                        repo = repo_full_path,
                        gone = gone.len(),
                        "studio-artifact-ingest: could not forget the bindings of deleted files; \
                         their nodes are kept for the next sync"
                    );
                    return 0;
                }
            }
        }

        // Content first, and a failure here keeps the files. The other order
        // could strand it: a retired file is gone from every listing, so no
        // later sync would find it gone again and come back for its content,
        // which would stay searchable and point at nothing.
        let contents = gone_contents(&gone);
        if let Err(e) = self.graph.delete_nodes(ctx, &contents).await {
            warn!(
                error = %e,
                repo = repo_full_path,
                gone = gone.len(),
                bindings,
                "studio-artifact-ingest: could not forget the content of deleted files; \
                 the files are kept for the next sync"
            );
            return 0;
        }

        match self.graph.delete_nodes(ctx, &gone).await {
            Ok(pruned) => {
                info!(
                    repo = repo_full_path,
                    pruned,
                    bindings,
                    "studio-artifact-ingest: forgot files the repository no longer has"
                );
                pruned
            }
            Err(e) => {
                warn!(
                    error = %e,
                    repo = repo_full_path,
                    gone = gone.len(),
                    bindings,
                    "studio-artifact-ingest: could not forget deleted files; the next sync retries"
                );
                0
            }
        }
    }

    /// Forget every repository the attachment scope holds that is not in
    /// `keep`, with everything synced from it.
    ///
    /// The graph keys a repository by attachment scope, connection and path
    /// (see [`gts::repo_node`]), and a sync only ever adds. So detaching a
    /// repository, or attaching the same one again through another connection,
    /// used to leave the old node set standing beside the new one — and every
    /// file of it showing on the Specs screen once per attachment it ever had.
    /// `keep` is what the project has attached now; anything else in its scope
    /// was attached once and is not any more.
    pub async fn prune_detached(
        &self,
        ctx: &SecurityContext,
        workspace_id: Option<&str>,
        project_id: Option<&str>,
        keep: &[KeptRepo],
    ) -> anyhow::Result<PruneSummary> {
        let scope = project_id.or(workspace_id).unwrap_or("unscoped");
        let kept: HashSet<String> = keep
            .iter()
            .map(|k| gts::repo_node(scope, &k.connector_id, "", &k.repo_full_path).instance_id)
            .collect();
        self.prune_repos(ctx, workspace_id, project_id, |repo| {
            !kept.contains(&repo.instance_id)
        })
        .await
    }

    /// After a sync of `repo_full_path`: forget the same repository as it was
    /// synced in this scope through any OTHER connection.
    ///
    /// That is always an older attachment of the one just synced — a project
    /// holds a repository once — so it goes without waiting for anybody to
    /// ask, and a re-attached repository stops listing its files twice.
    async fn prune_superseded(
        &self,
        ctx: &SecurityContext,
        workspace_id: Option<&str>,
        project_id: Option<&str>,
        current_repo_id: &str,
        repo_full_path: &str,
    ) -> anyhow::Result<PruneSummary> {
        self.prune_repos(ctx, workspace_id, project_id, |repo| {
            repo.instance_id != current_repo_id
                && repo
                    .value
                    .get("full_path")
                    .and_then(serde_json::Value::as_str)
                    == Some(repo_full_path)
        })
        .await
    }

    /// Forget the repository nodes of one attachment scope that `stale`
    /// picks, everything synced from them, and the bindings of their files.
    ///
    /// In `prune_gone_files`' order and for its reasons: bindings first, then
    /// file content, then the children, and the repository node last — each
    /// step is found again from the one after it, so a failure part-way leaves
    /// something the next prune still finds rather than an orphan nothing does.
    /// `delete_nodes` retires rather than deletes, so attaching the repository
    /// again later syncs over the same keys.
    async fn prune_repos(
        &self,
        ctx: &SecurityContext,
        workspace_id: Option<&str>,
        project_id: Option<&str>,
        stale: impl Fn(&GtsNode) -> bool,
    ) -> anyhow::Result<PruneSummary> {
        let listed = self.graph.list(ctx, Some(gts::REPO_TYPE)).await?;
        let repos: Vec<GtsNode> = listed
            .iter()
            .filter(|n| in_attachment(&n.value, workspace_id, project_id) && stale(n))
            .cloned()
            .collect();
        if repos.is_empty() {
            return Ok(PruneSummary::default());
        }
        let doomed: HashSet<&str> = repos.iter().map(|n| n.instance_id.as_str()).collect();

        let mut files: Vec<GtsNode> = Vec::new();
        let mut others: Vec<GtsNode> = Vec::new();
        for type_id in [
            gts::FILE_TYPE,
            gts::ISSUE_TYPE,
            gts::PULL_REQUEST_TYPE,
            gts::COMMENT_TYPE,
            gts::COMMIT_TYPE,
        ] {
            for node in self.graph.list(ctx, Some(type_id)).await?.iter() {
                let repo = node.value.get("repo").and_then(serde_json::Value::as_str);
                if repo.is_some_and(|r| doomed.contains(r))
                    && in_attachment(&node.value, workspace_id, project_id)
                {
                    if type_id == gts::FILE_TYPE {
                        files.push(node.clone());
                    } else {
                        others.push(node.clone());
                    }
                }
            }
        }

        let mut bindings = 0;
        if let (Some(classifier), Some(workspace)) = (
            self.classifier.as_ref(),
            workspace_id.and_then(|w| Uuid::parse_str(w).ok()),
        ) && !files.is_empty()
        {
            let project = project_id.and_then(|p| Uuid::parse_str(p).ok());
            let node_ids = files.iter().map(|n| n.instance_id.clone()).collect();
            bindings = classifier
                .forget_ingested(ctx, workspace, project, node_ids)
                .await?;
        }
        self.graph.delete_nodes(ctx, &gone_contents(&files)).await?;
        let mut nodes = self.graph.delete_nodes(ctx, &files).await?;
        nodes += self.graph.delete_nodes(ctx, &others).await?;
        let repos = self.graph.delete_nodes(ctx, &repos).await?;
        info!(
            repos,
            nodes,
            bindings,
            workspace_id,
            project_id,
            "studio-artifact-ingest: forgot repositories no longer attached"
        );
        Ok(PruneSummary {
            repos,
            nodes,
            bindings,
        })
    }

    /// Tag a batch of freshly-built nodes with their tenant scope and upsert
    /// them to the graph in bounded chunks. The graph embeds each node itself
    /// from the payload paths its type declares. Factored out of the final flush so a sync can store
    /// its objects batch-by-batch as it pulls them, not only at the end.
    async fn store_node_batch(
        &self,
        ctx: &SecurityContext,
        batch: &mut [GtsNode],
        workspace_id: Option<&str>,
        project_id: Option<&str>,
    ) -> anyhow::Result<()> {
        if batch.is_empty() {
            return Ok(());
        }
        if workspace_id.is_some() || project_id.is_some() {
            for n in batch.iter_mut() {
                if let Some(obj) = n.value.as_object_mut() {
                    if let Some(ws) = workspace_id {
                        obj.insert(
                            "workspace_id".to_string(),
                            serde_json::Value::String(ws.to_string()),
                        );
                    }
                    if let Some(pr) = project_id {
                        obj.insert(
                            "project_id".to_string(),
                            serde_json::Value::String(pr.to_string()),
                        );
                    }
                }
            }
        }
        for chunk in batch.chunks(NODE_CHUNK) {
            self.graph.upsert_nodes(ctx, chunk).await?;
        }
        Ok(())
    }

    /// Flush the nodes not stored yet to the graph, then report progress on the task: the phase line plus the
    /// running counts, including how many nodes are now stored. This is what
    /// makes a sync's objects appear in the graph — and its counts tick up —
    /// while it is still running, instead of only when it finishes.
    ///
    /// It empties `nodes` and adds them to `flushed`. Emptying is the point as
    /// much as storing: a node that is in the graph has no reason to stay in
    /// this process, and keeping every one until the sync ended held a whole
    /// repository -- its files' text included -- in memory at once
    /// (studio-web#561).
    #[allow(clippy::too_many_arguments)]
    async fn flush_and_report(
        &self,
        ctx: &SecurityContext,
        progress: &SyncReporter,
        nodes: &mut Vec<GtsNode>,
        flushed: &mut usize,
        workspace_id: Option<&str>,
        project_id: Option<&str>,
        phase: &str,
        issues: usize,
        pull_requests: usize,
        files: usize,
        comments: usize,
        commits: usize,
    ) -> anyhow::Result<()> {
        if !nodes.is_empty() {
            self.store_node_batch(ctx, nodes, workspace_id, project_id)
                .await?;
            *flushed += nodes.len();
            nodes.clear();
            // Give the memory back, not only the elements: after a file walk
            // the capacity is a chunk's worth, and after nothing it is less.
            nodes.shrink_to(NODE_CHUNK);
        }
        progress.set_with(
            phase,
            SyncSummary {
                issues,
                pull_requests,
                files,
                comments,
                commits,
                // Not a running count — see the field. The final result
                // carries it; a mid-sync tick has nothing new to say about it.
                open_review_threads: None,
                open_document_threads: None,
                stored: *flushed,
                pruned: 0,
            }
            .as_detail(),
        );
        Ok(())
    }

    /// Text files (path + content) from the studio-session checkout of one repo,
    /// so the portal can run analysis (spec-quality) over the actual repository
    /// rather than a hand-picked file. Empty when the checkout has not been
    /// materialized yet (the IDE has not cloned it).
    pub async fn read_repo_files(
        &self,
        workspace_id: &str,
        repo_dir: &str,
    ) -> anyhow::Result<Vec<(String, String)>> {
        let Some(dir) = self.shared_checkout_dir(Some(workspace_id), Some(repo_dir)) else {
            return Ok(Vec::new());
        };
        let (_dir, walked, _commit) = self.walk_checkout(dir).await?;
        Ok(walked
            .files
            .into_iter()
            .filter_map(|f| f.text.map(|t| (f.path, t)))
            .collect())
    }

    /// Every text file of the clone a sync of `repo_full_path` through
    /// `secret_ref` left under `work_root`, as `(path, text)`. Read as it
    /// stands — no fetch: the sync keeps it current, and a detector asked
    /// about a document wants the text the Specs screen was built from.
    pub async fn read_synced_clone(
        &self,
        secret_ref: &str,
        repo_full_path: &str,
    ) -> anyhow::Result<Vec<(String, String)>> {
        let Some(root) = self.work_root.as_ref() else {
            return Ok(Vec::new());
        };
        let dir = root.join(clone::checkout_key(secret_ref, repo_full_path));
        if !dir.join(".git").is_dir() {
            return Ok(Vec::new());
        }
        let (_dir, walked, _commit) = self.walk_checkout(dir).await?;
        Ok(walked
            .files
            .into_iter()
            .filter_map(|f| f.text.map(|t| (f.path, t)))
            .collect())
    }

    /// The nodes of one type set that name `scope` as their workspace or
    /// project — from the index when the tenant has one.
    pub async fn list_in_scope(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
        scope: &str,
    ) -> anyhow::Result<Vec<GtsNode>> {
        self.graph.list_in_scope(ctx, type_filter, scope).await
    }

    /// One page of the listing, as `/nodes` asks for it.
    pub async fn page_nodes(
        &self,
        ctx: &SecurityContext,
        query: &super::graph::NodePageQuery<'_>,
    ) -> anyhow::Result<super::graph::NodePage> {
        self.graph.page(ctx, query).await
    }

    /// Read the relations between ingested nodes back for the portal
    /// (authored_by / modifies / artifact_of / contains) as endpoint id pairs.
    pub async fn list_relations(
        &self,
        ctx: &SecurityContext,
    ) -> anyhow::Result<Vec<super::graph::GtsEdgeView>> {
        self.graph.list_relations(ctx).await
    }

    /// Search the artifact graph. The graph-storage store runs hybrid
    /// retrieval — it embeds the query with the same provider that embedded
    /// the nodes and fuses the vector and lexical arms; the in-memory fallback
    /// matches text.
    pub async fn search(
        &self,
        ctx: &SecurityContext,
        text: &str,
        limit: u32,
    ) -> anyhow::Result<Vec<GtsNode>> {
        self.graph.search(ctx, text, limit).await
    }

    /// Register a user-uploaded or Studio-generated project artifact after its
    /// bytes have been finalized by file-storage. Graph Storage receives only
    /// normalized metadata and the durable object reference.
    pub async fn upsert_project_artifact(
        &self,
        ctx: &SecurityContext,
        artifact: ProjectArtifact<'_>,
    ) -> anyhow::Result<String> {
        use super::gts;
        let node = gts::project_artifact_file_node(
            artifact.organization_id,
            artifact.workspace_id,
            artifact.project_id,
            artifact.origin,
            artifact.path,
            artifact.size,
            artifact.object_ref,
        );
        let id = node.instance_id.clone();
        self.graph
            .upsert_nodes(ctx, std::slice::from_ref(&node))
            .await?;
        Ok(id)
    }

    /// Persist spec-quality detector results the portal has parsed: one finding
    /// node per (detector, document) plus its `finding_on` edge, and the derived
    /// document↔document relations (`duplicates`, `traces_to`). Idempotent —
    /// re-running a detector upserts the same instances. Returns (nodes, edges).
    pub async fn upsert_quality(
        &self,
        ctx: &SecurityContext,
        findings: &[QualityFinding],
        duplicates: &[QualityLink],
        traces: &[QualityLink],
        workspace_id: Option<&str>,
        project_id: Option<&str>,
    ) -> anyhow::Result<(usize, usize)> {
        use super::gts;
        let mut nodes: Vec<GtsNode> = Vec::new();
        let mut edges: Vec<GtsEdge> = Vec::new();

        // One instant for the whole batch: four detectors reporting on the
        // same document in one run did so together, and stamping each as it is
        // built would scatter them across a few milliseconds for no reason.
        let recorded_at = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        for f in findings {
            if f.detector.trim().is_empty() || f.subject.trim().is_empty() {
                continue;
            }
            let mut node = gts::spec_finding_node(
                f.detector.trim(),
                f.subject.trim(),
                f.path.as_deref(),
                f.severity.as_deref(),
                f.summary.as_deref(),
                f.score,
                f.details.clone(),
                &recorded_at,
            );
            // Scope the finding to the same tenants as the document it is about,
            // so it survives the graph's `scope` filter instead of vanishing.
            if let Some(obj) = node.value.as_object_mut() {
                if let Some(ws) = workspace_id {
                    obj.insert(
                        "workspace_id".to_string(),
                        serde_json::Value::String(ws.to_string()),
                    );
                }
                if let Some(pr) = project_id {
                    obj.insert(
                        "project_id".to_string(),
                        serde_json::Value::String(pr.to_string()),
                    );
                }
            }
            let finding_id = node.instance_id.clone();
            nodes.push(node);
            // A document written in Studio (`studio-doc:<id>`) lives in the
            // documents gear, not in this graph, so there is no node for the
            // edge to reach; the finding's `subject` is what finds it again.
            if !f.subject.trim().starts_with("studio-doc:") {
                edges.push(gts::finding_on_edge(&finding_id, f.subject.trim()));
            }
        }
        for d in duplicates {
            let (a, b) = (d.from.trim(), d.to.trim());
            if a.is_empty() || b.is_empty() || a == b {
                continue;
            }
            edges.push(gts::duplicates_edge(a, b));
        }
        for t in traces {
            let (from, to) = (t.from.trim(), t.to.trim());
            if from.is_empty() || to.is_empty() || from == to {
                continue;
            }
            edges.push(gts::traces_to_edge(from, to));
        }

        if !nodes.is_empty() {
            self.graph.upsert_nodes(ctx, &nodes).await?;
        }
        if !edges.is_empty() {
            self.graph.upsert_edges(ctx, &edges).await?;
        }
        Ok((nodes.len(), edges.len()))
    }

    /// Record a member's decision on one mapping (`cpt-studio-fr-mapping-decisions`):
    /// a `mapping_decision` node scoped like the document it is about, and a
    /// `decision_on` edge to that document when it is a repository file.
    ///
    /// Deciding the same (document, section, capability, gear) again replaces
    /// the decision. The instance id is returned.
    pub async fn record_mapping_decision(
        &self,
        ctx: &SecurityContext,
        decision: &MappingDecision,
    ) -> anyhow::Result<GtsNode> {
        use super::gts;
        let id = gts::mapping_decision_instance_id(
            &decision.document,
            &decision.section,
            &decision.capability,
            &decision.gear,
        );
        let decided_at = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        let mut value = serde_json::json!({
            "title": format!("{} → {}: {}", decision.capability, decision.gear, decision.decision),
            "document": decision.document,
            "document_revision": decision.document_revision,
            "section": decision.section,
            "capability": decision.capability,
            "gear": decision.gear,
            "gear_version": decision.gear_version,
            "step": decision.step,
            "decision": decision.decision,
            "decided_by": ctx.subject_id().to_string(),
            "decided_at": decided_at,
            "workspace_id": decision.workspace_id,
        });
        if let (Some(obj), Some(project)) = (value.as_object_mut(), &decision.project_id) {
            obj.insert(
                "project_id".to_string(),
                serde_json::Value::String(project.clone()),
            );
        }
        let node = GtsNode {
            type_id: gts::MAPPING_DECISION_TYPE,
            instance_id: id.clone(),
            value,
        };
        self.graph
            .upsert_nodes(ctx, std::slice::from_ref(&node))
            .await?;
        if let Some(node_id) = &decision.document_node {
            self.graph
                .upsert_edges(ctx, &[gts::decision_on_edge(&id, node_id)])
                .await?;
        }
        Ok(node)
    }

    /// The mapping decisions recorded in a workspace or project.
    pub async fn list_mapping_decisions(
        &self,
        ctx: &SecurityContext,
        scope: &str,
    ) -> anyhow::Result<Vec<GtsNode>> {
        self.list_in_scope(ctx, Some("mapping_decision"), scope)
            .await
    }
}

/// A member's decision on one proposed mapping, as the portal sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappingDecision {
    pub workspace_id: String,
    pub project_id: Option<String>,
    /// The declaring document: a bound file's binding id or a Studio
    /// document's id, as `declared-capabilities` names it.
    pub document: String,
    /// The artifact node of a bound file, for the `decision_on` edge.
    pub document_node: Option<String>,
    /// What the document was when this was decided.
    pub document_revision: String,
    /// Where in the document the capability is declared. `front matter` for a
    /// `capabilities:` line, which is where every capability comes from today.
    pub section: String,
    pub capability: String,
    /// The gear by catalogue name. A rejected gap uses the empty string.
    pub gear: String,
    pub gear_version: Option<String>,
    /// The mapping step that proposed it: `contract`, `evidence` or `gap`.
    pub step: String,
    /// `confirmed` or `rejected`.
    pub decision: String,
}

/// What the portfolio counts, answered without a page to count.
///
/// The listing endpoint gives the same number as `total`. Here it is one
/// `COUNT` against the artifact index, or — for a tenant the index has not
/// been filled for yet — one projection read, shared with every other caller
/// through the per-tenant cache.
#[async_trait::async_trait]
impl super::port::ArtifactCounter for IngestService {
    async fn count_nodes(
        &self,
        ctx: &SecurityContext,
        type_leaf: &str,
        scope: &str,
    ) -> anyhow::Result<u32> {
        // The store's own count, through the same scope rule the listing
        // applies: two spellings of "in this scope" is how a count and a list
        // start disagreeing about the same project.
        let n = self
            .graph
            .count_in_scope(ctx, Some(type_leaf), scope)
            .await?;
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }
}

/// A project's row, folded from the same scoped reads the Sources table and
/// the Activity feed make — one indexed query each.
#[async_trait::async_trait]
impl super::port::ProjectSignalSource for IngestService {
    async fn project_signals(
        &self,
        ctx: &SecurityContext,
        scope: &str,
        days: usize,
    ) -> anyhow::Result<super::port::ProjectSignals> {
        let entries = |nodes: Vec<GtsNode>| -> Vec<(String, serde_json::Value)> {
            nodes
                .into_iter()
                .map(|n| (n.instance_id, n.value))
                .collect()
        };
        let values = |nodes: Vec<GtsNode>| -> Vec<serde_json::Value> {
            nodes.into_iter().map(|n| n.value).collect()
        };
        let findings = entries(self.list_in_scope(ctx, Some("spec_finding"), scope).await?);
        let comments = entries(self.list_in_scope(ctx, Some("comment"), scope).await?);
        let pulls = values(self.list_in_scope(ctx, Some("pull_request"), scope).await?);
        let repos = values(self.list_in_scope(ctx, Some("repo"), scope).await?);
        let now = i64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
        )
        .unwrap_or(0);
        Ok(super::activity::project_signals(
            &findings, &comments, &pulls, &repos, now, days,
        ))
    }
}

/// The files, offered to the gear that decides what each one is.
///
/// The same store read and the same scope rule as the count beside it — the
/// index's columns when the tenant has them, `node_in_scope` otherwise.
#[async_trait::async_trait]
impl super::port::ArtifactFiles for IngestService {
    async fn list_files(
        &self,
        ctx: &SecurityContext,
        scope: &str,
    ) -> anyhow::Result<Vec<super::port::IngestedFile>> {
        self.graph.files_in_scope(ctx, scope).await
    }
}

/// The checkout, offered to whoever owns the documents in it.
///
/// A thin forward to the inherent method the REST route already uses: the
/// contract exists so another gear can ask without going out through HTTP and
/// back, not because the reading itself is different.
#[async_trait::async_trait]
impl super::port::RepoFileReader for IngestService {
    async fn read_repo_files(
        &self,
        workspace_id: &str,
        repo_dir: &str,
    ) -> anyhow::Result<Vec<(String, String)>> {
        IngestService::read_repo_files(self, workspace_id, repo_dir).await
    }

    async fn read_synced_clone(
        &self,
        secret_ref: &str,
        repo_full_path: &str,
    ) -> anyhow::Result<Vec<(String, String)>> {
        IngestService::read_synced_clone(self, secret_ref, repo_full_path).await
    }

    async fn read_repo_file(
        &self,
        workspace_id: &str,
        repo_dir: &str,
        path: &str,
    ) -> anyhow::Result<Option<String>> {
        let Some(dir) = self.shared_checkout_dir(Some(workspace_id), Some(repo_dir)) else {
            return Ok(None);
        };
        read_one(dir, path).await
    }

    async fn read_synced_clone_file(
        &self,
        secret_ref: &str,
        repo_full_path: &str,
        path: &str,
    ) -> anyhow::Result<Option<String>> {
        let Some(root) = self.work_root.as_ref() else {
            return Ok(None);
        };
        let dir = root.join(clone::checkout_key(secret_ref, repo_full_path));
        if !dir.join(".git").is_dir() {
            return Ok(None);
        }
        read_one(dir, path).await
    }
}

/// [`clone::read_text_file`] off the async runtime.
async fn read_one(dir: PathBuf, path: &str) -> anyhow::Result<Option<String>> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || clone::read_text_file(&dir, &path))
        .await
        .map_err(|e| anyhow!("file read did not finish: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONNECTOR: &str = "conn-1";
    const REPO: &str = "constructorfabric/studio-web";

    /// A file node exactly as a sync in `scope` stores it.
    fn file(scope: &str, repo: &str, path: &str) -> GtsNode {
        let repo_id = gts::repo_node(scope, CONNECTOR, "github", repo).instance_id;
        gts::file_node_cloned(scope, &repo_id, CONNECTOR, repo, path, 1, None, None)
    }

    fn repo_id(scope: &str) -> String {
        gts::repo_node(scope, CONNECTOR, "github", REPO).instance_id
    }

    fn listing(paths: &[&str]) -> HashSet<String> {
        paths.iter().map(|p| (*p).to_string()).collect()
    }

    fn paths<'a>(nodes: &[&'a GtsNode]) -> Vec<&'a str> {
        let mut out: Vec<&str> = nodes
            .iter()
            .filter_map(|n| n.value.get("path").and_then(serde_json::Value::as_str))
            .collect();
        out.sort_unstable();
        out
    }

    /// The observed bug: an ADR moved away weeks ago is still a file node.
    /// Against a complete listing it is gone, and the files that are still
    /// there are not.
    #[test]
    fn a_complete_listing_forgets_what_it_no_longer_has() {
        let stored = [
            file("project-a", REPO, "README.md"),
            file("project-a", REPO, "docs/adr/0010-theia-backend-bridge.md"),
            file("project-a", REPO, "studio-backend/docs/adr/0001.md"),
        ];
        let listed = listing(&["README.md"]);
        let gone = gone_files(&stored, &repo_id("project-a"), Some(&listed));
        assert_eq!(
            paths(&gone),
            [
                "docs/adr/0010-theia-backend-bridge.md",
                "studio-backend/docs/adr/0001.md"
            ]
        );
    }

    /// A walk that failed, or was cut short, forgets nothing — however little
    /// it found. The error paths read as an empty listing, and believing one
    /// would wipe the repository.
    #[test]
    fn a_partial_listing_forgets_nothing() {
        let stored = [
            file("project-a", REPO, "README.md"),
            file("project-a", REPO, "docs/prd.md"),
        ];
        assert!(gone_files(&stored, &repo_id("project-a"), None).is_empty());
    }

    /// Another repository's files in the same project are not this listing's
    /// to judge.
    #[test]
    fn another_repositorys_files_are_left_alone() {
        let stored = [
            file("project-a", REPO, "README.md"),
            file("project-a", "constructorfabric/gears-rust", "Cargo.toml"),
        ];
        let listed = listing(&["README.md"]);
        assert!(gone_files(&stored, &repo_id("project-a"), Some(&listed)).is_empty());
    }

    /// The same repository attached to another project is another graph: its
    /// files are keyed on that scope, and this sync must not reach them.
    #[test]
    fn the_same_repository_in_another_scope_is_left_alone() {
        let stored = [
            file("project-a", REPO, "README.md"),
            file("project-b", REPO, "docs/adr/0010-theia-backend-bridge.md"),
        ];
        let listed = listing(&["README.md"]);
        assert!(gone_files(&stored, &repo_id("project-a"), Some(&listed)).is_empty());
    }

    /// A gone file takes its content node along, named from its own id, and a
    /// file that never had text names none.
    #[test]
    fn a_gone_file_names_its_content_and_a_file_without_text_names_none() {
        let repo_id = repo_id("project-a");
        let mut with_text = gts::file_node_cloned(
            "project-a",
            &repo_id,
            CONNECTOR,
            REPO,
            "docs/prd.md",
            1,
            None,
            None,
        );
        // As a sync before 2026-10-05 stored it.
        with_text.value["has_text"] = serde_json::json!(true);
        let without = file("project-a", REPO, "logo.png");
        let contents = gone_contents(&[with_text.clone(), without]);
        assert_eq!(contents.len(), 1);
        assert_eq!(contents[0].type_id, gts::FILE_CONTENT_TYPE);
        assert_eq!(
            contents[0].instance_id,
            gts::file_content_node(&with_text, "# PRD")
                .expect("text has content")
                .instance_id
        );
    }

    /// Only files. A repository's issues and pull requests carry the same
    /// `repo` field and have no path in any listing, and are not gone.
    #[test]
    fn nodes_that_are_not_files_are_left_alone() {
        let mut issue = file("project-a", REPO, "not-a-file");
        issue.type_id = gts::ISSUE_TYPE;
        let listed = listing(&[]);
        assert!(gone_files(&[issue], &repo_id("project-a"), Some(&listed)).is_empty());
    }
}

#[cfg(test)]
mod prune_tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use credstore_sdk::{
        CredStoreError, GetSecretResponse, SecretValue, SharingMode, WriteOptions,
        WritePrecondition,
    };
    use serde_json::json;

    use super::*;
    use crate::artifact_ingest::graph::InMemoryGraphStore;
    use crate::documents::port::ClassifiedCounts;

    const WS: &str = "00000000-0000-0000-0000-00000000000a";
    const PROJECT: &str = "00000000-0000-0000-0000-00000000000b";
    const OTHER_PROJECT: &str = "00000000-0000-0000-0000-00000000000c";

    struct NoSecrets;

    #[async_trait]
    impl CredStoreClientV1 for NoSecrets {
        async fn get(
            &self,
            _ctx: &SecurityContext,
            _key: &SecretRef,
        ) -> Result<Option<GetSecretResponse>, CredStoreError> {
            Ok(None)
        }

        async fn put_opts(
            &self,
            _ctx: &SecurityContext,
            _key: &SecretRef,
            _value: SecretValue,
            _sharing: SharingMode,
            _precondition: WritePrecondition,
            _opts: WriteOptions,
        ) -> Result<(), CredStoreError> {
            Ok(())
        }

        async fn create_opts(
            &self,
            _ctx: &SecurityContext,
            _key: &SecretRef,
            _value: SecretValue,
            _sharing: SharingMode,
            _opts: WriteOptions,
        ) -> Result<(), CredStoreError> {
            Ok(())
        }
    }

    /// Records what it was asked to forget.
    #[derive(Default)]
    struct Forgetful {
        forgot: Mutex<Vec<(Option<Uuid>, Vec<String>)>>,
    }

    #[async_trait]
    impl DocumentClassifier for Forgetful {
        async fn classify_ingested(
            &self,
            _ctx: &SecurityContext,
            _workspace_id: Uuid,
            _project_id: Option<Uuid>,
            _files: Vec<IngestedDocument>,
        ) -> anyhow::Result<ClassifiedCounts> {
            Ok(ClassifiedCounts::default())
        }

        async fn forget_ingested(
            &self,
            _ctx: &SecurityContext,
            _workspace_id: Uuid,
            project_id: Option<Uuid>,
            mut node_ids: Vec<String>,
        ) -> anyhow::Result<usize> {
            node_ids.sort();
            let n = node_ids.len();
            self.forgot
                .lock()
                .expect("forgot")
                .push((project_id, node_ids));
            Ok(n)
        }
    }

    fn ctx() -> SecurityContext {
        SecurityContext::builder()
            .subject_id(Uuid::from_u128(0xca7))
            .subject_type("user")
            .subject_tenant_id(Uuid::parse_str(WS).expect("uuid"))
            .build()
            .expect("security context")
    }

    fn stamped(mut node: GtsNode, project: Option<&str>) -> GtsNode {
        let obj = node.value.as_object_mut().expect("object");
        obj.insert("workspace_id".into(), json!(WS));
        if let Some(p) = project {
            obj.insert("project_id".into(), json!(p));
        }
        node
    }

    /// One repository as a sync of it would store it: the repo node and one
    /// file. Returns (repo id, file id).
    fn synced(
        nodes: &mut Vec<GtsNode>,
        project: Option<&str>,
        connection: &str,
        repo: &str,
    ) -> (String, String) {
        let scope = project.unwrap_or(WS);
        let r = gts::repo_node(scope, connection, "github", repo);
        let repo_id = r.instance_id.clone();
        let mut f = gts::file_node_cloned(
            scope,
            &repo_id,
            connection,
            repo,
            "README.md",
            1,
            None,
            None,
        );
        // As a sync before 2026-10-05 stored it, with an excerpt beside it.
        f.value["has_text"] = json!(true);
        let file_id = f.instance_id.clone();
        nodes.push(stamped(r, project));
        nodes.push(stamped(f, project));
        (repo_id, file_id)
    }

    fn service() -> (IngestService, Arc<InMemoryGraphStore>, Arc<Forgetful>) {
        let graph = Arc::new(InMemoryGraphStore::default());
        let classifier = Arc::new(Forgetful::default());
        let svc = IngestService::new(
            Arc::new(NoSecrets),
            HashMap::new(),
            graph.clone(),
            Some(classifier.clone()),
            None,
            None,
        );
        (svc, graph, classifier)
    }

    /// The nodes anything still lists.
    async fn ids(graph: &InMemoryGraphStore) -> HashSet<String> {
        let mut out = HashSet::new();
        for t in [gts::REPO_TYPE, gts::FILE_TYPE] {
            for n in graph.list(&ctx(), Some(t)).await.expect("list").iter() {
                out.insert(n.instance_id.clone());
            }
        }
        out
    }

    /// A flush stores what it was given and lets it go: the sync used to keep
    /// every node it had stored until it ended, a whole repository's files and
    /// their text at once (studio-web#561).
    #[tokio::test]
    async fn a_flush_stores_the_nodes_and_keeps_none_of_them() {
        let (svc, graph, _) = service();
        let progress = SyncReporter::detached();
        let mut nodes = Vec::new();
        let (repo_id, file_id) = synced(&mut nodes, Some(PROJECT), "conn", "org/studio-web");
        let mut flushed = 0usize;

        svc.flush_and_report(
            &ctx(),
            &progress,
            &mut nodes,
            &mut flushed,
            Some(WS),
            Some(PROJECT),
            "storing…",
            0,
            0,
            0,
            0,
            0,
        )
        .await
        .expect("flush");
        assert!(
            nodes.is_empty(),
            "stored nodes stay behind: {}",
            nodes.len()
        );
        assert_eq!(flushed, 2);
        assert_eq!(ids(&graph).await, HashSet::from([repo_id.clone(), file_id]));

        // The next flush adds to the count, and an empty one changes nothing.
        let more = gts::file_node_cloned(
            "p",
            &repo_id,
            "conn",
            "org/studio-web",
            "docs/a.md",
            1,
            None,
            None,
        );
        let more_id = more.instance_id.clone();
        nodes.push(more);
        svc.flush_and_report(
            &ctx(),
            &progress,
            &mut nodes,
            &mut flushed,
            Some(WS),
            Some(PROJECT),
            "storing…",
            0,
            0,
            0,
            0,
            0,
        )
        .await
        .expect("flush");
        svc.flush_and_report(
            &ctx(),
            &progress,
            &mut nodes,
            &mut flushed,
            Some(WS),
            Some(PROJECT),
            "storing…",
            0,
            0,
            0,
            0,
            0,
        )
        .await
        .expect("empty flush");
        assert!(nodes.is_empty());
        assert_eq!(flushed, 3);
        assert!(ids(&graph).await.contains(&more_id));
    }

    /// The excerpt an earlier sync stored beside a file is found from the file
    /// alone, only for this repository in this scope, and not at all once the
    /// file has been rewritten without one.
    #[tokio::test]
    async fn a_resync_finds_the_excerpts_an_earlier_sync_stored_and_only_those() {
        let (svc, graph, _) = service();
        let mut nodes = Vec::new();
        let (repo_id, file_id) = synced(&mut nodes, Some(PROJECT), "conn", "org/studio-web");
        let (other_repo, _) = synced(&mut nodes, Some(PROJECT), "conn", "org/other");
        let (_, elsewhere) = synced(&mut nodes, Some(OTHER_PROJECT), "conn", "org/studio-web");
        graph.upsert_nodes(&ctx(), &nodes).await.expect("upsert");

        let legacy = svc.legacy_contents(&ctx(), PROJECT, &repo_id).await;
        assert_eq!(legacy.len(), 1, "{legacy:?}");
        assert_eq!(legacy[0].type_id, gts::FILE_CONTENT_TYPE);
        assert_eq!(
            legacy[0].instance_id,
            gts::file_content_instance_id(&file_id)
        );
        assert_ne!(other_repo, repo_id);
        assert_ne!(
            legacy[0].instance_id,
            gts::file_content_instance_id(&elsewhere)
        );

        // Rewritten by this sync: nothing left to retire.
        let rewritten = stamped(
            gts::file_node_cloned(
                PROJECT,
                &repo_id,
                "conn",
                "org/studio-web",
                "README.md",
                1,
                None,
                None,
            ),
            Some(PROJECT),
        );
        assert_eq!(rewritten.instance_id, file_id);
        graph
            .upsert_nodes(&ctx(), &[rewritten])
            .await
            .expect("upsert");
        assert!(
            svc.legacy_contents(&ctx(), PROJECT, &repo_id)
                .await
                .is_empty()
        );
    }

    #[tokio::test]
    async fn a_pruned_repository_keeps_its_keys_so_attaching_it_again_can_sync_it() {
        let (svc, graph, _) = service();
        let mut nodes = Vec::new();
        let gone = synced(&mut nodes, Some(PROJECT), "conn", "org/studio-web");
        graph.upsert_nodes(&ctx(), &nodes).await.expect("upsert");

        svc.prune_detached(&ctx(), Some(WS), Some(PROJECT), &[])
            .await
            .expect("prune");

        assert!(ids(&graph).await.is_empty());

        // Attaching it again is an ordinary sync over the same keys.
        let mut again = Vec::new();
        let back = synced(&mut again, Some(PROJECT), "conn", "org/studio-web");
        graph.upsert_nodes(&ctx(), &again).await.expect("upsert");
        assert_eq!(back, gone);
        assert_eq!(ids(&graph).await, HashSet::from([gone.0, gone.1]));
    }

    #[tokio::test]
    async fn a_detached_repository_and_an_older_attachment_go_and_the_current_one_stays() {
        let (svc, graph, classifier) = service();
        let mut nodes = Vec::new();
        let current = synced(&mut nodes, Some(PROJECT), "conn-new", "org/studio-web");
        let older = synced(&mut nodes, Some(PROJECT), "conn-old", "org/studio-web");
        let fork = synced(&mut nodes, Some(PROJECT), "conn-new", "me/studio-web");
        // The same repository in a sibling project is that project's business.
        let sibling = synced(
            &mut nodes,
            Some(OTHER_PROJECT),
            "conn-old",
            "org/studio-web",
        );
        graph.upsert_nodes(&ctx(), &nodes).await.expect("upsert");

        let summary = svc
            .prune_detached(
                &ctx(),
                Some(WS),
                Some(PROJECT),
                &[KeptRepo {
                    connector_id: "conn-new".into(),
                    repo_full_path: "org/studio-web".into(),
                }],
            )
            .await
            .expect("prune");

        assert_eq!((summary.repos, summary.nodes), (2, 2));
        let left = ids(&graph).await;
        for id in [&current.0, &current.1, &sibling.0, &sibling.1] {
            assert!(left.contains(id), "{id} should have stayed");
        }
        for id in [&older.0, &older.1, &fork.0, &fork.1] {
            assert!(!left.contains(id), "{id} should be gone");
        }
        let mut forgotten = vec![older.1.clone(), fork.1.clone()];
        forgotten.sort();
        assert_eq!(
            *classifier.forgot.lock().expect("forgot"),
            vec![(Some(Uuid::parse_str(PROJECT).expect("uuid")), forgotten)]
        );
    }

    #[tokio::test]
    async fn a_sync_removes_the_same_repository_attached_through_another_connection_only() {
        let (svc, graph, _) = service();
        let mut nodes = Vec::new();
        let current = synced(&mut nodes, Some(PROJECT), "conn-new", "org/studio-web");
        let older = synced(&mut nodes, Some(PROJECT), "conn-old", "org/studio-web");
        let other = synced(&mut nodes, Some(PROJECT), "conn-old", "org/other");
        graph.upsert_nodes(&ctx(), &nodes).await.expect("upsert");

        svc.prune_superseded(
            &ctx(),
            Some(WS),
            Some(PROJECT),
            &current.0,
            "org/studio-web",
        )
        .await
        .expect("prune");

        let left = ids(&graph).await;
        assert!(left.contains(&current.0) && left.contains(&current.1));
        assert!(left.contains(&other.0) && left.contains(&other.1));
        assert!(!left.contains(&older.0) && !left.contains(&older.1));
    }

    #[tokio::test]
    async fn a_workspace_level_prune_never_reaches_into_its_projects() {
        let (svc, graph, _) = service();
        let mut nodes = Vec::new();
        let workspace_level = synced(&mut nodes, None, "conn", "org/ws-repo");
        let in_project = synced(&mut nodes, Some(PROJECT), "conn", "org/studio-web");
        graph.upsert_nodes(&ctx(), &nodes).await.expect("upsert");

        svc.prune_detached(&ctx(), Some(WS), None, &[])
            .await
            .expect("prune");

        let left = ids(&graph).await;
        assert!(!left.contains(&workspace_level.0));
        assert!(left.contains(&in_project.0) && left.contains(&in_project.1));
    }

    /// A detector reads the clone the sync left when no session shares its
    /// checkout — on a Kubernetes stand, always.
    #[tokio::test]
    async fn the_synced_clone_is_readable_by_the_connection_and_path_it_was_synced_with() {
        let root = std::env::temp_dir().join(format!("studio-clone-{}", Uuid::new_v4()));
        let dir = root.join(super::clone::checkout_key(
            "studio-connection-1",
            "org/repo",
        ));
        std::fs::create_dir_all(dir.join(".git")).expect("git dir");
        std::fs::create_dir_all(dir.join("docs")).expect("docs dir");
        std::fs::write(dir.join("docs/adr.md"), "# Decision").expect("file");
        let svc = IngestService::new(
            Arc::new(NoSecrets),
            HashMap::new(),
            Arc::new(InMemoryGraphStore::default()),
            None,
            None,
            Some(root.clone()),
        );

        let files = svc
            .read_synced_clone("studio-connection-1", "org/repo")
            .await
            .expect("read");
        let other = svc
            .read_synced_clone("studio-connection-2", "org/repo")
            .await
            .expect("read");
        let reader: &dyn crate::artifact_ingest::port::RepoFileReader = &svc;
        let one = reader
            .read_synced_clone_file("studio-connection-1", "org/repo", "docs/adr.md")
            .await
            .expect("read one");
        let absent = reader
            .read_synced_clone_file("studio-connection-1", "org/repo", "docs/missing.md")
            .await
            .expect("read one");
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(
            one.as_deref(),
            Some("# Decision"),
            "one file reads as the whole walk read it"
        );
        assert_eq!(absent, None);

        assert_eq!(
            files,
            vec![("docs/adr.md".to_string(), "# Decision".to_string())]
        );
        assert!(
            other.is_empty(),
            "another connection's clone is not this one"
        );
    }
}

/// Findings a Spec Quality run records itself. A forward to the method the
/// REST `POST /quality` uses, so both writers produce the same nodes.
#[async_trait::async_trait]
impl super::port::SpecFindingWriter for IngestService {
    async fn write_spec_findings(
        &self,
        ctx: &SecurityContext,
        findings: &[QualityFinding],
        duplicates: &[QualityLink],
        workspace_id: Option<&str>,
        project_id: Option<&str>,
    ) -> anyhow::Result<(usize, usize)> {
        self.upsert_quality(ctx, findings, duplicates, &[], workspace_id, project_id)
            .await
    }
}

#[async_trait::async_trait]
impl super::port::MappingDecisionStore for IngestService {
    async fn record_decision(
        &self,
        ctx: &SecurityContext,
        decision: &MappingDecision,
    ) -> anyhow::Result<(String, serde_json::Value)> {
        let node = self.record_mapping_decision(ctx, decision).await?;
        Ok((node.instance_id, node.value))
    }

    async fn list_decisions(
        &self,
        ctx: &SecurityContext,
        scope: &str,
    ) -> anyhow::Result<Vec<(String, serde_json::Value)>> {
        Ok(self
            .list_mapping_decisions(ctx, scope)
            .await?
            .into_iter()
            .map(|n| (n.instance_id, n.value))
            .collect())
    }
}
