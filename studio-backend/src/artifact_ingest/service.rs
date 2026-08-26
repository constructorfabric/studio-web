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
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::anyhow;
use credstore_sdk::{CredStoreClientV1, SecretRef};
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

impl IngestService {
    pub fn new(
        credstore: Arc<dyn CredStoreClientV1>,
        drivers: HashMap<String, Arc<dyn ConnectorDriver>>,
        graph: Arc<dyn GraphStore>,
        workspaces_root: Option<PathBuf>,
        work_root: Option<PathBuf>,
    ) -> Self {
        Self {
            credstore,
            drivers,
            graph,
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

        // Link an issue/PR to its author: intern a user node and add an
        // authored_by edge. No-op when the author is unknown.
        let author_edge = |edges: &mut Vec<GtsEdge>,
                           users: &mut HashMap<String, GtsNode>,
                           artifact_id: &str,
                           author: Option<&str>| {
            if let Some(login) = author.map(str::trim).filter(|s| !s.is_empty()) {
                let u = gts::user_node(connector_id, provider, login);
                edges.push(gts::authored_by_edge(artifact_id, &u.instance_id));
                users.entry(u.instance_id.clone()).or_insert(u);
            }
        };

        let repo = gts::repo_node(connector_id, provider, repo_full_path);
        let repo_id = repo.instance_id.clone();
        nodes.push(repo);

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
                let node = gts::issue_node(&repo_id, connector_id, repo_full_path, i);
                edges.push(gts::artifact_of_edge(&node.instance_id, &repo_id));
                author_edge(&mut edges, &mut users, &node.instance_id, author.as_deref());
                nodes.push(node);
            }
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
                let node = gts::pull_request_node(&repo_id, connector_id, repo_full_path, p);
                let pr_id = node.instance_id.clone();
                edges.push(gts::artifact_of_edge(&pr_id, &repo_id));
                author_edge(&mut edges, &mut users, &pr_id, author.as_deref());
                pr_refs.push((number, pr_id));
                nodes.push(node);
            }
        }

        // Files come from, in order of preference:
        //   1. the studio-session workspace checkout, if the IDE already cloned
        //      it — one shared clone, always what the IDE shows;
        //   2. our own shallow clone, if a fallback volume is configured;
        //   3. the connector tree API (metadata only).
        // Best-effort: a failure here never discards the issue/PR nodes.
        let mut files = 0usize;
        let on_disk: Option<(Vec<clone::WalkedFile>, Option<String>)> = if let Some(dir) =
            self.shared_checkout_dir(workspace_id, repo_dir)
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
                    Some((Vec::new(), None))
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
                    Some((Vec::new(), None))
                }
            }
        } else {
            None
        };

        match on_disk {
            Some((list, commit)) => {
                for wf in list.into_iter().take(MAX_FILES) {
                    files += 1;
                    let file_id = gts::file_instance_id(connector_id, repo_full_path, &wf.path);
                    edges.push(gts::contains_edge(&repo_id, &file_id));
                    file_paths.insert(wf.path.clone());
                    nodes.push(gts::file_node_cloned(
                        &repo_id,
                        connector_id,
                        repo_full_path,
                        &wf.path,
                        wf.size,
                        wf.text,
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
                            let file_id =
                                gts::file_instance_id(connector_id, repo_full_path, &path);
                            edges.push(gts::contains_edge(&repo_id, &file_id));
                            file_paths.insert(path);
                            nodes.push(gts::file_node(&repo_id, connector_id, repo_full_path, f));
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
                                let file_id =
                                    gts::file_instance_id(connector_id, repo_full_path, &path);
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

        // Author nodes discovered along the way join the batch.
        nodes.extend(users.into_values());

        self.progress(task_id, "storing…");
        self.graph.upsert_nodes(ctx, &nodes).await?;
        // Relations are additive: if the store rejects an edge batch, keep the
        // nodes (the sync still succeeded) and log rather than failing the job.
        if let Err(e) = self.graph.upsert_edges(ctx, &edges).await {
            tracing::warn!(
                error = %e,
                repo = repo_full_path,
                edges = edges.len(),
                "studio-artifact-ingest: edge upsert failed — nodes stored without relations"
            );
        }
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
    ) -> anyhow::Result<(Vec<clone::WalkedFile>, Option<String>)> {
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
            Ok((walked, res.commit))
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
    ) -> anyhow::Result<(Vec<clone::WalkedFile>, Option<String>)> {
        tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
            let commit = clone::head_commit(&dir);
            let walked = clone::walk(&dir)?;
            Ok((walked, commit))
        })
        .await
        .map_err(|e| anyhow!("workspace read did not finish: {e}"))?
    }

    fn progress(&self, task_id: Option<&str>, message: &str) {
        if let Some(id) = task_id {
            self.tasks.set_running(id, message);
        }
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
        let (walked, _commit) = self.walk_checkout(dir).await?;
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
}
