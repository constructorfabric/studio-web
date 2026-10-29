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

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::anyhow;
use credstore_sdk::{CredStoreClientV1, SecretRef};
use toolkit_security::SecurityContext;

use super::comment_threads;
use super::graph::{GraphStore, GtsEdge, GtsNode};
use super::gts;
use crate::connectors::sdk::git_checkout;
use crate::connectors::sdk::{
    ConnectionAuth, ConnectorDriver, DownloadTarget, Mention, NumberRef, PullRequestThreads,
    Relation, RemoteBuildArtifact, find_references,
};
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
/// CI runs read per repository, newest first (ADR-0045): three pages. Runs
/// are read again every sync, so this bounds every sync, not only the first.
const MAX_RUN_PAGES: u32 = 3;
/// Workflows whose runs are read, one page of 100 each.
const MAX_WORKFLOWS: usize = 20;
/// Completed runs whose jobs one sync reads, newest first, one request each.
/// Runs whose jobs are already kept are not counted, so the first sync of a
/// busy repository fills its history in over a few syncs.
const MAX_JOB_RUNS: usize = 40;
/// CI artifacts and releases read per repository, newest first, every sync:
/// two pages of each.
const MAX_OUTPUT_PAGES: u32 = 2;
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
    /// Why `work_root` cannot be written, found at startup: every clone into
    /// it would fail, so every reader is told so rather than to sync again.
    work_root_failure: Option<String>,
    /// The last clone failure of each repository, by its checkout key; gone
    /// once a clone of it succeeds.
    clone_failures: std::sync::Mutex<HashMap<String, String>>,
    /// The connector service, asked whose connection holds the token a sync
    /// reads with (`connectors::sdk::ownership`). `None` refuses every
    /// sync that names a token: nothing could say it is the organization's.
    connectors: Option<crate::connectors::sdk::Connectors>,
}

/// Why a sync may not read with the token it names.
#[derive(Debug)]
pub enum TokenRefused {
    /// The connection holding it is held outside the organization the sync
    /// is for -- the platform's root, or another organization.
    NotOwned(crate::connectors::sdk::ownership::NotOwned),
    /// No connection the sync's tenant can see holds that reference.
    Unknown,
}

impl std::fmt::Display for TokenRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotOwned(refused) => refused.fmt(f),
            Self::Unknown => f.write_str(
                "no connection of this organization holds that token reference: a repository is read only through a connection held by the organization, one of its workspaces or one of its projects",
            ),
        }
    }
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
            work_root_failure: None,
            clone_failures: std::sync::Mutex::new(HashMap::new()),
            connectors: None,
        }
    }

    /// Record that `work_root` cannot be written (see [`writable`]).
    #[must_use]
    pub fn with_work_root_failure(mut self, failure: Option<String>) -> Self {
        self.work_root_failure = failure;
        self
    }

    /// Why a repository's own clone is missing: the volume, else its last
    /// failed clone.
    fn clone_failure_of(&self, secret_ref: &str, repo_full_path: &str) -> Option<String> {
        if let Some(why) = &self.work_root_failure {
            return Some(why.clone());
        }
        let key = git_checkout::checkout_key(secret_ref, repo_full_path);
        self.clone_failures
            .lock()
            .ok()
            .and_then(|m| m.get(&key).cloned())
    }

    fn note_clone(&self, secret_ref: &str, repo_full_path: &str, failure: Option<String>) {
        let key = git_checkout::checkout_key(secret_ref, repo_full_path);
        if let Ok(mut m) = self.clone_failures.lock() {
            match failure {
                Some(why) => m.insert(key, why),
                None => m.remove(&key),
            };
        }
    }

    /// Ask `connectors` whose token a sync reads with.
    pub fn with_connectors(mut self, connectors: crate::connectors::sdk::Connectors) -> Self {
        self.connectors = Some(connectors);
        self
    }

    /// Refuse a sync, asked by `caller`, for `tenant` (its project, else
    /// its workspace, else the caller's own tenant), that reads with a
    /// token the organization does not hold. Credstore lends a token to
    /// every tenant below its holder, so without this an organization's
    /// sync could name the platform's token and read a repository with the
    /// platform's rights (`cpt-studio-constraint-connector-own-connections`).
    /// An empty reference reads nothing and passes.
    pub async fn ensure_token_owned(
        &self,
        ctx: &SecurityContext,
        caller: Uuid,
        tenant: Uuid,
        secret_ref: &str,
    ) -> Result<(), TokenRefused> {
        if secret_ref.trim().is_empty() {
            return Ok(());
        }
        let Some(connectors) = self.connectors.as_ref().and_then(|c| c.get()) else {
            return Err(TokenRefused::Unknown);
        };
        match connectors
            .ensure_secret_owned(ctx, caller, tenant, secret_ref)
            .await
        {
            Ok(Some(_)) => Ok(()),
            Ok(None) => Err(TokenRefused::Unknown),
            Err(refused) => Err(TokenRefused::NotOwned(refused)),
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
        // The issues among them: only an issue can be closed or be a parent.
        let mut issue_by_number: HashMap<i64, String> = HashMap::new();
        // Links read off an issue or a pull request, made edges once the
        // listing is done and every item of this repository has its node
        // (ADR-0047 §3). A target outside the repository, or outside this
        // sync's window, stays on the node's payload without an edge.
        let mut item_links: Vec<(String, &'static str, NumberRef)> = Vec::new();
        let syntax = driver.reference_syntax();
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

        // The node as the last sync left it: what it says about that sync
        // stays until this one finishes (`repo_node_keeping`).
        let repo_id =
            gts::repo_node(source_scope, connector_id, provider, repo_full_path).instance_id;
        let prior = match self.graph.list(ctx, Some(gts::REPO_TYPE)).await {
            Ok(repos) => repos
                .iter()
                .find(|n| n.instance_id == repo_id)
                .map(|n| n.value.clone()),
            Err(e) => {
                tracing::warn!(
                    repo = repo_full_path,
                    error = %e,
                    "studio-artifact-ingest: could not read the repository's last sync; it shows as not synced until this one finishes"
                );
                None
            }
        };
        nodes.push(gts::repo_node_keeping(
            source_scope,
            connector_id,
            provider,
            repo_full_path,
            prior.as_ref(),
        ));

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
                let parent = i.parent.clone();
                let node = gts::issue_node(source_scope, &repo_id, connector_id, repo_full_path, i);
                edges.push(gts::artifact_of_edge(&node.instance_id, &repo_id));
                author_edge(&mut edges, &mut users, &node.instance_id, author.as_deref());
                if let Some(parent) = parent {
                    item_links.push((node.instance_id.clone(), gts::REL_PART_OF, parent));
                }
                by_number.insert(number, node.instance_id.clone());
                issue_by_number.insert(number, node.instance_id.clone());
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
                let text = format!(
                    "{}
{}",
                    p.title,
                    p.body.as_deref().unwrap_or_default()
                );
                let links: Vec<Mention> = find_references(&text, syntax)
                    .into_iter()
                    .filter(|m| !(m.target.repo.is_none() && m.target.number == number))
                    .collect();
                let node = gts::pull_request_node(
                    source_scope,
                    &repo_id,
                    connector_id,
                    repo_full_path,
                    p,
                    review,
                    &links,
                );
                let pr_id = node.instance_id.clone();
                for m in links {
                    let rel = match m.relation {
                        Relation::Closes => gts::REL_CLOSES,
                        Relation::References => gts::REL_REFERENCES,
                    };
                    item_links.push((pr_id.clone(), rel, m.target));
                }
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

        edges.extend(item_link_edges(
            &item_links,
            &issue_by_number,
            &by_number,
            repo_full_path,
        ));

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
        let on_disk: Option<(PathBuf, git_checkout::Walk, Option<String>)> = if let Some(dir) =
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
                    Some((PathBuf::new(), git_checkout::Walk::default(), None))
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
                Ok(v) => {
                    self.note_clone(connector_id, repo_full_path, None);
                    Some(v)
                }
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        repo = repo_full_path,
                        "studio-artifact-ingest: clone failed — skipping files"
                    );
                    self.note_clone(
                        connector_id,
                        repo_full_path,
                        Some(format!("the last clone failed: {e:#}")),
                    );
                    // An incomplete walk, so nothing is forgotten over it.
                    Some((PathBuf::new(), git_checkout::Walk::default(), None))
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
        // Verdicts whose document went before verdicts went with it
        // (studio-web#706). Best-effort, like the prune: the next sync tries
        // again, and a verdict left over costs one count in the projects table.
        match self
            .sweep_orphan_verdicts(ctx, workspace_id, project_id)
            .await
        {
            Ok(0) => {}
            Ok(swept) => info!(
                repo = repo_full_path,
                swept, "studio-artifact-ingest: forgot verdicts whose document is gone"
            ),
            Err(e) => warn!(
                error = %e,
                repo = repo_full_path,
                "studio-artifact-ingest: could not sweep verdicts whose document is gone; the next sync retries"
            ),
        }

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

        // CI runs (ADR-0045): the newest of each workflow, whatever `since`
        // says -- a run that was in progress at the last sync has finished
        // since, and only reading it again says so. Per workflow, so a busy
        // workflow cannot push the one that builds the product out of the
        // window; repository-wide when the workflows cannot be listed. Best
        // effort: a token that cannot read Actions loses the runs, not the
        // sync, and the repository node says so.
        progress.set("pulling CI runs…");
        let mut runs = 0usize;
        let mut ci_error: Option<String> = None;
        // Completed runs, for their jobs: (created_at, run node, run id, attempt).
        let mut finished_runs: Vec<(Option<String>, String, i64, Option<i64>)> = Vec::new();
        let reads: Vec<(Option<i64>, u32)> = match driver
            .list_workflows(&auth, repo_full_path)
            .await
        {
            Ok(workflows) if !workflows.is_empty() => workflows
                .iter()
                .filter(|w| w.state.as_deref().is_none_or(|s| s == "active"))
                .take(MAX_WORKFLOWS)
                .map(|w| (Some(w.id), 1))
                .collect(),
            Ok(_) => vec![(None, MAX_RUN_PAGES)],
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    repo = repo_full_path,
                    "studio-artifact-ingest: workflow listing failed — reading runs repository-wide"
                );
                vec![(None, MAX_RUN_PAGES)]
            }
        };
        'reads: for (workflow, pages) in reads {
            for page in 1..=pages {
                let batch = match driver
                    .list_workflow_runs(&auth, repo_full_path, workflow, page, PER_PAGE)
                    .await
                {
                    Ok(b) => b,
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            repo = repo_full_path,
                            "studio-artifact-ingest: CI run listing failed — skipping CI runs"
                        );
                        ci_error = Some(format!("{e:#}").chars().take(300).collect());
                        break 'reads;
                    }
                };
                if batch.is_empty() {
                    break;
                }
                runs += batch.len();
                for r in batch {
                    let author = r.actor.clone();
                    let finished = r.status.as_deref() == Some("completed");
                    let (external, attempt, created) = (r.id, r.attempt, r.created_at.clone());
                    let node = gts::workflow_run_node(
                        source_scope,
                        &repo_id,
                        connector_id,
                        repo_full_path,
                        r,
                    );
                    let run_id = node.instance_id.clone();
                    edges.push(gts::artifact_of_edge(&run_id, &repo_id));
                    author_edge(&mut edges, &mut users, &run_id, author.as_deref());
                    nodes.push(node);
                    if finished {
                        finished_runs.push((created, run_id, external, attempt));
                    }
                }
                self.flush_and_report(
                    ctx,
                    progress,
                    &mut nodes,
                    &mut flushed,
                    workspace_id,
                    project_id,
                    "pulling CI runs…",
                    issues,
                    pull_requests,
                    files,
                    comments,
                    commits,
                )
                .await?;
            }
        }
        tracing::info!(
            repo = repo_full_path,
            runs,
            "studio-artifact-ingest: pulled CI runs"
        );

        // What the builds produced: the files CI runs kept, and releases with
        // their attachments -- the Artifacts tab's outputs. Read again every
        // sync, like the runs: an artifact expires and a release gains
        // assets. Only descriptions; the bytes stay with the provider and a
        // download is a link it signs. Best effort, like the runs.
        progress.set("pulling build outputs…");
        let mut outputs = 0usize;
        // Pipelines' manifests (ADR-0048 §4): read after the listing.
        let mut manifests: Vec<RemoteBuildArtifact> = Vec::new();
        'artifacts: for page in 1..=MAX_OUTPUT_PAGES {
            let batch = match driver
                .list_build_artifacts(&auth, repo_full_path, page, PER_PAGE)
                .await
            {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        repo = repo_full_path,
                        "studio-artifact-ingest: CI artifact listing failed — skipping them"
                    );
                    break 'artifacts;
                }
            };
            let last = batch.len() < PER_PAGE as usize;
            outputs += batch.len();
            for a in batch {
                if a.name == super::builds::MANIFEST_ARTIFACT && !a.expired && a.run_id.is_some() {
                    manifests.push(a.clone());
                }
                let node = gts::build_artifact_node(
                    source_scope,
                    &repo_id,
                    connector_id,
                    repo_full_path,
                    a,
                );
                edges.push(gts::artifact_of_edge(&node.instance_id, &repo_id));
                nodes.push(node);
            }
            if last {
                break;
            }
        }
        if let Some(project) = project_id
            && !manifests.is_empty()
        {
            self.record_pipeline_builds(
                ctx,
                driver.as_ref(),
                &auth,
                repo_full_path,
                project,
                workspace_id,
                manifests,
            )
            .await;
        }
        'releases: for page in 1..=MAX_OUTPUT_PAGES {
            let batch = match driver
                .list_releases(&auth, repo_full_path, page, PER_PAGE)
                .await
            {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        repo = repo_full_path,
                        "studio-artifact-ingest: release listing failed — skipping releases"
                    );
                    break 'releases;
                }
            };
            let last = batch.len() < PER_PAGE as usize;
            outputs += batch.len();
            for r in batch {
                let node =
                    gts::release_node(source_scope, &repo_id, connector_id, repo_full_path, r);
                edges.push(gts::artifact_of_edge(&node.instance_id, &repo_id));
                nodes.push(node);
            }
            if last {
                break;
            }
        }
        self.flush_and_report(
            ctx,
            progress,
            &mut nodes,
            &mut flushed,
            workspace_id,
            project_id,
            "pulling build outputs…",
            issues,
            pull_requests,
            files,
            comments,
            commits,
        )
        .await?;
        tracing::info!(
            repo = repo_full_path,
            outputs,
            "studio-artifact-ingest: pulled build outputs"
        );

        // The jobs of the newest completed runs: which part of a run failed,
        // and at which step. A finished attempt's jobs never change, so a run
        // whose attempt already has its jobs is not asked again -- a steady
        // sync asks only for the runs that finished since the last one. Best
        // effort, like the runs.
        if ci_error.is_none() && !finished_runs.is_empty() {
            progress.set("pulling CI jobs…");
            let known: HashSet<(String, Option<i64>)> = match project_id.or(workspace_id) {
                Some(scope) => self
                    .list_in_scope(ctx, Some("workflow_job"), scope)
                    .await
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|n| {
                        let run = n.value.get("run")?.as_str()?.to_string();
                        Some((
                            run,
                            n.value.get("attempt").and_then(serde_json::Value::as_i64),
                        ))
                    })
                    .collect(),
                None => HashSet::new(),
            };
            finished_runs.sort_by(|a, b| b.0.cmp(&a.0));
            let mut jobs = 0usize;
            for (_, run_node, external, attempt) in finished_runs
                .into_iter()
                .filter(|(_, run, _, attempt)| !known.contains(&(run.clone(), *attempt)))
                .take(MAX_JOB_RUNS)
            {
                let batch = match driver
                    .list_workflow_jobs(&auth, repo_full_path, external)
                    .await
                {
                    Ok(b) => b,
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            repo = repo_full_path,
                            "studio-artifact-ingest: CI job listing failed — skipping CI jobs"
                        );
                        break;
                    }
                };
                jobs += batch.len();
                for j in batch {
                    let node = gts::workflow_job_node(
                        source_scope,
                        &repo_id,
                        connector_id,
                        repo_full_path,
                        &run_node,
                        attempt,
                        j,
                    );
                    edges.push(gts::artifact_of_edge(&node.instance_id, &repo_id));
                    nodes.push(node);
                }
            }
            tracing::info!(
                repo = repo_full_path,
                jobs,
                "studio-artifact-ingest: pulled CI jobs"
            );
        }

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
                ci_runs: ci_error.is_none().then_some(runs),
                ci_error,
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
    ) -> anyhow::Result<(PathBuf, git_checkout::Walk, Option<String>)> {
        let clone_url = driver.clone_url(base_url, repo_full_path)?;
        let (username, password) = driver.clone_credentials(token);
        let username = username.to_string();
        let password = password.to_string();
        let connector_id = connector_id.to_string();
        let repo = repo_full_path.to_string();

        tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let res = git_checkout::clone_or_update(
                &work_root,
                &connector_id,
                &repo,
                &clone_url,
                &username,
                &password,
                None,
            )?;
            let walked = git_checkout::walk(&res.dir, &synced_text)?;
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
    /// (`git_checkout::update_shared_checkout`, a fast-forward only when nothing would
    /// be lost), then read it. A failed fetch -- no network, no credential --
    /// reads the checkout as it stands and says so, which is no worse than
    /// before.
    async fn walk_shared_checkout(
        &self,
        dir: PathBuf,
        username: String,
        password: String,
    ) -> anyhow::Result<(PathBuf, git_checkout::Walk, Option<String>)> {
        tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            match git_checkout::update_shared_checkout(&dir, &username, &password) {
                Ok(git_checkout::CheckoutUpdate::Advanced { from, to }) => tracing::info!(
                    dir = %dir.display(), %from, %to,
                    "studio-artifact-ingest: pulled the shared checkout up to the remote"
                ),
                Ok(git_checkout::CheckoutUpdate::Kept { reason }) => tracing::warn!(
                    dir = %dir.display(), %reason,
                    "studio-artifact-ingest: shared checkout not updated — reading it as it stands"
                ),
                Ok(git_checkout::CheckoutUpdate::Current) => {}
                Err(e) => tracing::warn!(
                    error = %e, dir = %dir.display(),
                    "studio-artifact-ingest: could not fetch the shared checkout's branch — reading it as it stands"
                ),
            }
            let commit = git_checkout::head_commit(&dir);
            let walked = git_checkout::walk(&dir, &synced_text)?;
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
    ) -> anyhow::Result<(PathBuf, git_checkout::Walk, Option<String>)> {
        self.walk_checkout_reading(dir, None).await
    }

    /// [`Self::walk_checkout`], reading the text of the `wanted` paths only
    /// when given: the rest are listed by path, and never loaded.
    async fn walk_checkout_reading(
        &self,
        dir: PathBuf,
        wanted: Option<BTreeSet<String>>,
    ) -> anyhow::Result<(PathBuf, git_checkout::Walk, Option<String>)> {
        tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let commit = git_checkout::head_commit(&dir);
            let read = |path: &str| wanted.as_ref().is_none_or(|w| w.contains(path));
            let walked = git_checkout::walk(&dir, &read)?;
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

        // The verdicts on those files, before the files: they are found by
        // the file's id, so a failure here keeps the files for the next sync
        // to find them again by. Left behind, they kept counting in the
        // projects table's `open_findings` for a document the Specs list no
        // longer shows (studio-web#706).
        if let Err(e) = self
            .forget_findings_on(ctx, project_id.or(workspace_id), &gone)
            .await
        {
            warn!(
                error = %e,
                repo = repo_full_path,
                gone = gone.len(),
                bindings,
                "studio-artifact-ingest: could not forget the verdicts on deleted files;                  the files are kept for the next sync"
            );
            return 0;
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
    /// the verdicts on the files, then file content, then the children, and the repository node last — each
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
            gts::WORKFLOW_RUN_TYPE,
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
        self.forget_findings_on(ctx, project_id.or(workspace_id), &files)
            .await?;
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

    /// Forget the `spec_finding` verdicts recorded on `documents` in `scope`.
    ///
    /// A verdict is about one document (its `subject`), and nothing else
    /// retires it: a document that leaves keeps its verdicts in the graph,
    /// where the projects table's `open_findings` still counts them and the
    /// Specs list, which has no row for them, does not (studio-web#706).
    ///
    /// One indexed read of the scope's verdicts, then the ones whose subject
    /// is among `documents`. A sync with no scope stamps none on its nodes and
    /// cannot be told apart from another one's, so nothing is forgotten.
    async fn forget_findings_on(
        &self,
        ctx: &SecurityContext,
        scope: Option<&str>,
        documents: &[GtsNode],
    ) -> anyhow::Result<usize> {
        let subjects: Vec<String> = documents.iter().map(|n| n.instance_id.clone()).collect();
        match scope {
            Some(scope) => self.forget_findings(ctx, scope, &subjects).await,
            None => Ok(0),
        }
    }

    /// Forget the verdicts in this sync's scope whose document no longer
    /// exists: verdicts did not go with their document until studio-web#706,
    /// so a project synced before that still has them, counted in the
    /// projects table's `open_findings` and listed nowhere.
    ///
    /// A verdict is about a file node or about `studio-doc:<id>`. A file
    /// verdict is gone when no file node in the WORKSPACE has its id — the
    /// whole workspace rather than the project, so a verdict is never judged
    /// against fewer files than could hold its document. A Studio verdict is
    /// gone when the documents gear says the document is not there; without
    /// that gear, or without a workspace to ask it about, those are left alone.
    /// A subject that is neither is not ours to judge and stays.
    async fn sweep_orphan_verdicts(
        &self,
        ctx: &SecurityContext,
        workspace_id: Option<&str>,
        project_id: Option<&str>,
    ) -> anyhow::Result<usize> {
        let Some(scope) = project_id.or(workspace_id) else {
            return Ok(0);
        };
        let verdicts = self
            .graph
            .list_in_scope(ctx, Some("spec_finding"), scope)
            .await?;
        if verdicts.is_empty() {
            return Ok(0);
        }
        let subject_of = |n: &GtsNode| -> Option<String> {
            n.value
                .get("subject")
                .and_then(serde_json::Value::as_str)
                .map(|s| s.trim().to_owned())
        };

        let files: HashSet<String> = self
            .graph
            .files_in_scope(ctx, workspace_id.unwrap_or(scope))
            .await?
            .into_iter()
            .map(|f| f.node_id)
            .collect();

        // The Studio documents these verdicts name, and which of them exist.
        let authored: Vec<Uuid> = verdicts
            .iter()
            .filter_map(subject_of)
            .filter_map(|s| Uuid::parse_str(s.strip_prefix("studio-doc:")?).ok())
            .collect();
        let existing: Option<HashSet<Uuid>> = match (
            self.classifier.as_ref(),
            workspace_id.and_then(|w| Uuid::parse_str(w).ok()),
        ) {
            (Some(classifier), Some(workspace)) if !authored.is_empty() => Some(
                classifier
                    .existing_documents(ctx, workspace, authored)
                    .await?,
            ),
            _ => None,
        };

        let doomed: Vec<GtsNode> = verdicts
            .into_iter()
            .filter(|n| {
                let Some(subject) = subject_of(n) else {
                    return false;
                };
                match subject.strip_prefix("studio-doc:") {
                    Some(id) => match (&existing, Uuid::parse_str(id)) {
                        (Some(existing), Ok(id)) => !existing.contains(&id),
                        _ => false,
                    },
                    // A file verdict: its node is gone. A subject that is not
                    // a node id of ours at all would read as gone too, which
                    // is why only file-shaped subjects are judged: the
                    // detectors only ever record on file nodes.
                    None => Uuid::parse_str(&subject).is_ok() && !files.contains(&subject),
                }
            })
            .collect();
        if doomed.is_empty() {
            return Ok(0);
        }
        self.graph.delete_nodes(ctx, &doomed).await
    }

    /// Forget every verdict whose `subject` is one of `subjects`, in `scope`.
    /// Returns how many went. Idempotent, as `delete_nodes` is.
    pub async fn forget_findings(
        &self,
        ctx: &SecurityContext,
        scope: &str,
        subjects: &[String],
    ) -> anyhow::Result<usize> {
        if subjects.is_empty() {
            return Ok(0);
        }
        let wanted: HashSet<&str> = subjects.iter().map(|s| s.trim()).collect();
        let doomed: Vec<GtsNode> = self
            .graph
            .list_in_scope(ctx, Some("spec_finding"), scope)
            .await?
            .into_iter()
            .filter(|n| {
                n.value
                    .get("subject")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|s| wanted.contains(s.trim()))
            })
            .collect();
        if doomed.is_empty() {
            return Ok(0);
        }
        self.graph.delete_nodes(ctx, &doomed).await
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
        Ok(text_only(
            self.read_repo_listing(workspace_id, repo_dir).await?,
        ))
    }

    /// Every file of that checkout, with the text of the ones
    /// [`Self::read_repo_files`] reads.
    pub async fn read_repo_listing(
        &self,
        workspace_id: &str,
        repo_dir: &str,
    ) -> anyhow::Result<Vec<(String, Option<String>)>> {
        let Some(dir) = self.shared_checkout_dir(Some(workspace_id), Some(repo_dir)) else {
            return Ok(Vec::new());
        };
        let (_dir, walked, _commit) = self.walk_checkout(dir).await?;
        Ok(walked.files.into_iter().map(|f| (f.path, f.text)).collect())
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
        Ok(text_only(
            self.read_synced_clone_listing(secret_ref, repo_full_path)
                .await?,
        ))
    }

    /// Every file of that clone, with the text of the ones
    /// [`Self::read_synced_clone`] reads.
    pub async fn read_synced_clone_listing(
        &self,
        secret_ref: &str,
        repo_full_path: &str,
    ) -> anyhow::Result<Vec<(String, Option<String>)>> {
        let Some(root) = self.work_root.as_ref() else {
            return Ok(Vec::new());
        };
        let dir = root.join(git_checkout::checkout_key(secret_ref, repo_full_path));
        if !dir.join(".git").is_dir() {
            return Ok(Vec::new());
        }
        let (_dir, walked, _commit) = self.walk_checkout(dir).await?;
        Ok(walked.files.into_iter().map(|f| (f.path, f.text)).collect())
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
    /// Record one report of a build the IDE ran (ADR-0045 phase 2) in
    /// `project`'s graph: its start, or its end over its start. The caller
    /// has checked that `ctx` reaches the project.
    /// Record the builds pipelines published, one per run that uploaded a
    /// `studio-build` artifact and has no record yet. Best effort: a manifest
    /// that cannot be read is logged and skipped, and tried again next sync.
    #[allow(clippy::too_many_arguments)]
    async fn record_pipeline_builds(
        &self,
        ctx: &SecurityContext,
        driver: &dyn ConnectorDriver,
        auth: &ConnectionAuth,
        repo_full_path: &str,
        project_id: &str,
        workspace_id: Option<&str>,
        manifests: Vec<RemoteBuildArtifact>,
    ) {
        use super::{builds, gts};
        let known: HashSet<String> = match self
            .graph
            .list_in_scope(ctx, Some(gts::BUILD_TYPE), project_id)
            .await
        {
            Ok(nodes) => nodes.into_iter().map(|n| n.instance_id).collect(),
            Err(e) => {
                warn!(error = %e, "studio-artifact-ingest: builds unreadable — pipeline manifests skipped");
                return;
            }
        };
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        for a in manifests {
            let Some(run) = a.run_id else { continue };
            if known.contains(&gts::build_instance_id(
                project_id,
                &builds::ci_build_id(run),
            )) {
                continue;
            }
            let read = async {
                let url = driver
                    .download_link(auth, repo_full_path, DownloadTarget::BuildArtifact(a.id))
                    .await?;
                let res = http.get(&url).send().await?.error_for_status()?;
                if res
                    .content_length()
                    .is_some_and(|n| n > builds::MAX_MANIFEST_BYTES as u64)
                {
                    anyhow::bail!("the artifact is larger than a manifest");
                }
                let bytes = res.bytes().await?;
                if bytes.len() > builds::MAX_MANIFEST_BYTES {
                    anyhow::bail!("the artifact is larger than a manifest");
                }
                builds::manifest_from_zip(&bytes)
            };
            let text = match read.await {
                Ok(t) => t,
                Err(e) => {
                    warn!(error = %e, run, repo = repo_full_path, "studio-artifact-ingest: a pipeline's manifest could not be read");
                    continue;
                }
            };
            let report = match builds::manifest_report(
                &text,
                run,
                a.sha.as_deref(),
                a.branch.as_deref(),
                repo_full_path,
            ) {
                Ok(r) => r,
                Err(e) => {
                    warn!(error = ?e, run, "studio-artifact-ingest: a pipeline's manifest is not one");
                    continue;
                }
            };
            if let Err(e) = self
                .record_build(ctx, project_id, workspace_id, &report)
                .await
            {
                warn!(error = ?e, run, "studio-artifact-ingest: a pipeline's build could not be recorded");
            }
        }
    }

    pub async fn record_build(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        workspace_id: Option<&str>,
        report: &super::builds::BuildReport,
    ) -> Result<GtsNode, super::builds::BuildRefusal> {
        use super::{builds, gts};
        let id = builds::checked_id(report)?;
        let instance = gts::build_instance_id(project_id, &id);
        // The project's builds, not the tenant's graph: one indexed read.
        let earlier = self
            .graph
            .list_in_scope(ctx, Some(gts::BUILD_TYPE), project_id)
            .await?
            .into_iter()
            .find(|n| n.instance_id == instance);
        let value = builds::record(
            report,
            project_id,
            workspace_id,
            &ctx.subject_id().to_string(),
            time::OffsetDateTime::now_utc(),
            earlier.as_ref().map(|n| &n.value),
        )?;
        let node = gts::build_node(project_id, &id, value);
        self.graph
            .upsert_nodes(ctx, std::slice::from_ref(&node))
            .await?;
        Ok(node)
    }

    /// Build in CI (ADR-0045 phase 3): start the project's build workflow --
    /// or the one `req` names -- through the connection of the project's
    /// repository it is in, on `req`'s ref or that repository's branch.
    /// Only a connection the project's organization owns is used. Returns
    /// the repository, workflow and ref it was started on.
    pub async fn dispatch_build(
        &self,
        ctx: &SecurityContext,
        am: &dyn account_management_sdk::AccountManagementClient,
        project: Uuid,
        req: &super::builds::BuildDispatch,
    ) -> Result<(String, String, String), super::builds::BuildRefusal> {
        use super::builds::{self, BuildRefusal};
        let config = crate::project_sources::read_config(am, ctx, project)
            .await
            .ok_or_else(|| BuildRefusal::NotFound(format!("project {project} is not found")))?;
        let setting = crate::project_sources::build_workflow(&config);
        let pick = |given: &Option<String>, set: Option<&str>| {
            given
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .or(set)
                .map(str::to_owned)
        };
        let repo = pick(&req.repo, setting.as_ref().map(|s| s.repo.as_str()));
        let workflow = pick(&req.workflow, setting.as_ref().map(|s| s.workflow.as_str()));
        let (Some(repo), Some(workflow)) = (repo, workflow) else {
            return Err(BuildRefusal::Invalid(
                "the project names no build workflow: pick the workflow that builds the product \
                 on its Builds tab"
                    .into(),
            ));
        };
        let workflow = builds::workflow_file(&workflow)?;
        let git_ref = builds::checked_ref(req.git_ref.as_deref())?;
        let source = crate::project_sources::parse(&config)
            .into_iter()
            .find(|s| s.full_path.eq_ignore_ascii_case(repo.trim()))
            .ok_or_else(|| {
                BuildRefusal::NotFound(format!("{repo} is not one of the project's repositories"))
            })?;
        let service = self
            .connectors
            .as_ref()
            .and_then(crate::connectors::sdk::Connectors::get)
            .ok_or_else(|| BuildRefusal::Internal(anyhow::anyhow!("no connector service")))?;
        service
            .ensure_owned(ctx, project, project, source.connection_id, "github")
            .await
            .map_err(BuildRefusal::NotOwned)?;
        let repository = crate::connectors::sdk::Repository::open(
            &service,
            ctx,
            project,
            source.connection_id,
            "github",
            &source.full_path,
            source.branch.as_deref(),
        )
        .await
        .map_err(|e| BuildRefusal::Provider(format!("{e:#}")))?;
        let started_on = repository
            .dispatch_workflow(&workflow, git_ref.as_deref())
            .await
            .map_err(|e| BuildRefusal::Provider(format!("{e:#}")))?;
        Ok((source.full_path, workflow, started_on))
    }

    /// What a project's builds produced -- CI artifacts and releases -- as
    /// the last sync kept them, unsorted.
    pub async fn list_outputs(
        &self,
        ctx: &SecurityContext,
        project: &str,
    ) -> anyhow::Result<Vec<super::outputs::Output>> {
        use super::outputs::{OutputKind, output_of};
        let mut outputs = Vec::new();
        for kind in [OutputKind::BuildArtifact, OutputKind::Release] {
            for node in self.list_in_scope(ctx, Some(kind.leaf()), project).await? {
                outputs.extend(output_of(kind, &node.instance_id, &node.value));
            }
        }
        Ok(outputs)
    }

    /// A provider-signed link that downloads one of the project's outputs
    /// (or one asset of a release), asked for through the connection of the
    /// project repository it came from -- only one the project's organization
    /// owns, as for Build in CI. The link lives about a minute; nothing is
    /// downloaded here.
    pub async fn output_download_link(
        &self,
        ctx: &SecurityContext,
        am: &dyn account_management_sdk::AccountManagementClient,
        project: Uuid,
        output_id: &str,
        asset: Option<&str>,
    ) -> Result<String, super::builds::BuildRefusal> {
        use super::builds::BuildRefusal;
        let output = self
            .list_outputs(ctx, &project.to_string())
            .await?
            .into_iter()
            .find(|o| o.id == output_id)
            .ok_or_else(|| {
                BuildRefusal::NotFound(format!("output {output_id} is not in project {project}"))
            })?;
        let (repo, target) = super::outputs::download_target(&output, asset)
            .map_err(|why| BuildRefusal::Invalid(why.to_string()))?;
        let config = crate::project_sources::read_config(am, ctx, project)
            .await
            .ok_or_else(|| BuildRefusal::NotFound(format!("project {project} is not found")))?;
        let source = crate::project_sources::parse(&config)
            .into_iter()
            .find(|s| s.full_path.eq_ignore_ascii_case(repo.trim()))
            .ok_or_else(|| {
                BuildRefusal::NotFound(format!(
                    "{repo} is no longer one of the project's repositories"
                ))
            })?;
        let service = self
            .connectors
            .as_ref()
            .and_then(crate::connectors::sdk::Connectors::get)
            .ok_or_else(|| BuildRefusal::Internal(anyhow::anyhow!("no connector service")))?;
        service
            .ensure_owned(ctx, project, project, source.connection_id, "github")
            .await
            .map_err(BuildRefusal::NotOwned)?;
        let repository = crate::connectors::sdk::Repository::open(
            &service,
            ctx,
            project,
            source.connection_id,
            "github",
            &source.full_path,
            None,
        )
        .await
        .map_err(|e| BuildRefusal::Provider(format!("{e:#}")))?;
        repository
            .download_link(target)
            .await
            .map_err(|e| BuildRefusal::Provider(format!("{e:#}")))
    }

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

/// A project's work, from the same scoped reads: one indexed query per kind.
#[async_trait::async_trait]
impl super::port::ProjectWork for IngestService {
    async fn project_work(
        &self,
        ctx: &SecurityContext,
        scope: &str,
    ) -> anyhow::Result<Vec<super::port::WorkItem>> {
        // Three independent queries: asked together, the read waits for the
        // slowest rather than for the sum. Kept in this order, issues and pull
        // requests before commits.
        let (issues, pulls, commits) = tokio::try_join!(
            self.list_in_scope(ctx, Some("issue"), scope),
            self.list_in_scope(ctx, Some("pull_request"), scope),
            self.list_in_scope(ctx, Some("commit"), scope),
        )?;
        let mut out = Vec::with_capacity(issues.len() + pulls.len() + commits.len());
        for (kind, nodes) in [
            ("issue", issues),
            ("pull_request", pulls),
            ("commit", commits),
        ] {
            out.extend(nodes.iter().map(|node| work_item(kind, &node.value)));
        }
        Ok(out)
    }
}

/// One issue, pull request or commit payload as a [`super::port::WorkItem`].
/// Every field is read defensively: a payload from an older sync may lack any
/// of them.
fn work_item(kind: &str, v: &serde_json::Value) -> super::port::WorkItem {
    let text = |key: &str| {
        v.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    super::port::WorkItem {
        kind: kind.to_string(),
        number: v.get("number").and_then(serde_json::Value::as_i64),
        title: text("title").unwrap_or_default(),
        text: text(if kind == "commit" { "message" } else { "body" }).unwrap_or_default(),
        url: text("url"),
        state: text("state"),
        merged: v
            .get("merged")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        sha: text("short_sha"),
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
        // Four independent queries, asked together.
        let (findings, comments, pulls, repos) = tokio::try_join!(
            self.list_in_scope(ctx, Some("spec_finding"), scope),
            self.list_in_scope(ctx, Some("comment"), scope),
            self.list_in_scope(ctx, Some("pull_request"), scope),
            self.list_in_scope(ctx, Some("repo"), scope),
        )?;
        let findings = entries(findings);
        let comments = entries(comments);
        let pulls = values(pulls);
        let repos = values(repos);
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
/// A project's builds by id: one indexed read of its builds.
#[async_trait::async_trait]
impl super::port::BuildRecords for IngestService {
    async fn build(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        build_id: &str,
    ) -> anyhow::Result<Option<super::port::BuildRecord>> {
        let instance = super::gts::build_instance_id(project_id, build_id);
        Ok(self
            .graph
            .list_in_scope(ctx, Some(super::gts::BUILD_TYPE), project_id)
            .await?
            .into_iter()
            .find(|n| n.instance_id == instance)
            .map(|n| super::port::BuildRecord::of(&n.value)))
    }

    async fn record(
        &self,
        ctx: &SecurityContext,
        project_id: &str,
        o: &super::port::BuildOutcome,
    ) -> anyhow::Result<()> {
        let report = super::builds::BuildReport {
            build_id: o.build_id.clone(),
            r#where: o.r#where.clone().unwrap_or_else(|| "studio".into()),
            action: Some("build".into()),
            status: o.status.clone(),
            product: o.product.clone(),
            profile: o.profile.clone(),
            repository: o.repository.clone(),
            commit: o.commit.clone(),
            branch: None,
            lock_hash: o.lock_hash.clone(),
            started_at: None,
            finished_at: None,
            failure: o.failure.clone(),
            failure_step: o.failure_step.clone(),
            step: o.step.clone(),
            outputs: o.images.iter().map(|(_, i)| i.clone()).collect(),
            images: o.images.clone(),
            chart_ref: o.chart_ref.clone(),
            chart_version: o.chart_version.clone(),
        };
        self.record_build(ctx, project_id, None, &report)
            .await
            .map(|_| ())
            .map_err(|e| anyhow!("the build could not be recorded: {e:?}"))
    }
}

/// The same store read and the same scope rule as the count beside it — the
/// index's columns when the tenant has them, `node_in_scope` otherwise.
#[async_trait::async_trait]
impl super::port::DeliveryEvidence for IngestService {
    async fn ci_runs(
        &self,
        ctx: &SecurityContext,
        scope: &str,
    ) -> anyhow::Result<Vec<super::port::CiRun>> {
        Ok(self
            .list_in_scope(ctx, Some("workflow_run"), scope)
            .await?
            .into_iter()
            .filter_map(|n| super::ci_runs::run_of(&n.instance_id, &n.value))
            .collect())
    }

    async fn pulls_waiting_on_review(
        &self,
        ctx: &SecurityContext,
        scope: &str,
    ) -> anyhow::Result<u32> {
        let pulls: Vec<(String, serde_json::Value)> = self
            .list_in_scope(ctx, Some("pull_request"), scope)
            .await?
            .into_iter()
            .map(|n| (n.instance_id, n.value))
            .collect();
        let now = time::OffsetDateTime::now_utc().unix_timestamp() * 1000;
        let waiting = super::pull_request_waits::waiting_pulls(&pulls, now)
            .into_iter()
            .filter(|w| {
                matches!(
                    w.verdict.waiting,
                    super::pull_request_waits::Waiting::Review
                )
            })
            .count();
        Ok(u32::try_from(waiting).unwrap_or(u32::MAX))
    }
}

#[async_trait::async_trait]
impl super::port::OpenPullRequests for IngestService {
    async fn open_pulls(
        &self,
        ctx: &SecurityContext,
        scope: &str,
    ) -> anyhow::Result<Vec<super::port::OpenPull>> {
        let pulls: Vec<(String, serde_json::Value)> = self
            .list_in_scope(ctx, Some("pull_request"), scope)
            .await?
            .into_iter()
            .map(|n| (n.instance_id, n.value))
            .collect();
        let now = time::OffsetDateTime::now_utc().unix_timestamp() * 1000;
        Ok(super::pull_request_waits::waiting_pulls(&pulls, now)
            .into_iter()
            .map(|w| {
                let mut reviewers = w.facts.requested_reviewers.clone();
                for r in w.facts.reviews.iter().flatten() {
                    if !reviewers.contains(&r.login) {
                        reviewers.push(r.login.clone());
                    }
                }
                super::port::OpenPull {
                    project_id: w.project_id,
                    author: w.facts.author,
                    waiting: w.verdict.waiting.as_str().to_owned(),
                    waiting_on: w.verdict.on,
                    reviewers,
                    days_open: w.days_open,
                    days_since_update: w.days_since_update,
                }
            })
            .collect())
    }
}

#[async_trait::async_trait]
impl super::port::ArtifactFiles for IngestService {
    async fn list_files(
        &self,
        ctx: &SecurityContext,
        scope: &str,
    ) -> anyhow::Result<Vec<super::port::IngestedFile>> {
        self.graph.files_in_scope(ctx, scope).await
    }

    async fn reviews(
        &self,
        ctx: &SecurityContext,
        scope: &str,
        dismissed: &std::collections::BTreeSet<String>,
    ) -> anyhow::Result<HashMap<String, super::port::ReviewSummary>> {
        let findings: Vec<(String, serde_json::Value)> = self
            .list_in_scope(ctx, Some("spec_finding"), scope)
            .await?
            .into_iter()
            .map(|n| (n.instance_id, n.value))
            .collect();
        Ok(super::activity::review_by_subject_except(
            &findings, dismissed,
        ))
    }

    async fn repo_paths(
        &self,
        ctx: &SecurityContext,
        scope: &str,
    ) -> anyhow::Result<HashMap<String, String>> {
        Ok(self
            .list_in_scope(ctx, Some("repo"), scope)
            .await?
            .into_iter()
            .filter_map(|n| {
                let path = n.value.get("full_path")?.as_str()?.to_owned();
                Some((n.instance_id, path))
            })
            .collect())
    }
}

/// Whether a clone volume can be written: a probe file is created and
/// removed. `Some(why)` when it cannot. A claim the pod's fsGroup did not
/// reach mounts `root:root 755`, and every clone into it then fails with
/// "Permission denied" (#854) — found here, at startup, not at each sync.
pub fn writable(dir: &std::path::Path) -> Option<String> {
    let probe = dir.join(".studio-write-probe");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            None
        }
        Err(e) => Some(format!(
            "the clone volume {} cannot be written: {e}",
            dir.display()
        )),
    }
}

/// The checkout, offered to whoever owns the documents in it.
///
/// A thin forward to the inherent method the REST route already uses: the
/// contract exists so another gear can ask without going out through HTTP and
/// back, not because the reading itself is different.
#[async_trait::async_trait]
impl super::port::RepoFileReader for IngestService {
    async fn clone_failure(&self, secret_ref: &str, repo_full_path: &str) -> Option<String> {
        self.clone_failure_of(secret_ref, repo_full_path)
    }

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

    async fn read_repo_listing(
        &self,
        workspace_id: &str,
        repo_dir: &str,
    ) -> anyhow::Result<Vec<(String, Option<String>)>> {
        IngestService::read_repo_listing(self, workspace_id, repo_dir).await
    }

    async fn read_synced_clone_listing(
        &self,
        secret_ref: &str,
        repo_full_path: &str,
    ) -> anyhow::Result<Vec<(String, Option<String>)>> {
        IngestService::read_synced_clone_listing(self, secret_ref, repo_full_path).await
    }

    async fn read_repo_listing_of(
        &self,
        workspace_id: &str,
        repo_dir: &str,
        wanted: &BTreeSet<String>,
    ) -> anyhow::Result<Vec<(String, Option<String>)>> {
        let Some(dir) = self.shared_checkout_dir(Some(workspace_id), Some(repo_dir)) else {
            return Ok(Vec::new());
        };
        let (_dir, walked, _commit) = self
            .walk_checkout_reading(dir, Some(wanted.clone()))
            .await?;
        Ok(walked.files.into_iter().map(|f| (f.path, f.text)).collect())
    }

    async fn read_synced_clone_listing_of(
        &self,
        secret_ref: &str,
        repo_full_path: &str,
        wanted: &BTreeSet<String>,
    ) -> anyhow::Result<Vec<(String, Option<String>)>> {
        let Some(root) = self.work_root.as_ref() else {
            return Ok(Vec::new());
        };
        let dir = root.join(git_checkout::checkout_key(secret_ref, repo_full_path));
        if !dir.join(".git").is_dir() {
            return Ok(Vec::new());
        }
        let (_dir, walked, _commit) = self
            .walk_checkout_reading(dir, Some(wanted.clone()))
            .await?;
        Ok(walked.files.into_iter().map(|f| (f.path, f.text)).collect())
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
        let dir = root.join(git_checkout::checkout_key(secret_ref, repo_full_path));
        if !dir.join(".git").is_dir() {
            return Ok(None);
        }
        read_one(dir, path).await
    }
}

/// The files of a listing that were read as text.
fn text_only(listing: Vec<(String, Option<String>)>) -> Vec<(String, String)> {
    listing
        .into_iter()
        .filter_map(|(path, text)| text.map(|t| (path, t)))
        .collect()
}

/// [`git_checkout::read_text_file`] off the async runtime.
async fn read_one(dir: PathBuf, path: &str) -> anyhow::Result<Option<String>> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || git_checkout::read_text_file(&dir, &path))
        .await
        .map_err(|e| anyhow!("file read did not finish: {e}"))
}

/// The edges the links read off this repository's items make, for the
/// targets this sync holds a node of (ADR-0047 §3). Only an issue is closed
/// or is a parent: "closes" naming a pull request is a reference to it, and
/// "part of" a pull request is nothing.
fn item_link_edges(
    links: &[(String, &'static str, NumberRef)],
    issue_by_number: &HashMap<i64, String>,
    by_number: &HashMap<i64, String>,
    repo_full_path: &str,
) -> Vec<GtsEdge> {
    let mut out: Vec<GtsEdge> = Vec::new();
    for (from, rel, target) in links {
        if !target.is_in(repo_full_path) {
            continue;
        }
        let (rel, to) = match (*rel, issue_by_number.get(&target.number)) {
            (gts::REL_CLOSES | gts::REL_PART_OF, Some(issue)) => (*rel, issue),
            (gts::REL_PART_OF, None) => continue,
            (_, _) => match by_number.get(&target.number) {
                Some(item) => (gts::REL_REFERENCES, item),
                None => continue,
            },
        };
        if to != from {
            out.push(gts::item_link_edge(rel, from, to));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A link becomes an edge only to an item of this repository the sync
    /// holds; closing a pull request is referencing it (ADR-0047 §3).
    #[test]
    fn links_become_edges_to_the_items_this_repository_holds() {
        let here = |number| NumberRef { repo: None, number };
        let issues = HashMap::from([(1, "i1".to_string()), (2, "i2".to_string())]);
        let mut items = issues.clone();
        items.insert(3, "p3".to_string());
        let links = vec![
            ("p3".to_string(), gts::REL_CLOSES, here(1)),
            ("p3".to_string(), gts::REL_CLOSES, here(4)),
            ("p3".to_string(), gts::REL_REFERENCES, here(2)),
            ("p5".to_string(), gts::REL_CLOSES, here(3)),
            ("p3".to_string(), gts::REL_REFERENCES, here(3)),
            (
                "p3".to_string(),
                gts::REL_CLOSES,
                NumberRef {
                    repo: Some("other/repo".into()),
                    number: 1,
                },
            ),
            (
                "i2".to_string(),
                gts::REL_PART_OF,
                NumberRef {
                    repo: Some("Acme/Specs".into()),
                    number: 1,
                },
            ),
            ("i1".to_string(), gts::REL_PART_OF, here(3)),
        ];
        let got: Vec<(&str, String, String)> =
            item_link_edges(&links, &issues, &items, "acme/specs")
                .into_iter()
                .map(|e| (e.type_id, e.from, e.to))
                .collect();
        assert_eq!(
            got,
            vec![
                (gts::REL_CLOSES, "p3".into(), "i1".into()),
                (gts::REL_REFERENCES, "p3".into(), "i2".into()),
                (gts::REL_REFERENCES, "p5".into(), "p3".into()),
                (gts::REL_PART_OF, "i2".into(), "i1".into()),
            ]
        );
    }

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
        /// The Studio documents it says exist.
        existing: Mutex<HashSet<Uuid>>,
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

        async fn existing_documents(
            &self,
            _ctx: &SecurityContext,
            _workspace_id: Uuid,
            ids: Vec<Uuid>,
        ) -> anyhow::Result<HashSet<Uuid>> {
            let existing = self.existing.lock().expect("existing");
            Ok(ids.into_iter().filter(|id| existing.contains(id)).collect())
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

    /// A provider that lists nothing: the sync fails at its first page.
    struct Unreachable;

    #[async_trait]
    impl ConnectorDriver for Unreachable {
        fn provider(&self) -> &'static str {
            "unreachable"
        }
        fn display_name(&self) -> &'static str {
            "Unreachable"
        }
        fn default_base_url(&self) -> &'static str {
            "https://unreachable.example.com"
        }
        fn category(&self) -> crate::connectors::sdk::ConnectorCategory {
            crate::connectors::sdk::ConnectorCategory::SourceCode
        }
        async fn test(
            &self,
            _: &crate::connectors::sdk::ConnectionAuth,
        ) -> anyhow::Result<crate::connectors::sdk::DriverIdentity> {
            Err(anyhow!("unreachable"))
        }
    }

    #[tokio::test]
    async fn a_failed_sync_keeps_when_the_last_one_finished_and_what_it_pulled() {
        let graph = Arc::new(InMemoryGraphStore::default());
        let mut drivers: HashMap<String, Arc<dyn ConnectorDriver>> = HashMap::new();
        drivers.insert("unreachable".into(), Arc::new(Unreachable));
        let svc = IngestService::new(
            Arc::new(NoSecrets),
            drivers,
            graph.clone(),
            None,
            None,
            None,
        );
        let last = gts::repo_synced_node(
            "p1",
            "conn",
            "unreachable",
            "acme/app",
            "2026-10-20T10:00:00Z",
            gts::RepoSyncStats {
                issues: 7,
                files: 3,
                ..Default::default()
            },
            &[],
        );
        let repo_id = last.instance_id.clone();
        graph
            .upsert_nodes(&ctx(), &[stamped(last, Some("p1"))])
            .await
            .expect("seed");

        let sync = svc
            .run_sync(
                &ctx(),
                "unreachable",
                None,
                "conn",
                "acme/app",
                None,
                "token",
                Some(WS),
                Some("p1"),
                None,
                &SyncReporter::detached(),
            )
            .await;
        assert!(sync.is_err(), "the provider lists nothing");

        let repos = graph
            .list(&ctx(), Some(gts::REPO_TYPE))
            .await
            .expect("list");
        let repo = repos
            .iter()
            .find(|n| n.instance_id == repo_id)
            .expect("the repository is still there");
        assert_eq!(repo.value["synced_at"], "2026-10-20T10:00:00Z");
        assert_eq!(repo.value["issues"], 7);
        assert_eq!(repo.value["files"], 3);
        assert_eq!(repo.value["full_path"], "acme/app");
    }

    #[test]
    fn a_first_sync_starts_from_the_bare_repository() {
        let node = gts::repo_node_keeping("p1", "conn", "github", "acme/app", None);
        let bare = gts::repo_node("p1", "conn", "github", "acme/app");
        assert_eq!(node.instance_id, bare.instance_id);
        assert_eq!(node.value, bare.value);
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
    async fn a_token_nobody_can_vouch_for_is_refused_and_no_token_passes() {
        // Without the connector service nothing can say whose connection holds
        // the reference, and credstore would lend it anyway: refuse.
        let (svc, _, _) = service();
        let tenant = Uuid::from_u128(7);
        assert!(matches!(
            svc.ensure_token_owned(&ctx(), tenant, tenant, "secret://root/github")
                .await,
            Err(TokenRefused::Unknown)
        ));
        // A public repository synced without a token reads with nobody's.
        assert!(
            svc.ensure_token_owned(&ctx(), tenant, tenant, "  ")
                .await
                .is_ok()
        );
    }

    #[test]
    fn a_refusal_names_whose_connection_it_was() {
        let refused = TokenRefused::NotOwned(crate::connectors::sdk::ownership::NotOwned {
            holder: crate::connectors::sdk::ownership::PLATFORM_ROOT_TENANT,
            organization: Uuid::from_u128(7),
        });
        assert!(
            refused.to_string().contains("the platform's root"),
            "{refused}"
        );
        assert!(
            TokenRefused::Unknown
                .to_string()
                .contains("no connection of this organization")
        );
    }

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

    /// A detector's verdict on `subject`, stored as a run in `project` would.
    fn verdict_on(subject: &str, project: Option<&str>) -> GtsNode {
        stamped(
            gts::spec_finding_node(
                "purpose",
                subject,
                None,
                Some("high"),
                None,
                None,
                json!({ "findings": [{ "id": "1" }] }),
                "2026-10-01T00:00:00Z",
            ),
            project,
        )
    }

    /// Whose verdicts are still in the graph.
    async fn verdict_subjects(graph: &InMemoryGraphStore) -> HashSet<String> {
        graph
            .list(&ctx(), Some(gts::SPEC_FINDING_TYPE))
            .await
            .expect("list")
            .iter()
            .filter_map(|n| n.value.get("subject")?.as_str().map(str::to_owned))
            .collect()
    }

    #[tokio::test]
    async fn a_file_the_repository_no_longer_has_takes_its_verdicts_with_it() {
        let (svc, graph, _) = service();
        let mut nodes = Vec::new();
        let (repo_id, file_id) = synced(&mut nodes, Some(PROJECT), "conn", "org/studio-web");
        let (_, kept_file) = synced(&mut nodes, Some(PROJECT), "conn", "org/other");
        nodes.push(verdict_on(&file_id, Some(PROJECT)));
        nodes.push(verdict_on(&kept_file, Some(PROJECT)));
        nodes.push(verdict_on("studio-doc:d1", Some(PROJECT)));
        graph.upsert_nodes(&ctx(), &nodes).await.expect("upsert");

        // A complete listing without README.md: the file is gone.
        let pruned = svc
            .prune_gone_files(
                &ctx(),
                &repo_id,
                Some(&HashSet::new()),
                Some(WS),
                Some(PROJECT),
                "org/studio-web",
            )
            .await;

        assert_eq!(pruned, 1);
        assert_eq!(
            verdict_subjects(&graph).await,
            HashSet::from([kept_file, "studio-doc:d1".to_owned()])
        );
    }

    #[tokio::test]
    async fn a_detached_repository_takes_the_verdicts_on_its_files_with_it() {
        let (svc, graph, _) = service();
        let mut nodes = Vec::new();
        let (_, gone_file) = synced(&mut nodes, Some(PROJECT), "conn", "org/studio-web");
        let (_, kept_file) = synced(&mut nodes, Some(PROJECT), "conn", "org/other");
        // The same repository in a sibling project, and its verdict, stay.
        let (_, sibling_file) = synced(&mut nodes, Some(OTHER_PROJECT), "conn", "org/studio-web");
        for (subject, project) in [
            (&gone_file, PROJECT),
            (&kept_file, PROJECT),
            (&sibling_file, OTHER_PROJECT),
        ] {
            nodes.push(verdict_on(subject, Some(project)));
        }
        graph.upsert_nodes(&ctx(), &nodes).await.expect("upsert");

        svc.prune_detached(
            &ctx(),
            Some(WS),
            Some(PROJECT),
            &[KeptRepo {
                connector_id: "conn".into(),
                repo_full_path: "org/other".into(),
            }],
        )
        .await
        .expect("prune");

        assert_eq!(
            verdict_subjects(&graph).await,
            HashSet::from([kept_file, sibling_file])
        );
    }

    #[tokio::test]
    async fn a_sync_sweeps_verdicts_whose_document_went_before_verdicts_went_with_it() {
        let (svc, graph, classifier) = service();
        let kept_doc = Uuid::new_v4();
        let deleted_doc = Uuid::new_v4();
        classifier
            .existing
            .lock()
            .expect("existing")
            .insert(kept_doc);
        let mut nodes = Vec::new();
        let (_, live_file) = synced(&mut nodes, Some(PROJECT), "conn", "org/studio-web");
        // A file in a sibling project of the same workspace still holds its
        // verdict: files are judged across the workspace.
        let (_, sibling_file) = synced(&mut nodes, Some(OTHER_PROJECT), "conn", "org/studio-web");
        let gone_file = Uuid::new_v4().to_string();
        let kept = format!("studio-doc:{kept_doc}");
        let deleted = format!("studio-doc:{deleted_doc}");
        for subject in [
            &live_file,
            &sibling_file,
            &gone_file,
            &kept,
            &deleted,
            // Not a node id of ours: not ours to judge.
            &"legacy-subject".to_owned(),
        ] {
            nodes.push(verdict_on(subject, Some(PROJECT)));
        }
        graph.upsert_nodes(&ctx(), &nodes).await.expect("upsert");

        let swept = svc
            .sweep_orphan_verdicts(&ctx(), Some(WS), Some(PROJECT))
            .await
            .expect("sweep");

        assert_eq!(swept, 2);
        assert_eq!(
            verdict_subjects(&graph).await,
            HashSet::from([live_file, sibling_file, kept, "legacy-subject".to_owned()])
        );
        // Nothing left to sweep the second time.
        assert_eq!(
            svc.sweep_orphan_verdicts(&ctx(), Some(WS), Some(PROJECT))
                .await
                .expect("again"),
            0
        );
    }

    #[tokio::test]
    async fn a_studio_verdict_nobody_can_vouch_for_is_left_alone() {
        // No documents gear to ask: a Studio document's verdict stays, whether
        // or not the document does.
        let graph = Arc::new(InMemoryGraphStore::default());
        let svc = IngestService::new(
            Arc::new(NoSecrets),
            HashMap::new(),
            graph.clone(),
            None,
            None,
            None,
        );
        let subject = format!("studio-doc:{}", Uuid::new_v4());
        graph
            .upsert_nodes(&ctx(), &[verdict_on(&subject, Some(PROJECT))])
            .await
            .expect("upsert");

        let swept = svc
            .sweep_orphan_verdicts(&ctx(), Some(WS), Some(PROJECT))
            .await
            .expect("sweep");

        assert_eq!(swept, 0);
        assert_eq!(verdict_subjects(&graph).await, HashSet::from([subject]));
    }

    #[tokio::test]
    async fn a_deleted_studio_document_can_have_its_verdicts_forgotten_by_subject() {
        use super::super::port::SpecFindingWriter;
        let (svc, graph, _) = service();
        graph
            .upsert_nodes(
                &ctx(),
                &[
                    verdict_on("studio-doc:d1", Some(PROJECT)),
                    verdict_on("studio-doc:d2", Some(PROJECT)),
                ],
            )
            .await
            .expect("upsert");

        // Recorded under the parent workspace, which is what the documents
        // gear knows a document by.
        let n = svc
            .forget_spec_findings(&ctx(), WS, &["studio-doc:d1".to_owned()])
            .await
            .expect("forget");

        assert_eq!(n, 1);
        assert_eq!(
            verdict_subjects(&graph).await,
            HashSet::from(["studio-doc:d2".to_owned()])
        );
        // Again is nothing, not an error.
        assert_eq!(
            svc.forget_spec_findings(&ctx(), WS, &["studio-doc:d1".to_owned()])
                .await
                .expect("again"),
            0
        );
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
        let dir = root.join(crate::connectors::sdk::git_checkout::checkout_key(
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

    #[tokio::test]
    async fn a_failed_clone_is_said_until_one_succeeds() {
        use super::super::port::RepoFileReader;
        let (svc, _, _) = service();
        assert_eq!(svc.clone_failure("conn", "org/repo").await, None);
        svc.note_clone(
            "conn",
            "org/repo",
            Some("the last clone failed: Permission denied".into()),
        );
        assert_eq!(
            svc.clone_failure("conn", "org/repo").await.as_deref(),
            Some("the last clone failed: Permission denied")
        );
        assert_eq!(
            svc.clone_failure("conn", "org/other").await,
            None,
            "only that repository"
        );
        svc.note_clone("conn", "org/repo", None);
        assert_eq!(svc.clone_failure("conn", "org/repo").await, None);
    }

    #[tokio::test]
    async fn an_unwritable_volume_is_the_reason_for_every_repository() {
        use super::super::port::RepoFileReader;
        let (svc, _, _) = service();
        let svc = svc.with_work_root_failure(Some("the clone volume /c cannot be written".into()));
        assert_eq!(
            svc.clone_failure("any", "org/repo").await.as_deref(),
            Some("the clone volume /c cannot be written")
        );
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn a_writable_volume_passes_the_probe_and_keeps_nothing() {
        let dir = scratch("probe-ok");
        assert_eq!(writable(&dir), None);
        assert_eq!(
            std::fs::read_dir(&dir).expect("read").count(),
            0,
            "the probe is removed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_volume_that_cannot_be_written_fails_the_probe() {
        let dir = scratch("probe-missing");
        let missing = dir.join("not-there");
        let why = writable(&missing).expect("a directory that does not exist cannot be written");
        assert!(why.contains("cannot be written"), "{why}");
        let _ = std::fs::remove_dir_all(&dir);
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

    async fn forget_spec_findings(
        &self,
        ctx: &SecurityContext,
        scope: &str,
        subjects: &[String],
    ) -> anyhow::Result<usize> {
        self.forget_findings(ctx, scope, subjects).await
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
