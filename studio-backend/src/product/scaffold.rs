//! Writing files into a project's connected repository: a scaffolded gear, or
//! a product description.
//!
//! Read paths elsewhere stay read-only; this is where the product *writes*.
//! Through the connection's [`Repository`] it commits the files in one commit
//! on a branch off the base branch, and optionally opens a pull request. The
//! token stays with the connection; the provider's API is the driver's
//! business (`connectors/github_write.rs`).

use anyhow::Result;

use crate::connectors::sdk::{FileToWrite, Repository};

/// One file to write into the repository.
#[derive(Clone, Debug)]
pub struct ScaffoldFile {
    pub path: String,
    pub content: String,
}

/// Where the scaffold landed.
#[derive(Debug)]
pub struct ScaffoldWrite {
    pub branch: String,
    pub commit_sha: String,
    pub pr_url: Option<String>,
}

/// Commit `files` onto `branch` off `base_branch` in one commit, and -- when
/// `pr_title` is set and the branch is not the base -- open a pull request
/// back into `base_branch`, or return the one already open. `pr_body` is the
/// pull request's text; `None` is the scaffold's.
pub async fn write_scaffold(
    repo: &Repository,
    base_branch: &str,
    branch: &str,
    files: &[ScaffoldFile],
    message: &str,
    pr_title: Option<&str>,
    pr_body: Option<&str>,
) -> Result<ScaffoldWrite> {
    let files: Vec<FileToWrite> = files
        .iter()
        .map(|f| FileToWrite {
            path: f.path.clone(),
            content: f.content.clone(),
        })
        .collect();
    let commit_sha = repo
        .commit_files(base_branch, branch, &files, message)
        .await?;
    // Nothing to request when the commit is already on the base branch.
    let pr_url = match pr_title {
        Some(title) if branch != base_branch => {
            repo.open_pull_request(
                branch,
                base_branch,
                title,
                Some(pr_body.unwrap_or(
                    "Scaffolded gear skeleton from an App Spec gap. Fill in the service, then review.",
                )),
            )
            .await?
            .url
        }
        _ => None,
    };
    Ok(ScaffoldWrite {
        branch: branch.to_string(),
        commit_sha,
        pr_url,
    })
}
