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
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::anyhow;
use bytes::Bytes;
use credstore_sdk::{CredStoreClientV1, SecretRef};
use file_parser_sdk::{Detection, FileParserClientV1, ParseBytesRequest};
use toolkit_security::SecurityContext;

use super::clone;
use super::comment_threads;
use super::graph::{GraphStore, GtsEdge, GtsNode};
use super::gts;
use crate::connectors::driver::{ConnectionAuth, ConnectorDriver};
use tracing::{info, warn};
use uuid::Uuid;

use crate::documents::port::{DocumentClassifier, IngestedDocument, is_prose_path};
use crate::tasks::registry::SyncReporter;

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
const NODE_CHUNK: usize = 1_000;
const EDGE_CHUNK: usize = 5_000;
/// Upper bound on a binary document we hand to the file-parser gear. Extraction
/// cost and the resulting text both scale with size; 15 MiB covers real specs
/// and slide decks without letting a giant asset stall a sync.
const MAX_PARSE_BYTES: u64 = 15 * 1024 * 1024;

/// True when a path looks like a document the file-parser can turn into text —
/// office formats, PDFs, e-books and rich text. Plain-text formats already come
/// through the walk as `text`, and opaque binaries (images, archives, media)
/// have no text to extract, so both are skipped.
fn is_parseable_doc(path: &str) -> bool {
    const DOC_EXT: &[&str] = &[
        "pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "odt", "ods", "odp", "rtf", "epub",
    ];
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    DOC_EXT.contains(&ext.as_str())
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
    /// The counts recorded on a run, or zeroes when it has not reported any
    /// yet.
    ///
    /// Tolerant on purpose: a run queued by an older version of this code, or
    /// one whose result is some other shape, polls as zeroes rather than as a
    /// 500.
    pub fn of_result(result: Option<serde_json::Value>) -> Self {
        result
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

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
    /// The file-parser gear, when linked: extracts text (Markdown) from binary
    /// documents (PDF/docx/…) so their content is indexed for search. `None`
    /// leaves binary files as metadata-only, exactly as before.
    file_parser: Option<Arc<dyn FileParserClientV1>>,
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
        file_parser: Option<Arc<dyn FileParserClientV1>>,
        classifier: Option<Arc<dyn DocumentClassifier>>,
        workspaces_root: Option<PathBuf>,
        work_root: Option<PathBuf>,
    ) -> Self {
        Self {
            credstore,
            drivers,
            graph,
            file_parser,
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

        // How many of `nodes` are already flushed to the graph. Each phase
        // flushes the nodes it just appended (`nodes[flushed..]`) so objects
        // land in the store as the sync runs. Flush the repo node right away.
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
        let threads_by_number: std::collections::HashMap<i64, usize> = threads
            .into_iter()
            .flatten()
            .map(|t| (t.number, t.open))
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
                // Only an open pull request has threads worth counting; a
                // merged one is nobody's queue, so its count stays unset
                // rather than being reported as zero.
                let open_threads = threads_by_number.get(&number).copied();
                let node = gts::pull_request_node(
                    source_scope,
                    &repo_id,
                    connector_id,
                    repo_full_path,
                    p,
                    open_threads,
                );
                let pr_id = node.instance_id.clone();
                edges.push(gts::artifact_of_edge(&pr_id, &repo_id));
                author_edge(&mut edges, &mut users, &pr_id, author.as_deref());
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

        match on_disk {
            Some((dir, walk, commit)) => {
                // The walk stops at the same cap, and says so when it does.
                listing_complete = walk.complete && walk.files.len() <= MAX_FILES;
                for wf in walk.files.into_iter().take(MAX_FILES) {
                    files += 1;
                    let file_id =
                        gts::file_instance_id(source_scope, connector_id, repo_full_path, &wf.path);
                    edges.push(gts::contains_edge(&repo_id, &file_id));
                    file_paths.insert(wf.path.clone());
                    // Text files carry their content already; for a binary
                    // document (no text) ask the file-parser gear to extract it,
                    // so its content is indexed for search too.
                    let text = match wf.text {
                        Some(t) => Some(t),
                        None => self.parse_binary_text(ctx, &dir, &wf.path, wf.size).await,
                    };
                    if is_prose_path(&wf.path) {
                        if let Some(content) = text.as_deref() {
                            scanned.push(IngestedDocument {
                                node_id: gts::file_instance_id(
                                    source_scope,
                                    connector_id,
                                    repo_full_path,
                                    &wf.path,
                                ),
                                path: wf.path.clone(),
                                content: content.to_string(),
                            });
                        }
                        // Prose the walk could not read is left alone rather
                        // than called undetermined: nothing has looked at it.
                    } else {
                        scanned.push(IngestedDocument {
                            node_id: gts::file_instance_id(
                                source_scope,
                                connector_id,
                                repo_full_path,
                                &wf.path,
                            ),
                            path: wf.path.clone(),
                            content: String::new(),
                        });
                    }
                    let file = gts::file_node_cloned(
                        source_scope,
                        &repo_id,
                        connector_id,
                        repo_full_path,
                        &wf.path,
                        wf.size,
                        text.is_some(),
                        commit.as_deref(),
                        threads.documents.get(&wf.path).copied(),
                    );
                    // The text goes beside the file, not into it, so listing
                    // files never drags it along. Pushed after the file: the
                    // edge flush comes after every node, and its endpoints
                    // have to exist by then.
                    let content = text
                        .as_deref()
                        .and_then(|t| gts::file_content_node(&file, t));
                    nodes.push(file);
                    if let Some(content) = content {
                        edges.push(gts::content_of_edge(&content.instance_id, &file_id));
                        nodes.push(content);
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
            let walked = clone::walk(&res.dir)?;
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
            let walked = clone::walk(&dir)?;
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
            let walked = clone::walk(&dir)?;
            Ok((dir, walked, commit))
        })
        .await
        .map_err(|e| anyhow!("workspace read did not finish: {e}"))?
    }

    /// Extract text from a binary document via the file-parser gear, so its
    /// content is indexed for search. Best-effort: `None` when no parser is
    /// wired, the file is not a parseable document, it is empty/too large, it
    /// cannot be read, or extraction yields nothing. `dir` is the checkout root
    /// and `rel` the repo-relative path.
    async fn parse_binary_text(
        &self,
        ctx: &SecurityContext,
        dir: &Path,
        rel: &str,
        size: u64,
    ) -> Option<String> {
        let parser = self.file_parser.as_ref()?;
        if size == 0 || size > MAX_PARSE_BYTES || !is_parseable_doc(rel) {
            return None;
        }
        let bytes = tokio::fs::read(dir.join(rel)).await.ok()?;
        let req = ParseBytesRequest {
            filename: Some(rel.to_string()),
            content_type: None,
            bytes: Bytes::from(bytes),
            detection: Detection::Auto,
        };
        match parser.parse_bytes(ctx, req).await {
            Ok(p) if !p.markdown.trim().is_empty() => Some(p.markdown),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!(error = %e, path = rel, "studio-artifact-ingest: file-parser extraction failed — leaving file metadata-only");
                None
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

    /// Flush the nodes appended since the last flush (`nodes[*flushed..]`) to
    /// the graph, then report progress on the task: the phase line plus the
    /// running counts, including how many nodes are now stored. This is what
    /// makes a sync's objects appear in the graph — and its counts tick up —
    /// while it is still running, instead of only when it finishes.
    #[allow(clippy::too_many_arguments)]
    async fn flush_and_report(
        &self,
        ctx: &SecurityContext,
        progress: &SyncReporter,
        nodes: &mut [GtsNode],
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
        let end = nodes.len();
        if end > *flushed {
            self.store_node_batch(ctx, &mut nodes[*flushed..end], workspace_id, project_id)
                .await?;
            *flushed = end;
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
            edges.push(gts::finding_on_edge(&finding_id, f.subject.trim()));
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
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONNECTOR: &str = "conn-1";
    const REPO: &str = "constructorfabric/studio-web";

    /// A file node exactly as a sync in `scope` stores it.
    fn file(scope: &str, repo: &str, path: &str) -> GtsNode {
        let repo_id = gts::repo_node(scope, CONNECTOR, "github", repo).instance_id;
        gts::file_node_cloned(scope, &repo_id, CONNECTOR, repo, path, 1, false, None, None)
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
        let with_text = gts::file_node_cloned(
            "project-a",
            &repo_id,
            CONNECTOR,
            REPO,
            "docs/prd.md",
            1,
            true,
            None,
            None,
        );
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
