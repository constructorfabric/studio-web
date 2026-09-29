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
