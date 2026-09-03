//! Ingest orchestration: connector source → normalized GTS nodes → graph store.
//!
//! Three channels feed the artifact graph: issues and pull requests (connector
//! API), and files. Files come from a real, shallow git clone into a mounted
//! volume when one is configured (`work_root`), so File nodes carry the actual
//! checkout — including text-file content; without a volume the pipeline falls
//! back to the connector's tree API (metadata only).
//!
//! A sync can take seconds (cloning), so it runs as a background task: callers
//! `enqueue_sync` and poll the [`TaskRegistry`]. The connection is passed
//! explicitly (`provider`, `base_url`, `connector_id`) so the pipeline is
//! testable on its own.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::anyhow;
use bytes::Bytes;
use credstore_sdk::{CredStoreClientV1, SecretRef};
use file_parser_sdk::{Detection, FileParserClientV1, ParseBytesRequest};
use toolkit_security::SecurityContext;
use uuid::Uuid;

use super::clone;
use super::graph::{GraphStore, GtsEdge, GtsNode};
use super::gts;
use super::tasks::{TaskRecord, TaskRegistry};
use crate::connectors::driver::{ConnectionAuth, ConnectorDriver};

/// Hard cap on pages per channel — a runaway loop backstop, not a real limit.
const MAX_PAGES: u32 = 50;
const PER_PAGE: u32 = 100;
/// Backstop on file nodes per sync, so a giant monorepo can't flood the graph.
const MAX_FILES: usize = 10_000;
/// Backstops on comment/commit nodes per sync — the same "don't flood the
/// graph" guard as files. Hitting one is logged (not silent truncation).
const MAX_COMMENTS: usize = 20_000;
const MAX_COMMITS: usize = 20_000;
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

#[derive(Debug, Clone, Copy)]
pub struct SyncSummary {
    pub issues: usize,
    pub pull_requests: usize,
    pub files: usize,
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
    /// The studio-session workspaces root (`STUDIO_WORKSPACES_ROOT`). When a
    /// sync names a workspace + repo dir and the session gear has already
    /// cloned it here, ingest reads that checkout instead of cloning its own —
    /// one clone, always consistent with what the IDE shows.
    workspaces_root: Option<PathBuf>,
    /// Fallback own-clone volume (`STUDIO_ARTIFACT_WORKDIR`). `None` = no
    /// fallback clone → tree-API metadata when no workspace checkout exists.
    work_root: Option<PathBuf>,
    /// Background sync tasks, polled by the portal.
    tasks: Arc<TaskRegistry>,
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
        workspaces_root: Option<PathBuf>,
        work_root: Option<PathBuf>,
    ) -> Self {
        Self {
            credstore,
            drivers,
            graph,
            file_parser,
            workspaces_root,
            work_root,
            tasks: Arc::new(TaskRegistry::default()),
        }
    }

    /// Resolve the connector token from credstore. Needs the request's security
    /// context, so it is done up front (in the handler) before a sync is spawned
    /// into the background.
    pub async fn resolve_token(
        &self,
        ctx: &SecurityContext,
        secret_ref: &str,
    ) -> anyhow::Result<String> {
        let key = SecretRef::new(secret_ref).map_err(|e| anyhow!("bad secret reference: {e}"))?;
        let secret = self
            .credstore
            .get(ctx, &key)
            .await
            .map_err(|e| anyhow!("credstore: {e}"))?
            .ok_or_else(|| {
                anyhow!("the token for '{secret_ref}' is not readable (wrong scope or removed)")
            })?;
        String::from_utf8(secret.value.as_bytes().to_vec())
            .map_err(|_| anyhow!("stored token is not valid UTF-8"))
    }

    /// Enqueue a sync and return its task id. The token is resolved by the
    /// caller (it needs the security context) and handed in, so the spawned job
    /// carries no request state.
    #[allow(clippy::too_many_arguments)]
    pub fn enqueue_sync(
        self: &Arc<Self>,
        ctx: SecurityContext,
        provider: String,
        base_url: Option<String>,
        connector_id: String,
        repo_full_path: String,
        since: Option<String>,
        token: String,
        workspace_id: Option<String>,
        project_id: Option<String>,
        repo_dir: Option<String>,
    ) -> String {
        let id = Uuid::new_v4().to_string();
        self.tasks.create(&id, &repo_full_path);
        let svc = Arc::clone(self);
        let task_id = id.clone();
        tokio::spawn(async move {
            svc.tasks.set_running(&task_id, "syncing…");
            match svc
                .run_sync(
                    &ctx,
                    &provider,
                    base_url.as_deref(),
                    &connector_id,
                    &repo_full_path,
                    since.as_deref(),
                    &token,
                    workspace_id.as_deref(),
                    project_id.as_deref(),
                    repo_dir.as_deref(),
                    Some(&task_id),
                )
                .await
            {
                Ok(s) => svc.tasks.succeed(
                    &task_id,
                    s.issues as u32,
                    s.pull_requests as u32,
                    s.files as u32,
                ),
                Err(e) => svc.tasks.fail(&task_id, &format!("{e:#}")),
            }
        });
        id
    }

    /// Snapshot of a task for the poll endpoint.
    pub fn task(&self, id: &str) -> Option<TaskRecord> {
        self.tasks.get(id)
    }

    /// Pull issues + PRs + files for one repository and upsert them into the
    /// graph. `task_id`, when set, receives short progress lines.
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
        task_id: Option<&str>,
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
            task_id,
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

        self.progress(task_id, "pulling issues…");
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
                task_id,
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

        self.progress(task_id, "pulling pull requests…");
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
                let node =
                    gts::pull_request_node(source_scope, &repo_id, connector_id, repo_full_path, p);
                let pr_id = node.instance_id.clone();
                edges.push(gts::artifact_of_edge(&pr_id, &repo_id));
                author_edge(&mut edges, &mut users, &pr_id, author.as_deref());
                by_number.insert(number, pr_id.clone());
                pr_refs.push((number, pr_id));
                nodes.push(node);
            }
            self.flush_and_report(
                ctx,
                task_id,
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
        // The IDE materializes each repo under the tenant that opened Studio —
        // the project tenant when opened from a project. Prefer `project_id`
        // for the checkout path; fall back to `workspace_id` for a
        // workspace-level open.
        let on_disk: Option<(PathBuf, Vec<clone::WalkedFile>, Option<String>)> = if let Some(dir) =
            self.shared_checkout_dir(project_id.or(workspace_id), repo_dir)
        {
            self.progress(task_id, "reading workspace files…");
            match self.walk_checkout(dir).await {
                Ok(v) => Some(v),
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        repo = repo_full_path,
                        "studio-artifact-ingest: reading the workspace checkout failed — skipping files"
                    );
                    Some((PathBuf::new(), Vec::new(), None))
                }
            }
        } else if let Some(work_root) = self.work_root.clone() {
            self.progress(task_id, "cloning repository…");
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
                    Some((PathBuf::new(), Vec::new(), None))
                }
            }
        } else {
            None
        };

        match on_disk {
            Some((dir, list, commit)) => {
                for wf in list.into_iter().take(MAX_FILES) {
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
                    nodes.push(gts::file_node_cloned(
                        source_scope,
                        &repo_id,
                        connector_id,
                        repo_full_path,
                        &wf.path,
                        wf.size,
                        text,
                        commit.as_deref(),
                    ));
                }
            }
            None => {
                // No checkout available — fall back to connector metadata.
                self.progress(task_id, "listing files…");
                match driver.list_files(&auth, repo_full_path, None).await {
                    Ok(list) => {
                        for f in list.into_iter().filter(|f| !f.is_dir).take(MAX_FILES) {
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

        // Flush the file nodes gathered from the checkout/tree before deriving
        // PR→file links (those are edges, whose endpoints must already exist).
        self.flush_and_report(
            ctx,
            task_id,
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

        // PR → file (`modifies`): one API call per PR, best-effort, and only for
        // files we actually ingested so every edge endpoint exists in the graph.
        if !pr_refs.is_empty() && !file_paths.is_empty() {
            self.progress(task_id, "linking pull requests to files…");
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
        self.progress(task_id, "pulling comments…");
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
                task_id,
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
        self.progress(task_id, "pulling commits…");
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
                task_id,
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
        self.progress(task_id, "storing…");
        self.flush_and_report(
            ctx,
            task_id,
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
    ) -> anyhow::Result<(PathBuf, Vec<clone::WalkedFile>, Option<String>)> {
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

    /// Walk an existing checkout on a blocking thread (no clone), reading text
    /// content, and capture its HEAD commit.
    async fn walk_checkout(
        &self,
        dir: PathBuf,
    ) -> anyhow::Result<(PathBuf, Vec<clone::WalkedFile>, Option<String>)> {
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

    fn progress(&self, task_id: Option<&str>, message: &str) {
        if let Some(id) = task_id {
            self.tasks.set_running(id, message);
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
        task_id: Option<&str>,
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
        if let Some(id) = task_id {
            self.tasks.report(
                id,
                phase,
                issues as u32,
                pull_requests as u32,
                files as u32,
                comments as u32,
                commits as u32,
                *flushed as u32,
            );
        }
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
            .into_iter()
            .filter_map(|f| f.text.map(|t| (f.path, t)))
            .collect())
    }

    /// Read ingested nodes back for the portal, optionally filtered by type
    /// substring (`issue`, `pull_request`, `file`, `repo`).
    pub async fn list_nodes(
        &self,
        ctx: &SecurityContext,
        type_filter: Option<&str>,
    ) -> anyhow::Result<Vec<GtsNode>> {
        self.graph.list(ctx, type_filter).await
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
