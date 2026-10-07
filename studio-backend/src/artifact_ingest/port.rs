//! What another gear may ask studio-artifact-ingest for.
//!
//! One method, and the mirror of `documents::port`. That seam exists because
//! the ingest walks a repository and ends up holding every file's text, while
//! the documents gear owns the type catalogue — neither can answer alone. This
//! one is the same shape read the other way: the documents gear knows which
//! files are specs and what type each is, and needs their TEXT to have them
//! analysed.
//!
//! Nobody stored that text on purpose. The graph keeps an excerpt and drops the
//! rest (`bounded_payload`), and a binding records a path and a verdict, never
//! the bytes. So the only thing that can produce a document's text is whatever
//! holds the checkout, which is this gear.
//!
//! Until this existed, the only caller that could join the two was the browser:
//! it read the files through `GET /repo-files`, held a repository in memory,
//! and posted the text back to be analysed — a full round trip of bytes the
//! backend had just read off its own disk.
//!
//! Published on the ClientHub rather than reached for directly, for the same
//! reason as the other seam: a deployment without a checkout volume simply has
//! no reader, and a consumer that resolves nothing says so instead of failing.

use async_trait::async_trait;

/// Reads the working copy a sync left on disk.
#[async_trait]
pub trait RepoFileReader: Send + Sync + 'static {
    /// Every text file of one repository's checkout, as `(path, text)`.
    ///
    /// `repo_dir` is the directory a sync cloned into, as the workspace's
    /// settings record it. An empty vector is the ordinary answer for a
    /// repository nobody has cloned yet — not an error, because a project may
    /// legitimately have sources it has never synced.
    async fn read_repo_files(
        &self,
        workspace_id: &str,
        repo_dir: &str,
    ) -> anyhow::Result<Vec<(String, String)>>;

    /// The same, from the copy a sync cloned for itself — addressed the way the
    /// sync was, by the connection's `secret_ref` and `owner/repo`. Empty when
    /// this deployment keeps no clones or has not cloned this one yet.
    async fn read_synced_clone(
        &self,
        _secret_ref: &str,
        _repo_full_path: &str,
    ) -> anyhow::Result<Vec<(String, String)>> {
        Ok(Vec::new())
    }

    /// One text file of the checkout [`Self::read_repo_files`] reads, by its
    /// repo-relative `path`. `None` when the checkout does not hold it as text.
    ///
    /// The default walks the whole checkout; an implementation that can open
    /// the one file should, since a reader opening a document asks for one.
    async fn read_repo_file(
        &self,
        workspace_id: &str,
        repo_dir: &str,
        path: &str,
    ) -> anyhow::Result<Option<String>> {
        Ok(self
            .read_repo_files(workspace_id, repo_dir)
            .await?
            .into_iter()
            .find_map(|(p, text)| (p == path).then_some(text)))
    }

    /// The same, from the sync's clone [`Self::read_synced_clone`] reads.
    async fn read_synced_clone_file(
        &self,
        secret_ref: &str,
        repo_full_path: &str,
        path: &str,
    ) -> anyhow::Result<Option<String>> {
        Ok(self
            .read_synced_clone(secret_ref, repo_full_path)
            .await?
            .into_iter()
            .find_map(|(p, text)| (p == path).then_some(text)))
    }
}

/// How much of the artifact graph belongs to one scope.
///
/// A second seam, added for the portfolio's per-project counts.
///
/// WHY NOT THE LISTING ENDPOINT. `GET /v1/nodes` answers the same question, and
/// the portfolio used to ask it that way — once per row, with `limit=1`,
/// reading `total`. That limit saves nothing: the projection cannot narrow by
/// payload, so the endpoint walks the tenant's whole typed node set and slices
/// it in this process. Measured on studio-dev: 28,717 nodes, 31 MB and 144
/// sequential round trips per call, a p95 of 8.06 s. A table of ten projects
/// asked for that ten times, from a browser.
///
/// Through here it is asked once per rollup, against the projection this
/// process already holds, and the caller is handed a number rather than a page
/// it has to count.
#[async_trait]
pub trait ArtifactCounter: Send + Sync + 'static {
    /// Nodes of `type_leaf` (`spec_finding`, `issue`, `file`, …) whose payload
    /// names `scope` as its workspace or its project.
    ///
    /// `Ok(n)` means n. An `Err` means the count is UNKNOWN, which a caller
    /// must not render as zero: "this project has no findings" and "nobody
    /// could tell me" are different sentences on a screen people use to decide
    /// where to look next.
    async fn count_nodes(
        &self,
        ctx: &toolkit_security::SecurityContext,
        type_leaf: &str,
        scope: &str,
    ) -> anyhow::Result<u32>;
}

/// One ingested file, as a screen listing a project's specs needs it.
///
/// Four fields out of a node that carries far more: enough to show the row and
/// to match a later scan back to it, and nothing that would make this a second
/// spelling of the artifact DTO.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngestedFile {
    /// Graph instance id — what a binding and a finding are keyed on.
    pub node_id: String,
    /// Repo-relative path.
    pub path: String,
    /// The repository it came from, for the provenance column. Empty when the
    /// sync did not record one.
    pub repo: String,
}

/// The files a sync ingested, for the gear that decides what they are.
///
/// WHY THIS EXISTS, like [`ArtifactCounter`] beside it. The Specs screen built
/// this list in the browser: `GET /v1/nodes?type=file` in a loop over every
/// page, for the sole purpose of finding which files nothing has classified
/// yet and which repository each came from. The projection cannot narrow by a
/// payload field, so each of those pages is a slice of the tenant's whole
/// typed node set — the same walk the portfolio was paying for, this time once
/// per page rather than once per row.
///
/// Through here it is one projection read in this process, against the cache
/// the ingest gear already holds.
#[async_trait]
pub trait ArtifactFiles: Send + Sync + 'static {
    /// Every `file` node whose payload names `scope` as its workspace or its
    /// project, directories excluded.
    ///
    /// `Ok(files)` is the list. An `Err` means it is UNKNOWN — a caller must
    /// not render that as "this project has no files".
    async fn list_files(
        &self,
        ctx: &toolkit_security::SecurityContext,
        scope: &str,
    ) -> anyhow::Result<Vec<IngestedFile>>;
}

pub use super::activity::ProjectSignals;

/// What a project's row in the projects table says about its review and its
/// sources: open findings, open comments, pull requests over a window and the
/// last thing that happened.
///
/// WHY THIS EXISTS, like [`ArtifactCounter`]: each of these is a screen of its
/// own (`/nodes?type=spec_finding`, `/source-activity`, `/activity`), and a
/// table that asked each of them for every row was the browser fan-out the
/// rollup replaced. Here it is four indexed reads in this process per project.
#[async_trait]
pub trait ProjectSignalSource: Send + Sync + 'static {
    /// The row for `scope` (a project's tenant id), over the last `days` days.
    ///
    /// An `Err` means every signal is UNKNOWN; a caller renders it as such.
    async fn project_signals(
        &self,
        ctx: &toolkit_security::SecurityContext,
        scope: &str,
        days: usize,
    ) -> anyhow::Result<ProjectSignals>;
}

pub use super::service::{QualityFinding, QualityLink};

/// Writes spec-quality findings into the artifact graph.
///
/// The REST `POST /quality` writes the same nodes for a caller that parsed a
/// verdict itself. This is the seam for the one that does not need to: a
/// Spec Quality run that records its own results as each document finishes,
/// including a run started by a source sync with nobody watching it.
#[async_trait]
pub trait SpecFindingWriter: Send + Sync + 'static {
    /// One `spec_finding` node per (detector, document), its `finding_on`
    /// edge, and the derived document relations. Idempotent, as the REST
    /// route is. Returns (nodes, edges).
    async fn write_spec_findings(
        &self,
        ctx: &toolkit_security::SecurityContext,
        findings: &[QualityFinding],
        duplicates: &[QualityLink],
        workspace_id: Option<&str>,
        project_id: Option<&str>,
    ) -> anyhow::Result<(usize, usize)>;
}

pub use super::service::MappingDecision;

/// Where the spec-mapping gear keeps a member's decisions
/// (`cpt-studio-fr-mapping-decisions`): `mapping_decision` nodes in this
/// graph, beside the documents they are about, written through the
/// `GraphStore` like every other artifact so the index follows them.
#[async_trait]
pub trait MappingDecisionStore: Send + Sync + 'static {
    /// Record one decision, replacing an earlier one on the same document,
    /// section, capability and gear. Answers the node's id and payload.
    async fn record_decision(
        &self,
        ctx: &toolkit_security::SecurityContext,
        decision: &MappingDecision,
    ) -> anyhow::Result<(String, serde_json::Value)>;

    /// Every decision recorded in a workspace or project, as (id, payload).
    async fn list_decisions(
        &self,
        ctx: &toolkit_security::SecurityContext,
        scope: &str,
    ) -> anyhow::Result<Vec<(String, serde_json::Value)>>;
}
