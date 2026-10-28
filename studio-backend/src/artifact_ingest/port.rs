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

use std::collections::BTreeSet;

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

    /// Every file of the checkout [`Self::read_repo_files`] reads, text or
    /// not, as `(path, text)` — the text for exactly the files that method
    /// returns. A link in a document may lead to any file, a template or an
    /// image as much as another document, so whether it resolves is a
    /// question about this listing, not about the text files.
    ///
    /// The default knows only the text files, which is all a reader that
    /// cannot walk the checkout has to give.
    async fn read_repo_listing(
        &self,
        workspace_id: &str,
        repo_dir: &str,
    ) -> anyhow::Result<Vec<(String, Option<String>)>> {
        Ok(self
            .read_repo_files(workspace_id, repo_dir)
            .await?
            .into_iter()
            .map(|(path, text)| (path, Some(text)))
            .collect())
    }

    /// The same, from the sync's clone [`Self::read_synced_clone`] reads.
    async fn read_synced_clone_listing(
        &self,
        secret_ref: &str,
        repo_full_path: &str,
    ) -> anyhow::Result<Vec<(String, Option<String>)>> {
        Ok(self
            .read_synced_clone(secret_ref, repo_full_path)
            .await?
            .into_iter()
            .map(|(path, text)| (path, Some(text)))
            .collect())
    }

    /// [`Self::read_repo_listing`], with the text of the `wanted` paths only:
    /// every other file is listed by its path alone. What a caller reading a
    /// few documents out of a large checkout asks, so the rest of its text is
    /// never loaded. The default reads the whole listing and drops the rest;
    /// an implementation that walks the checkout should not read it at all.
    async fn read_repo_listing_of(
        &self,
        workspace_id: &str,
        repo_dir: &str,
        wanted: &BTreeSet<String>,
    ) -> anyhow::Result<Vec<(String, Option<String>)>> {
        Ok(text_of(
            self.read_repo_listing(workspace_id, repo_dir).await?,
            wanted,
        ))
    }

    /// The same, from the sync's clone [`Self::read_synced_clone`] reads.
    async fn read_synced_clone_listing_of(
        &self,
        secret_ref: &str,
        repo_full_path: &str,
        wanted: &BTreeSet<String>,
    ) -> anyhow::Result<Vec<(String, Option<String>)>> {
        Ok(text_of(
            self.read_synced_clone_listing(secret_ref, repo_full_path)
                .await?,
            wanted,
        ))
    }

    /// Why the sync's own clone of a repository is missing, when it is known:
    /// the last clone of it failed, or the clone volume cannot be written.
    /// `None` when nothing failed — the default, for a reader that keeps no
    /// clones of its own.
    async fn clone_failure(&self, _secret_ref: &str, _repo_full_path: &str) -> Option<String> {
        None
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

/// `listing` with the text of the `wanted` paths only.
pub fn text_of(
    listing: Vec<(String, Option<String>)>,
    wanted: &BTreeSet<String>,
) -> Vec<(String, Option<String>)> {
    listing
        .into_iter()
        .map(|(path, text)| {
            let text = text.filter(|_| wanted.contains(&path));
            (path, text)
        })
        .collect()
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

    /// Each document's recorded verdicts in `scope`, folded, keyed by the
    /// verdict's `subject`: a file's node id, or `studio-doc:<id>` for a
    /// document written in Studio. A document with no entry was never checked.
    ///
    /// Beside the files because the Specs list needs both, and paged every
    /// `spec_finding` in the browser to fold this itself.
    ///
    /// `dismissed` holds the fingerprints of findings members marked as not a
    /// problem; they are not counted.
    async fn reviews(
        &self,
        ctx: &toolkit_security::SecurityContext,
        scope: &str,
        dismissed: &std::collections::BTreeSet<String>,
    ) -> anyhow::Result<std::collections::HashMap<String, ReviewSummary>>;

    /// `repo node id -> full_path` for every repository in `scope`: what
    /// [`IngestedFile::repo`] names, spelled the way a reader knows it.
    async fn repo_paths(
        &self,
        ctx: &toolkit_security::SecurityContext,
        scope: &str,
    ) -> anyhow::Result<std::collections::HashMap<String, String>>;
}

pub use super::activity::{ProjectSignals, ReviewSummary};

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

pub use super::ci_runs::{CiRun, latest_completed as latest_completed_run};

/// What a project's synced repositories show about its delivery: the CI runs
/// and the pull requests waiting on a review — the evidence the documents
/// gear's stage gates of kind `tests` and `review` read (issue #782).
#[async_trait]
pub trait DeliveryEvidence: Send + Sync + 'static {
    /// Every CI run the sync kept in `scope` (a project's tenant id).
    async fn ci_runs(
        &self,
        ctx: &toolkit_security::SecurityContext,
        scope: &str,
    ) -> anyhow::Result<Vec<CiRun>>;

    /// How many open pull requests in `scope` wait on a reviewer.
    async fn pulls_waiting_on_review(
        &self,
        ctx: &toolkit_security::SecurityContext,
        scope: &str,
    ) -> anyhow::Result<u32>;
}

/// One open pull request and who it waits on, as `open-pull-requests`
/// classifies it — the accounts as the provider names them, for a gear that
/// reads them as people itself.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpenPull {
    /// The project whose sync wrote it.
    pub project_id: Option<String>,
    pub author: Option<String>,
    /// `review`, `author`, `merge`, `draft` or `nobody`.
    pub waiting: String,
    /// The accounts at the front of its queue.
    pub waiting_on: Vec<String>,
    /// Everybody asked to review it or who did.
    pub reviewers: Vec<String>,
    pub days_open: Option<u32>,
    pub days_since_update: Option<u32>,
}

/// A project's open pull requests, classified — what the organization's
/// overview counts stuck work from. One indexed read in scope.
#[async_trait]
pub trait OpenPullRequests: Send + Sync + 'static {
    async fn open_pulls(
        &self,
        ctx: &toolkit_security::SecurityContext,
        scope: &str,
    ) -> anyhow::Result<Vec<OpenPull>>;
}

/// One piece of a project's work, as the sync keeps it: an issue, a pull
/// request or a commit, with the text a person wrote on it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkItem {
    /// `issue`, `pull_request` or `commit`.
    pub kind: String,
    /// The issue's or pull request's number; `None` for a commit.
    pub number: Option<i64>,
    /// The title, or a commit's subject line.
    pub title: String,
    /// The body, or a commit's whole message. Empty when the sync dropped an
    /// oversized body.
    pub text: String,
    pub url: Option<String>,
    /// `open` or `closed` for an issue or pull request.
    pub state: Option<String>,
    pub merged: bool,
    /// A commit's short sha.
    pub sha: Option<String>,
}

/// A project's issues, pull requests and commits, for the gear that links
/// them to what the documents require (`docs/project-and-product.md`, "The
/// links"). Three indexed reads in scope, as [`ProjectSignalSource`] makes.
#[async_trait]
pub trait ProjectWork: Send + Sync + 'static {
    /// The work in `scope` (a project's tenant id), in no particular order.
    async fn project_work(
        &self,
        ctx: &toolkit_security::SecurityContext,
        scope: &str,
    ) -> anyhow::Result<Vec<WorkItem>>;
}

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

    /// Forget every verdict recorded on `subjects` in `scope`, for the gear
    /// whose document went: a verdict outliving its document kept counting in
    /// the projects table's `open_findings` (studio-web#706). `subjects` are
    /// what verdicts are keyed on — `studio-doc:<id>` for a document written
    /// in Studio. Returns how many went; a subject with none is not an error.
    async fn forget_spec_findings(
        &self,
        ctx: &toolkit_security::SecurityContext,
        scope: &str,
        subjects: &[String],
    ) -> anyhow::Result<usize>;
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

#[cfg(test)]
mod text_of_tests {
    use super::*;

    #[test]
    fn only_the_wanted_paths_keep_their_text_and_every_path_stays_listed() {
        let listing = vec![
            ("docs/PRD.md".to_owned(), Some("# PRD".to_owned())),
            ("src/main.rs".to_owned(), Some("fn main() {}".to_owned())),
            ("logo.png".to_owned(), None),
        ];
        let wanted = BTreeSet::from(["docs/PRD.md".to_owned(), "logo.png".to_owned()]);
        assert_eq!(
            text_of(listing, &wanted),
            [
                ("docs/PRD.md".to_owned(), Some("# PRD".to_owned())),
                ("src/main.rs".to_owned(), None),
                ("logo.png".to_owned(), None),
            ]
        );
    }
}

/// One build as its record says (ADR-0045, ADR-0048 §4): what another gear
/// deploys when it is told a build's id.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BuildRecord {
    pub build_id: String,
    /// `running` | `passed` | `failed` | `cancelled`.
    pub status: String,
    pub product: Option<String>,
    pub profile: Option<String>,
    pub commit: Option<String>,
    pub lock_hash: Option<String>,
    /// `(app, image)`: what it published, with registry and digest.
    pub images: Vec<(String, String)>,
    pub chart_ref: Option<String>,
    pub chart_version: Option<String>,
}

impl BuildRecord {
    /// A record's fields out of its node's payload.
    pub fn of(value: &serde_json::Value) -> Self {
        let text = |k: &str| value.get(k).and_then(|v| v.as_str()).map(str::to_owned);
        BuildRecord {
            build_id: text("build_id").unwrap_or_default(),
            status: text("status").unwrap_or_default(),
            product: text("product"),
            profile: text("profile"),
            commit: text("commit"),
            lock_hash: text("lock_hash"),
            images: value
                .get("images")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|i| {
                            Some((
                                i.get("app")?.as_str()?.to_owned(),
                                i.get("image")?.as_str()?.to_owned(),
                            ))
                        })
                        .collect()
                })
                .unwrap_or_default(),
            chart_ref: value
                .get("chart")
                .and_then(|c| c.get("reference"))
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            chart_version: value
                .get("chart")
                .and_then(|c| c.get("version"))
                .and_then(|v| v.as_str())
                .map(str::to_owned),
        }
    }
}

/// A build Studio ran in an organization's cluster (ADR-0048 §9), as its
/// gear records it: running, then passed with what it published, or failed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BuildOutcome {
    pub build_id: String,
    /// `running` | `passed` | `failed`.
    pub status: String,
    pub product: Option<String>,
    pub profile: Option<String>,
    /// `owner/name`.
    pub repository: Option<String>,
    pub commit: Option<String>,
    pub lock_hash: Option<String>,
    pub failure: Option<String>,
    pub failure_step: Option<String>,
    /// The step a running build is in.
    pub step: Option<String>,
    pub images: Vec<(String, String)>,
    pub chart_ref: Option<String>,
    pub chart_version: Option<String>,
}

impl BuildOutcome {
    pub fn running(build_id: &str, repository: &str, profile: &str) -> Self {
        Self {
            build_id: build_id.to_owned(),
            status: "running".into(),
            repository: Some(repository.to_owned()),
            profile: Some(profile.to_owned()),
            ..Self::default()
        }
    }

    pub fn failed(
        build_id: &str,
        repository: &str,
        profile: &str,
        failure: &str,
        step: &str,
    ) -> Self {
        Self {
            build_id: build_id.to_owned(),
            status: "failed".into(),
            repository: Some(repository.to_owned()),
            profile: Some(profile.to_owned()),
            failure: Some(one_line(failure).chars().take(500).collect()),
            failure_step: Some(step.to_owned()),
            ..Self::default()
        }
    }
}

/// A tool's output as the one line a build's `failure` holds: its lines
/// joined with ` · `, any other control character dropped. The record refuses
/// a control character, and a refused failure left the build `running` for
/// good, its watch giving up on recording it.
fn one_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
        .chars()
        .filter(|c| !c.is_control())
        .collect()
}

#[cfg(test)]
mod build_outcome_tests {
    use super::*;

    #[test]
    fn a_failure_of_many_lines_is_recorded_as_one() {
        let o = BuildOutcome::failed(
            "b",
            "acme/shop",
            "prod",
            "Error: gearbox generate failed: error [GBX0511] no plugin\r\n\terror: nothing was generated\n",
            "prepare",
        );
        assert_eq!(
            o.failure.as_deref(),
            Some(
                "Error: gearbox generate failed: error [GBX0511] no plugin · error: nothing was generated"
            )
        );
    }
}

/// A project's builds, by id, for the gear that deploys them -- and the
/// builds that gear runs itself.
#[async_trait]
pub trait BuildRecords: Send + Sync + 'static {
    /// The build `build_id` of `project_id` (its tenant id); `None` when the
    /// project has none by that id.
    async fn build(
        &self,
        ctx: &toolkit_security::SecurityContext,
        project_id: &str,
        build_id: &str,
    ) -> anyhow::Result<Option<BuildRecord>>;

    /// Record a build Studio runs (`where: studio`): its start, then its end.
    async fn record(
        &self,
        ctx: &toolkit_security::SecurityContext,
        project_id: &str,
        outcome: &BuildOutcome,
    ) -> anyhow::Result<()>;
}
